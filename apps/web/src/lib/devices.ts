import { apiFetch } from "./api";

/**
 * Device sign-in as the confirmation page `/device` uses it (the kernel's
 * `packages/kernel/src/devices/device-auth.controller.ts`; environments spec §13.3). Web code never
 * imports kernel code.
 */

/** The machine waiting behind a user code, as `capybara-device login` described it. */
export interface PendingMachine {
  name: string;
  os: string;
  arch: string;
  programVersion: string;
}

export interface PendingDevice {
  machine: PendingMachine;
  expiresAt: string;
}

/** Confirm into an existing connected environment (`environmentId`) or a new one (`name`). */
export type DeviceConfirmInput = { userCode: string; orgId: string } & (
  | { environmentId: string }
  | { name: string }
);

/** The 20 consonants a user code is made of (the kernel's `USER_CODE_ALPHABET`). */
const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;

/**
 * A user code as typed → `XXXX-XXXX`, or null when it cannot be one (case, spaces and the dash
 * are forgiven, as the kernel forgives them).
 */
export function normalizeUserCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  return USER_CODE_RE.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
}

/** The user code a `?code=` parameter names ("" without one): normalized when it can be one. */
export function codeParam(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  return s === "" ? "" : (normalizeUserCode(s) ?? s);
}

/** The org a device is connected into first: the session's current org, else its first. */
export const defaultDeviceOrg = (me: {
  currentOrgId: string | null;
  memberships: { orgId: string }[];
}): string | undefined => me.currentOrgId ?? me.memberships[0]?.orgId;

/** An OS as the program reports it (`darwin`, `linux`) → its name (not translated). */
export function osLabel(os: string): string {
  switch (os) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return os;
  }
}

/** The command that installs the connector program. */
export const DEVICE_INSTALL_COMMAND = "npm install -g @capybara-hq/device";

/** The command that connects a machine to the deployment at `origin`. */
export const deviceLoginCommand = (origin: string) => `capybara-device login --url ${origin}`;

const base = "/api/v1/device";

export const peekDevice = (userCode: string) =>
  apiFetch<PendingDevice>(`${base}/pending/${encodeURIComponent(userCode)}`);

export const confirmDevice = (input: DeviceConfirmInput) =>
  apiFetch<{ environmentId: string }>(`${base}/confirm`, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const denyDevice = (userCode: string) =>
  apiFetch<void>(`${base}/deny`, { method: "POST", body: JSON.stringify({ userCode }) });
