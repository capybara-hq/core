import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Fields every log record written inside the current async context carries (`reqId` for an HTTP
 * request, `queue` / `jobId` / `runId` for a queue job). Read by the logger's pino mixin; the
 * context is per async call chain, never shared between requests.
 */
export type LogContext = Readonly<Record<string, string>>;

const storage = new AsyncLocalStorage<LogContext>();

/** A source of extra per-record fields, e.g. the active trace / span ids when tracing is on. */
type ContextSource = () => Record<string, string> | undefined;
let traceSource: ContextSource | undefined;

/** The fields of the current context (plus the trace source's), or undefined outside any. */
export function logContext(): LogContext | undefined {
  const own = storage.getStore();
  const trace = traceSource?.();
  if (!trace) return own;
  return own ? { ...own, ...trace } : trace;
}

/**
 * Registers the source of trace fields (`traceId` / `spanId`); set by the tracing bootstrap only
 * when tracing is enabled, so the kernel never imports OpenTelemetry itself.
 */
export function setTraceContextSource(source: ContextSource | undefined): void {
  traceSource = source;
}

/** Runs `fn` with `fields` added to the current context (undefined values are skipped). */
export function withLogContext<T>(fields: Record<string, string | undefined>, fn: () => T): T {
  const next: Record<string, string> = { ...storage.getStore() };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) next[k] = v;
  return storage.run(next, fn);
}

/** The part of a BullMQ job the context reads. */
export interface ContextJob {
  id?: string | undefined;
  data?: unknown;
}

/** Hooks around every queue job (the tracing bootstrap wraps jobs in a span through this). */
export type JobWrapper = <T>(queue: string, job: ContextJob, fn: () => Promise<T>) => Promise<T>;
let jobWrapper: JobWrapper | undefined;

/** Registers a wrapper run around every job processor (tracing); undefined removes it. */
export function setJobWrapper(wrapper: JobWrapper | undefined): void {
  jobWrapper = wrapper;
}

/**
 * Runs a queue job's processor with `queue`, `jobId` and, when the job data has one, `runId` in the
 * log context (and inside the registered job wrapper, if any).
 */
export function withJobContext<T>(
  queue: string,
  job: ContextJob,
  fn: () => Promise<T>,
): Promise<T> {
  const data = job.data as { runId?: unknown } | null | undefined;
  const runId = typeof data?.runId === "string" ? data.runId : undefined;
  return withLogContext({ queue, jobId: job.id, runId }, () =>
    jobWrapper ? jobWrapper(queue, job, fn) : fn(),
  );
}
