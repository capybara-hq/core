import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DeviceMode } from "./args.js";
import { credentialPath, readCredential, stateDir } from "./state.js";

/** The directory under the machine's state directory that holds one directory per connection. */
export const CONNECTIONS_DIR = "connections";
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** One deployment this machine is connected to, read from its credential. */
export interface ConnectionInfo {
  deviceId: string;
  orgId: string;
  url: string;
  /** URL host[:port] */
  host: string;
  deviceName: string | null;
  orgName: string | null;
  /** connections/<deviceId> */
  stateDir: string;
  /** The credential's working directory. */
  workDir: string;
  mode: DeviceMode;
}

export function connectionsDir(machineDir: string): string {
  return join(machineDir, CONNECTIONS_DIR);
}

/** Connection directory names: real directories (never symlinks) with a valid device id. */
function connectionIds(machineDir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(connectionsDir(machineDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const e of entries) {
    if (!DEVICE_ID_PATTERN.test(e.name)) continue;
    try {
      if (!lstatSync(join(connectionsDir(machineDir), e.name)).isDirectory()) continue;
    } catch {
      continue;
    }
    ids.push(e.name);
  }
  return ids;
}

const optionalString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Readable connections, sorted by host, then deviceName, then deviceId. Skips non-directories,
 * symlinks, names failing {@link DEVICE_ID_PATTERN}, directories without credential.json and
 * unreadable ones (see {@link unreadableConnections}).
 */
export function listConnections(machineDir: string = stateDir()): ConnectionInfo[] {
  const out: ConnectionInfo[] = [];
  for (const id of connectionIds(machineDir)) {
    const dir = join(connectionsDir(machineDir), id);
    try {
      const c = readCredential(dir);
      if (c === undefined) continue;
      out.push({
        deviceId: id,
        orgId: c.orgId,
        url: c.url,
        host: new URL(c.url).host,
        deviceName: optionalString((c as { deviceName?: unknown }).deviceName),
        orgName: optionalString((c as { orgName?: unknown }).orgName),
        stateDir: dir,
        workDir: c.dir,
        mode: c.mode,
      });
    } catch {
      // Reported by unreadableConnections.
    }
  }
  const cmp = (a: string | null, b: string | null): number => (a ?? "").localeCompare(b ?? "");
  return out.sort(
    (a, b) => cmp(a.host, b.host) || cmp(a.deviceName, b.deviceName) || cmp(a.deviceId, b.deviceId),
  );
}

/** The connection directories whose credential.json exists but cannot be read (fail closed). */
export function unreadableConnections(
  machineDir: string = stateDir(),
): Array<{ deviceId: string; reason: string }> {
  const out: Array<{ deviceId: string; reason: string }> = [];
  for (const id of connectionIds(machineDir)) {
    const dir = join(connectionsDir(machineDir), id);
    if (!existsSync(credentialPath(dir))) continue;
    try {
      const c = readCredential(dir);
      if (c !== undefined) new URL(c.url);
    } catch (e) {
      out.push({ deviceId: id, reason: (e as Error).message });
    }
  }
  return out.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}
