import { lstatSync, readdirSync, statSync } from "node:fs";
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

/**
 * Connection directory names: real directories (never symlinks) with a valid device id. No
 * connections directory means no connections; any other failure to list it throws (fail closed: a
 * connection that cannot be listed cannot be kept out of the sandbox).
 */
function connectionIds(machineDir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(connectionsDir(machineDir), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ids: string[] = [];
  for (const e of entries) {
    if (!DEVICE_ID_PATTERN.test(e.name)) continue;
    try {
      if (!lstatSync(join(connectionsDir(machineDir), e.name)).isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // removed meanwhile
      throw error;
    }
    ids.push(e.name);
  }
  return ids;
}

const optionalString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The connection directories whose credential.json exists but cannot be read. */
export interface UnreadableConnection {
  deviceId: string;
  reason: string;
}

/**
 * Every connection of this machine, each credential read once: readable ones sorted by host, then
 * deviceName, then deviceId; unreadable ones (credential.json present but not readable or
 * invalid) sorted by deviceId. Skips non-directories, symlinks and names failing
 * {@link DEVICE_ID_PATTERN}; directories without credential.json (logged out: their policy, logs
 * and default working directory may remain) are listed by id in `credentialless`, sorted.
 */
export function scanConnections(machineDir: string = stateDir()): {
  readable: ConnectionInfo[];
  unreadable: UnreadableConnection[];
  credentialless: string[];
} {
  const readable: ConnectionInfo[] = [];
  const unreadable: UnreadableConnection[] = [];
  const credentialless: string[] = [];
  for (const id of connectionIds(machineDir)) {
    const dir = join(connectionsDir(machineDir), id);
    try {
      // only a missing credential.json means "no connection here"; one this program cannot even
      // stat (a directory it may not search) is unreadable, never skipped
      try {
        statSync(credentialPath(dir));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          credentialless.push(id);
          continue;
        }
        throw e;
      }
      const c = readCredential(dir);
      if (c === undefined) {
        credentialless.push(id); // removed in between
        continue;
      }
      readable.push({
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
    } catch (e) {
      unreadable.push({ deviceId: id, reason: (e as Error).message });
    }
  }
  const cmp = (a: string | null, b: string | null): number => (a ?? "").localeCompare(b ?? "");
  readable.sort(
    (a, b) => cmp(a.host, b.host) || cmp(a.deviceName, b.deviceName) || cmp(a.deviceId, b.deviceId),
  );
  unreadable.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  credentialless.sort((a, b) => a.localeCompare(b));
  return { readable, unreadable, credentialless };
}

/** The readable connections of {@link scanConnections}. */
export function listConnections(machineDir: string = stateDir()): ConnectionInfo[] {
  return scanConnections(machineDir).readable;
}

/** The unreadable connections of {@link scanConnections} (fail closed). */
export function unreadableConnections(machineDir: string = stateDir()): UnreadableConnection[] {
  return scanConnections(machineDir).unreadable;
}
