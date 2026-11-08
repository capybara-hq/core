import { randomUUID } from "node:crypto";
import {
  type DeviceOp,
  type DeviceOpResults,
  DeviceProtocolError,
  type DeviceRes,
  type ExtensionContext,
  FileSystemGoneError,
  type KernelCancel,
  type KernelReq,
  parseDeviceFrame,
  parseOpResult,
  SandboxGoneError,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_BUS, KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { environmentNotFound } from "../sandbox/sandbox.service.js";
import {
  deviceLeaseKey,
  deviceReqKey,
  deviceReqTopic,
  deviceResKey,
  deviceResTopic,
} from "./keys.js";
import { type DeviceTargetState, DeviceTargets } from "./targets.js";

/** The environment's connected machine is not connected (no replica holds its lease). */
export const environmentOffline = (): ApiError =>
  new ApiError(
    "environment.offline",
    "The connected machine of this environment is offline. Start capybara-device on that machine, or pick another environment.",
  );

/**
 * The environment's machine was disconnected (revoked, signed out): 403 `environment.forbidden`
 * with `details: [{ reason: "machine_revoked" }]`, so the tools tell the model what to ask for.
 */
export const machineRevoked = (): ApiError =>
  new ApiError(
    "environment.forbidden",
    "The connected machine of this environment was disconnected. Sign it in again with capybara-device login, or pick another environment.",
    [{ reason: "machine_revoked" }],
  );

/** The text a machine's `error` result reaches the model with (ruling R28). */
export const ON_MACHINE_PREFIX = "On the connected machine: ";

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

type Outcome = { res: DeviceRes } | { error: typeof ABORTED | typeof GRACE_EXPIRED | Error };

export interface DeviceCallOptions {
  /** How long the machine may take for the operation (sent to it as `deadlineMs`). */
  deadlineMs: number;
  /** The caller's signal: aborting gives the request up and rejects. */
  signal: AbortSignal;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The caller side of the device relay (environments spec §13.4). A request goes onto the
 * environment's Redis list (`capk:device-req:<environmentId>`) and is announced on
 * `device.req.<environmentId>`; whichever gateway replica holds the machine's lease drains the
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
 * `environments.device.reconnectGraceSeconds`; when the lease disappears meanwhile (checked every
 * {@link HOLDER_POLL_MS}) the wait ends at most one grace later. A result produced while the
 * machine was disconnected arrives after it reconnects. Giving up (grace, abort, a bad result)
 * removes the request from the list, or queues a `cancel` when the machine already took it
 * (ruling R15). Nothing is kept in process memory beyond the call.
 */
@Injectable()
export class DeviceRelay {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KERNEL_BUS) private readonly bus: ExtensionContext["bus"],
    @Inject(LockService) private readonly locks: Pick<LockService, "holderOf">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Inject(DeviceTargets) private readonly targets: Pick<DeviceTargets, "state">,
  ) {}

  /** Whether a gateway replica holds the machine's connection now. */
  async holderLive(environmentId: string): Promise<boolean> {
    return (await this.locks.holderOf(deviceLeaseKey(environmentId))) !== null;
  }

  /**
   * Queues `op` for the machine without waiting for an answer (ruling R14: `stop`). The caller
   * checks {@link holderLive} first; the frame waits on the list for the grace like any request.
   */
  async send(
    environmentId: string,
    op: DeviceOp,
    args: unknown,
    deadlineMs: number,
  ): Promise<void> {
    const id = randomUUID();
    const d = Math.max(1, Math.ceil(deadlineMs));
    const req: KernelReq = { type: "req", id, op, args, deadlineMs: d };
    await this.push(environmentId, JSON.stringify(req), this.graceMs() + d + LIST_TTL_MARGIN_MS);
    await this.bus.publish(deviceReqTopic(environmentId), { id });
  }

  /**
   * Runs `op` on the environment's machine and returns its validated result. Throws
   * `environment.offline` when no replica holds the machine at send time or when the wait ran
   * out, but `environment.forbidden` ({@link machineRevoked}) when the machine was revoked and
   * `environment.not_found` when the environment was deleted (checked whenever the connection is
   * missing, ruling R27); the machine's failures map to `SandboxGoneError` (`gone`),
   * `FileSystemGoneError` (`fs_gone`) or a `ToolError` (`policy`, and `error` prefixed
   * {@link ON_MACHINE_PREFIX}); an invalid answer throws a `DeviceProtocolError`. On abort the
   * abort reason is thrown.
   */
  async call<Op extends DeviceOp>(
    environmentId: string,
    op: Op,
    args: unknown,
    opts: DeviceCallOptions,
  ): Promise<DeviceOpResults[Op]> {
    const { signal } = opts;
    signal.throwIfAborted();
    if (!(await this.holderLive(environmentId))) {
      throw this.goneError(await this.targetState(environmentId)) ?? environmentOffline();
    }
    signal.throwIfAborted();

    const id = randomUUID();
    const deadlineMs = Math.max(1, Math.ceil(opts.deadlineMs));
    const graceMs = this.graceMs();
    const listTtlMs = graceMs + deadlineMs + LIST_TTL_MARGIN_MS;
    const reqJson = JSON.stringify({ type: "req", id, op, args, deadlineMs } satisfies KernelReq);

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
      if (raw !== null) settle(this.parseRes(raw, id));
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
      await this.push(environmentId, reqJson, listTtlMs);
      this.nudge(environmentId, id);
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
          const live = await this.leaseCheck(environmentId);
          if (live === true && capped) {
            capped = false;
            giveUpAt = fullGiveUpAt;
          } else if (live === false && !capped) {
            capped = true;
            giveUpAt = Math.min(giveUpAt, Date.now() + graceMs);
          }
          if (live === false) {
            // a revoked machine or a deleted environment never comes back: fail at once
            const gone = this.goneError(await this.targetState(environmentId));
            if (gone) {
              settle({ error: gone });
              return;
            }
          }
        } catch (e) {
          this.log.warn("device relay lease check failed", { environmentId, error: errMsg(e) });
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
        await this.quietly("delete the result", environmentId, () =>
          this.redis.del(deviceResKey(id)),
        );
        return this.resultOf(op, r.res);
      }
      if (r.error instanceof Error) {
        // a bad answer: drop it, give the request up, report the protocol error
        await this.quietly("delete the result", environmentId, () =>
          this.redis.del(deviceResKey(id)),
        );
      }
      await this.giveUp(environmentId, id, reqJson, listTtlMs);
      if (r.error === ABORTED) throw signal.reason;
      if (r.error === GRACE_EXPIRED) throw environmentOffline();
      throw r.error;
    } finally {
      stopped = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      await this.quietly("unsubscribe", environmentId, unsubscribe);
    }
  }

  /** {@link holderLive}, or undefined when it takes longer than {@link LEASE_CHECK_TIMEOUT_MS}. */
  private async leaseCheck(environmentId: string): Promise<boolean | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const check = this.holderLive(environmentId);
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
   * The environment's state ({@link DeviceTargets}), or undefined when it cannot be read within
   * {@link LEASE_CHECK_TIMEOUT_MS} (a failure only logs: the caller keeps its other rules).
   */
  private async targetState(environmentId: string): Promise<DeviceTargetState | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const read = this.targets.state(environmentId);
    read.catch(() => {});
    try {
      return await Promise.race([
        read,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), LEASE_CHECK_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      this.log.warn("device relay could not read the environment state", {
        environmentId,
        error: errMsg(e),
      });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The error of a state that never comes back; undefined for `active` or unknown. */
  private goneError(state: DeviceTargetState | undefined): ApiError | undefined {
    if (state === "deleted") return environmentNotFound();
    if (state === "revoked") return machineRevoked();
    return undefined;
  }

  private graceMs(): number {
    return this.config.get().environments.device.reconnectGraceSeconds * 1000;
  }

  private async push(environmentId: string, frame: string, ttlMs: number): Promise<void> {
    await this.redis.eval(PUSH_WITH_TTL, 1, deviceReqKey(environmentId), frame, String(ttlMs));
  }

  /** Announces new frames to the holder; a lost nudge is picked up on the holder's next drain. */
  private nudge(environmentId: string, id: string): void {
    this.bus.publish(deviceReqTopic(environmentId), { id }).catch((e: unknown) => {
      this.log.warn("device relay nudge failed", { environmentId, error: errMsg(e) });
    });
  }

  /** Removes the request from the list, or queues a cancel when the machine took it (R15). */
  private async giveUp(
    environmentId: string,
    id: string,
    reqJson: string,
    ttlMs: number,
  ): Promise<void> {
    const cancel = JSON.stringify({ type: "cancel", id } satisfies KernelCancel);
    await this.quietly("give the request up", environmentId, async () => {
      const queued = await this.redis.eval(
        GIVE_UP,
        1,
        deviceReqKey(environmentId),
        reqJson,
        cancel,
        String(ttlMs),
      );
      if (queued === 1) this.nudge(environmentId, id);
    });
  }

  /** Runs a side step whose failure must not replace the call's outcome: logged, swallowed. */
  private async quietly(what: string, environmentId: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      this.log.warn(`device relay could not ${what}`, { environmentId, error: errMsg(e) });
    }
  }

  /** A stored / published `res` frame for request `id`, or the protocol error it carries. */
  private parseRes(raw: string, id: string): Outcome {
    try {
      const f = parseDeviceFrame(raw, "device");
      if (f.type !== "res" || f.id !== id) {
        return { error: new DeviceProtocolError("the connected machine sent an unexpected frame") };
      }
      return { res: f };
    } catch (e) {
      return {
        error:
          e instanceof DeviceProtocolError
            ? e
            : new DeviceProtocolError(`the connected machine sent an invalid frame: ${errMsg(e)}`),
      };
    }
  }

  private resultOf<Op extends DeviceOp>(op: Op, res: DeviceRes): DeviceOpResults[Op] {
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
      case "gone":
        throw new SandboxGoneError(message);
      case "fs_gone":
        throw new FileSystemGoneError(message);
      case "policy":
        throw new ToolError(`Refused by the machine's local policy: ${message}`);
      default:
        throw new ToolError(`${ON_MACHINE_PREFIX}${message}`);
    }
  }
}
