import { existsSync, lstatSync } from "node:fs";
import { plistPath } from "./launchd.js";
import { unitPath, unitWantsLink } from "./systemd.js";

/**
 * Whether a login service is installed here for one connection, by its file (the platform decides
 * which one): the file exists as soon as `service install` wrote it, with or without the service
 * running. On Linux the instance counts as installed when the template exists and its enable link
 * does.
 */
export function hasLoginService(
  home: string,
  platform: NodeJS.Platform,
  deviceId: string,
): boolean {
  if (platform === "darwin") return existsSync(plistPath(home, deviceId));
  if (platform === "linux") {
    return existsSync(unitPath(home)) && linkExists(unitWantsLink(home, deviceId));
  }
  return false;
}

function linkExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
