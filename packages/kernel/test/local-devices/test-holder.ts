import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import type {
  DeviceErrorKind,
  KernelCancel,
  KernelReq,
} from "@capybara-hq/plugin-sdk/device-protocol";
import type { Redis } from "ioredis";
import { storedResult } from "../../src/dial-in/envelope.js";
import {
  deviceLeaseKey,
  deviceReqKey,
  deviceReqTopic,
  deviceResKey,
  deviceResTopic,
  deviceTransportKey,
} from "../../src/dial-in/keys.js";

/** The machine's answer to one request: a result, an error, or nothing (the test answers later). */
export type Answer =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: {
        kind: DeviceErrorKind | "denied" | "unsupported" | "unsettled" | "unknown" | "invalid";
        message: string;
      };
    }
  | undefined;

/** A queued `stop` as the holder pops it (the machine it is fenced to kept). */
export interface QueuedStopFrame {
  type: "stop";
  reason: "drain" | "stop";
  machineId?: string;
}

/** What a {@link TestHolder} records. */
export type HeldFrame = KernelReq | KernelCancel | QueuedStopFrame;

/** The lease token and connection a {@link TestHolder} holds. */
export const TEST_HOLDER_TOKEN = "test-holder";
export const TEST_HOLDER_CONNECTION = {
  connectionId: "test-holder-connection",
  maxFrameBytes: 69632,
};

/**
 * A stand-in for the gateway replica that holds a machine's connection: it claims the lease and
 * publishes its connection (as the gateway does after a hello), drains the request list on every
 * nudge, and stores results the way the real holder does (`SET capk:device-res:<id> PX`, then
 * `PUBLISH device.res.<id>`, tagged with the connection: `dial-in/envelope.ts`). Requests are
 * recorded as their body's `op` and `args` (the `capybara-device` body).
 */
export class TestHolder {
  readonly frames: HeldFrame[] = [];
  private unsubscribe: (() => Promise<void>) | undefined;
  private waiters: {
    pred: (f: HeldFrame) => boolean;
    resolve: (f: HeldFrame) => void;
  }[] = [];

  constructor(
    private readonly redis: Redis,
    private readonly bus: ExtensionContext["bus"],
    readonly deviceId: string,
    private readonly answer: (req: KernelReq) => Answer = () => undefined,
    private readonly resultTtlMs = 60_000,
  ) {}

  /** Takes the lease, publishes its connection and starts serving (drains what is queued). */
  async connect(): Promise<void> {
    await this.redis.set(deviceLeaseKey(this.deviceId), TEST_HOLDER_TOKEN, "PX", 60_000);
    await this.redis.set(
      deviceTransportKey(this.deviceId, TEST_HOLDER_TOKEN),
      JSON.stringify(TEST_HOLDER_CONNECTION),
      "PX",
      60_000,
    );
    this.unsubscribe = await this.bus.subscribe(deviceReqTopic(this.deviceId), () => {
      void this.drain();
    });
    await this.drain();
  }

  /** Drops the connection: releases the lease and stops draining. */
  async disconnect(): Promise<void> {
    await this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.redis.del(deviceLeaseKey(this.deviceId));
    await this.redis.del(deviceTransportKey(this.deviceId, TEST_HOLDER_TOKEN));
  }

  /** Waits for a frame matching `pred` (already received or still to come). */
  next<F extends HeldFrame = KernelReq | KernelCancel>(
    pred: (f: HeldFrame) => boolean = () => true,
  ): Promise<F> {
    const seen = this.frames.find(pred);
    if (seen) return Promise.resolve(seen as F);
    return new Promise((resolve) => this.waiters.push({ pred, resolve: (f) => resolve(f as F) }));
  }

  /** Stores and publishes the result of request `id` (its body `answer`), like the real holder. */
  async respond(
    id: string,
    answer: NonNullable<Answer>,
    opts: { publish?: boolean } = {},
  ): Promise<void> {
    const frame = storedResult({ id, body: answer }, TEST_HOLDER_CONNECTION);
    await this.redis.set(deviceResKey(id), JSON.stringify(frame), "PX", this.resultTtlMs);
    if (opts.publish !== false) await this.bus.publish(deviceResTopic(id), frame);
  }

  private async drain(): Promise<void> {
    for (;;) {
      const raw = await this.redis.lpop(deviceReqKey(this.deviceId));
      if (raw === null) return;
      const q = JSON.parse(raw) as {
        type: string;
        id: string;
        deadlineMs?: number;
        body?: { op: KernelReq["op"]; args: unknown };
        reason?: "drain" | "stop";
        machineId?: string;
      };
      const f: HeldFrame =
        q.type === "stop"
          ? {
              type: "stop",
              reason: q.reason ?? "stop",
              ...(q.machineId !== undefined && { machineId: q.machineId }),
            }
          : q.type === "req"
            ? {
                type: "req",
                id: q.id,
                op: q.body?.op as KernelReq["op"],
                args: q.body?.args,
                deadlineMs: Number(q.deadlineMs),
              }
            : { type: "cancel", id: q.id };
      this.frames.push(f);
      for (const w of [...this.waiters]) {
        if (w.pred(f)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(f);
        }
      }
      if (f.type === "req") {
        const a = this.answer(f);
        if (a !== undefined) await this.respond(f.id, a);
      }
    }
  }
}

/**
 * A stand-in for `DialInRelay.request` answering a `capybara-device` request body `{ op, args }`
 * with `fn`'s result as an `ok` response body (a throw rejects the request as the relay would).
 */
export const answering =
  (
    fn: (
      op: string,
      args: Record<string, unknown>,
      call: { deviceId: string; signal: AbortSignal },
    ) => Promise<unknown>,
  ) =>
  async (deviceId: string, body: unknown, opts: { signal?: AbortSignal }): Promise<unknown> => {
    const { op, args } = body as { op: string; args: Record<string, unknown> };
    const signal = opts.signal ?? new AbortController().signal;
    return { ok: true, result: await fn(op, args, { deviceId, signal }) };
  };
