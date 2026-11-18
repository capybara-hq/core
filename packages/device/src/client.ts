/**
 * What the device program's connection shares: the messages it ends with, the reconnect backoff
 * and the running connection's interface. The connection itself is the protocol 3 one
 * (`staged-connect.ts`).
 */

export const OUTDATED_MESSAGE =
  "This capybara-device is too old for the deployment. Upgrade it: npm install -g @capybara-hq/device@next";
export const DISCONNECTED_MESSAGE =
  "This machine was disconnected from the deployment. Run capybara-device logout, then capybara-device login.";
export const REPLACED_MESSAGE =
  "This machine connected elsewhere: a newer connection to this device replaced this one.";
export const DELETED_MESSAGE =
  "The device was deleted on the deployment. The files on this machine stay where they are.";

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

/**
 * A running connection. `done` resolves with the exit code once the program should end: 0 for a
 * deliberate stop (revoked, replaced by a newer connection of this device, deleted, stopped,
 * drained), which a service manager that restarts on failure leaves stopped; 1 when the deployment
 * needs a newer program (426), which an upgrade in place recovers once the service starts it again.
 * Connection failures never end it: they reconnect with backoff.
 */
export interface Connection {
  readonly done: Promise<number>;
  /** Accept no new operations; end when the running ones have finished. */
  drain(): void;
  /** Close the socket and end. */
  stop(): void;
}

/** Backoff before reconnect attempt `attempt` (0-based): 1 s doubling to 60 s, with jitter. */
export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

export {
  createStagedSessionState,
  drainStagedSession,
  type StagedDrainReport,
  serveStagedSession,
} from "./staged-session.js";
