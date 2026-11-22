import { randomUUID } from "node:crypto";
import { DeviceOfflineError, type ExtensionContext } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { deviceNotFound, machineRevoked } from "../devices/errors.js";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_BUS, KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  DeviceProgramRestartedError,
  DeviceRequestNotSentError,
  isDeviceRequestNotSent,
} from "../sandbox/request-not-sent.js";
import {
  type DialInConnectionFence,
  type QueuedCancel,
  type QueuedRequest,
  type QueuedStop,
  type ReadResult,
  readStoredResult,
} from "./envelope.js";
import {
  deviceLeaseKey,
  deviceReqKey,
  deviceReqTopic,
  deviceResKey,
  deviceResTopic,
} from "./keys.js";
import { type DeviceConnectionInfo, type DeviceTargetState, DeviceTargets } from "./targets.js";

/** The device's machine is not connected (no replica holds its lease): the kernel's own error. */
export const deviceOffline = (): ApiError =>
  new ApiError(
    "device.offline",
    "The machine of this device is offline. Start its program on that machine, or pick another device.",
  );

export { machineRevoked } from "../devices/errors.js";

export { DeviceRequestNotSentError, isDeviceRequestNotSent };

/**
 * A fenced request's result arrived on another connection than the request went out on, or the
 * machine reconnected while a fenced request waited: its answer was sized for the old connection.
 */
export class DialInConnectionChangedError extends Error {
  readonly connectionChanged = true as const;
  constructor() {
    super("The machine's connection changed while the request waited; retry it");
    this.name = "DialInConnectionChangedError";
  }
}

/** A request whose frame does not fit the machine connection's negotiated frame capacity. */
export class DialInFrameTooLargeError extends Error {
  constructor(maxFrameBytes: number) {
    super(
      `The request does not fit the machine connection's frame limit of ${maxFrameBytes} bytes; check the device and deployment frame limits`,
    );
    this.name = "DialInFrameTooLargeError";
  }
}

/** The longest one lease check of a waiting caller may take before it counts as "unknown". */
export const LEASE_CHECK_TIMEOUT_MS = 2000;

/** How often a waiting caller checks that a replica still holds the machine's connection. */
export const HOLDER_POLL_MS = 5000;

/**
 * How much longer than the caller's wait a queued request lives: giving up must still find an
 * untaken request on the list (an expired one would look taken and get a needless cancel).
 */
export const LIST_TTL_MARGIN_MS = 30_000;

/**
 * Appends one frame to the request list and makes sure the list lives at least `ARGV[2]` ms
 * (never shortens the TTL a request with a longer deadline set). Atomic, so the list never exists
 * without a TTL.
 */
const PUSH_WITH_TTL = `
redis.call('RPUSH', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 1
`;

/**
 * Gives up on a request (ruling R15): removes the exact request frame `ARGV[1]` from the list; only
 * when it is no longer queued (the machine already took it) appends the cancel `ARGV[2]`, with the
 * TTL rule of {@link PUSH_WITH_TTL}. Returns 1 when a cancel was queued.
 */
const GIVE_UP = `
if redis.call('LREM', KEYS[1], 1, ARGV[1]) > 0 then
  return 0
end
redis.call('RPUSH', KEYS[1], ARGV[2])
if redis.call('PTTL', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
end
return 1
`;

/** Why a call stopped waiting without a result. */
const ABORTED = Symbol("aborted");
const GRACE_EXPIRED = Symbol("grace expired");

type Outcome = { res: ReadResult } | { error: typeof ABORTED | typeof GRACE_EXPIRED | Error };

