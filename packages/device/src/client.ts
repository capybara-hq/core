import {
  DEVICE_PROTOCOL_VERSION,
  type DeviceFeature,
  type DeviceHello,
  type DeviceRes,
  type KernelReq,
  parseDeviceFrame,
} from "@capybara-hq/plugin-sdk";
import WebSocket from "ws";
import type { CommandLog } from "./command-log.js";
import type { Executor } from "./exec/types.js";
import type { PolicyStore } from "./policy-store.js";
import {
  logEntryFor,
  type OpContext,
  policySummary,
  type SeenState,
  serveOp,
  summaryFacts,
} from "./server-ops.js";
import type { Credential } from "./state.js";
import { PROGRAM_VERSION } from "./version.js";

export const OUTDATED_MESSAGE =
  "This capybara-device is too old for the deployment. Upgrade it: npm install -g @capybara-hq/device@next";
export const DISCONNECTED_MESSAGE =
  "This machine was disconnected from the deployment. Run capybara-device logout, then capybara-device login.";
export const REPLACED_MESSAGE =
  "This machine connected elsewhere: a newer connection to this device replaced this one.";
export const DELETED_MESSAGE =
  "The device was deleted on the deployment. The files on this machine stay where they are.";

/** The answer sent instead of a result whose frame would exceed the connection's frame limit. */
export const TOO_LARGE_MESSAGE = "result larger than the connection's frame limit";

/** A failing connection is reported at most this often. */
const FAILURE_REPORT_INTERVAL_MS = 60_000;

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

