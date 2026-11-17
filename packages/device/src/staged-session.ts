import {
  type DeviceHelloV3,
  type DeviceResponseV3,
  type KernelReadyV3,
  parseDeviceFrameV3,
  type SandboxHandle,
} from "@capybara-hq/plugin-sdk";
import type WebSocket from "ws";
import type { InstanceBinder } from "./exec/instance-binding.js";
import type { MacOperationBackend } from "./exec/mac-operation-backend.js";
import { serveOperationV3 } from "./server-ops.js";
import type { Credential } from "./state.js";

/**
 * What a staged (protocol 3) program keeps across its sockets, like protocol 2's connection
 * (`client.ts`): the running operations and the answers produced while no socket was ready.
 */
export interface StagedSessionState {
  readonly graceMs: number;
  readonly running: Map<string, { op: string; ctl: AbortController; done: Promise<void> }>;
  /** Set by {@link drainStagedSession}; never cleared in this process (a drained device is not reused). */
  draining: boolean;
  /** Answers waiting for the next ready socket, with their expiry. */
  readonly pending: Map<string, { res: DeviceResponseV3; expires: number }>;
  /** Delivers on the current ready socket; undefined while none is ready. */
  current: ((res: DeviceResponseV3) => void) | undefined;
}

export function createStagedSessionState(opts: { graceMs: number }): StagedSessionState {
  return {
    graceMs: opts.graceMs,
    running: new Map(),
    pending: new Map(),
    current: undefined,
    draining: false,
  };
}

/**
 * Operations whose answer is fenced to the connection their request came on: an output read is
 * sized for that connection's capacity and the kernel refuses its answer on another one, so a
 * socket close aborts it (the kernel retries the read from the same offset).
 */
const CONNECTION_FENCED = new Set(["backgroundReadOutput"]);

/**
 * Admissions a draining session refuses here: unsupervised native, preparation and browsing
 * operations and instance creation. Execution and background starts reach the supervisor, which
 * refuses only fresh admissions (a retry of an admitted id stays recoverable); exact status, read,
 * tail, stop, revoke and policy reconciliation are always served.
 */
const REFUSED_WHILE_DRAINING = new Set([
  "readFile",
  "writeFile",
  "stat",
  "list",
  "scan",
  "prepareReadFile",
  "prepareWriteFile",
  "prepareStat",
  "browseStat",
  "browseList",
  "browseScan",
  "create",
]);

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
  while (state.running.size > 0 && !signal.aborted)
    await Promise.race([
      Promise.allSettled([...state.running.values()].map((r) => r.done)),
      aborted,
    ]);
  if (!signal.aborted) {
    try {
      await backend.lifecycle.settle(signal);
      if (state.running.size === 0) return { drained: true };
    } catch {
      // reported below with what is still owned
    }
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
  state: StagedSessionState = createStagedSessionState({ graceMs: 0 }),
  /**
   * The post-commit binder (B4). With one, operations go to the generation it bound (none while
   * unbound) and `bindInstance` is served; without one, the fixed backend serves a bound hello.
   */
  binder?: InstanceBinder,
): { ready: () => KernelReadyV3 | undefined } {
  const hello: DeviceHelloV3 = {
    ...report,
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
  const hold = (res: DeviceResponseV3) => {
    if (state.graceMs > 0) state.pending.set(res.id, { res, expires: Date.now() + state.graceMs });
  };
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
        const now = Date.now();
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
        frame.op === "bindInstance"
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
      const done = serveOperationV3(target.backend, target.handle, frame, ctl.signal, binder)
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
