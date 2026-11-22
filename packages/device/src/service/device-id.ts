import { DEVICE_ID_PATTERN } from "../connections.js";

/**
 * A device id becomes part of a launchd label, a plist or link file name and a systemd instance
 * name only after it matches the pattern: nothing else may reach a path or a unit name.
 */
export function serviceDeviceId(deviceId: string): string {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error(
      `Invalid device id ${JSON.stringify(deviceId)}: expected 1 to 128 letters, digits, "_" or "-"`,
    );
  }
  return deviceId;
}
