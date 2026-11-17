import {
  type DeviceHelloV3,
  type DeviceResponseV3,
  type KernelReadyV3,
  parseDeviceFrameV3,
  type SandboxHandle,
} from "@capybara-hq/plugin-sdk";
import type WebSocket from "ws";
import { currentBootId } from "./boot-id.js";
import { credentialIdentity, type InstanceBinder } from "./exec/instance-binding.js";
import type { MacOperationBackend } from "./exec/mac-operation-backend.js";
import { DrainPendingError } from "./exec/operation-supervisor.js";
import { type StagedOwnerPolicy, serveOperationV3 } from "./server-ops.js";
import type { Credential } from "./state.js";

/** Held answers a session keeps at most while no socket is ready; the oldest is dropped first. */
export const MAX_HELD_ANSWERS = 64;

/**
 * What a staged (protocol 3) program keeps across its sockets, like protocol 2's connection
 * (`client.ts`): the running operations and the answers produced while no socket was ready.
 * One state belongs to one machine credential ({@link StagedSessionStates}); it never serves
 * another credential's sockets.
 */
export interface StagedSessionState {
  readonly graceMs: number;
  /** {@link stagedSessionIdentity} of the credential this state serves; undefined only in tests. */
  readonly identity: string | undefined;
  /** At most this many answers are held while no socket is ready. */
  readonly maxPending: number;
  readonly now: () => number;
  readonly running: Map<string, { op: string; ctl: AbortController; done: Promise<void> }>;
  /** Set by {@link drainStagedSession}; never cleared in this process (a drained device is not reused). */
  draining: boolean;
  /** Set when a credential change replaced this state: it holds nothing and serves no socket. */
  discarded: boolean;
  /** Answers waiting for the next ready socket, with their expiry. */
  readonly pending: Map<string, { res: DeviceResponseV3; expires: number }>;
  /** Delivers on the current ready socket; undefined while none is ready. */
  current: ((res: DeviceResponseV3) => void) | undefined;
}

/**
 * `graceMs` is required: production passes the credential's `reconnectGraceSeconds * 1000`
 * ({@link StagedSessionStates}); 0 holds nothing and must be asked for explicitly.
 */
export function createStagedSessionState(opts: {
  graceMs: number;
  identity?: string;
  maxPending?: number;
  now?: () => number;
}): StagedSessionState {
  if (!Number.isSafeInteger(opts?.graceMs) || opts.graceMs < 0)
    throw new Error("Pass the reconnect grace in milliseconds (a non-negative integer)");
  const maxPending = opts.maxPending ?? MAX_HELD_ANSWERS;
  if (!Number.isSafeInteger(maxPending) || maxPending < 1)
    throw new Error("Pass a positive held-answer limit");
  return {
    graceMs: opts.graceMs,
    identity: opts.identity,
    maxPending,
    now: opts.now ?? Date.now,
    running: new Map(),
    pending: new Map(),
    current: undefined,
    draining: false,
    discarded: false,
  };
}

/** The credential fields a staged session is keyed by, plus its reconnect grace. */
export type StagedSessionCredential = Pick<
  Credential,
  "url" | "orgId" | "deviceId" | "credential" | "reconnectGraceSeconds"
>;

/** The machine and credential a session state belongs to (never the secret itself). */
export const stagedSessionIdentity = (
  cred: Omit<StagedSessionCredential, "reconnectGraceSeconds">,
) => JSON.stringify([cred.url, cred.orgId, cred.deviceId, credentialIdentity(cred.credential)]);

/**
 * The program's session states, one per machine credential (8.1 rereview N2): the same credential
 * gets the same state across reconnects; a different one discards the old state, its held
 * answers included, so no answer produced for one credential reaches another's socket.
 */
export class StagedSessionStates {
  private state: StagedSessionState | undefined;

  for(cred: StagedSessionCredential): StagedSessionState {
    const identity = stagedSessionIdentity(cred);
    if (this.state && this.state.identity === identity) return this.state;
    if (this.state) discardStagedSessionState(this.state);
    this.state = createStagedSessionState({
      graceMs: cred.reconnectGraceSeconds * 1000,
      identity,
    });
    return this.state;
  }
}

function discardStagedSessionState(state: StagedSessionState): void {
  state.discarded = true;
  state.pending.clear();
  state.current = undefined;
}

/**
 * Holds an answer for the next ready socket: expired entries are swept first, and the oldest
 * entries are dropped beyond the limit, so a device that never reconnects stays bounded.
 */
