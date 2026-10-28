/** Whether the process is shutting down; readiness answers 503 from then on. */
export interface ShutdownState {
  isShuttingDown(): boolean;
}

/** Injection token of the {@link ShutdownState}. Provided by the root module. */
export const SHUTDOWN_STATE = Symbol("SHUTDOWN_STATE");
