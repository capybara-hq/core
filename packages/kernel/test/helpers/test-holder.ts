import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
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

/**
 * A request as a test reads it: the test bodies are `{ op, args }` (opaque to the relay, which
 * never looks inside them).
 */
export interface KernelReq {
  type: "req";
  id: string;
  op: string;
  args: unknown;
  deadlineMs: number;
}

/** The kernel gives up on a request (abort or deadline). */
export interface KernelCancel {
  type: "cancel";
  id: string;
}

/** The machine's answer to one request: its response body, or nothing (the test answers later). */
export type Answer = unknown;

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
 * recorded as their body's `op` and `args`.
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
  async respond(id: string, answer: Answer, opts: { publish?: boolean } = {}): Promise<void> {
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
        body?: { op: string; args: unknown };
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
                op: String(q.body?.op),
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
