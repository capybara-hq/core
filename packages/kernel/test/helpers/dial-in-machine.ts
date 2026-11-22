import { randomUUID } from "node:crypto";
import { FAKE_DIAL_IN_PROTOCOL } from "@capybara-hq/testing";
import WebSocket from "ws";
import type { Answer, KernelCancel, KernelReq } from "./test-holder.js";

export type { Answer, KernelCancel, KernelReq };

/** A `stop` the kernel sent (the envelope's `stop`). */
export interface KernelStop {
  type: "stop";
  reason: "drain" | "stop";
}

/** A kernel frame as a test reads it: a request (its body's `op` and `args`), a cancel or a stop. */
export type KernelFrame = KernelReq | KernelCancel | KernelStop;

/** The frame capacity a fake machine announces by default. */
export const FAKE_MAX_FRAME_BYTES = 69632;

/** The `fake-dial-in` hello body a machine sends by default (its provider's own shape). */
export const DEFAULT_HELLO_BODY = { revision: "r1", outsideSandbox: false };

const ENVELOPE_KEYS = new Set(["protocol", "programRunId", "program", "transport"]);

/**
 * The hello envelope of a fake machine: {@link FAKE_DIAL_IN_PROTOCOL}, a fresh program run, the
 * default program facts and {@link DEFAULT_HELLO_BODY} as the body, with `overrides` split
 * between the envelope (`protocol`, `programRunId`, `program`, `transport`, `bootId`,
 * `programVersion`) and the body (every other key).
 */
export function helloEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    type: "hello",
    protocol: FAKE_DIAL_IN_PROTOCOL,
    programRunId: randomUUID(),
    program: { version: "0.1.0", os: "linux", arch: "x64" },
    transport: { maxFrameBytes: FAKE_MAX_FRAME_BYTES },
  };
  const body: Record<string, unknown> = { ...DEFAULT_HELLO_BODY };
  for (const [k, v] of Object.entries(overrides)) {
    if (k === "bootId")
      envelope.program = {
        ...(envelope.program as object),
        ...(v === undefined ? {} : { bootId: v }),
      };
    else if (k === "programVersion")
      envelope.program = { ...(envelope.program as object), version: v };
    else if (ENVELOPE_KEYS.has(k)) envelope[k] = v;
    else if (v === undefined) delete body[k];
    else body[k] = v;
  }
  return { ...envelope, body };
}

/** Options of {@link EnvelopeMachine}. */
export interface EnvelopeMachineOptions {
  /** false: the test sends the hello itself (with {@link EnvelopeMachine.hello}). */
  hello?: boolean;
  autoPong?: boolean;
}

/**
 * A machine on the generic dial-in channel for gateway and relay tests, over a real WebSocket
 * against the HTTP route: it speaks the `fake-dial-in` protocol (the provider's bodies are opaque
 * to the kernel), records the kernel's frames (a request as its body's `op` and `args`), keeps the
 * `ready` frame apart and answers requests with `answer` (undefined: the test answers with
 * {@link respond}). Unlike `FakeDialInMachine` it can withhold or script the hello, skip pongs and
 * send raw frames.
 */
export class EnvelopeMachine {
  readonly frames: KernelFrame[] = [];
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly opened: Promise<void>;
  /** Resolves with the kernel's `ready` frame (its connection id and effective capacity). */
  readonly ready: Promise<{ type: "ready"; connectionId: string; maxFrameBytes: number }>;
  private waiters: {
    pred: (f: KernelFrame) => boolean;
    resolve: (f: KernelFrame) => void;
  }[] = [];

  constructor(
    url: string,
    credential: string,
    private readonly answer: (req: KernelReq) => Answer = () => undefined,
    opts: EnvelopeMachineOptions = {},
  ) {
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${credential}`,
        "X-Capybara-Device-Protocol": FAKE_DIAL_IN_PROTOCOL,
      },
      autoPong: opts.autoPong ?? true,
    });
    this.closed = new Promise((resolve) => {
      this.ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.on("open", () => {
        if (opts.hello !== false) this.hello();
        resolve();
      });
      this.ws.on("error", reject);
    });
    let onReady!: (r: { type: "ready"; connectionId: string; maxFrameBytes: number }) => void;
    this.ready = new Promise((resolve) => {
      onReady = resolve;
    });
    this.ws.on("message", (data) => {
      const f = JSON.parse(String(data)) as {
        type: string;
        id?: string;
        deadlineMs?: number;
        body?: { op?: unknown; args?: unknown };
        reason?: "drain" | "stop";
        connectionId?: string;
        maxFrameBytes?: number;
      };
      if (f.type === "ready") {
        onReady({
          type: "ready",
          connectionId: String(f.connectionId),
          maxFrameBytes: Number(f.maxFrameBytes),
        });
        return;
      }
      let frame: KernelFrame;
      if (f.type === "req")
        frame = {
          type: "req",
          id: String(f.id),
          op: String(f.body?.op),
          args: f.body?.args,
          deadlineMs: Number(f.deadlineMs),
        };
      else if (f.type === "cancel") frame = { type: "cancel", id: String(f.id) };
      else if (f.type === "stop") frame = { type: "stop", reason: f.reason ?? "stop" };
      else return;
      this.frames.push(frame);
      for (const w of [...this.waiters]) {
        if (w.pred(frame)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(frame);
        }
      }
      if (frame.type === "req") {
        const a = this.answer(frame);
        if (a !== undefined) this.respond(frame.id, a);
      }
    });
  }

  /** Sends the hello envelope ({@link helloEnvelope} with `overrides`). */
  hello(overrides: Record<string, unknown> = {}): void {
    this.send(helloEnvelope(overrides));
  }

  /** Sends a raw frame. */
  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Sends an `event` envelope with `body`. */
  event(body: unknown): void {
    this.send({ type: "event", body });
  }

  /** Sends the response body `answer` of request `id`. */
  respond(id: string, answer: Answer): void {
    this.send({ type: "res", id, body: answer });
  }

  /** Waits for a frame matching `pred` (already received or still to come). */
  next(pred: (f: KernelFrame) => boolean = () => true): Promise<KernelFrame> {
    const seen = this.frames.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }

  close(): void {
    this.ws.terminate();
  }
}

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
