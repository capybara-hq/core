import {
  DEVICE_PROTOCOL_VERSION,
  type DeviceHello,
  type DeviceLocalPolicySummary,
  type DeviceOwnerCeiling,
  type KernelCancel,
  type KernelReady,
  type KernelReq,
  type LegacyDeviceHello,
  parseDeviceFrame,
} from "@capybara-hq/plugin-sdk";
import WebSocket from "ws";
import {
  FakeMachine as FakeMachineV2,
  HELLO as HELLO_V2,
  refusal,
  stagedHello,
} from "./fake-machine.js";
import type { Answer } from "./test-holder.js";

export { refusal, stagedHello };

/** What a fake machine of either protocol offers a test. */
export interface FakeMachineApi {
  readonly frames: (KernelReq | KernelCancel)[];
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly opened: Promise<void>;
  /** Sends the machine's hello: the protocol's default with `overrides` applied. */
  hello(overrides?: Record<string, unknown>): void;
  send(frame: unknown): void;
  respond(id: string, answer: NonNullable<Answer>): void;
  next(pred?: (f: KernelReq | KernelCancel) => boolean): Promise<KernelReq | KernelCancel>;
  close(): void;
}

export interface FakeMachineOptions {
  /** false: the test sends the hello itself (with {@link FakeMachineApi.hello}). */
  hello?: boolean;
  autoPong?: boolean;
}

export type FakeMachineConstructor = new (
  url: string,
  credential: string,
  answer?: (req: KernelReq) => Answer,
  opts?: FakeMachineOptions,
) => FakeMachineApi;

/** The staged hello of a machine whose instance is not bound yet (the kernel binds it). */
export const HELLO_V3: DeviceHello = stagedHello();

/** The v3 owner report a fake machine answers a bind with. */
export const FAKE_OWNER_CEILING: DeviceOwnerCeiling = HELLO_V3.ownerCeiling;

/**
 * A `capybara-device` stand-in speaking the staged (protocol 3) wire over a real WebSocket,
 * against `LocalDeviceGateway.accept` (or, after the paired activation, the HTTP route):
 * it records the kernel's frames, keeps the `ready` frame apart (its connection id and capacity
 * are in {@link ready}), and answers requests with `answer` (undefined: the test answers with
 * {@link respond}). A `bindInstance` nobody answered is answered with the installed evidence of
 * the generation it asks for ({@link bindAnswer}), as an enforcing device would. The device's own
 * session code (`serveStagedSession`) is used where a test needs real operations; this fake is for
 * tests that script a machine's answers.
 */
export class FakeMachineV3 implements FakeMachineApi {
  readonly frames: (KernelReq | KernelCancel)[] = [];
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly opened: Promise<void>;
  /** Resolves with the kernel's `ready` frame (its connection id and negotiated capacity). */
  readonly ready: Promise<KernelReady>;
  private waiters: {
    pred: (f: KernelReq | KernelCancel) => boolean;
    resolve: (f: KernelReq | KernelCancel) => void;
  }[] = [];

  constructor(
    url: string,
    credential: string,
    private readonly answer: (req: KernelReq) => Answer = () => undefined,
    opts: FakeMachineOptions = {},
  ) {
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${credential}`, "X-Capybara-Device-Protocol": "3" },
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
    let onReady!: (r: KernelReady) => void;
    this.ready = new Promise((resolve) => {
      onReady = resolve;
    });
    this.ws.on("message", (data) => {
      const f = parseDeviceFrame(String(data), "kernel");
      if (f.type === "ready") {
        onReady(f);
        return;
      }
      if (f.type !== "req" && f.type !== "cancel") return;
      // a staged request names operations protocol 2's type does not know: tests read `op` as text
      const frame = f as unknown as KernelReq | KernelCancel;
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
        if (String(frame.op) === "bindInstance" && (a === undefined || isNullResult(a))) {
          a = bindAnswer(frame);
        }
        if (a !== undefined) this.respond(frame.id, a);
      }
    });
  }

  hello(overrides: Record<string, unknown> = {}): void {
    this.send({ ...HELLO_V3, ...overrides });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  respond(id: string, answer: NonNullable<Answer>): void {
    this.send({ type: "res", id, ...answer });
  }

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
    restrictedAllowedDomains: [...policy.allowedDomains],
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
        version: 1,
        restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
        fullAccess: true,
        background: true,
      },
      ownerCeiling: FAKE_OWNER_CEILING,
    },
  } as NonNullable<Answer>;
}

/**
 * The protocol under test: the SDK's protocol constant, so the paired activation flips these
 * fixtures with it. `CAPYBARA_TEST_DEVICE_PROTOCOL=3` forces the staged fakes while the constant
 * is still 2 (to see what the activation will need).
 */
export function deviceProtocolUnderTest(): 2 | 3 {
  const forced = process.env.CAPYBARA_TEST_DEVICE_PROTOCOL;
  if (forced === "2" || forced === "3") return Number(forced) as 2 | 3;
  return (DEVICE_PROTOCOL_VERSION as number) === 3 ? 3 : 2;
}

/** The fake machine pieces of one protocol; a test file takes them from {@link fakeMachine}. */
export function fakeMachineFor(protocol: 2 | 3) {
  const staged = protocol === 3;
  return {
    protocol,
    /** The header an upgrade request of this protocol carries. */
    protocolHeader: String(protocol),
    Machine: (staged ? FakeMachineV3 : FakeMachineV2) as FakeMachineConstructor,
    HELLO: (staged ? HELLO_V3 : HELLO_V2) as LegacyDeviceHello,
    /** The hello frame with `overrides` (v2-only fields such as `policy` ride along in both). */
    helloWith: (overrides: Record<string, unknown> = {}): LegacyDeviceHello =>
      ({ ...(staged ? HELLO_V3 : HELLO_V2), ...overrides }) as LegacyDeviceHello,
  };
}

/** What the test files use: the machine of the protocol under test. */
export const fakeMachine = fakeMachineFor(deviceProtocolUnderTest());
export const FakeMachine = fakeMachine.Machine;
export type FakeMachine = FakeMachineApi;
export const HELLO = fakeMachine.HELLO;
export const DEVICE_PROTOCOL_HEADER_VALUE = fakeMachine.protocolHeader;
