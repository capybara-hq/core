import { ApiError } from "../errors.js";
/** The device is missing, deleted, or not in the caller's org (404; ids cannot be probed). */
export const deviceNotFound = (): ApiError =>
  new ApiError("device.not_found", "This device does not exist or was deleted.");

/**
 * The machine serving a dial-in device was disconnected (revoked, signed out): 403
 * `device.forbidden` with `details: [{ reason: "machine_revoked" }]`, so the tools tell the model
 * what to ask for.
 */
export const machineRevoked = (): ApiError =>
  new ApiError(
    "device.forbidden",
    "The machine serving this device was disconnected. Sign that machine in to this device again, or pick another device.",
    [{ reason: "machine_revoked" }],
  );

/**
 * The device offers no projects (project root §4.1): its provider does not implement `list`
 * (or `scan`).
 */
export const projectsUnsupported = (): ApiError =>
  new ApiError(
    "device.projects_unsupported",
    "This device's provider does not support projects; its conversations work without one.",
  );
