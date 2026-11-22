/**
 * What the device program's connection shares: the messages it ends with, the reconnect backoff
 * and the running connection's interface. The connection itself is the protocol 5 one
 * (`staged-connect.ts`).
 */
import {
  DEVICE_DIAL_IN_PROTOCOL,
  DEVICE_PROTOCOL_VERSION,
} from "@capybara-hq/plugin-sdk/device-protocol";

export const OUTDATED_MESSAGE =
  "This capybara-device is too old for the deployment. Upgrade it: npm install -g @capybara-hq/device@next";
/** A 426 from a kernel serving an older `capybara-device` protocol than this program's. */
export const deploymentOutdatedMessage = (kernelProtocol: string): string =>
  `The deployment is older than this capybara-device: it speaks ${kernelProtocol}, this program ${DEVICE_DIAL_IN_PROTOCOL}. Ask its super admin to upgrade the deployment first, or install a capybara-device release that speaks ${kernelProtocol}.`;
/** A 426 naming another program's protocol: the device is served by another provider. */
export const foreignProtocolMessage = (kernelProtocol: string): string =>
  `The deployment serves this device with ${kernelProtocol}, not with capybara-device (${DEVICE_DIAL_IN_PROTOCOL}). Connect it with the program of that protocol, or log this machine in to a new device: capybara-device logout, then capybara-device login.`;

/**
 * The message a 426 refusal ends the program with, from the refusal's body (the kernel's
 * `device.program_outdated` names the protocol it serves the device with, `<name>/<major>`): an
 * older `capybara-device` major means the deployment is to be upgraded first, another program's
 * protocol that the device is not this program's; else (a newer major, an unreadable body) this
 * program is outdated.
 */
export function outdatedMessage(body: string): string {
  let message = "";
  try {
    message = String((JSON.parse(body) as { error?: { message?: unknown } }).error?.message ?? "");
  } catch {}
  for (const [, name, major] of message.matchAll(
    /\b([a-z][a-z0-9-]{0,40})\/([1-9][0-9]{0,3})\b/g,
  )) {
    const protocol = `${name}/${major}`;
    if (protocol === DEVICE_DIAL_IN_PROTOCOL) continue;
    if (name !== "capybara-device") return foreignProtocolMessage(protocol);
    return Number(major) < DEVICE_PROTOCOL_VERSION
      ? deploymentOutdatedMessage(protocol)
      : OUTDATED_MESSAGE;
  }
  return OUTDATED_MESSAGE;
}
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
