// Ported from octok-platform libs/common/src/tracing/process-guards.ts (owner-approved, 2026-10-28).
import type { KernelLogger } from "../../log.js";

/**
 * Process-level guards for `capybara start`: an unhandled rejection or an uncaught exception is
 * logged and the process keeps running, unless they come in bursts.
 *
 * Node's default for an async failure nobody handles is to kill the process. That default assumes
 * the program state is corrupt, which holds for errors thrown by business logic, but the ones seen
 * in practice come from peripheral I/O (a telemetry export, an event emitter's `error` nobody
 * listens to, an SDK of an extension). With several replicas the same peripheral failure takes
 * every replica down at once. Both mechanisms are guarded: `unhandledRejection` alone does not
 * catch an `error` event thrown synchronously by an EventEmitter (`uncaughtException`).
 *
 * Swallowing is not unconditional: peripheral noise is sporadic, real corruption repeats. More than
 * {@link GUARD_CIRCUIT_LIMIT} fatal events within {@link GUARD_CIRCUIT_WINDOW_MS} open the circuit:
 * the process exits with 1 and the orchestrator (Kubernetes, docker restart) starts a clean one.
 *
 * What this cannot save: a V8 heap exhaustion is a hard abort no listener sees; and a resource that
 * first fails through an uncaught event and afterwards only through caught errors (500s) keeps the
 * process alive but broken, which used to self-heal through a crash and a restart. Known trade-off.
 *
 * Every line of the recorder is wrapped: a handler that throws while the process handles a fatal
 * event would defeat the guard. Records go through the kernel logger (pino, redacted) with
 * `marker: "process-guard"`; only `kind: "circuit-open"` is worth alerting on.
 *
 * Installed only by `capybara start` (apps/capybara), never by `createKernelApp` / tests / library
 * code paths: a library must not take over process-wide handlers.
 */

/** The fatal events allowed within the window; one more opens the circuit (exit 1). */
export const GUARD_CIRCUIT_LIMIT = 5;

/** The circuit's observation window (ms). */
export const GUARD_CIRCUIT_WINDOW_MS = 60_000;

/** The fixed marker on every guard record. */
export const GUARD_LOG_MARKER = "process-guard";

/** The guarded events (Node's two mechanisms) and the circuit opening. */
export type GuardKind = "unhandledRejection" | "uncaughtException" | "circuit-open";

export interface ProcessGuardDeps {
  /** The logger to write to, read on every event (`capybara start` switches to the configured one). */
  log: () => Pick<KernelLogger, "error">;
  /** Ends the process when the circuit opens. */
  exit: (code: number) => void;
  /** The current time in ms; default `Date.now`. */
  now?: () => number;
  /** Where the events come from; default `process`. */
  process?: Pick<NodeJS.EventEmitter, "on" | "off">;
}

/**
 * A recorder for fatal events: logs one record and exits once more than
 * {@link GUARD_CIRCUIT_LIMIT} events fell within {@link GUARD_CIRCUIT_WINDOW_MS}. Never throws.
 */
export function createFatalRecorder(
  deps: Omit<ProcessGuardDeps, "process">,
): (kind: Exclude<GuardKind, "circuit-open">, err: unknown) => void {
  const now = deps.now ?? Date.now;
  let recent: number[] = [];
  let open = false;
  return (kind, err) => {
    try {
      const t = now();
      recent = recent.filter((x) => t - x < GUARD_CIRCUIT_WINDOW_MS);
      recent.push(t);
      safely(() =>
        deps
          .log()
          .error(
            kind === "unhandledRejection" ? "unhandled promise rejection" : "uncaught exception",
            { marker: GUARD_LOG_MARKER, kind, err },
          ),
      );
      if (recent.length > GUARD_CIRCUIT_LIMIT && !open) {
        open = true;
        safely(() =>
          deps.log().error("too many fatal events; exiting so the process is restarted clean", {
            marker: GUARD_LOG_MARKER,
            kind: "circuit-open" satisfies GuardKind,
            events: recent.length,
            windowMs: GUARD_CIRCUIT_WINDOW_MS,
          }),
        );
        deps.exit(1);
      }
    } catch {
      // Recording must never take the process down: that is what this module prevents
    }
  };
}

/** Runs fn, swallowing what it throws (a logger failing must not skip the circuit). */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // ignored
  }
}

/** Installs both guards; returns a function that removes them. */
export function installProcessGuards(deps: ProcessGuardDeps): () => void {
  const target = deps.process ?? process;
  const record = createFatalRecorder(deps);
  const onRejection = (reason: unknown) => record("unhandledRejection", reason);
  const onException = (err: unknown) => record("uncaughtException", err);
  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);
  return () => {
    target.off("unhandledRejection", onRejection);
    target.off("uncaughtException", onException);
  };
}
