import { randomUUID } from "node:crypto";
import {
  type BindInstanceRequestV3,
  DEVICE_PROTOCOL_VERSION,
  type DeviceOp,
  type DeviceOperationV3,
  type DeviceOpResults,
  DeviceProtocolError,
  type DeviceResponseV3,
  type DeviceStopArgs,
  type ExtensionContext,
  FileSystemGoneError,
  type KernelReq,
  parseDeviceFrame,
  parseDeviceFrameV3,
  parseOperationResultV3,
  parseOpResult,
  SandboxGoneError,
  SandboxOperationOutcomeUnknownError,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
  STAGED_DEVICE_PROTOCOL_VERSION,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_BUS, KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { DeviceRequestNotSentError, isDeviceRequestNotSent } from "../sandbox/request-not-sent.js";
import { deviceNotFound } from "../sandbox/sandbox.service.js";
import {
  deviceLeaseKey,
  deviceReqKey,
  deviceReqTopic,
  deviceResKey,
  deviceResTopic,
} from "./keys.js";
import { type DeviceTargetState, DeviceTargets } from "./targets.js";

/** The device's connected machine is not connected (no replica holds its lease). */
export const deviceOffline = (): ApiError =>
  new ApiError(
    "device.offline",
    "The machine of this local device is offline. Start capybara-device on that machine, or pick another device.",
  );

/**
 * The device's machine was disconnected (revoked, signed out): 403 `device.forbidden`
 * with `details: [{ reason: "machine_revoked" }]`, so the tools tell the model what to ask for.
 */
export const machineRevoked = (): ApiError =>
  new ApiError(
    "device.forbidden",
    "The machine of this local device was disconnected. Run capybara-device logout, then capybara-device login on it, or pick another device.",
    [{ reason: "machine_revoked" }],
  );

/** The text a machine's `policy` refusal reaches the model with. */
export const POLICY_REFUSAL_PREFIX = "Refused by the machine's local policy: ";

/** The text a machine's `error` result reaches the model with (ruling R28). */
export const ON_MACHINE_PREFIX = "On the connected machine: ";

/**
 * The text of a staged (protocol 3) request refused because the machine's connection changed.
 * Only an output read has an offset to retry from; every other operation is simply retried.
 */
export const connectionChangedMessage = (op: string): string =>
  op === "backgroundReadOutput"
    ? "The machine's connection changed during the read; retry the read from the same offset"
    : `The machine's connection changed before ${op} was sent; retry the operation`;

export { DeviceRequestNotSentError, isDeviceRequestNotSent };

/**
 * The operations held under a stable operation identity (native, preparation and browsing
 * operations, execution, a background start and an operation revoke): their not-sent refusal is
 * typed ({@link DeviceRequestNotSentError}) so the operation path records it as definite. Exact
 * status, tail, stop and reads, the policy controls and binding keep their plain errors.
 */
const heldOperation = (op: string): boolean =>
  op === "backgroundStart" ||
  op === "revokeOperation" ||
  /^(?:exec|readFile|writeFile|stat|list|scan|prepare(?:ReadFile|WriteFile|Stat)|browse(?:Stat|List|Scan))$/.test(
    op,
  );

/**
 * Whether a staged operation's result is fenced to the connection its request was sent on.
 * Protocol 3 (spec B5) fences every request to its connection, so an old capacity is never used on
 * a replacement socket. For results, only an output read is fenced: its range was sized for the
 * old connection's capacity and an in-flight read that meets a reconnect fails so the reader
 * retries from the same offset. Every other operation keeps protocol 2's grace semantics: the
 * machine keeps it running across a socket blip and its result, validated by the gateway against
 * the capacity of the connection it arrived on, is accepted after a reconnect within the grace.
 */
const connectionFenced = (op: string): boolean => op === "backgroundReadOutput";

/**
 * The kernel-internal field of a queued `stop` naming the machine it is for (stripped by the holder
 * before the frame goes out; a frame for another machine is dropped).
 */
export const STOP_MACHINE = "machineId" as const;

/**
 * Whether the deployment speaks the staged device protocol: the single gate is the SDK's protocol
 * constant (flipped to 3 at the paired activation). Until then the active wire stays protocol 2.
 */
export const stagedDeviceProtocolActive = (): boolean =>
  (DEVICE_PROTOCOL_VERSION as number) === STAGED_DEVICE_PROTOCOL_VERSION;

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

type Outcome =
  /**
   * `connectionId`: the connection a staged result arrived on (tagged by the gateway). `notSent`:
   * the gateway's own marker that the request never reached the machine.
   */
  | { res: DeviceResponseV3; connectionId?: string; notSent?: true }
  | { error: typeof ABORTED | typeof GRACE_EXPIRED | Error };

/**
 * The kernel-internal fields the gateway adds to what it stores for a staged result, next to the
 * device's frame: the connection it arrived on, that connection's capacity and, only on the
 * gateway's own refusal of a request queued for another connection, {@link GATEWAY_NOT_SENT}. The
 * device's frame is parsed strictly (unknown keys refused), so a device can never set them.
 */
export const GATEWAY_NOT_SENT = "notSent" as const;

/**
 * A staged request refused because it was not sent, outside the operations held under an operation
 * identity (a policy control, a status read): a protocol error that also says nothing ran, so a
 * caller can record it as never received instead of unknown ({@link wasDeviceRequestNotSent}).
 */
export class DeviceRequestNotSentProtocolError extends DeviceProtocolError {
  readonly notSent = true as const;
}

/** Any staged request the kernel knows was never sent to the machine (held or not). */
export const wasDeviceRequestNotSent = (e: unknown): boolean =>
  e instanceof Error && (e as { notSent?: unknown }).notSent === true;

/** The not-sent refusal of `op`: typed for held operations, a not-sent protocol error otherwise. */
const notSentError = (op: string): Error =>
  heldOperation(op)
    ? new DeviceRequestNotSentError(connectionChangedMessage(op))
    : new DeviceRequestNotSentProtocolError(connectionChangedMessage(op));

export interface DeviceCallOptions {
  /** How long the machine may take for the operation (sent to it as `deadlineMs`). */
  deadlineMs: number;
  /** The caller's signal: aborting gives the request up and rejects. */
  signal: AbortSignal;
  /** Internal authenticated lease/capacity fence; never part of caller operation arguments. */
  connection?: { connectionId: string; maxFrameBytes: number };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The caller side of the device relay (environments spec §13.4). A request goes onto the
 * device's Redis list (`capk:device-req:<deviceId>`) and is announced on
 * `device.req.<deviceId>`; whichever gateway replica holds the machine's lease drains the
 * list and forwards the frames to the machine.
 *
 * **The holder's half of the wire** (Task 6 follows it): items on the list are `KernelReq` or
 * `KernelCancel` frames as JSON text, to be parsed with `parseDeviceFrame(item, "kernel")`; the
 * nudge's payload is `{ id }`. For each `res` frame the machine sends, the holder writes the frame
 * (the JSON text as validated by `parseDeviceFrame(…, "device")`) under
 * `capk:device-res:<requestId>` with a TTL and publishes the same frame object on
 * `device.res.<requestId>`.
 *
 * The caller subscribes to its result topic before pushing and reads the result key once after,
 * and once more before giving up (the run-abort pattern; a publish lost while the subscriber
 * reconnects is still found). It waits within its own call for at most `deadlineMs` plus
 * `devices.local.reconnectGraceSeconds`; when the lease disappears meanwhile (checked every
 * {@link HOLDER_POLL_MS}) the wait ends at most one grace later. A result produced while the
 * machine was disconnected arrives after it reconnects. Giving up (grace, abort, a bad result)
 * removes the request from the list, or queues a `cancel` when the machine already took it
 * (ruling R15). Nothing is kept in process memory beyond the call.
 */
@Injectable()
export class LocalDeviceRelay {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KERNEL_BUS) private readonly bus: ExtensionContext["bus"],
    @Inject(LockService) private readonly locks: Pick<LockService, "holderOf">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Inject(DeviceTargets) private readonly targets: Pick<DeviceTargets, "state" | "transport">,
  ) {}

  /** Whether a gateway replica holds the machine's connection now. */
  async holderLive(deviceId: string): Promise<boolean> {
    return (await this.locks.holderOf(deviceLeaseKey(deviceId))) !== null;
  }

  /**
   * Whether the protocol gate is open ({@link stagedDeviceProtocolActive}; a test seam opens it
   * for one relay instance, the deployment never does).
   */
  stagedProtocolActive: () => boolean = stagedDeviceProtocolActive;

  /**
   * The negotiated transport of the device's connection when the platform's own controls (policy
   * ops) must speak protocol 3 to it, else null (protocol 2). With the gate closed every
   * connection is protocol 2: nothing is looked up (no lease or transport read per op). With it
   * open every connection is staged, so this is {@link connection} (a missing or unready one
   * throws its typed error).
   */
  async stagedTransport(
    deviceId: string,
  ): Promise<{ connectionId: string; maxFrameBytes: number } | null> {
    if (!this.stagedProtocolActive()) return null;
    return this.connection(deviceId);
  }

  /**
   * The negotiated transport of the machine's current connection, for a staged call. Liveness is
   * checked first (ruling R27): no holder throws `device.not_found` for a deleted device,
   * `device.forbidden` for a revoked machine and `device.offline` otherwise.
   */
  async connection(deviceId: string): Promise<{ connectionId: string; maxFrameBytes: number }> {
    if (await this.holderLive(deviceId)) {
      const transport = await this.targets.transport(deviceId);
      if (transport) return transport;
    }
    throw this.goneError(await this.targetState(deviceId)) ?? deviceOffline();
  }

  /**
   * Queues `stop` for the machine without waiting for an answer (ruling R14). The caller checks
   * {@link holderLive} first; the frame waits on the list for the grace like any request. It is
   * fenced to the machine `machineId` ({@link STOP_MACHINE}): a holder hands it only to that
   * machine's connection (on a staged connection as a protocol 3 `stop`, across a socket blip
   * too), never to a newer machine of the device. Only `stop` is ever queued this way: a broad
   * kill (`killAll` / `killTagged`) has no frame on protocol 3.
   */
  async send(
    deviceId: string,
    op: "stop",
    args: DeviceStopArgs,
    deadlineMs: number,
    machineId: string,
  ): Promise<void> {
    const id = randomUUID();
    const d = Math.max(1, Math.ceil(deadlineMs));
    const req: KernelReq = { type: "req", id, op, args, deadlineMs: d };
    const tagged = { ...req, [STOP_MACHINE]: machineId };
    await this.push(deviceId, JSON.stringify(tagged), this.graceMs() + d + LIST_TTL_MARGIN_MS);
    await this.bus.publish(deviceReqTopic(deviceId), { id });
  }

  /**
   * Runs `op` on the device's machine and returns its validated result. Throws
   * `device.offline` when no replica holds the machine at send time or when the wait ran
   * out, but `device.forbidden` ({@link machineRevoked}) when the machine was revoked and
   * `device.not_found` when the device was deleted (checked whenever the connection is
   * missing, ruling R27); the machine's failures map to `SandboxGoneError` (`gone`),
   * `FileSystemGoneError` (`fs_gone`) or a `ToolError` (`policy`, and `error` prefixed
   * {@link ON_MACHINE_PREFIX}); an invalid answer throws a `DeviceProtocolError`. On abort the
   * abort reason is thrown.
   */
  async call<Op extends DeviceOp>(
    deviceId: string,
    op: Op,
    args: unknown,
    opts: DeviceCallOptions,
  ): Promise<DeviceOpResults[Op]> {
    return this.callWithCodec(deviceId, op, args, opts, false) as Promise<DeviceOpResults[Op]>;
  }

  /** Development staging: the active gateway continues rejecting protocol 3 until coordinated cutover. */
  async callV3(
    deviceId: string,
    op: DeviceOperationV3,
    args: Record<string, unknown>,
    opts: DeviceCallOptions,
  ): Promise<unknown> {
    parseDeviceFrameV3(
      JSON.stringify({ type: "req", id: "validation", op, args, deadlineMs: opts.deadlineMs }),
      "kernel",
    );
    return this.callWithCodec(deviceId, op, args, opts, true);
  }
  private async callWithCodec(
    deviceId: string,
    op: DeviceOperationV3 | DeviceOp,
    args: unknown,
    opts: DeviceCallOptions,
    staged: boolean,
  ): Promise<unknown> {
    const { signal } = opts;
    signal.throwIfAborted();
    // liveness first: a deleted device or a revoked machine keeps its typed error (R27)
    const connection = staged ? await this.connection(deviceId) : undefined;
    if (!staged && !(await this.holderLive(deviceId))) {
      throw this.goneError(await this.targetState(deviceId)) ?? deviceOffline();
    }
    if (
      opts.connection &&
      (connection?.connectionId !== opts.connection.connectionId ||
        connection?.maxFrameBytes !== opts.connection.maxFrameBytes)
    )
      // nothing was queued: the request was definitely not sent
      throw notSentError(op);
    const fenced = staged && connectionFenced(op);
    signal.throwIfAborted();

    const id = randomUUID();
    const deadlineMs = Math.max(1, Math.ceil(opts.deadlineMs));
    const graceMs = this.graceMs();
    const listTtlMs = graceMs + deadlineMs + LIST_TTL_MARGIN_MS;
    const frame = { type: "req", id, op, args, deadlineMs };
    if (connection) parseDeviceFrameV3(JSON.stringify(frame), "kernel", connection.maxFrameBytes);
    const reqJson = JSON.stringify({ ...frame, ...connection });

    let settle!: (r: Outcome) => void;
    const outcome = new Promise<Outcome>((resolve) => {
      let done = false;
      settle = (r) => {
        if (done) return;
        done = true;
        resolve(r);
      };
    });
    const onStored = (raw: string | null) => {
      if (raw !== null) settle(this.parseRes(raw, id, op, connection, fenced));
    };
    const onAbort = () => settle({ error: ABORTED });

    const unsubscribe = await this.bus.subscribe(deviceResTopic(id), (payload) => {
      onStored(JSON.stringify(payload));
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
          if (fenced && connection && live === true) {
            // an output read never waits across a reconnect: its range was sized for this socket
            const current = await this.targets.transport(deviceId);
            if (
              current &&
              (current.connectionId !== connection.connectionId ||
                current.maxFrameBytes !== connection.maxFrameBytes)
            ) {
              settle({ error: new DeviceProtocolError(connectionChangedMessage(op)) });
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
        // only the gateway's marker says a request never reached the machine: never its text
        if (connection && r.notSent) throw notSentError(op);
        return staged && r.res.ok
          ? parseOperationResultV3(
              op as DeviceOperationV3,
              r.res.result,
              op === "backgroundReadOutput"
                ? (args as { offset: number; maxBytes: number })
                : op === "bindInstance"
                  ? (args as BindInstanceRequestV3)
                  : undefined,
            )
          : this.resultOf(op as DeviceOp, r.res);
      }
      if (r.error instanceof Error) {
        // a bad answer: drop it, give the request up, report the protocol error
        await this.quietly("delete the result", deviceId, () => this.redis.del(deviceResKey(id)));
      }
      await this.giveUp(deviceId, id, reqJson, listTtlMs, connection);
      if (r.error === ABORTED) throw signal.reason;
      if (r.error === GRACE_EXPIRED) throw deviceOffline();
      throw r.error;
    } finally {
      stopped = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      await this.quietly("unsubscribe", deviceId, unsubscribe);
    }
  }

  /** {@link holderLive}, or undefined when it takes longer than {@link LEASE_CHECK_TIMEOUT_MS}. */
  private async leaseCheck(deviceId: string): Promise<boolean | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const check = this.holderLive(deviceId);
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
  private async giveUp(
    deviceId: string,
    id: string,
    reqJson: string,
    ttlMs: number,
    connection?: { connectionId: string; maxFrameBytes: number },
  ): Promise<void> {
    const cancel = JSON.stringify({ type: "cancel", id, ...connection });
    await this.quietly("give the request up", deviceId, async () => {
      const queued = await this.redis.eval(
        GIVE_UP,
        1,
        deviceReqKey(deviceId),
        reqJson,
        cancel,
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
   * A stored / published `res` frame for request `id`, or the protocol error it carries. A staged
   * frame carries the tag of the connection it arrived on (added by the gateway); a fenced
   * operation ({@link connectionFenced}) accepts only its request's connection, any other staged
   * operation a well-formed tag, and the frame is parsed against that connection's capacity.
   */
  private parseRes(
    raw: string,
    id: string,
    op: string,
    connection?: { connectionId: string; maxFrameBytes: number },
    fenced = false,
  ): Outcome {
    try {
      let wire = raw;
      let cap: number | undefined;
      let arrivedOn: string | undefined;
      let notSent = false;
      if (connection) {
        const {
          connectionId,
          maxFrameBytes,
          [GATEWAY_NOT_SENT]: marker,
          ...frame
        } = JSON.parse(raw) as Record<string, unknown>;
        if (
          typeof connectionId !== "string" ||
          connectionId === "" ||
          typeof maxFrameBytes !== "number" ||
          !Number.isSafeInteger(maxFrameBytes) ||
          maxFrameBytes < 1024
        )
          throw new DeviceProtocolError("the gateway stored a result without its connection");
        if (
          fenced &&
          (connectionId !== connection.connectionId || maxFrameBytes !== connection.maxFrameBytes)
        )
          throw new DeviceProtocolError(connectionChangedMessage(op));
        cap = maxFrameBytes;
        arrivedOn = connectionId;
        notSent = marker === true;
        wire = JSON.stringify(frame);
      }
      const f = connection
        ? parseDeviceFrameV3(wire, "device", cap)
        : parseDeviceFrame(wire, "device");
      if (f.type !== "res" || f.id !== id) {
        return { error: new DeviceProtocolError("the connected machine sent an unexpected frame") };
      }
      if (arrivedOn === undefined) return { res: f };
      // a refusal only: a successful result never carries the marker
      return notSent && !f.ok
        ? { res: f, connectionId: arrivedOn, notSent: true }
        : { res: f, connectionId: arrivedOn };
    } catch (e) {
      return {
        error:
          e instanceof DeviceProtocolError
            ? e
            : new DeviceProtocolError(`the connected machine sent an invalid frame: ${errMsg(e)}`),
      };
    }
  }

  private resultOf<Op extends DeviceOp>(op: Op, res: DeviceResponseV3): DeviceOpResults[Op] {
    if (res.ok) {
      try {
        return parseOpResult(op, res.result);
      } catch (e) {
        throw new DeviceProtocolError(
          `The connected machine sent an invalid ${op} result: ${errMsg(e)}`,
        );
      }
    }
    const { kind, message } = res.error;
    switch (kind) {
      case "denied":
        throw new SandboxScopeDeniedError(message);
      case "unsupported":
        throw new SandboxPermissionUnsupportedError(message);
      case "unknown":
        throw new SandboxOperationOutcomeUnknownError(message);
      case "gone":
        throw new SandboxGoneError(message);
      case "fs_gone":
        throw new FileSystemGoneError(message);
      case "policy":
        throw new ToolError(`${POLICY_REFUSAL_PREFIX}${message}`);
      default:
        throw new ToolError(`${ON_MACHINE_PREFIX}${message}`);
    }
  }
}
