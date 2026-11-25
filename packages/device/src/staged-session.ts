import { randomUUID } from "node:crypto";
import {
  type DialInMachineFrame,
  parseDialInKernelFrame,
  parseDialInMachineFrame,
  type SandboxHandle,
} from "@capybara-hq/plugin-sdk";
import {
  DEVICE_DIAL_IN_PROTOCOL,
  type DeviceHello,
  type DevicePolicyChanged,
  type DeviceResponse,
  type DeviceResponseBody,
  type KernelRequest,
  parseDeviceFrame,
} from "@capybara-hq/plugin-sdk/device-protocol";
import type WebSocket from "ws";
import { currentBootId } from "./boot-id.js";
import { credentialIdentity, type InstanceBinder } from "./exec/instance-binding.js";
import type { MacOperationBackend } from "./exec/mac-operation-backend.js";
import { DrainPendingError } from "./exec/operation-supervisor.js";
import { type StagedOwnerPolicy, serveOperationV3 } from "./server-ops.js";
import { isServiceOpBody, serveServiceOp } from "./services/ops.js";
import { DialInStreamBridge, isKernelStreamFrame } from "./services/stream-bridge.js";
import type { ServiceSupervisor } from "./services/supervisor.js";
import type { Credential } from "./state.js";

/**
 * This process's run of the program, the same on every connection it makes: the results kept for
 * a reconnect live in this process, so a new value tells the kernel that requests sent to the old
 * run will never be answered (it ends their wait at once instead of at their deadline).
 */
export const PROGRAM_RUN_ID = randomUUID();

/** Held answers a session keeps at most while no socket is ready; the oldest is dropped first. */
export const MAX_HELD_ANSWERS = 64;

/**
 * What a staged (protocol 5) program keeps across its sockets, like protocol 2's connection
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
  /** Closes each socket this state serves; a discard closes them all. */
  readonly sockets: Set<() => void>;
  /** Answers waiting for the next ready socket, with their expiry. */
  readonly pending: Map<string, { res: DeviceResponse; expires: number }>;
  /** Delivers on the current ready socket; undefined while none is ready. */
  current: ((res: DeviceResponse) => void) | undefined;
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
    sockets: new Set(),
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
  for (const close of [...state.sockets]) close();
  state.sockets.clear();
}

/**
 * Holds an answer for the next ready socket: expired entries are swept first, and the oldest
 * entries are dropped beyond the limit, so a device that never reconnects stays bounded.
 */
