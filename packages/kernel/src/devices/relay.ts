import { randomUUID } from "node:crypto";
import {
  type DeviceOp,
  type DeviceOpResults,
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
import { KERNEL_BUS, REDIS } from "../infra/tokens.js";
import {
  deviceLeaseKey,
  deviceReqKey,
  deviceReqTopic,
  deviceResKey,
  deviceResTopic,
} from "./keys.js";

/** The environment's connected machine is not connected (no replica holds its lease). */
export const environmentOffline = (): ApiError =>
  new ApiError(
    "environment.offline",
    "The connected machine of this environment is offline. Start capybara-device on that machine, or pick another environment.",
  );

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

/** Why a call stopped waiting without a result. */
const ABORTED = Symbol("aborted");
const GRACE_EXPIRED = Symbol("grace expired");

export interface DeviceCallOptions {
  /** How long the machine may take for the operation (sent to it as `deadlineMs`). */
  deadlineMs: number;
  /** The caller's signal: aborting queues a `cancel` for the request and rejects. */
  signal: AbortSignal;
}

/**
 * The caller side of the device relay (environments spec §13.4). A request goes onto the
 * environment's Redis list (`capk:device-req:<environmentId>`) and is announced on
 * `device.req.<environmentId>`; whichever gateway replica holds the machine's lease drains the
 * list and forwards the frames to the machine.
 *
 * **The holder's half of the wire** (Task 6 follows it): items on the list are `KernelReq` or
 * `KernelCancel` frames as JSON text, to be parsed with `parseDeviceFrame(item, "kernel")`. For
 * each `res` frame the machine sends, the holder writes the frame (the JSON text as validated by
 * `parseDeviceFrame(…, "device")`) under `capk:device-res:<requestId>` with a TTL and publishes
 * the same frame object on `device.res.<requestId>`.
 *
 * The caller subscribes to its result topic before pushing and reads the result key once after,
 * and once more before giving up (the run-abort pattern; a publish lost while the subscriber
 * reconnects is still found). It waits within its own call for at most `deadlineMs` plus
 * `environments.device.reconnectGraceSeconds`: a result produced while the machine was
 * disconnected arrives after it reconnects. Nothing is kept in process memory beyond the call.
 */
@Injectable()
export class DeviceRelay {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KERNEL_BUS) private readonly bus: ExtensionContext["bus"],
    @Inject(LockService) private readonly locks: Pick<LockService, "holderOf">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
  ) {}

  /** Whether a gateway replica holds the machine's connection now. */
  async holderLive(environmentId: string): Promise<boolean> {
    return (await this.locks.holderOf(deviceLeaseKey(environmentId))) !== null;
  }

  /**
   * Runs `op` on the environment's machine and returns its validated result. Throws
   * `environment.offline` when no replica holds the machine at send time or when the grace ran
   * out; the machine's failures map to `SandboxGoneError` (`gone`), `FileSystemGoneError`
   * (`fs_gone`), a `ToolError` (`policy`) or an `Error` (`error`). On abort or grace expiry a
   * `cancel` for the request is queued (delivered on the machine's next connect).
   */
  async call<Op extends DeviceOp>(
    environmentId: string,
    op: Op,
    args: unknown,
    opts: DeviceCallOptions,
  ): Promise<DeviceOpResults[Op]> {
    const { signal } = opts;
    signal.throwIfAborted();
    if (!(await this.holderLive(environmentId))) throw environmentOffline();
    signal.throwIfAborted();

    const id = randomUUID();
    const deadlineMs = Math.max(1, Math.ceil(opts.deadlineMs));
    const graceMs = this.config.get().environments.device.reconnectGraceSeconds * 1000;
    const listTtlMs = graceMs + deadlineMs;
    const req: KernelReq = { type: "req", id, op, args, deadlineMs };

    let settle!: (r: { res: DeviceRes } | { error: unknown }) => void;
    const outcome = new Promise<{ res: DeviceRes } | { error: unknown }>((resolve) => {
      let done = false;
      settle = (r) => {
        if (done) return;
        done = true;
        resolve(r);
      };
    });
    const onStored = (raw: string | null) => {
      if (raw === null) return;
      settle(this.parseRes(raw, id));
    };

    const unsubscribe = await this.bus.subscribe(deviceResTopic(id), (payload) => {
      onStored(JSON.stringify(payload));
    });
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => settle({ error: ABORTED });
    try {
      signal.addEventListener("abort", onAbort, { once: true });
      // aborted while subscribing: nothing was sent yet
      signal.throwIfAborted();
      await this.push(environmentId, req, listTtlMs);
      await this.bus.publish(deviceReqTopic(environmentId), { id });
      onStored(await this.redis.get(deviceResKey(id)));
      timer = setTimeout(() => {
        // a last look at the key: the publish may have been lost while the subscriber reconnected
        this.redis.get(deviceResKey(id)).then(
          (raw) => (raw !== null ? onStored(raw) : settle({ error: GRACE_EXPIRED })),
          () => settle({ error: GRACE_EXPIRED }),
        );
      }, deadlineMs + graceMs);

      const r = await outcome;
      if ("res" in r) {
        await this.redis.del(deviceResKey(id)).catch(() => {});
        return this.resultOf(op, r.res);
      }
      if (r.error === ABORTED || r.error === GRACE_EXPIRED) {
        await this.push(environmentId, { type: "cancel", id } satisfies KernelCancel, listTtlMs);
        await this.bus.publish(deviceReqTopic(environmentId), { id });
        if (r.error === ABORTED) throw signal.reason;
        throw environmentOffline();
      }
      throw r.error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      await unsubscribe();
    }
  }

  private async push(
    environmentId: string,
    frame: KernelReq | KernelCancel,
    ttlMs: number,
  ): Promise<void> {
    await this.redis.eval(
      PUSH_WITH_TTL,
      1,
      deviceReqKey(environmentId),
      JSON.stringify(frame),
      String(ttlMs),
    );
  }

  /** A stored / published `res` frame for request `id`, or the protocol error it carries. */
  private parseRes(raw: string, id: string): { res: DeviceRes } | { error: unknown } {
    try {
      const f = parseDeviceFrame(raw, "device");
      if (f.type !== "res" || f.id !== id) {
        return { error: new Error(`the connected machine answered with an unexpected frame`) };
      }
      return { res: f };
    } catch (e) {
      return { error: e };
    }
  }

  private resultOf<Op extends DeviceOp>(op: Op, res: DeviceRes): DeviceOpResults[Op] {
    if (res.ok) {
      try {
        return parseOpResult(op, res.result);
      } catch (e) {
        throw new Error(
          `The connected machine sent an invalid ${op} result: ${e instanceof Error ? e.message : String(e)}`,
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
        throw new Error(message);
    }
  }
}
