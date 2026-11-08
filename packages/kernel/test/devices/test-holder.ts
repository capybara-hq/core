import {
  type DeviceErrorKind,
  type DeviceRes,
  type ExtensionContext,
  type KernelCancel,
  type KernelReq,
  parseDeviceFrame,
} from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import {
  deviceLeaseKey,
  deviceReqKey,
  deviceReqTopic,
  deviceResKey,
  deviceResTopic,
} from "../../src/devices/keys.js";

/** The machine's answer to one request: a result, an error, or nothing (the test answers later). */
export type Answer =
  | { ok: true; result: unknown }
  | { ok: false; error: { kind: DeviceErrorKind; message: string } }
  | undefined;

/**
 * A stand-in for the gateway replica that holds a machine's connection (Task 6): it claims the
 * lease, drains the request list on every nudge, and stores results the way the real holder does
 * (`SET capk:device-res:<id> PX`, then `PUBLISH device.res.<id>` with the `res` frame).
 */
export class TestHolder {
  readonly frames: (KernelReq | KernelCancel)[] = [];
  private unsubscribe: (() => Promise<void>) | undefined;
  private waiters: {
    pred: (f: KernelReq | KernelCancel) => boolean;
    resolve: (f: KernelReq | KernelCancel) => void;
  }[] = [];

  constructor(
    private readonly redis: Redis,
    private readonly bus: ExtensionContext["bus"],
    readonly environmentId: string,
    private readonly answer: (req: KernelReq) => Answer = () => undefined,
    private readonly resultTtlMs = 60_000,
  ) {}

  /** Takes the lease and starts serving (drains what is already queued). */
  async connect(): Promise<void> {
    await this.redis.set(deviceLeaseKey(this.environmentId), "test-holder", "PX", 60_000);
    this.unsubscribe = await this.bus.subscribe(deviceReqTopic(this.environmentId), () => {
      void this.drain();
    });
    await this.drain();
  }

  /** Drops the connection: releases the lease and stops draining. */
  async disconnect(): Promise<void> {
    await this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.redis.del(deviceLeaseKey(this.environmentId));
  }

  /** Waits for a frame matching `pred` (already received or still to come). */
  next(
    pred: (f: KernelReq | KernelCancel) => boolean = () => true,
  ): Promise<KernelReq | KernelCancel> {
    const seen = this.frames.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }

  /** Stores and publishes the result of request `id`, like the real holder. */
  async respond(
    id: string,
    answer: NonNullable<Answer>,
    opts: { publish?: boolean } = {},
  ): Promise<void> {
    const frame = { type: "res", id, ...answer } as DeviceRes;
    await this.redis.set(deviceResKey(id), JSON.stringify(frame), "PX", this.resultTtlMs);
    if (opts.publish !== false) await this.bus.publish(deviceResTopic(id), frame);
  }

  private async drain(): Promise<void> {
    for (;;) {
      const raw = await this.redis.lpop(deviceReqKey(this.environmentId));
      if (raw === null) return;
      const f = parseDeviceFrame(raw, "kernel") as KernelReq | KernelCancel;
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