function holdAnswer(state: StagedSessionState, res: DeviceResponseV3): void {
  if (state.graceMs <= 0 || state.discarded) return;
  const now = state.now();
  for (const [id, p] of state.pending) if (p.expires <= now) state.pending.delete(id);
  state.pending.delete(res.id);
  while (state.pending.size >= state.maxPending) {
    const oldest = state.pending.keys().next();
    if (oldest.done) break;
    state.pending.delete(oldest.value);
  }
  state.pending.set(res.id, { res, expires: now + state.graceMs });
}

/**
 * Operations whose answer is fenced to the connection their request came on: an output read is
 * sized for that connection's capacity and the kernel refuses its answer on another one, so a
 * socket close aborts it (the kernel retries the read from the same offset).
 */
const CONNECTION_FENCED = new Set(["backgroundReadOutput"]);

/**
 * Admissions a draining session refuses here: instance creation, which no supervisor owns, and a
 * new instance binding, since a drained session never takes on a new generation (8.4 B4 M9).
 * Execution, background starts and native, preparation and browsing operations all reach the
 * supervisor, whose admission refuses only fresh operations while draining: a retry of an admitted
 * id (an answer lost on a socket blip) still recovers. Exact status, read, tail, stop, revoke and
 * policy reconciliation are always served.
 */
const REFUSED_WHILE_DRAINING = new Set(["create", "bindInstance"]);

export type StagedDrainReport =
  | { drained: true }
  | {
      drained: false;
      pending: { requests: number } & ReturnType<MacOperationBackend["lifecycle"]["ownership"]>;
    };

/**
 * Graceful drain (permission runtime cutover phase 8.4): new admissions are refused at once;
 * status, reads, tails, stops, reconciliation and recovery of admitted ids continue. It resolves
 * `drained` only when the in-flight requests and everything the backend owns (acknowledged tasks
 * whose start RPC already ended, collectors, pending exact cancellations, deferred persistence)
 * have settled. When `signal` aborts first it reports what is pending; the session stays draining
 * and is never reused. The caller disconnects after a drained report.
 */
export async function drainStagedSession(
  state: StagedSessionState,
  backend: Pick<MacOperationBackend, "lifecycle">,
  signal: AbortSignal,
): Promise<StagedDrainReport> {
  state.draining = true;
  backend.lifecycle.beginDrain();
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const idle = () => {
    const o = backend.lifecycle.ownership();
    return (
      state.running.size === 0 && o.workers + o.cancellations + o.collectors + o.persistence === 0
    );
  };
  // Status and output reads keep arriving while draining: wait for both the request table and
  // the owned work, again, until both are empty at once. Only the signal ends it as pending.
  while (!signal.aborted) {
    while (state.running.size > 0 && !signal.aborted)
      await Promise.race([
        Promise.allSettled([...state.running.values()].map((r) => r.done)),
        aborted,
      ]);
    if (signal.aborted) break;
    try {
      await backend.lifecycle.settle(signal);
    } catch (error) {
      // Only the drain timeout is "still pending"; any other failure is a real error.
      if (!(error instanceof DrainPendingError)) throw error;
      break; // aborted: reported below with what is still owned
    }
    if (idle()) return { drained: true };
  }
  return {
    drained: false,
    pending: { requests: state.running.size, ...backend.lifecycle.ownership() },
  };
}

/**
 * Dormant authenticated socket adapter. Production connect() remains v2 until paired activation.
 *
 * Reconnect semantics follow protocol 2: a socket close aborts only in-flight output reads; every
 * other operation keeps running, and an answer produced while no socket is ready waits up to the
 * grace for the next ready socket served with the same `state`. A cancel reaches an operation
 * whichever socket it arrives on.
 */
