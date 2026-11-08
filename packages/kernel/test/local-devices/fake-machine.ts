import {
  DEFAULT_SANDBOX_ROOTS,
  type DeviceHello,
  type KernelCancel,
  type KernelReq,
  parseDeviceFrame,
} from "@capybara-hq/plugin-sdk";
import WebSocket from "ws";
import type { Answer } from "./test-holder.js";

export const HELLO: DeviceHello = {
  type: "hello",
  protocol: 1,
  programVersion: "0.1.0",
  os: "linux",
  arch: "x64",
  mode: "os",
  roots: { ...DEFAULT_SANDBOX_ROOTS },
  sessionIsolation: false,
};

/** The HTTP answer to an upgrade the kernel refused. */
export interface Refusal {
  status: number;
  body: string;
}

/** Tries the upgrade; resolves the refusal, or null when the socket opened (then closes it). */
export function refusal(url: string, headers: Record<string, string>): Promise<Refusal | null> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
      });
      res.on("end", () => {
        ws.terminate();
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    ws.on("open", () => {
      ws.terminate();
      resolve(null);
    });
    ws.on("error", (e) => {
      if (!String(e.message).includes("Unexpected server response")) reject(e);
    });
  });
}

/**
 * A `capybara-device` stand-in over a real WebSocket: sends `hello`, records the kernel's frames
 * and answers requests with `answer` (undefined: the test answers with {@link respond}).
 */
export class FakeMachine {
  readonly frames: (KernelReq | KernelCancel)[] = [];
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly opened: Promise<void>;
  private waiters: {
    pred: (f: KernelReq | KernelCancel) => boolean;
    resolve: (f: KernelReq | KernelCancel) => void;
  }[] = [];

  constructor(
    url: string,
    credential: string,
    private readonly answer: (req: KernelReq) => Answer = () => undefined,
    opts: { hello?: boolean; autoPong?: boolean } = {},
  ) {
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${credential}`, "X-Capybara-Device-Protocol": "1" },
      autoPong: opts.autoPong ?? true,
    });
    this.closed = new Promise((resolve) => {
      this.ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.on("open", () => {
        if (opts.hello !== false) this.send(HELLO);
        resolve();
      });
      this.ws.on("error", reject);
    });
    this.ws.on("message", (data) => {
      const f = parseDeviceFrame(String(data), "kernel") as KernelReq | KernelCancel;
      this.frames.push(f);
      for (const w of [...this.waiters]) {
        if (w.pred(f)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(f);
        }
      }
      if (f.type === "req") {
        const a = this.answer(f);
        if (a !== undefined) this.respond(f.id, a);
      }
    });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  respond(id: string, answer: NonNullable<Answer>): void {
    this.send({ type: "res", id, ...answer });
  }

  /** Waits for a frame matching `pred` (already received or still to come). */
  next(
    pred: (f: KernelReq | KernelCancel) => boolean = () => true,
  ): Promise<KernelReq | KernelCancel> {
    const seen = this.frames.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }

  close(): void {
    this.ws.terminate();
  }
}