function holdAnswer(state: StagedSessionState, res: DeviceResponse): void {
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
 * new instance binding, since a drained session never takes on a new generation (8.4 B4 M9); a
 * retried bindInstance is refused too, and a drained session is never reused.
 * Execution, background starts and native, preparation and browsing operations all reach the
 * supervisor, whose admission refuses only fresh operations while draining: a retry of an admitted
 * id (an answer lost on a socket blip) still recovers. Exact status, read, tail, stop, revoke and
 * policy reconciliation are always served.
 */
const REFUSED_WHILE_DRAINING = new Set(["create", "bindInstance"]);

/** Controls served while no generation is bound: binding and the machine lifecycle. */
const CONTROLS = new Set(["bindInstance", "create", "stop"]);

/**
 * The machine lifecycle of a staged program (`start` supplies it): `create` reports the roots of
 * a new instance, `stop` (revoked or deleted on the deployment) exact-stops what the program owns
 * before it is answered; `stopped` is called once that answer was handed to the socket, and ends
 * the program. `kernelStop` is the envelope's `stop` frame: the kernel asks the program to drain
 * (finish its work, then disconnect) or to stop at once.
 */
export interface StagedMachineControl {
  create(signal: AbortSignal): Promise<{ roots: import("@capybara-hq/plugin-sdk").SandboxRoots }>;
  stop(reason: "revoked" | "deleted", signal: AbortSignal): Promise<void>;
  stopped(reason: "revoked" | "deleted"): void;
  kernelStop?(reason: "drain" | "stop"): void;
}

/** A served socket: its `ready` state and the sender of unsolicited events. */
export interface StagedSession {
  /** The kernel's `ready`, with the connection's effective frame capacity; undefined before. */
  ready(): { connectionId: string; maxFrameBytes: number } | undefined;
  /**
   * Sends an event body on this connection once it is ready. False when it is not ready or the
   * frame does not fit the connection's capacity (nothing is sent).
   */
  event(body: DevicePolicyChanged): boolean;
}

/** The program facts a hello's envelope carries (`DialInMachineFrame`'s `program`). */
export type StagedProgram = Extract<DialInMachineFrame, { type: "hello" }>["program"];

/**
 * What a socket's hello says (`StagedDevice.report`): the program facts of the dial-in envelope
 * and the device protocol body. The session adds the protocol, this run's id and the capacity.
 */
export interface StagedHello {
  envelope: { program: StagedProgram };
  body: DeviceHello;
}

async function serveMachineControl(
  machine: StagedMachineControl | undefined,
  req: { id: string; op: string; args: Readonly<Record<string, unknown>> },
  signal: AbortSignal,
): Promise<DeviceResponse> {
  const sdk = await import("@capybara-hq/plugin-sdk");
  const proto = await import("@capybara-hq/plugin-sdk/device-protocol");
  try {
    if (!machine)
      throw new sdk.SandboxPermissionUnsupportedError(
        "This program cannot serve the machine lifecycle; update capybara-device",
      );
    if (req.op === "create")
      return {
        type: "res",
        id: req.id,
        ok: true,
        result: proto.parseOperationResult("create", await machine.create(signal)),
      };
    const reason = (req.args as { reason?: unknown }).reason;
    if (reason !== "revoked" && reason !== "deleted")
      throw new proto.DeviceProtocolError("A machine stop names its reason: revoked or deleted");
    await machine.stop(reason, signal);
    return { type: "res", id: req.id, ok: true, result: null };
  } catch (error) {
    return {
      type: "res",
      id: req.id,
      ok: false,
      error: {
        kind: sdk.isFileSystemGoneError(error)
          ? "fs_gone"
          : sdk.isSandboxWorkUnsettledError(error)
            ? "unsettled"
            : sdk.isSandboxPermissionUnsupportedError(error)
              ? "unsupported"
              : "error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

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
 * Serves one authenticated socket with the dial-in envelope: sends the hello (protocol
 * `capybara-device/6`, this run's id, the program facts, the credential's frame capacity and the
 * device protocol body), waits for `ready`, then answers each `req` body with a `res` body and
 * honours `cancel` and the kernel's `stop`. Every frame from the kernel is parsed strictly (the
 * envelope, then the request body) and bounded by the connection's capacity (the credential's
 * until `ready`, then the effective one `ready` names), which every frame sent obeys too; a
 * malformed frame closes the socket with 4400.
 *
 * Reconnect semantics follow protocol 2: a socket close aborts only in-flight output reads; every
 * other operation keeps running, and an answer produced while no socket is ready waits up to the
 * grace for the next ready socket served with the same `state`. A cancel reaches an operation
 * whichever socket it arrives on.
 */
export function serveStagedSession(
  socket: WebSocket,
  report: StagedHello,
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
  /** The owner's local controls: the command log and the running operations it lists. */
  owner?: StagedOwnerPolicy,
  /** Serves the machine lifecycle `create` and `stop`; without it they are unsupported. */
  machine?: StagedMachineControl,
  /**
   * The device's services (browser use spec §5, §6.1): the relay's `service.*` bodies and the
   * dial-in streams to them; without it both are refused.
   */
  services?: ServiceSupervisor,
): StagedSession {
  if (!state || state.discarded)
    throw new Error("Serve the session with the current credential's session state");
  const bootId = report.envelope.program.bootId ?? currentBootId();
  const cap = credential.maxFrameBytes;
  const hello = {
    type: "hello",
    protocol: DEVICE_DIAL_IN_PROTOCOL,
    programRunId: PROGRAM_RUN_ID,
    program: {
      ...report.envelope.program,
      // the host's OS boot identity: the deployment's evidence that the host restarted (8.5)
      ...(bootId !== undefined && { bootId }),
    },
    transport: { maxFrameBytes: cap },
    body: report.body,
  } satisfies DialInMachineFrame;
  let ready: { connectionId: string; maxFrameBytes: number } | undefined;
  /** This connection's capacity: the kernel's effective one once ready, the credential's before. */
  const limit = () => ready?.maxFrameBytes ?? cap;
  const send = (value: unknown) => {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > limit())
      throw new Error("Check device and deployment frame limits: control frame cannot fit");
    socket.send(raw);
  };
  const fail = (error: unknown) => socket.close(4400, String(error).slice(0, 100));
  /** The envelope of `res`, or of an error answer when it cannot fit the capacity. */
  const wire = (res: DeviceResponse) => {
    const { type: _type, id, ...body } = res;
    const frame = { type: "res" as const, id, body };
    return Buffer.byteLength(JSON.stringify(frame)) <= limit()
      ? frame
      : {
          type: "res" as const,
          id,
          body: {
            ok: false,
            error: {
              kind: "error",
              message: "Result exceeds negotiated capacity; check frame limits and retry",
            },
          },
        };
  };
  /** `res` itself, or the error answer {@link wire} would send instead. */
  const fit = (res: DeviceResponse): DeviceResponse => {
    const frame = wire(res);
    return { type: "res", id: frame.id, ...(frame.body as DeviceResponseBody) };
  };
  const deliverHere = (res: DeviceResponse) => {
    if (ready === undefined || socket.readyState !== socket.OPEN) {
      hold(res);
      return;
    }
    try {
      send(wire(res));
    } catch (error) {
      fail(error);
    }
  };
  // fitted to this socket's capacity, so a held answer is bounded in bytes as well as in count
  const hold = (res: DeviceResponse) => holdAnswer(state, fit(res));
  const deliver = (res: DeviceResponse) => {
    if (state.current) state.current(res);
    else hold(res);
  };
  const refuse = (id: string, kind: "unsupported" | "error", message: string) =>
    deliverHere({ type: "res", id, ok: false, error: { kind, message } });
  /** Services and streams run under the bound generation's sandbox: none while unbound. */
  const bound = () =>
    binder ? binder.current() !== undefined : report.body.instanceGeneration !== null;
  // this socket's streams: frames go straight over it, each within its capacity
  const streams = new DialInStreamBridge(
    {
      send(text) {
        if (ready === undefined || socket.readyState !== socket.OPEN) return false;
        if (Buffer.byteLength(text) > limit()) return false;
        socket.send(text);
        return true;
      },
      maxFrameBytes: limit,
    },
    async (body, signal) => {
      if (!services) throw new Error("This device program serves no device streams");
      if (!bound())
        throw new Error("Instance is unbound; complete authenticated binding before streams");
      return services.openStream(body, signal);
    },
  );
  const credentialChanged = () => socket.close(4401, "Credential changed; reconnect");
  state.sockets.add(credentialChanged);
  socket.on("message", (data, binary) => {
    // a socket opened before its credential's state was discarded admits nothing more
    if (state.discarded) {
      credentialChanged();
      return;
    }
    try {
      if (binary) throw new Error("Use JSON text frames");
      const envelope = parseDialInKernelFrame(data.toString(), limit());
      if (envelope.type === "ready") {
        // the effective capacity is at most what this program announced
        if (ready || envelope.maxFrameBytes > cap)
          throw new Error("Invalid ready capacity; reconnect");
        ready = { connectionId: envelope.connectionId, maxFrameBytes: envelope.maxFrameBytes };
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
      if (envelope.type === "stop") {
        // a session served without the machine lifecycle (tests) has nothing to stop
        machine?.kernelStop?.(envelope.reason);
        return;
      }
      if (envelope.type === "cancel") {
        state.pending.delete(envelope.id);
        state.running.get(envelope.id)?.ctl.abort();
        return;
      }
      if (isKernelStreamFrame(envelope)) {
        streams.onFrame(envelope);
        return;
      }
      if (envelope.type !== "req")
        throw new Error(`Unexpected ${(envelope as { type: string }).type} frame`);
      // a device service body (`service.*`, the device-local provider's): answered like an
      // operation, with a typed error for a malformed one
      if (isServiceOpBody(envelope.body)) {
        const id = envelope.id;
        if (!bound()) {
          refuse(
            id,
            "unsupported",
            "Instance is unbound; complete authenticated binding before services",
          );
          return;
        }
        if (state.running.has(id)) {
          refuse(id, "error", "Duplicate request; use a fresh request id");
          return;
        }
        if (state.draining && (envelope.body as { op: string }).op === "service.ensure") {
          refuse(id, "unsupported", "The device is draining; retry after it reconnects");
          return;
        }
        const ctl = new AbortController();
        const timer = setTimeout(
          () => ctl.abort(new Error("Request deadline elapsed; retry the request")),
          envelope.deadlineMs,
        );
        // always answered, an elapsed deadline as a typed error: a request's own wait ends
        // before the deadline (clamped), so the kernel hears why instead of nothing
        const done = serveServiceOp(services, envelope.body, ctl.signal, {
          deadlineMs: envelope.deadlineMs,
        })
          .then((answer) => deliver({ type: "res", id, ...answer } as DeviceResponse))
          .catch(fail)
          .finally(() => {
            clearTimeout(timer);
            state.running.delete(id);
          });
        state.running.set(id, { op: (envelope.body as { op: string }).op, ctl, done });
        return;
      }
      // a body this protocol does not define (a removed or unknown operation, an unscoped read)
      // is a protocol error like a malformed envelope: the socket closes with 4400
      const body = parseDeviceFrame(envelope.body, "req");
      const frame: KernelRequest = {
        type: "req",
        id: envelope.id,
        op: body.op,
        args: body.args,
        deadlineMs: envelope.deadlineMs,
      };
      // per-request problems get a typed answer; the socket and its other requests carry on
      const target =
        // binding and the machine lifecycle are served while unbound too
        CONTROLS.has(frame.op)
          ? { backend, handle }
          : binder
            ? binder.current()
            : report.body.instanceGeneration === null
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
      let overdue = false;
      const timer = setTimeout(() => {
        ctl.abort(new Error("Request deadline elapsed; retry the request"));
        // answered now, whatever the work does with its signal: the kernel hears that the
        // deadline passed instead of waiting in silence (a machine stop answers when it ends)
        if (frame.op === "stop") return;
        overdue = true;
        deliver({
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            kind: "unknown",
            message: `The machine did not finish ${frame.op} within its deadline of ${Math.ceil(frame.deadlineMs / 1000)} s; its outcome is unknown, check the device and retry`,
          },
        });
      }, frame.deadlineMs);
      const lifecycle = frame.op === "create" || frame.op === "stop";
      const done = (
        lifecycle
          ? serveMachineControl(machine, frame, ctl.signal)
          : serveOperationV3(target.backend, target.handle, frame, ctl.signal, binder, owner)
      )
        .then((res) => {
          // a machine stop is answered even when its deadline passed: the program ends anyway
          // after the deadline (answered then) or a cancel (the kernel gave up): one answer at most
          if (overdue || (ctl.signal.aborted && frame.op !== "stop")) return;
          deliver(res);
          // a valid machine stop ends the program even when some stops are still pending (its
          // answer names them): the machine is revoked or deleted either way
          const reason = (frame.args as { reason?: unknown }).reason;
          if (frame.op === "stop" && machine && (reason === "revoked" || reason === "deleted"))
            machine.stopped(reason);
        })
        // work that fails after its overdue answer went out has nothing left to tell
        .catch((error: unknown) => {
          if (!overdue) fail(error);
        })
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
    streams.closeAll("connection closed");
    state.sockets.delete(credentialChanged);
    ready = undefined;
    if (state.current === deliverHere) state.current = undefined;
    for (const { op, ctl } of state.running.values())
      if (CONNECTION_FENCED.has(op)) ctl.abort(new Error("Connection closed; retry the read"));
  });
  try {
    // the hello as the kernel and the provider will read it: the envelope, then the body
    const text = JSON.stringify(hello);
    parseDialInMachineFrame(text, cap);
    parseDeviceFrame(hello.body, "hello");
    send(hello);
  } catch (error) {
    fail(error);
  }
  return {
    ready: () => ready,
    event(body) {
      if (ready === undefined || socket.readyState !== socket.OPEN) return false;
      const raw = JSON.stringify({ type: "event", body });
      if (Buffer.byteLength(raw) > limit()) return false;
      socket.send(raw);
      return true;
    },
  };
}
