import { queueAfterCommit } from "./transaction-host.js";

/**
 * Runs a side effect (enqueue a job, publish on the bus) only after the root transaction commits;
 * a rollback drops it; it runs outside any transaction. Outside a transaction it runs immediately.
 * A failing hook is logged and
 * never fails the committed call.
 */
export function afterCommit(fn: () => void | Promise<void>): void {
  queueAfterCommit(fn);
}
