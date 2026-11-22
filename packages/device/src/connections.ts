import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DeviceMode } from "./args.js";
import { credentialPath, readCredential, stateDir, writePrivate } from "./state.js";

/**
 * The machine directory (`$XDG_CONFIG_HOME/capybara-device`) holds one directory per connection to
 * a deployment, keyed by the device id the deployment gave it:
 *
 *   machine.json                 { "version": 1 }
 *   run/                         0700; the control socket of each running connection
 *     <sha256(deviceId)[:16]>.sock
 *   connections/<deviceId>/      0700; credential.json, policy.json, policy.json.lock, pid,
 *                                commands.log, service.log, owner-report.json, other private files
 *
 * A device id comes from the deployment: it becomes a path segment only after
 * {@link DEVICE_ID_PATTERN} matches it.
 */
export const CONNECTIONS_DIR = "connections";
export const MACHINE_FILE = "machine.json";
export const MACHINE_FORMAT_VERSION = 1;
/** The machine-level directory of the control sockets: short, so the socket path fits 103 bytes. */
export const RUN_DIR = "run";
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** One readable connection of this machine. Never the credential itself. */
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
  /** the credential's working directory */
  workDir: string;
  mode: DeviceMode;
}

function assertDeviceId(deviceId: string): void {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error(
      `Invalid device id ${JSON.stringify(deviceId)}: expected 1 to 128 letters, digits, "_" or "-"`,
    );
  }
}

export function connectionsDir(machineDir: string): string {
  return join(machineDir, CONNECTIONS_DIR);
}

/** `<machineDir>/connections/<deviceId>`. Throws Error("Invalid device id …") unless DEVICE_ID_PATTERN matches. */
export function connectionDir(machineDir: string, deviceId: string): string {
  assertDeviceId(deviceId);
  return join(connectionsDir(machineDir), deviceId);
}

/**
 * The machine directory of a connection directory (the inverse of {@link connectionDir}). Throws
 * when `connectionStateDir` is not `<machineDir>/connections/<deviceId>`.
 */
export function machineDirOfConnection(connectionStateDir: string): string {
  const parent = dirname(connectionStateDir);
  if (
    basename(parent) !== CONNECTIONS_DIR ||
    !DEVICE_ID_PATTERN.test(basename(connectionStateDir))
  ) {
    throw new Error(
      `${connectionStateDir} is not a connection directory (<machineDir>/${CONNECTIONS_DIR}/<deviceId>)`,
    );
  }
  return dirname(parent);
}

export function runDir(machineDir: string): string {
  return join(machineDir, RUN_DIR);
}

/**
 * `<machineDir>/run/<first 16 hex of sha256(deviceId)>.sock`: a fixed-length name, so a long
 * device id or home directory does not push the path past the unix socket limit.
 */
export function controlSocketPathFor(machineDir: string, deviceId: string): string {
  assertDeviceId(deviceId);
  const name = createHash("sha256").update(deviceId).digest("hex").slice(0, 16);
  return join(runDir(machineDir), `${name}.sock`);
}

