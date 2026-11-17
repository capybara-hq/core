/**
 * Whether this process swallowed a fatal event (an unhandled rejection or uncaught exception the
 * process guards kept running through). Readiness answers 503 from then on, and `capybara start`
 * stops gracefully and exits with 1 (`onProcessFault`, wired by `handleShutdownSignals`) so any
 * restart policy replaces the process; liveness is unchanged. Per-process state about this process
 * itself, never shared across replicas, and never cleared (a faulted process is meant to be
 * replaced).
 */
let fault: { kind: string } | undefined;
const listeners = new Set<(kind: string) => void>();

/**
 * Marks this process faulted (idempotent: the first kind stays, and only the first mark notifies
 * the listeners; a listener that throws does not keep the others from running).
 */
export function markProcessFaulted(kind: string): void {
  if (fault !== undefined) return;
  fault = { kind };
  for (const l of [...listeners]) {
    try {
      l(kind);
    } catch {
      // a listener failing must not stop the others (nor reach the guard that marked the fault)
    }
  }
}

/** The kind of the first swallowed fatal event, or `undefined` while the process is clean. */
export function processFault(): { kind: string } | undefined {
  return fault;
}

/**
 * Calls `listener` when this process is marked faulted (at once when it already is); returns a
 * function that removes it.
 */
export function onProcessFault(listener: (kind: string) => void): () => void {
  if (fault !== undefined) {
    listener(fault.kind);
    return () => {};
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: clears the state (the listeners stay). */
export function resetProcessFault(): void {
  fault = undefined;
}