export function serveStagedSession(
  socket: WebSocket,
  report: Omit<DeviceHelloV3, "transport">,
  credential: Pick<Credential, "maxFrameBytes">,
  backend: MacOperationBackend,
  handle: SandboxHandle,
  /** Required: from {@link StagedSessionStates}, so the grace and the credential are explicit. */
  state: StagedSessionState,
  /**
   * The post-commit binder (B4). With one, operations go to the generation it bound (none while
   * unbound) and `bindInstance` is served; without one, the fixed backend serves a bound hello.
   */
  binder?: InstanceBinder,
  /** Serves `policy` / `policyStatus` with owner reports (B2); without it they are unsupported. */
  owner?: StagedOwnerPolicy,
): { ready: () => KernelReadyV3 | undefined } {
  if (!state || state.discarded)
    throw new Error("Serve the session with the current credential's session state");
  const bootId = report.bootId ?? currentBootId();
  const hello: DeviceHelloV3 = {
    ...report,
    // the host's OS boot identity: the deployment's evidence that the host restarted (8.5)
    ...(bootId !== undefined && { bootId }),
    transport: { maxFrameBytes: credential.maxFrameBytes },
  };
  let ready: KernelReadyV3 | undefined;
  const send = (value: unknown, cap: number) => {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > cap)
      throw new Error("Check device and deployment frame limits: control frame cannot fit");
    socket.send(raw);
  };
  const fail = (error: unknown) => socket.close(4400, String(error).slice(0, 100));
  /** `res`, or an error answer when it cannot fit the negotiated capacity. */
  const fit = (res: DeviceResponseV3, cap: number): DeviceResponseV3 =>
    Buffer.byteLength(JSON.stringify(res)) <= cap
      ? res
      : {
          type: "res",
          id: res.id,
          ok: false,
          error: {
            kind: "error",
            message: "Result exceeds negotiated capacity; check frame limits and retry",
          },
        };
  const deliverHere = (res: DeviceResponseV3) => {
    const cap = ready?.maxFrameBytes;
    if (cap === undefined || socket.readyState !== socket.OPEN) {
      hold(res);
      return;
    }
    try {
      send(fit(res, cap), cap);
    } catch (error) {
      fail(error);
    }
  };
  const hold = (res: DeviceResponseV3) => holdAnswer(state, res);
  const deliver = (res: DeviceResponseV3) => {
    if (state.current) state.current(res);
    else hold(res);
  };
  const refuse = (id: string, kind: "unsupported" | "error", message: string) =>
    deliverHere({ type: "res", id, ok: false, error: { kind, message } });
  socket.on("message", (data, binary) => {
    try {
      if (binary) throw new Error("Use JSON text frames");
      const frame = parseDeviceFrameV3(
        data.toString(),
        "kernel",
        ready?.maxFrameBytes ?? hello.transport.maxFrameBytes,
      );
      if (frame.type === "ready") {
        if (ready || frame.maxFrameBytes > hello.transport.maxFrameBytes)
          throw new Error("Invalid ready capacity; reconnect");
        ready = frame;
        state.current = deliverHere;
        // answers produced while no socket was ready, within the grace
        const now = state.now();
        for (const [id, p] of [...state.pending]) {
          state.pending.delete(id);
          if (p.expires > now) deliverHere(p.res);
        }
        return;
      }
      if (!ready) throw new Error("Wait for ready before sending requests");
      if (frame.type === "cancel") {
        state.pending.delete(frame.id);
        state.running.get(frame.id)?.ctl.abort();
        return;
      }
      if (frame.type !== "req") throw new Error("Expected request or cancellation");
      // per-request problems get a typed answer; the socket and its other requests carry on
      const target =
        // lifecycle and owner policy controls are served while unbound too
        frame.op === "bindInstance" || frame.op === "policy" || frame.op === "policyStatus"
          ? { backend, handle }
          : binder
            ? binder.current()
            : hello.instanceGeneration === null
              ? undefined
              : { backend, handle };
      if (!target) {
        refuse(
          frame.id,
          "unsupported",
          "Instance is unbound; complete authenticated binding before operations",
        );
        return;
      }
      if (state.running.has(frame.id)) {
        refuse(frame.id, "error", "Duplicate request; use a fresh request id");
        return;
      }
      if (state.draining && REFUSED_WHILE_DRAINING.has(frame.op)) {
        refuse(frame.id, "unsupported", "The device is draining; retry after it reconnects");
        return;
      }
      const ctl = new AbortController();
      const timer = setTimeout(
        () => ctl.abort(new Error("Request deadline elapsed; retry the request")),
        frame.deadlineMs,
      );
      const done = serveOperationV3(target.backend, target.handle, frame, ctl.signal, binder, owner)
        .then((res) => {
          if (ctl.signal.aborted) return;
          deliver(res);
        })
        .catch(fail)
        .finally(() => {
          clearTimeout(timer);
          state.running.delete(frame.id);
        });
      state.running.set(frame.id, { op: frame.op, ctl, done });
    } catch (error) {
      fail(error);
    }
  });
  socket.on("close", () => {
    ready = undefined;
    if (state.current === deliverHere) state.current = undefined;
    for (const { op, ctl } of state.running.values())
      if (CONNECTION_FENCED.has(op)) ctl.abort(new Error("Connection closed; retry the read"));
  });
  try {
    parseDeviceFrameV3(JSON.stringify(hello), "device", hello.transport.maxFrameBytes);
    send(hello, hello.transport.maxFrameBytes);
  } catch (error) {
    fail(error);
  }
  return { ready: () => ready };
}
