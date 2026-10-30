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
 * flush nothing and end the process by re-raising the signal.
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
  const dispose = () => {
    for (const s of SHUTDOWN_SIGNALS) signals.off(s, onSignal);
  };
  function onSignal(signal: NodeJS.Signals): void {
    if (exiting) {
      log.warn("second signal received; exiting immediately", { signal });
      dispose();
      forced = true;
      exit(1);
      return;
    }
    log.info("signal received; shutting down", { signal });
    const end = (code: number) =>
      log
        .flush()
        .catch(() => {})
        .then(() => {
          dispose();
          if (!forced) exit(code);
        });
    exiting = close().then(
      () => end(0),
      (err: unknown) => {
        log.error("shutdown failed", { err });
        return end(1);
      },
    );
  }
  for (const s of SHUTDOWN_SIGNALS) signals.on(s, onSignal);
  return { exiting: () => exiting, dispose };
}
