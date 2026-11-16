/**
 * Whether this process swallowed a fatal event (an unhandled rejection or uncaught exception the
 * process guards kept running through). Readiness answers 503 from then on so the orchestrator
 * replaces the replica; liveness is unchanged. Per-process state about this process itself, never
 * shared across replicas, and never cleared (a faulted process is meant to be replaced).
 */
let fault: { kind: string } | undefined;

/** Marks this process faulted (idempotent: the first kind stays). */
export function markProcessFaulted(kind: string): void {
  fault ??= { kind };
}

/** The kind of the first swallowed fatal event, or `undefined` while the process is clean. */
export function processFault(): { kind: string } | undefined {
  return fault;
}

/** Test seam: clears the state. */
export function resetProcessFault(): void {
  fault = undefined;
}