/** The options of {@link DialInRelay.request}. */
export interface DialInRequestOptions {
  /** How long the machine may take (sent to it as `deadlineMs`). */
  timeoutMs: number;
  /** The caller's signal: aborting gives the request up and rejects with its reason. */
  signal?: AbortSignal;
  /**
   * Kernel-internal: the connection the caller sized its request for. Another current connection
   * refuses the request as not sent before anything is queued. Never from an extension.
   */
  connection?: DialInConnectionFence;
  /**
   * Kernel-internal: the result was sized for the request's connection, so it is accepted only from
   * that connection and the wait ends as soon as the machine reconnects
   * ({@link DialInConnectionChangedError}). Never from an extension.
   */
  fenced?: boolean;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The caller side of the dial-in relay (environments spec §13.4), for every provider serving its
 * devices over the dial-in channel. A request goes onto the device's Redis list
 * (`capk:device-req:<deviceId>`) as a {@link QueuedRequest} fenced to the machine's current
 * connection, and is announced on `device.req.<deviceId>`; whichever gateway replica holds the
 * machine's lease drains the list and sends the envelope `req` to the machine (gateway.ts). The
 * holder stores the machine's `res` under `capk:device-res:<requestId>` and publishes it on
 * `device.res.<requestId>`, tagged with the connection it arrived on (envelope.ts); the relay hands
 * back only the body, never reading it.
 *
 * The caller subscribes to its result topic before pushing and reads the result key once after,
 * and once more before giving up (the run-abort pattern; a publish lost while the subscriber
 * reconnects is still found). It waits within its own call for at most `timeoutMs` plus
 * `devices.local.reconnectGraceSeconds`; when the lease disappears meanwhile (checked every
 * {@link HOLDER_POLL_MS}) the wait ends at most one grace later ({@link DeviceOfflineError}), and
 * when the machine is connected again as another run of its program (`programRunId`) it ends at
 * that poll with {@link DeviceProgramRestartedError}: the old run's kept results died with it. A
 * result produced while the machine was disconnected arrives after it reconnects. Giving up (grace,
 * abort, a bad result) removes the request from the list, or queues a `cancel` when the machine
 * already took it (ruling R15). Nothing is kept in process memory beyond the call.
 */
@Injectable()
export class DialInRelay {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KERNEL_BUS) private readonly bus: ExtensionContext["bus"],
    @Inject(LockService) private readonly locks: Pick<LockService, "holderOf">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Inject(DeviceTargets)
    private readonly targets: Pick<DeviceTargets, "state" | "current">,
  ) {}

  /** Whether a gateway replica holds the machine's connection now. */
  async online(deviceId: string): Promise<boolean> {
    return (await this.locks.holderOf(deviceLeaseKey(deviceId))) !== null;
  }

  /**
   * The negotiated transport of the machine's current connection. Liveness is checked first
   * (ruling R27): no holder throws `device.not_found` for a deleted device, `device.forbidden` for
   * a revoked machine and `device.offline` ({@link deviceOffline}) otherwise. It carries the
   * program run the connection's hello named (`programRunId`): kernel-internal evidence a request
   * keeps, never put into a frame.
   */
  async connection(deviceId: string): Promise<DeviceConnectionInfo> {
    if (await this.online(deviceId)) {
      const current = await this.targets.current(deviceId);
      if (current) return current;
    }
    throw this.goneError(await this.targetState(deviceId)) ?? deviceOffline();
  }

  /**
   * Queues a `stop` for the machine without waiting for an answer (ruling R14), only while a
   * replica holds its connection (an offline machine must not find it on the list later). With
   * `machineId`, the holder hands it only to that machine's connection (across a socket blip too),
   * never to a newer machine of the device.
   */
  async stop(
    deviceId: string,
    reason: "drain" | "stop",
    opts: { machineId?: string } = {},
  ): Promise<void> {
    if (!(await this.online(deviceId))) return;
    const frame: QueuedStop = {
      type: "stop",
      reason,
      ...(opts.machineId !== undefined && { machineId: opts.machineId }),
    };
    await this.push(deviceId, JSON.stringify(frame), this.graceMs() + LIST_TTL_MARGIN_MS);
    await this.bus.publish(deviceReqTopic(deviceId), { id: randomUUID() });
  }

  /**
   * Sends `body` to the device's machine as the body of a `req` and resolves the body of its `res`
   * (never read here). Throws {@link DeviceOfflineError} when no replica holds the machine at send
   * time or when the wait ran out, but `device.forbidden` ({@link machineRevoked}) when the machine
   * was revoked and `device.not_found` when the device was deleted (checked whenever the
   * connection is missing, ruling R27); {@link DeviceRequestNotSentError} when the request never
   * reached the machine (its connection changed first), {@link DialInFrameTooLargeError} when it
   * cannot fit, {@link DeviceProgramRestartedError} when the machine's program restarted before
   * answering. On abort the abort reason is thrown.
   */
  async request(deviceId: string, body: unknown, opts: DialInRequestOptions): Promise<unknown> {
    const signal = opts.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    let current: DeviceConnectionInfo;
    try {
      // liveness first: a deleted device or a revoked machine keeps its typed error (R27)
      current = await this.connection(deviceId);
    } catch (e) {
      if (e instanceof ApiError && e.code === "device.offline")
        throw new DeviceOfflineError(deviceId, { cause: e });
      throw e;
    }
    const connection: DialInConnectionFence = {
      connectionId: current.connectionId,
      maxFrameBytes: current.maxFrameBytes,
    };
    if (
      opts.connection &&
      (connection.connectionId !== opts.connection.connectionId ||
        connection.maxFrameBytes !== opts.connection.maxFrameBytes)
    )
      // nothing was queued: the request was definitely not sent
      throw new DeviceRequestNotSentError(
        "The machine's connection changed before the request was sent; retry it",
      );
    // the program run the request goes to: the drain sends it only on this connection (a newer
    // one refuses it as not sent), so a later connection of another run proves its result lost
    const sentToRun = current.programRunId;
    const fenced = opts.fenced === true;
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)
      throw new RangeError(`timeoutMs must be a positive number, got ${opts.timeoutMs}`);
    if (body === undefined) throw new TypeError("a dial-in request needs a body");

    const id = randomUUID();
    const deadlineMs = Math.max(1, Math.ceil(opts.timeoutMs));
    const graceMs = this.graceMs();
    const listTtlMs = graceMs + deadlineMs + LIST_TTL_MARGIN_MS;
    const wire = JSON.stringify({ type: "req", id, deadlineMs, body });
    if (Buffer.byteLength(wire) > connection.maxFrameBytes)
      throw new DialInFrameTooLargeError(connection.maxFrameBytes);
    const queued: QueuedRequest = { type: "req", id, deadlineMs, body, ...connection };
    const reqJson = JSON.stringify(queued);
    signal.throwIfAborted();

    let settle!: (r: Outcome) => void;
    const outcome = new Promise<Outcome>((resolve) => {
      let done = false;
      settle = (r) => {
        if (done) return;
        done = true;
        resolve(r);
      };
    });
    const onStored = (raw: unknown) => {
      if (raw !== null && raw !== undefined) settle(this.parseRes(raw, id, connection, fenced));
    };
    const onAbort = () => settle({ error: ABORTED });

    const unsubscribe = await this.bus.subscribe(deviceResTopic(id), (payload) => {
      onStored(payload);
    });
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    try {
      signal.addEventListener("abort", onAbort, { once: true });
      // aborted while subscribing: nothing was sent yet
      signal.throwIfAborted();
      await this.push(deviceId, reqJson, listTtlMs);
      this.nudge(deviceId, id);
      onStored(await this.redis.get(deviceResKey(id)));

      // wait until the result, the abort, or `giveUpAt`. The lease is checked every poll: its loss
      // caps `giveUpAt` at one grace from then (never extending it); a reconnect within that grace
      // restores the full wait, so a long command whose machine blipped keeps its deadline
      const fullGiveUpAt = Date.now() + deadlineMs + graceMs;
      let giveUpAt = fullGiveUpAt;
      let capped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          // a stalled Redis must not hold the give-up back: no answer in time means "unknown"
          const live = await this.leaseCheck(deviceId);
          if (fenced && live === true) {
            // a fenced request never waits across a reconnect: its answer was sized for this socket
            const now = await this.targets.current(deviceId);
            if (
              now &&
              (now.connectionId !== connection.connectionId ||
                now.maxFrameBytes !== connection.maxFrameBytes)
            ) {
              settle({ error: new DialInConnectionChangedError() });
              return;
            }
          }
          if (!fenced && sentToRun !== undefined && live === true) {
            // results a program keeps for a reconnect live in its memory: once the machine is
            // connected as another run, this request's result can never arrive (unless it was
            // stored before the old run went away, which the last look below still finds)
            const now = await this.targets.current(deviceId).catch(() => null);
            if (now?.programRunId !== undefined && now.programRunId !== sentToRun) {
              this.redis.get(deviceResKey(id)).then(
                (raw) =>
                  raw !== null
                    ? onStored(raw)
                    : settle({ error: new DeviceProgramRestartedError("the request") }),
                () => settle({ error: new DeviceProgramRestartedError("the request") }),
              );
              return;
            }
          }
          if (live === true && capped) {
            capped = false;
            giveUpAt = fullGiveUpAt;
          } else if (live === false && !capped) {
            capped = true;
            giveUpAt = Math.min(giveUpAt, Date.now() + graceMs);
          }
          if (live === false) {
            // a revoked machine or a deleted device never comes back: fail at once
            const gone = this.goneError(await this.targetState(deviceId));
            if (gone) {
              settle({ error: gone });
              return;
            }
          }
        } catch (e) {
          this.log.warn("device relay lease check failed", { deviceId, error: errMsg(e) });
        }
        if (stopped) return;
        if (Date.now() >= giveUpAt) {
          // a last look at the key: the publish may have been lost while the subscriber reconnected
          this.redis.get(deviceResKey(id)).then(
            (raw) => (raw !== null ? onStored(raw) : settle({ error: GRACE_EXPIRED })),
            () => settle({ error: GRACE_EXPIRED }),
          );
          return;
        }
        schedule();
      };
      const schedule = () => {
        if (stopped) return;
        const wait = Math.max(0, Math.min(HOLDER_POLL_MS, giveUpAt - Date.now()));
        timer = setTimeout(() => void tick(), wait);
      };
      schedule();

      const r = await outcome;
      stopped = true;
      clearTimeout(timer);
      if ("res" in r) {
        // the result's connection tag was checked in parseRes: a later reconnect changes nothing
        await this.quietly("delete the result", deviceId, () => this.redis.del(deviceResKey(id)));
        // only the gateway's marker says a request never reached the machine
        if (r.res.notSent !== undefined) throw new DeviceRequestNotSentError(r.res.notSent);
        return r.res.body;
      }
      if (r.error instanceof Error) {
        // a bad answer: drop it, give the request up, report the error
        await this.quietly("delete the result", deviceId, () => this.redis.del(deviceResKey(id)));
      }
      await this.giveUp(deviceId, id, reqJson, listTtlMs);
      if (r.error === ABORTED) throw signal.reason;
      if (r.error === GRACE_EXPIRED) throw new DeviceOfflineError(deviceId);
      throw r.error;
    } finally {
      stopped = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      await this.quietly("unsubscribe", deviceId, unsubscribe);
    }
  }

  /** {@link online}, or undefined when it takes longer than {@link LEASE_CHECK_TIMEOUT_MS}. */
  private async leaseCheck(deviceId: string): Promise<boolean | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const check = this.online(deviceId);
    check.catch(() => {}); // a late failure after the timeout is not unhandled
    try {
      return await Promise.race([
        check,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), LEASE_CHECK_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The device's state ({@link DeviceTargets}), or undefined when it cannot be read within
   * {@link LEASE_CHECK_TIMEOUT_MS} (a failure only logs: the caller keeps its other rules).
   */
  private async targetState(deviceId: string): Promise<DeviceTargetState | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const read = this.targets.state(deviceId);
    read.catch(() => {});
    try {
      return await Promise.race([
        read,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), LEASE_CHECK_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      this.log.warn("device relay could not read the device state", {
        deviceId,
        error: errMsg(e),
      });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The error of a state that never comes back; undefined for `active` or unknown. */
  private goneError(state: DeviceTargetState | undefined): ApiError | undefined {
    if (state === "deleted") return deviceNotFound();
    if (state === "revoked") return machineRevoked();
    return undefined;
  }

  private graceMs(): number {
    return this.config.get().devices.local.reconnectGraceSeconds * 1000;
  }

  private async push(deviceId: string, frame: string, ttlMs: number): Promise<void> {
    await this.redis.eval(PUSH_WITH_TTL, 1, deviceReqKey(deviceId), frame, String(ttlMs));
  }

  /** Announces new frames to the holder; a lost nudge is picked up on the holder's next drain. */
  private nudge(deviceId: string, id: string): void {
    this.bus.publish(deviceReqTopic(deviceId), { id }).catch((e: unknown) => {
      this.log.warn("device relay nudge failed", { deviceId, error: errMsg(e) });
    });
  }

  /** Removes the request from the list, or queues a cancel when the machine took it (R15). */
  private async giveUp(deviceId: string, id: string, reqJson: string, ttlMs: number) {
    const cancel: QueuedCancel = { type: "cancel", id };
    await this.quietly("give the request up", deviceId, async () => {
      const queued = await this.redis.eval(
        GIVE_UP,
        1,
        deviceReqKey(deviceId),
        reqJson,
        JSON.stringify(cancel),
        String(ttlMs),
      );
      if (queued === 1) this.nudge(deviceId, id);
    });
  }

  /** Runs a side step whose failure must not replace the call's outcome: logged, swallowed. */
  private async quietly(what: string, deviceId: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      this.log.warn(`device relay could not ${what}`, { deviceId, error: errMsg(e) });
    }
  }

  /**
   * A stored / published result for request `id` with the kernel's tags stripped
   * ({@link readStoredResult}), or the error it carries. A fenced request accepts only its own
   * connection's result.
   */
  private parseRes(
    raw: unknown,
    id: string,
    connection: DialInConnectionFence,
    fenced: boolean,
  ): Outcome {
    try {
      const r = readStoredResult(raw);
      if (r.id !== id) throw new Error("the gateway stored a result for another request");
      if (
        fenced &&
        (r.connection.connectionId !== connection.connectionId ||
          r.connection.maxFrameBytes !== connection.maxFrameBytes)
      )
        return { error: new DialInConnectionChangedError() };
      return { res: r };
    } catch (e) {
      return { error: new Error(`the device relay read an invalid result: ${errMsg(e)}`) };
    }
  }
}
