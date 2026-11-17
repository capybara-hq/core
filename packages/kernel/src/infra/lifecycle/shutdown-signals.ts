import type { KernelLogger } from "../../log.js";

/** The signals that shut the kernel down. */
export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const satisfies NodeJS.Signals[];

/** Where the signals come from and how the process ends (tests pass their own). */
export interface ShutdownSignalOptions {
  /** Default `process`. */
  signals?: Pick<NodeJS.EventEmitter, "on" | "off">;
  /**
   * Ends the process: 0 after a completed shutdown, 1 after a failed one or on a second signal.
   * Default `process.exit`.
   */
  exit?: (code: number) => void;
  /**
   * Subscribes to this process's fault (a swallowed fatal event, `onProcessFault`); returns the
   * unsubscribe. A fault runs the same graceful stop as a signal, then exits with 1 either way, so
   * any restart policy replaces the process (readiness alone restarts nothing: Kubernetes only
   * takes the pod out of its endpoints, a worker serves no traffic, compose does not restart an
   * unhealthy container). `capybara start` passes it; default: none (tests, library use).
   */
  faults?: (onFault: (kind: string) => void) => () => void;
}

export interface ShutdownSignalHandle {
  /** The shutdown a signal started, settled once `exit` was called; undefined before any signal. */
  exiting(): Promise<void> | undefined;
  /** Removes the listeners. */
  dispose(): void;
}

/**
 * Installs SIGTERM / SIGINT handlers around a running (or starting) kernel application, in place
 * of Nest's `enableShutdownHooks()`. The first signal runs `close` (`closeKernelApp`: the shutdown
 * begins at once, so a start in progress stops at its next checkpoint, then the stop phases and
 * the infra closes, all within the 30 s stop budget) and exits with 0, or 1 when it failed, after
 * flushing the logs. A second signal while that runs exits with 1 at once, so an operator's second
 * Ctrl-C (or an orchestrator's repeated SIGTERM) never waits on a stuck shutdown. Nest's handlers
 * would begin the shutdown only after every module's `onModuleDestroy`, ignore a second signal,
 * flush nothing and end the process by re-raising the signal. With `faults`, a swallowed fatal
 * event starts the same stop and exits with 1.
 */
export function handleShutdownSignals(
  close: () => Promise<void>,
  log: KernelLogger,
  opts: ShutdownSignalOptions = {},
): ShutdownSignalHandle {
  const signals = opts.signals ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let exiting: Promise<void> | undefined;
  // Set by a second signal: the forced exit(1) stays the process's code
  let forced = false;
  let unsubscribe = () => {};
  const dispose = () => {
    for (const s of SHUTDOWN_SIGNALS) signals.off(s, onSignal);
    unsubscribe();
  };
  /** Runs `close` once, then exits with `code` (1 when the stop failed). */
  function stop(code: 0 | 1): void {
    const end = (c: number) =>
      log
        .flush()
        .catch(() => {})
        .then(() => {
          dispose();
          if (!forced) exit(c);
        });
    exiting = close().then(
      () => end(code),
      (err: unknown) => {
        log.error("shutdown failed", { err });
        return end(1);
      },
    );
  }
  function onSignal(signal: NodeJS.Signals): void {
    if (exiting) {
      log.warn("second signal received; exiting immediately", { signal });
      dispose();
      forced = true;
      exit(1);
      return;
    }
    log.info("signal received; shutting down", { signal });
    stop(0);
  }
  for (const s of SHUTDOWN_SIGNALS) signals.on(s, onSignal);
  if (opts.faults) {
    unsubscribe = opts.faults((kind) => {
      if (exiting) return;
      log.error("fatal event swallowed; shutting down so the process is replaced", { kind });
      stop(1);
    });
  }
  return { exiting: () => exiting, dispose };
}