export interface ConnectOptions {
  log?: CommandLog;
  /**
   * The local policy the executor reads: its summary goes in each hello, and the `policy` op
   * edits it. Without it the device does not offer the `policy` op.
   */
  policy?: PolicyStore;
  err?: (line: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  programVersion?: string;
  /** A connection must stay up this long before the backoff resets (default 10 s). */
  stableMs?: number;
  /** Terminate a socket that heard nothing from the server for this long (default 60 s). */
  livenessMs?: number;
  /** Terminate a socket still closing this long after we asked it to close (default 2 s). */
  closeTimeoutMs?: number;
  /**
   * How often a connected program checks its policy summary for a change made on the machine
   * (default 2 s); a change is pushed to the deployment as a `policy` frame.
   */
  policyCheckMs?: number;
}

/**
 * A running connection. `done` resolves with the exit code once the program should end: 0 for the
 * terminal conditions (revoked, outdated, replaced, deleted, stopped, drained), so a service
 * manager that restarts on failure leaves it stopped.
 */
export interface Connection {
  readonly done: Promise<number>;
  /** Accept no new operations; end when the running ones have finished. */
  drain(): void;
  /** Close the socket and end. */
  stop(): void;
}

/** Backoff before reconnect attempt `attempt` (0-based): 1 s doubling to 60 s, with jitter. */
export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

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

type SessionEnd = { exit: number; message?: string } | { reconnect: true };

/** Connects this machine to the deployment and serves operations until told to stop. */
export function connect(
  cred: Credential,
  executor: Executor,
  opts: ConnectOptions = {},
): Connection {
  const err = opts.err ?? ((l: string) => console.error(l));
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const graceMs = cred.reconnectGraceSeconds * 1000;
  const stableMs = opts.stableMs ?? 10_000;
  const livenessMs = opts.livenessMs ?? 60_000;
  const closeTimeoutMs = opts.closeTimeoutMs ?? 2000;
  const policyCheckMs = opts.policyCheckMs ?? 2000;

  const lifetime = new AbortController();
  let ws: WebSocket | undefined;
  let draining = false;
  let stopping = false;
  let exitAfterStop: { exit: number; message?: string } | undefined;
  let session: ((end: SessionEnd) => void) | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  /** What the requests of this run have seen (the latest exec's mode), over reconnects. */
  const seen: SeenState = {};
  const ctx: OpContext = {
    seen,
    ...(opts.policy !== undefined && { policy: opts.policy }),
  };

  const running = new Map<string, AbortController>();
  /** Requests the kernel gave up on: never started, or their result is dropped. */
  const cancelled = new Map<string, number>();
  /** Requests already seen (running, answered): a repeated req is ignored. */
  const known = new Map<string, number>();
  /** Answers produced while no socket was open, with their expiry. */
  const pending = new Map<string, { res: DeviceRes; expires: number }>();

  const prune = (): void => {
    const t = now();
    for (const m of [cancelled, known]) for (const [k, exp] of m) if (exp <= t) m.delete(k);
    for (const [k, v] of pending) if (v.expires <= t) pending.delete(k);
  };

  const isOpen = (): boolean => ws !== undefined && ws.readyState === WebSocket.OPEN;

  /** The policy summary now: the store's policy (re-read when its file changed) and the facts. */
  const summaryNow = () =>
    opts.policy === undefined
      ? undefined
      : policySummary(opts.policy.current(), summaryFacts(executor, ctx));
  /** The summary the deployment last got on this connection (hello, `policy` op, `policy` frame). */
  let sentPolicy: string | undefined;

  /**
   * Pushes the policy summary when it differs from the one the deployment last got: the owner
   * changed the mode or the policy on the machine (`capybara-device mode` / `policy ...`), or an
   * exec brought a new mode ceiling. Without it the deployment would learn the change only at the
   * next connect.
   */
  const pushPolicy = (): void => {
    if (!isOpen()) return;
    const summary = summaryNow();
    if (summary === undefined) return;
    const json = JSON.stringify(summary);
    if (json === sentPolicy) return;
    sentPolicy = json;
    ws?.send(JSON.stringify({ type: "policy", policy: summary }));
  };

  /** `res`, or an error answer when its frame would exceed the deployment's frame limit. */
  const fit = (res: DeviceRes): DeviceRes =>
    Buffer.byteLength(JSON.stringify(res)) <= cred.maxFrameBytes
      ? res
      : {
          type: "res",
          id: res.id,
          ok: false,
          error: { kind: "error", message: TOO_LARGE_MESSAGE },
        };

  const deliver = (answer: DeviceRes): void => {
    const res = fit(answer);
    if (isOpen()) {
      ws?.send(JSON.stringify(res), (e) => {
        if (e) pending.set(res.id, { res, expires: now() + graceMs });
      });
    } else {
      pending.set(res.id, { res, expires: now() + graceMs });
    }
  };

  const endSession = (end: SessionEnd): void => {
    const s = session;
    session = undefined;
    s?.(end);
  };

  /** Ends the loop: no more reconnects, and a backoff sleep in progress wakes up. */
  const halt = (): void => {
    stopping = true;
    lifetime.abort();
  };

  /** Asks the socket to close; terminates it if the close handshake does not finish. */
  const closeSocket = (sock: WebSocket | undefined): void => {
    if (!sock) return;
    sock.close(1000);
    setTimeout(() => sock.terminate(), closeTimeoutMs).unref();
  };

  const finishDrain = (): void => {
    clearTimeout(drainTimer);
    exitAfterStop = { exit: 0 };
    halt();
    closeSocket(ws);
    if (!isOpen()) endSession({ exit: 0 });
  };

  const maybeFinishDrain = (): void => {
    if (!draining || running.size > 0 || stopping) return;
    prune();
    if (pending.size > 0 && !isOpen()) {
      // Results wait for a reconnect, at most the grace.
      drainTimer ??= setTimeout(finishDrain, graceMs);
      return;
    }
    finishDrain();
  };

  const handleReq = (req: KernelReq): void => {
    prune();
    if (cancelled.has(req.id)) return; // the kernel gave up before it started: never start it
    if (running.has(req.id) || known.has(req.id)) return;
    known.set(req.id, now() + graceMs + req.deadlineMs);
    if (draining && req.op !== "stop") {
      deliver({
        type: "res",
        id: req.id,
        ok: false,
        error: { kind: "error", message: "draining" },
      });
      return;
    }
    const ctl = new AbortController();
    running.set(req.id, ctl);
    void serveOp(executor, req, ctl.signal, ctx).then(({ res, detail, run }) => {
      running.delete(req.id);
      opts.log?.append(logEntryFor(req, res, new Date(now()), detail, run));
      if (cancelled.has(req.id)) {
        // The kernel is no longer waiting for this one.
      } else if (req.op === "stop") {
        const reason = (req.args as { reason: "revoked" | "deleted" }).reason;
        exitAfterStop =
          reason === "revoked"
            ? { exit: 0, message: DISCONNECTED_MESSAGE }
            : { exit: 0, message: DELETED_MESSAGE };
        halt();
        const sock = ws;
        if (isOpen() && sock) {
          sock.send(JSON.stringify(res), () => closeSocket(sock));
        } else {
          endSession(exitAfterStop);
        }
        return;
      } else {
        // a policy op's answer carries the summary the deployment stores
        if (req.op === "policy" && res.ok) {
          sentPolicy = JSON.stringify((res.result as { policy: unknown }).policy);
        }
        deliver(res);
        // an exec may have changed the ceiling (the effective mode)
        pushPolicy();
      }
      maybeFinishDrain();
    });
  };

  const handleCancel = (id: string): void => {
    prune();
    cancelled.set(id, now() + graceMs);
    pending.delete(id);
    running.get(id)?.abort();
  };

  const onMessage = (raw: string): void => {
    let frame: ReturnType<typeof parseDeviceFrame>;
    try {
      frame = parseDeviceFrame(raw, "kernel");
    } catch (e) {
      // Best effort: tell the kernel a request it sent was unusable.
      try {
        const o = JSON.parse(raw) as { type?: string; id?: unknown };
        if (o.type === "req" && typeof o.id === "string" && o.id !== "") {
          deliver({
            type: "res",
            id: o.id,
            ok: false,
            error: { kind: "error", message: `invalid request: ${(e as Error).message}` },
          });
        }
      } catch {
        // not JSON: ignore
      }
      return;
    }
    if (frame.type === "req") handleReq(frame);
    else if (frame.type === "cancel") handleCancel(frame.id);
  };

  /**
   * The hello, built at each (re)connect: the OS mode reports blocked hosts per command (Docker
   * mode has no per-host view); the device applies `limits.mode` / `limits.network` (`mode`); the
   * policy summary is the store's policy now, with the effective mode and the latest ceiling seen;
   * then the outcomes of the latest policy ops by op id.
   */
  const hello = (): DeviceHello => {
    const summary = summaryNow();
    sentPolicy = summary === undefined ? undefined : JSON.stringify(summary);
    const features: DeviceFeature[] = [];
    if (executor.mode === "os") features.push("networkReport");
    // the policy op, logged by its op id (policy-ops.json next to the policy)
    if (opts.policy !== undefined) features.push("policyOp", "policyOpId");
    features.push("mode");
    return {
      type: "hello",
      protocol: DEVICE_PROTOCOL_VERSION,
      programVersion: opts.programVersion ?? PROGRAM_VERSION,
      os: process.platform === "darwin" ? "darwin" : "linux",
      arch: process.arch,
      mode: executor.mode,
      roots: executor.roots,
      sessionIsolation: false,
      features,
      ...(summary !== undefined && { policy: summary }),
      // what became of the latest policy ops, so an answer lost with a connection is not lost
      ...(opts.policy !== undefined && { recentOps: opts.policy.ops.recent() }),
    };
  };

  let attempt = 0;
  /** When a failing connection was last reported; reset once a connection stays up. */
  let lastReport: number | undefined;

  /** Reports why connecting keeps failing, at most once a minute. */
  const reportFailure = (why: string): void => {
    const t = now();
    if (lastReport !== undefined && t - lastReport < FAILURE_REPORT_INTERVAL_MS) return;
    lastReport = t;
    err(`${why} Retrying.`);
  };

  const runSession = (): Promise<SessionEnd> =>
    new Promise<SessionEnd>((resolve) => {
      session = resolve;
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
      /** The deployment answered the upgrade with an HTTP status (already handled). */
      let answered = false;
      const heard = (): void => {
        clearTimeout(liveness);
        liveness = setTimeout(() => sock.terminate(), livenessMs);
      };
      sock.on("ping", heard);
      sock.on("open", () => {
        opened = true;
        heard();
        stable = setTimeout(() => {
          attempt = 0;
          lastReport = undefined;
        }, stableMs);
        sock.send(JSON.stringify(hello()));
        if (opts.policy !== undefined) policyCheck = setInterval(pushPolicy, policyCheckMs);
        prune();
        for (const [id, p] of pending) {
          pending.delete(id);
          deliver(p.res);
        }
        maybeFinishDrain();
      });
      sock.on("message", (data, isBinary) => {
        heard();
        if (isBinary) return;
        onMessage(data.toString("utf8"));
      });
      sock.on("unexpected-response", (_req, res) => {
        answered = true;
        const status = res.statusCode ?? 0;
        res.resume();
        sock.terminate();
        if (status === 401) return endSession({ exit: 0, message: DISCONNECTED_MESSAGE });
        if (status === 426) return endSession({ exit: 0, message: OUTDATED_MESSAGE });
        reportFailure(
          status === 404
            ? `Connecting to ${cred.connectUrl} failed: HTTP 404. The deployment must route ` +
                "/device/connect to its gateway (see the deployment docs)."
            : `Connecting to ${cred.connectUrl} failed: HTTP ${status}.`,
        );
        endSession({ reconnect: true });
      });
      sock.on("error", (e) => {
        // 'close' follows; the reason is decided there. A failure before the socket opened is a
        // connection attempt that did not reach the deployment.
        if (!opened && !answered && !stopping) {
          reportFailure(`Cannot reach ${cred.connectUrl}: ${e.message}.`);
        }
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
      const end = await runSession();
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

  const done = loop().finally(() => {
    clearTimeout(drainTimer);
    lifetime.abort();
    for (const ctl of running.values()) ctl.abort();
  });

  return {
    done,
    drain() {
      draining = true;
      maybeFinishDrain();
    },
    stop() {
      halt();
      if (ws) closeSocket(ws);
      else endSession({ exit: 0 });
    },
  };
}
