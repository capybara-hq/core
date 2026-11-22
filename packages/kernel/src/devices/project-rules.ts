import { ApiError } from "../errors.js";
import type { SandboxMode } from "../sandbox/modes.js";
/** What a project's scope is read from: the device's mode now and the bases it gives. */
export interface DeviceProjectScope {
  mode: SandboxMode;
  /** The workspace root as last known (the held instance's handle). */
  workspace: string;
  /**
   * The home its provider last reported (`devices.report.home`): projects are relative to it and
   * the kernel narrows no path below it (where a project may lie is the provider's rule); null
   * when the provider reports none, and projects stay in the workspace.
   */
  home: string | null;
  supported: boolean;
}

type Scope = DeviceProjectScope;

/** The base a relative path resolves against (project root §4.2): the home, else the workspace. */
export const baseOf = (s: Scope, workspace: string = s.workspace): string => s.home ?? workspace;

/**
 * `path` lies inside what the kernel lets the scope's projects reach: anywhere when the provider
 * reports a home (the provider refuses what it will not serve), else inside the workspace (as the
 * held instance reports it when given).
 */
export const withinMode = (s: Scope, path: string, workspace: string = s.workspace): boolean =>
  s.home !== null ||
  path === workspace ||
  path.startsWith(workspace === "/" ? "/" : `${workspace}/`);

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

/** A device-supplied or person-supplied string inside a message, bounded. */
export function clipped(s: string, max = 200): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
