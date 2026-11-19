import { join } from "node:path";

/**
 * The local control socket of a running `capybara-device` (JSON lines over a unix socket, mode
 * 0600, in the owner-only state directory): what the desktop app and `status` ask the runner.
 */

/** The longest socket path this program binds: macOS `sun_path` holds 104 bytes with its NUL. */
export const CONTROL_PATH_MAX_BYTES = 103;

/** The longest line a peer may send; a longer one ends that connection. */
export const CONTROL_LINE_MAX_BYTES = 64 * 1024;

/** The most unread answer bytes a connection may queue; past it the connection is closed. */
export const CONTROL_WRITE_MAX_BYTES = 1024 * 1024;

/** `<stateDir>/control.sock`. */
export function controlSocketPath(stateDir: string): string {
  return join(stateDir, "control.sock");
}

export const CONTROL_OPS = ["status", "running", "subscribe", "drain", "stop"] as const;

/** One request line. `id` is the peer's own (a positive integer); the answer carries it back. */
export type ControlRequest = {
  id: number;
  op: "status" | "running" | "subscribe" | "drain" | "stop";
};

/** One answer line. A line without a usable id is answered with id 0. */
export type ControlResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } };

/** A line pushed to a connection that subscribed, after each status change. */
export type ControlEvent = { event: "status"; status: LiveStatus };

/** The runner's state now. Never the credential. */
export interface LiveStatus {
  pid: number;
  version: string;
  url: string;
  orgId: string;
  deviceId: string;
  mode: "os" | "docker";
  connection: "starting" | "online" | "offline" | "draining";
  /** Why it is offline (the last connection failure), only while offline. */
  offlineReason?: string;
  /** When `connection` last changed (ISO 8601). */
  since: string;
  /** Keep-awake now: the policy mode, whether the assertion is held, why it cannot be. */
  keepAwake: { mode: "off" | "while-busy" | "connected"; held: boolean; unavailable?: string };
  /** When this program last noticed the computer woke from sleep (ISO 8601), once it did. */
  lastWakeAt?: string;
}
