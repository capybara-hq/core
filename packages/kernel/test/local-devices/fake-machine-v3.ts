import { randomUUID } from "node:crypto";
import {
  DEVICE_DIAL_IN_PROTOCOL,
  type DeviceHello,
  type DeviceLocalPolicySummary,
  type DeviceOwnerCeiling,
  type KernelCancel,
  type KernelReq,
} from "@capybara-hq/plugin-sdk/device-protocol";
import WebSocket from "ws";
import { refusal, stagedHello } from "./fake-machine.js";
import type { Answer } from "./test-holder.js";

export { refusal, stagedHello };

/** A `stop` the kernel sent (the envelope's `stop`). */
export interface KernelStop {
  type: "stop";
  reason: "drain" | "stop";
}

/** A kernel frame as a test reads it: a request (its body's `op` and `args`), a cancel or a stop. */
export type KernelFrame = KernelReq | KernelCancel | KernelStop;

/** What a fake machine offers a test. */
export interface FakeMachineApi {
  readonly frames: KernelFrame[];
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly opened: Promise<void>;
  /**
   * Sends the machine's hello envelope: the default program facts and body with `overrides`
   * applied (envelope keys `protocol`, `programRunId`, `program`, `transport`, `bootId` and
   * `programVersion` go to the envelope, every other key to the body).
   */
  hello(overrides?: Record<string, unknown>): void;
  /** Sends a raw frame. */
  send(frame: unknown): void;
  /** Sends an `event` envelope with `body`. */
  event(body: unknown): void;
  respond(id: string, answer: NonNullable<Answer>): void;
  next(pred?: (f: KernelFrame) => boolean): Promise<KernelFrame>;
  close(): void;
}

export interface FakeMachineOptions {
  /** false: the test sends the hello itself (with {@link FakeMachineApi.hello}). */
  hello?: boolean;
  autoPong?: boolean;
  /**
   * false: a `bindInstance` gets exactly what the test's answer gives (a scripted `null` result,
   * an error, or no answer). Default true: an unscripted bind, or one the answer's catch-all
   * `null` result covers, gets the installed evidence of {@link bindAnswer}.
   */
  autoBind?: boolean;
}

export type FakeMachineConstructor = new (
  url: string,
  credential: string,
  answer?: (req: KernelReq) => Answer,
  opts?: FakeMachineOptions,
) => FakeMachineApi;

/** The hello body of a machine whose instance is not bound yet (the kernel binds it). */
export const HELLO_V3: DeviceHello = stagedHello();

/** The v3 owner report a fake machine answers a bind with. */
export const FAKE_OWNER_CEILING: DeviceOwnerCeiling = HELLO_V3.ownerCeiling;

/** The frame capacity a fake machine announces by default. */
export const FAKE_MAX_FRAME_BYTES = 69632;

const ENVELOPE_KEYS = new Set(["protocol", "programRunId", "program", "transport", "bootId"]);

/**
 * The hello envelope of a fake machine: `capybara-device/5`, a fresh program run, the default
 * program facts and {@link HELLO_V3} as the body, with `overrides` split between the envelope and
 * the body ({@link FakeMachineApi.hello}).
 */
export function helloEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    type: "hello",
    protocol: DEVICE_DIAL_IN_PROTOCOL,
    programRunId: randomUUID(),
    program: { version: "0.1.0", os: "linux", arch: "x64" },
    transport: { maxFrameBytes: FAKE_MAX_FRAME_BYTES },
  };
  const body: Record<string, unknown> = { ...HELLO_V3 };
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

/**
 * A `capybara-device` stand-in speaking the dial-in envelope (protocol `capybara-device/5`) over
 * a real WebSocket, against the HTTP route: it records the kernel's frames (a request as its
 * body's `op` and `args`), keeps the `ready` frame apart (its connection id is in {@link ready}),
 * and answers requests with `answer` (undefined: the test answers with {@link respond}). A
 * `bindInstance` nobody answered is answered with the installed evidence of the generation it asks
 * for ({@link bindAnswer}), as an enforcing device would. The device's own session code is used
 * where a test needs real operations; this fake is for tests that script a machine's answers.
 */
export class FakeMachineV3 implements FakeMachineApi {
  readonly frames: KernelFrame[] = [];
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly opened: Promise<void>;
  /** Resolves with the kernel's `ready` frame (its connection id). */
  readonly ready: Promise<{ type: "ready"; connectionId: string; maxFrameBytes: number }>;
  private waiters: {
    pred: (f: KernelFrame) => boolean;
    resolve: (f: KernelFrame) => void;
  }[] = [];

