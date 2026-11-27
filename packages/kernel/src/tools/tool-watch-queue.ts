/**
 * The watched-wait poll queue (browser long waits spec §5.3), spelled without Nest dependencies so
 * the questions service, the outbox registry and the health overview name it without importing
 * the worker module. No `:` in the queue name or job ids.
 */
export const TOOL_WATCH_QUEUE = "cap-kernel-tool-watch";

/** The queue's one job name: poll the watcher of one watched question. */
export const TOOL_WATCH_JOB = "tool-watch";

/** One job per watched question: `tool-watch-<questionId>`. */
export const toolWatchJobId = (questionId: string): string => `tool-watch-${questionId}`;

/** A `tool-watch` job's data: the org scope (`runJob`), the question, the failures in a row. */
export interface ToolWatchJobData {
  orgId: string;
  questionId: string;
  failures: number;
}

/** How often a pending watched wait's watcher is polled. */
export const TOOL_WATCH_INTERVAL_MS = 10_000;

/** How long one watcher call may take before it is aborted (counted as a failure). */
export const TOOL_WATCH_TIMEOUT_MS = 5_000;

/** Consecutive watcher failures that wake the call (the resumed handler reports what is wrong). */
export const TOOL_WATCH_MAX_FAILURES = 3;

/** The poll timings ({@link TOOL_WATCH_TIMINGS}). */
export interface ToolWatchTimings {
  intervalMs: number;
  timeoutMs: number;
}

/**
 * Optional provider (a kernel test seam): shorter poll timings than {@link TOOL_WATCH_INTERVAL_MS}
 * and {@link TOOL_WATCH_TIMEOUT_MS}, read by the ask (the first poll's delay) and the poll.
 */
export const TOOL_WATCH_TIMINGS = Symbol("TOOL_WATCH_TIMINGS");

/** The timings in force: the seam's, else the production constants. */
export function toolWatchTimings(seam?: Partial<ToolWatchTimings>): ToolWatchTimings {
  return {
    intervalMs: seam?.intervalMs ?? TOOL_WATCH_INTERVAL_MS,
    timeoutMs: seam?.timeoutMs ?? TOOL_WATCH_TIMEOUT_MS,
  };
}