/** Creates machineDir (0700) and machine.json {version:1} (0600) when absent; throws on another version. */
export function ensureMachineFile(machineDir: string): void {
  mkdirSync(machineDir, { recursive: true, mode: 0o700 });
  const file = join(machineDir, MACHINE_FILE);
  if (!existsSync(file)) {
    writePrivate(file, `${JSON.stringify({ version: MACHINE_FORMAT_VERSION })}\n`);
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message})`);
  }
  const version = (raw as { version?: unknown } | null)?.version;
  if (version !== MACHINE_FORMAT_VERSION) {
    throw new Error(
      `${file} has format version ${JSON.stringify(version)}; this capybara-device reads version ` +
        `${MACHINE_FORMAT_VERSION}. Install the capybara-device release that wrote it`,
    );
  }
}

/** One snapshot of the connections directory: what can be used, and what cannot and why. */
export interface ConnectionScan {
  readable: ConnectionInfo[];
  unreadable: Array<{ deviceId: string; reason: string }>;
}

/** The connection a directory holds; throws why it cannot be used. */
function readConnection(dir: string, deviceId: string): ConnectionInfo {
  const cred = readCredential(dir);
  if (cred === undefined) throw new Error(`${credentialPath(dir)} is missing`);
  if (cred.deviceId !== deviceId) {
    throw new Error(
      `${credentialPath(dir)} names device ${JSON.stringify(cred.deviceId)}, not ${deviceId}; log in again`,
    );
  }
  let host: string;
  try {
    host = new URL(cred.url).host;
  } catch {
    throw new Error(`${credentialPath(dir)} is invalid: url is not a URL; log in again`);
  }
  return {
    deviceId,
    orgId: cred.orgId,
    url: cred.url,
    host,
    deviceName: cred.deviceName ?? null,
    orgName: cred.orgName ?? null,
    stateDir: dir,
    workDir: cred.dir,
    mode: cred.mode,
  };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === "ENOENT";

/**
 * {@link listConnections} and {@link unreadableConnections} from one read of the directory, for a
 * caller that needs both to agree. Only a missing file means "absent": a connection directory or
 * credential that cannot be examined (EACCES, ELOOP, …) is unreadable, never skipped, and a
 * `connections/` directory that cannot be read, or is not a directory (a symlink included), throws.
 * Fails closed: a caller that denies other connections' files never misses one silently.
 */
export function scanConnections(machineDir: string = stateDir()): ConnectionScan {
  const root = connectionsDir(machineDir);
  const unusable = (why: string): Error =>
    new Error(`${root} cannot be read (${why}); fix its permissions or remove it`);
  let names: string[];
  let isDir: boolean;
  try {
    // lstat: a symlinked connections/ is refused, never followed
    isDir = lstatSync(root).isDirectory();
    names = isDir ? readdirSync(root) : [];
  } catch (e) {
    if (isMissing(e)) return { readable: [], unreadable: [] };
    throw unusable((e as Error).message);
  }
  if (!isDir) throw unusable("not a directory");
  const out: ConnectionScan = { readable: [], unreadable: [] };
  for (const name of names.sort(compare)) {
    if (!DEVICE_ID_PATTERN.test(name)) continue;
    const dir = join(root, name);
    const unreadable = (reason: string): void => {
      out.unreadable.push({ deviceId: name, reason });
    };
    try {
      // lstat: a symlink is never followed, whatever it points at
      if (!lstatSync(dir).isDirectory()) continue;
    } catch (e) {
      if (!isMissing(e)) unreadable(`${dir} cannot be examined (${(e as Error).message})`);
      continue;
    }
    let cred: ReturnType<typeof lstatSync>;
    try {
      cred = lstatSync(credentialPath(dir));
    } catch (e) {
      if (!isMissing(e)) {
        unreadable(`${credentialPath(dir)} cannot be examined (${(e as Error).message})`);
      }
      continue;
    }
    if (!cred.isFile()) {
      unreadable(`${credentialPath(dir)} is not a file`);
      continue;
    }
    try {
      out.readable.push(readConnection(dir, name));
    } catch (e) {
      unreadable((e as Error).message);
    }
  }
  out.readable.sort(
    (a, b) =>
      compare(a.host, b.host) ||
      compare(a.deviceName ?? "", b.deviceName ?? "") ||
      compare(a.deviceId, b.deviceId),
  );
  return out;
}

/**
 * Readable connections, sorted by host, then deviceName, then deviceId. Skips non-directories,
 * symlinks, names failing DEVICE_ID_PATTERN, dirs without credential.json, unreadable ones (those
 * are in {@link unreadableConnections}). Throws when `connections/` cannot be read.
 */
export function listConnections(machineDir: string = stateDir()): ConnectionInfo[] {
  return scanConnections(machineDir).readable;
}

/** Connection directories with a credential.json that cannot be used, and why, by device id. */
export function unreadableConnections(
  machineDir: string = stateDir(),
): Array<{ deviceId: string; reason: string }> {
  return scanConnections(machineDir).unreadable;
}

/** Why no single connection was chosen; `candidates` are the connections to choose from. */
export class ConnectionSelectError extends Error {
  constructor(
    readonly code: "no_connection" | "not_found" | "ambiguous",
    message: string,
    readonly candidates: ConnectionInfo[],
  ) {
    super(message);
    this.name = "ConnectionSelectError";
  }
}

/** "host · orgName|orgId · deviceName|deviceId (deviceId)": one line of a listing. */
export function connectionLine(c: ConnectionInfo): string {
  return `${c.host} · ${c.orgName ?? c.orgId} · ${c.deviceName ?? c.deviceId} (${c.deviceId})`;
}

const listing = (cs: ConnectionInfo[]): string =>
  cs.map((c) => `  ${connectionLine(c)}`).join("\n");
const CHOOSE = "choose one with --connection <deviceId>";

/** deviceId exact, else deviceName exact, else host exact; implied when exactly one exists. */
export function resolveConnection(
  selector?: string,
  machineDir: string = stateDir(),
): ConnectionInfo {
  const { readable: all, unreadable } = scanConnections(machineDir);
  if (all.length === 0) {
    const broken = unreadable.map((u) => `\n  ${u.deviceId}: ${u.reason}`).join("");
    throw new ConnectionSelectError(
      "no_connection",
      `This machine has no usable connection to a deployment; connect it with ` +
        `capybara-device login --url <url>${broken === "" ? "" : `. Unreadable:${broken}`}`,
      [],
    );
  }
  if (selector === undefined) {
    if (all.length === 1) return all[0] as ConnectionInfo;
    throw new ConnectionSelectError(
      "ambiguous",
      `This machine has ${all.length} connections; ${CHOOSE}:\n${listing(all)}`,
      all,
    );
  }
  const byId = all.find((c) => c.deviceId === selector);
  if (byId !== undefined) return byId;
  for (const matches of [
    all.filter((c) => c.deviceName === selector),
    all.filter((c) => c.host === selector),
  ]) {
    if (matches.length === 1) return matches[0] as ConnectionInfo;
    if (matches.length > 1) {
      throw new ConnectionSelectError(
        "ambiguous",
        `${JSON.stringify(selector)} matches ${matches.length} connections; ${CHOOSE}:\n${listing(matches)}`,
        matches,
      );
    }
  }
  const broken = unreadable.find((u) => u.deviceId === selector);
  throw new ConnectionSelectError(
    "not_found",
    broken !== undefined
      ? `The connection ${JSON.stringify(selector)} cannot be used: ${broken.reason}`
      : `No connection matches ${JSON.stringify(selector)}; ${CHOOSE}:\n${listing(all)}`,
    all,
  );
}
