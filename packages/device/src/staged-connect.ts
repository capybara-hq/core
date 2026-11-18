import { DEVICE_PROTOCOL_VERSION } from "@capybara-hq/plugin-sdk";
import WebSocket from "ws";
import { currentBootId } from "./boot-id.js";
import {
  backoffMs,
  type Connection,
  DELETED_MESSAGE,
  DISCONNECTED_MESSAGE,
  OUTDATED_MESSAGE,
  REPLACED_MESSAGE,
} from "./client.js";
import { policySummary } from "./server-ops.js";
import { type OwnedStop, type StagedDevice, unconfirmedStops } from "./staged-device.js";
import {
  drainStagedSession,
  type StagedSessionState,
  serveStagedSession,
  stagedSessionIdentity,
} from "./staged-session.js";
import type { Credential } from "./state.js";

/** Printed when the machine credential changed under a running program. */
export const CREDENTIAL_CHANGED_MESSAGE =
  "The machine credential changed (a new login). Restarting with the new one.";

/** How long a stop (`capybara-device stop`, a signal) waits for the owned work to be stopped. */
export const STOP_CANCEL_TIMEOUT_MS = 10_000;

export interface StagedConnectOptions {
  err?: (line: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  programVersion?: string;
  home?: string;
  /** The host's OS boot identity in each hello (default: read once from the OS); null leaves it out. */
  bootId?: string | null;
  stableMs?: number;
  livenessMs?: number;
  closeTimeoutMs?: number;
  /** How often the owner report is checked for a change made on the machine (default 2 s). */
  policyCheckMs?: number;
  /**
   * The machine credential now, read only before each reconnect, never while a socket is open
   * (default: the one the program started with). A different credential discards the old one's
   * session state, held answers included, stops the old credential's work and ends the program
   * with exit 1, so the service manager (or the owner) starts it again with the new credential.
   */
  credential?: () => Credential | undefined;
}

type SessionEnd = { exit: number; message?: string } | { reconnect: true };

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Connects a staged (protocol 3) program and serves it until told to stop (permission activation
 * W3-M), with protocol 2's lifetime rules (`connect`): backoff, liveness, 401 / 426 / replaced /
 * revoked endings. Each socket is served by {@link serveStagedSession} with the credential's one
 * session state ({@link StagedDevice.states}, grace from the credential), the binder and the owner
 * policy; a machine stop exact-stops the owned work before it is answered; a drain refuses new
 * admissions and ends once the requests and everything the bound backend owns settled.
 */
export function connectStaged(device: StagedDevice, opts: StagedConnectOptions = {}): Connection {
  const err = opts.err ?? ((l: string) => console.error(l));
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const stableMs = opts.stableMs ?? 10_000;
  const livenessMs = opts.livenessMs ?? 60_000;
  const closeTimeoutMs = opts.closeTimeoutMs ?? 2000;
  const policyCheckMs = opts.policyCheckMs ?? 2000;
  const bootId = opts.bootId === undefined ? currentBootId() : (opts.bootId ?? undefined);
  const started = device.cred;
  const identity = stagedSessionIdentity(started);

  const lifetime = new AbortController();
  let ws: WebSocket | undefined;
  let stopping = false;
  let draining = false;
  let exitAfterStop: { exit: number; message?: string } | undefined;
  let session: ((end: SessionEnd) => void) | undefined;
  let state: StagedSessionState = device.states.for(started);

  const endSession = (end: SessionEnd): void => {
    const s = session;
    session = undefined;
    s?.(end);
  };
  const halt = (): void => {
    stopping = true;
    lifetime.abort();
  };
  const closeSocket = (sock: WebSocket | undefined): void => {
    if (!sock) return;
    sock.close(1000);
    setTimeout(() => sock.terminate(), closeTimeoutMs).unref();
  };
  const finish = (end: { exit: number; message?: string }): void => {
    exitAfterStop = end;
    halt();
    const sock = ws;
    if (sock && sock.readyState === WebSocket.OPEN) closeSocket(sock);
    else endSession(end);
  };

  /**
   * Exact-stops everything the program owns, bounded: what has not settled by then is logged by
   * operation id (it stays owned, `cancel-pending`). Every end of the program goes through it once.
   */
  let cancelling: Promise<OwnedStop[]> | undefined;
  const stopOwned = (signal?: AbortSignal): Promise<OwnedStop[]> => {
    state.draining = true;
    cancelling ??= device
      .cancelOwners(
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(STOP_CANCEL_TIMEOUT_MS)])
          : AbortSignal.timeout(STOP_CANCEL_TIMEOUT_MS),
      )
      .catch((): OwnedStop[] => [])
      .then((stops) => {
        const pending = unconfirmedStops(stops);
        if (pending.length > 0)
          err(
            `${pending.length} operation(s) still stopping after the stop request: ` +
              `${pending.map((p) => p.operationId).join(", ")}. They may keep running; check them on this machine.`,
          );
        return pending;
      });
    return cancelling;
  };

  /**
   * A drained program still holding answers for a socket waits until a ready socket took them,
   * at most the credential's grace (protocol 2's drain does the same).
   */
  const heldAnswersDelivered = async (): Promise<void> => {
    const deadline = Date.now() + state.graceMs;
    for (;;) {
      const now = Date.now();
      for (const [id, p] of state.pending) if (p.expires <= now) state.pending.delete(id);
      if (state.pending.size === 0 || now >= deadline || lifetime.signal.aborted) return;
      await defaultSleep(Math.min(100, deadline - now), lifetime.signal);
    }
  };

  const machine = {
    create: (signal: AbortSignal) => device.create(signal),
    stop: async (_reason: "revoked" | "deleted", signal: AbortSignal) => {
      // the machine is going away: nothing new is admitted, the owned work is stopped exactly
      const pending = await stopOwned(signal);
      if (pending.length > 0)
        throw new Error(
          `The machine stopped admitting work, but ${pending.length} operation(s) are still ` +
            `stopping: ${pending.map((p) => p.operationId).join(", ")}`,
        );
    },
    stopped: (reason: "revoked" | "deleted") =>
      finish({
        exit: 0,
        message: reason === "revoked" ? DISCONNECTED_MESSAGE : DELETED_MESSAGE,
      }),
  };

  let attempt = 0;
  let lastReport: string | undefined;
  let lastReportAt: number | undefined;
  const reportFailure = (why: string): void => {
    const t = Date.now();
    if (why === lastReport && lastReportAt !== undefined && t - lastReportAt < 60_000) return;
    lastReport = why;
    lastReportAt = t;
    err(`${why} Retrying.`);
  };

  const runSession = (cred: Credential): Promise<SessionEnd> =>
    new Promise<SessionEnd>((resolveSession) => {
      session = resolveSession;
      const sock = new WebSocket(cred.connectUrl, {
        headers: {
          Authorization: `Bearer ${cred.credential}`,
          "X-Capybara-Device-Protocol": String(DEVICE_PROTOCOL_VERSION),
        },
      });
      ws = sock;
      let liveness: ReturnType<typeof setTimeout> | undefined;
      let stable: ReturnType<typeof setTimeout> | undefined;
      let policyCheck: ReturnType<typeof setInterval> | undefined;
      let opened = false;
      let answered = false;
      const heard = (): void => {
        clearTimeout(liveness);
        liveness = setTimeout(() => sock.terminate(), livenessMs);
      };
      sock.on("ping", heard);
      sock.on("message", heard);
      sock.on("open", () => {
        opened = true;
        heard();
        stable = setTimeout(() => {
          attempt = 0;
          lastReport = undefined;
          lastReportAt = undefined;
        }, stableMs);
        void (async () => {
          let served: ReturnType<typeof serveStagedSession>;
          try {
            const report = await device.report({
              ...(opts.programVersion !== undefined && { programVersion: opts.programVersion }),
              ...(opts.home !== undefined && { home: opts.home }),
              ...(bootId !== undefined && { bootId }),
            });
            if (sock.readyState !== WebSocket.OPEN) return;
            served = serveStagedSession(
              sock,
              report,
              cred,
              device.backend(),
              device.handle,
              state,
              device.binder,
              device.owner,
              machine,
            );
          } catch (error) {
            err(`Cannot report this device: ${(error as Error).message}`);
            sock.close(4400, "Device report unavailable; reconnect");
            return;
          }
          // the owner changed the ceiling on the machine: push the new owner report
          let sent = JSON.stringify(report_(device));
          policyCheck = setInterval(() => {
            void (async () => {
              await device.owner.reconcile(AbortSignal.timeout(30_000));
              if (!served.ready() || sock.readyState !== WebSocket.OPEN) return;
              const next = report_(device);
              const json = JSON.stringify(next);
              if (json === sent) return;
              sent = json;
              sock.send(JSON.stringify({ type: "policy", ...next }));
            })().catch((error: unknown) =>
              err(`Owner ceiling reconciliation failed: ${String(error)}`),
            );
          }, policyCheckMs);
        })();
      });
      sock.on("unexpected-response", (_req, res) => {
        answered = true;
        const status = res.statusCode ?? 0;
        res.resume();
        sock.terminate();
        if (status === 401) return endSession({ exit: 0, message: DISCONNECTED_MESSAGE });
        if (status === 426) return endSession({ exit: 1, message: OUTDATED_MESSAGE });
        reportFailure(`Connecting to ${cred.connectUrl} failed: HTTP ${status}.`);
        endSession({ reconnect: true });
      });
      sock.on("error", (e) => {
        if (!opened && !answered && !stopping)
          reportFailure(`Cannot reach ${cred.connectUrl}: ${e.message}.`);
      });
      sock.on("close", (code, reason) => {
        clearTimeout(liveness);
        clearTimeout(stable);
        clearInterval(policyCheck);
        if (ws === sock) ws = undefined;
        if (exitAfterStop) return endSession(exitAfterStop);
        if (code === 4002) return endSession({ exit: 0, message: REPLACED_MESSAGE });
        if (code === 4003) return endSession({ exit: 0, message: DISCONNECTED_MESSAGE });
        if (code === 4400) {
          const why = reason.toString("utf8");
          reportFailure(`The deployment closed the connection: 4400${why ? ` ${why}` : ""}.`);
        }
        endSession({ reconnect: true });
      });
    });

  const loop = async (): Promise<number> => {
    while (!stopping) {
      const cred = opts.credential?.() ?? started;
      if (stagedSessionIdentity(cred) !== identity) {
        // another credential: its state replaces (discards) ours; our work does not outlive it
        // (stopped as the program ends, below)
        state = device.states.for(cred);
        err(CREDENTIAL_CHANGED_MESSAGE);
        return 1;
      }
      const end = await runSession(cred);
      if ("exit" in end) {
        if (end.message) err(end.message);
        return end.exit;
      }
      if (stopping) break;
      await sleep(backoffMs(attempt++, random), lifetime.signal);
    }
    if (exitAfterStop?.message) err(exitAfterStop.message);
    return exitAfterStop?.exit ?? 0;
  };

  // every end (stop, drain, machine stop, 401 / 426, replaced, revoked, a new credential) leaves
  // no owned work running: v2 aborted every running request as its connection ended
  const done = loop()
    .then(async (code) => {
      await stopOwned();
      return code;
    })
    .finally(() => {
      lifetime.abort();
    });

  return {
    done,
    drain() {
      if (draining) return;
      draining = true;
      // no new admission at once; ends when the requests and the owned work settled
      void drainStagedSession(state, device.drainTarget(), new AbortController().signal)
        .then(() => heldAnswersDelivered())
        .then(() => finish({ exit: 0 }))
        .catch((error: unknown) => {
          err(`Drain failed: ${String(error)}`);
          finish({ exit: 1 });
        });
    },
    stop() {
      if (stopping || exitAfterStop) return;
      exitAfterStop = { exit: 0 };
      // a stopped program leaves no work running: the owned operations are stopped exactly
      void stopOwned().then(() => finish({ exit: 0 }));
    },
  };
}

/** The owner report and policy summary a `policy` frame carries. */
function report_(device: StagedDevice) {
  return {
    policy: policySummary(device.owner.store.current(), { mode: device.mode }),
    ownerCeiling: device.owner.report(),
  };
}
