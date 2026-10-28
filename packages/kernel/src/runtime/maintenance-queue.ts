/**
 * The kernel maintenance queue (no `:`): wait timeouts (`wait-timeout`, see waits.ts), one-off
 * maintenance (sandbox destruction, connector drift, directory sync) and the periodic jobs not
 * converted to `@LockedCron` yet. The queue has one Worker (started on the `worker` role only) that
 * dispatches by job name to the registered handlers. Separate from the run queues: their handler,
 * stalled and failure handling assume "one job = one run"; maintenance jobs are short, with no
 * conversation lock or quota. A leaf module, so providers that add jobs (orgs/directory-sync.ts)
 * import the name without importing the worker (which imports their scheduler ids back).
 */
export const MAINTENANCE_QUEUE_NAME = "cap-kernel-maintenance";
