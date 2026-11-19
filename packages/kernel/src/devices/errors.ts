import { ApiError } from "../errors.js";
/** The device is missing, deleted, or not in the caller's org (404; ids cannot be probed). */
export const deviceNotFound = (): ApiError =>
  new ApiError("device.not_found", "This device does not exist or was deleted.");

/**
 * The device's machine was disconnected (revoked, signed out): 403 `device.forbidden`
 * with `details: [{ reason: "machine_revoked" }]`, so the tools tell the model what to ask for.
 */
export const machineRevoked = (): ApiError =>
  new ApiError(
    "device.forbidden",
    "The machine of this local device was disconnected. Run capybara-device logout, then capybara-device login on it, or pick another device.",
    [{ reason: "machine_revoked" }],
  );

/**
 * The device offers no projects (project root §4.1): a local machine whose `capybara-device`
 * does not announce `projects`, or a cloud provider without `list` / `scan`.
 */
export const projectsUnsupported = (local: boolean): ApiError =>
  new ApiError(
    "device.projects_unsupported",
    local
      ? "This device's capybara-device does not support projects; update capybara-device on that machine and reconnect it."
      : "This device's sandbox provider does not support projects; its conversations work without one.",
  );
