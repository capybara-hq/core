import { existsSync } from "node:fs";
import { plistPath } from "./launchd.js";
import { unitPath } from "./systemd.js";

/**
 * Whether a login service is installed here, by its file (the platform decides which one): the
 * file exists as soon as `service install` wrote it, with or without the service running.
 */
export function hasLoginService(home: string, platform: NodeJS.Platform): boolean {
  if (platform === "darwin") return existsSync(plistPath(home));
  if (platform === "linux") return existsSync(unitPath(home));
  return false;
}