  constructor(
    url: string,
    credential: string,
    private readonly answer: (req: KernelReq) => Answer = () => undefined,
    opts: FakeMachineOptions = {},
  ) {
    const autoBind = opts.autoBind ?? true;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${credential}`,
        "X-Capybara-Device-Protocol": DEVICE_DIAL_IN_PROTOCOL,
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
        body?: { op?: string; args?: unknown };
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
          op: f.body?.op as KernelReq["op"],
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
        let a = this.answer(frame);
        // a bind nobody scripted (no answer, or the catch-all `null` result many answers give
        // every op they do not handle) gets the installed evidence an enforcing device returns
        if (
          autoBind &&
          String(frame.op) === "bindInstance" &&
          (a === undefined || isNullResult(a))
        ) {
          a = bindAnswer(frame);
        }
        if (a !== undefined) this.respond(frame.id, a);
      }
    });
  }

  hello(overrides: Record<string, unknown> = {}): void {
    this.send(helloEnvelope(overrides));
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  event(body: unknown): void {
    this.send({ type: "event", body });
  }

  respond(id: string, answer: NonNullable<Answer>): void {
    this.send({ type: "res", id, body: answer });
  }

  next(pred: (f: KernelFrame) => boolean = () => true): Promise<KernelFrame> {
    const seen = this.frames.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }

  close(): void {
    this.ws.terminate();
  }
}

let ownerSequence = 0;

/**
 * A fresh owner report of a machine whose local allowlist is `policy.allowedDomains` (the device
 * reports its restricted allowance from it): each call issues a higher sequence and a new revision,
 * so a report after a policy change, or a reconnect's hello, is never stale for the kernel.
 */
export function ownerReportFor(
  policy: { readonly allowedDomains: readonly string[] },
  over: Partial<DeviceOwnerCeiling> = {},
): DeviceOwnerCeiling {
  ownerSequence += 1;
  return {
    ...FAKE_OWNER_CEILING,
    sequence: ownerSequence,
    revision: `test-owner-r${ownerSequence}`,
    allowedDomains: [...policy.allowedDomains],
    ...over,
  };
}

/** A v3 `policy` answer: the policy as written and the owner report issued for it. */
export function policyAnswer(policy: DeviceLocalPolicySummary): NonNullable<Answer> {
  return {
    ok: true,
    result: { policy, ownerCeiling: ownerReportFor(policy) },
  } as NonNullable<Answer>;
}

/**
 * A v3 `policyStatus` answer: an `applied` outcome carries the machine's current owner report
 * (protocol 3 requires it); other outcomes carry none.
 */
export function policyStatusAnswer(
  outcome: "applied" | "refused" | "started" | "unknown",
  policy: DeviceLocalPolicySummary,
): NonNullable<Answer> {
  return {
    ok: true,
    result: {
      outcome,
      policy,
      ...(outcome === "applied" && { ownerCeiling: ownerReportFor(policy) }),
    },
  } as NonNullable<Answer>;
}

const isNullResult = (a: NonNullable<Answer>): boolean =>
  (a as { ok?: unknown }).ok === true && (a as { result?: unknown }).result === null;

/**
 * The installed evidence an enforcing device answers `bindInstance` with: the asked generation and
 * binding id echoed with a runtime identity of that generation, full permission support and the
 * machine's owner report.
 */
export function bindAnswer(req: KernelReq): NonNullable<Answer> {
  const args = req.args as {
    instanceId: string;
    instanceGeneration: string;
    bindingId: string;
  };
  return {
    ok: true,
    result: {
      instanceId: args.instanceId,
      instanceGeneration: args.instanceGeneration,
      bindingId: args.bindingId,
      runtimeIdentity: {
        runtimeHash: "a".repeat(64),
        helperHash: "b".repeat(64),
        imageFingerprint: "c".repeat(64),
        instanceGeneration: args.instanceGeneration,
      },
      permissionSupport: {
        version: 2,
        restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
        boundary: "operation",
        network: { openPublic: false, allowlist: true, perOperationHosts: true },
        outsideSandbox: true,
        background: true,
      },
      ownerCeiling: FAKE_OWNER_CEILING,
    },
  } as NonNullable<Answer>;
}

/** What the test files use: the machine of protocol 5 (the dial-in envelope). */
export const FakeMachine: FakeMachineConstructor = FakeMachineV3;
export type FakeMachine = FakeMachineApi;
export const HELLO = HELLO_V3;
/** The upgrade header a fake machine sends. */
export const DEVICE_PROTOCOL_HEADER_VALUE = DEVICE_DIAL_IN_PROTOCOL;

/** The local dial-in handler a hand-built gateway asks: accepts every hello unless given one. */
export interface LocalHandlerStub {
  readonly kernelInternal: true;
  onHello(
    deviceId: string,
    hello: unknown,
    signal: AbortSignal,
    connection?: { machineId: string; connectionId: string },
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  onFrame?(
    deviceId: string,
    frame: unknown,
    connection?: { machineId: string; connectionId: string },
  ): Promise<void>;
}

/**
 * `DialInHandlers` for a hand-built gateway: every device is served by the kernel's `@local`
 * provider speaking `capybara-device/5`, through `handler` (default: accepts every hello).
 */
export function localHandlers(
  handler: LocalHandlerStub = { kernelInternal: true, onHello: async () => ({ ok: true }) },
) {
  return {
    forDevice: async () => ({
      plugin: "@local",
      protocol: DEVICE_DIAL_IN_PROTOCOL,
      internal: true as const,
      handler,
    }),
  };
}
