/**
 * Debug-level stage timings of native file transfers (readFile / writeFile). Off by default:
 * `CAPYBARA_DEVICE_DEBUG_TIMINGS=1` prints one line per stage to stderr, and tests observe the
 * stages through {@link observeTransferTimings}. Timings carry no paths and no data.
 */
export type TransferStage =
  | "encode"
  | "digest"
  | "journal"
  | "prepare"
  | "spawn"
  | "serialise"
  | "helperIo"
  | "parse"
  | "total";

export interface TransferTiming {
  method: string;
  stage: TransferStage;
  ms: number;
}

const listeners = new Set<(timing: TransferTiming) => void>();

/** Observes every recorded stage until the returned function is called. */
export function observeTransferTimings(listener: (timing: TransferTiming) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recordTransferTiming(method: string, stage: TransferStage, ms: number): void {
  if (process.env.CAPYBARA_DEVICE_DEBUG_TIMINGS === "1")
    process.stderr.write(`[capybara-device] ${method} ${stage} ${ms.toFixed(1)} ms\n`);
  for (const listener of listeners)
    try {
      listener({ method, stage, ms });
    } catch {
      // instrumentation never changes an operation's outcome
    }
}

/** Runs `work` and records how long it took as `stage`. */
export function timed<T>(method: string, stage: TransferStage, work: () => T): T {
  const started = performance.now();
  const result = work();
  if (result instanceof Promise)
    return result.finally(() =>
      recordTransferTiming(method, stage, performance.now() - started),
    ) as T;
  recordTransferTiming(method, stage, performance.now() - started);
  return result;
}
