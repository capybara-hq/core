import { ApiError } from "../errors.js";
import type { SandboxMode } from "../sandbox/modes.js";
/** What a project's scope is read from: the device's mode now and the bases it gives. */
export interface DeviceProjectScope {
  source: "cloud" | "local";
  mode: SandboxMode;
  /**
   * How far restricted reads reach (B2): `os-user` only on a local machine whose owner chose it,
   * within a platform and org that allow the wider device ceiling; else the workspace.
   */
  reach: "workspace" | "os-user";
  /** The workspace root as last known (a machine's hello, a cloud instance's handle). */
  workspace: string;
  /** The owner's home a local machine reported; null when unknown (and for a cloud device). */
  home: string | null;
  supported: boolean;
}

type Scope = DeviceProjectScope;

/** Only the owner's home bounds nothing: OS-user reach on a machine reads what its owner can. */
const homeBased = (s: Pick<Scope, "source" | "reach">): boolean =>
  s.source === "local" && s.reach === "os-user";

/** The base a relative path is resolved against in the scope's mode (project root §4.2). */
export const baseOf = (s: Scope, workspace: string = s.workspace): string | null =>
  homeBased(s) ? s.home : workspace;

/**
 * `path` lies inside what the scope's mode may read (sandbox mode and cloud: the workspace, as the
 * held instance reports it when given).
 */
export const withinMode = (s: Scope, path: string, workspace: string = s.workspace): boolean =>
  homeBased(s) || path === workspace || path.startsWith(workspace === "/" ? "/" : `${workspace}/`);

export const nameInvalid = (name: string): ApiError =>
  new ApiError(
    "device.project_name_invalid",
    `"${clipped(name)}" is not a valid project name: use 1-64 characters, not . or .., without / or control characters, and without leading or trailing spaces`,
  );
export const nameTaken = (name: string): ApiError =>
  new ApiError(
    "device.project_name_taken",
    `This device already has a project named "${clipped(name)}"; pick another name`,
  );
export const projectNotFound = (name: string): ApiError =>
  new ApiError("device.project_not_found", `This device has no project named "${clipped(name)}"`);
export const outsideMode = (path: string, mode: SandboxMode): ApiError =>
  new ApiError(
    "device.project_outside_mode",
    mode === "sandbox"
      ? `${clipped(path)} is outside the device's workspace, the only directory it can read in sandbox mode`
      : `${clipped(path)} is outside the device's workspace, the only directory a cloud device can read`,
  );
export const tooBroad = (path: string): ApiError =>
  new ApiError(
    "device.project_path_too_broad",
    `${clipped(path)} holds the owner's home directory (or other people's): pick the project's own directory, the home or below it`,
  );

export const homeUnknown = (): ApiError =>
  new ApiError(
    "device.project_home_unknown",
    "In auto mode a project's path is relative to the owner's home directory, which this device has not reported; update capybara-device on that machine and reconnect it",
  );

/** A device-supplied or person-supplied string inside a message, bounded. */
export function clipped(s: string, max = 200): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
