import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeviceMode } from "./args.js";

/** What `login` stores: how to reach the deployment and who this machine is there. */
export interface Credential {
  url: string;
  connectUrl: string;
  credential: string;
  orgId: string;
  deviceId: string;
  dir: string;
  mode: DeviceMode;
  /** The deployment's `devices.local.reconnectGraceSeconds`, returned with the credential. */
  reconnectGraceSeconds: number;
  /** The deployment's `devices.local.maxFrameBytes`: no frame this program sends is larger. */
  maxFrameBytes: number;
}

/** Local limits the person sets for this machine. */
export interface Policy {
  allowedDomains: string[];
  allowCredentials: string[];
  cpu: number | null;
  memoryMb: number | null;
}

const DEFAULT_RECONNECT_GRACE_SECONDS = 120;
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const DEFAULT_POLICY: Policy = {
  allowedDomains: [],
  allowCredentials: [],
  cpu: null,
  memoryMb: null,
};

type Env = Record<string, string | undefined>;

/** `$XDG_CONFIG_HOME/capybara-device`, or `~/.config/capybara-device`. */
export function stateDir(env: Env = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : join(home, ".config");
  return join(base, "capybara-device");
}

export function credentialPath(dir: string): string {
  return join(dir, "credential.json");
}

export function policyPath(dir: string): string {
  return join(dir, "policy.json");
}

/** The lock file that serializes read-modify-writes of policy.json across processes. */
export function policyLockPath(dir: string): string {
  return join(dir, "policy.json.lock");
}

/** The default working directory of a device: `~/capybara-device/<deviceId>`. */
export function defaultWorkDir(deviceId: string, home: string = homedir()): string {
  return join(home, "capybara-device", deviceId);
}

export function writePrivate(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function writeCredential(dir: string, cred: Credential): void {
  writePrivate(credentialPath(dir), `${JSON.stringify(cred, null, 2)}\n`);
}

/** The stored credential; undefined when absent. Throws on a file other users can read, or on bad content. */
export function readCredential(dir: string): Credential | undefined {
  const file = credentialPath(dir);
  if (!existsSync(file)) return undefined;
  if ((statSync(file).mode & 0o077) !== 0) {
    throw new Error(
      `${file} is readable by other users; refusing to use it. Run chmod 600 ${file}, or log in again`,
    );
  }
  let raw: Partial<Credential>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Credential>;
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message})`);
  }
  for (const key of ["url", "connectUrl", "credential", "orgId", "deviceId", "dir", "mode"]) {
    if (typeof raw[key as keyof Credential] !== "string") {
      throw new Error(`${file} is invalid: missing ${key}; log in again`);
    }
  }
  const grace = raw.reconnectGraceSeconds ?? DEFAULT_RECONNECT_GRACE_SECONDS;
  if (!Number.isInteger(grace) || grace <= 0) {
    throw new Error(`${file} is invalid: reconnectGraceSeconds must be a positive integer`);
  }
  const maxFrameBytes = raw.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new Error(`${file} is invalid: maxFrameBytes must be a positive integer`);
  }
  return { ...(raw as Credential), reconnectGraceSeconds: grace, maxFrameBytes };
}

export function removeCredential(dir: string): boolean {
  const file = credentialPath(dir);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isCeiling = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isFinite(v) && v > 0);

const POLICY_KEYS: readonly string[] = Object.keys(DEFAULT_POLICY);

/** The local policy (defaults when absent). Throws, naming the file, on bad JSON or field types. */
export function readPolicy(dir: string): Policy {
  return readPolicyFile(dir).policy;
}

/**
 * The local policy plus the file's keys this version does not know (kept on every write, so an
 * older program never drops a newer one's settings). Throws like {@link readPolicy}.
 */
export function readPolicyFile(dir: string): { policy: Policy; extra: Record<string, unknown> } {
  const file = policyPath(dir);
  if (!existsSync(file)) return { policy: { ...DEFAULT_POLICY }, extra: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} is invalid: expected a JSON object`);
  }
  const policy: Policy = { ...DEFAULT_POLICY, ...(raw as Partial<Policy>) };
  const bad = (key: string, want: string): Error =>
    new Error(`${file} is invalid: ${key} must be ${want} (fix or delete the file)`);
  if (!isStringList(policy.allowedDomains)) throw bad("allowedDomains", "a list of strings");
  if (!isStringList(policy.allowCredentials)) throw bad("allowCredentials", "a list of strings");
  if (!isCeiling(policy.cpu)) throw bad("cpu", "a positive number or null");
  if (!isCeiling(policy.memoryMb)) throw bad("memoryMb", "a positive number or null");
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!POLICY_KEYS.includes(k)) extra[k] = v;
  return {
    policy: {
      allowedDomains: policy.allowedDomains,
      allowCredentials: policy.allowCredentials,
      cpu: policy.cpu,
      memoryMb: policy.memoryMb,
    },
    extra,
  };
}

/** Writes policy.json atomically (owner-only); `extra` are unknown keys to keep. */
export function writePolicy(
  dir: string,
  policy: Policy,
  extra: Record<string, unknown> = {},
): void {
  writePrivate(policyPath(dir), `${JSON.stringify({ ...extra, ...policy }, null, 2)}\n`);
}

/** A lock file older than this is left over by a crashed process and is taken over. */
const POLICY_LOCK_STALE_MS = 10_000;
const POLICY_LOCK_WAIT_MS = 2_000;
const POLICY_LOCK_RETRY_MS = 25;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether the pid written in a lock file names a running process (EPERM: someone else's). */
function holderAlive(lock: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(lock, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes a stale lock out of the way atomically: renames it aside (only one taker can), then
 * checks the renamed file is the one judged stale. If a fresh lock was renamed instead, it is
 * linked back (unless a new one exists already). The caller then retries the exclusive create.
 */
function takeOver(lock: string, judged: { ino: number; mtimeMs: number }): void {
  const aside = `${lock}.${process.pid}.${randomBytes(6).toString("hex")}.stale`;
  try {
    renameSync(lock, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  try {
    const st = statSync(aside);
    if (st.ino !== judged.ino || st.mtimeMs !== judged.mtimeMs) {
      try {
        linkSync(aside, lock);
      } catch {
        // A new lock exists already; its holder goes on.
      }
    }
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Runs `fn` holding policy.json.lock (created with O_EXCL), so a read-modify-write of the policy
 * by this program and a concurrent `capybara-device policy` never loses an update. A lock older
 * than 10 s whose holder pid no longer runs is stale and taken over; a held one is retried for
 * about 2 s, then this throws. The lock is removed at the end only while it is still this
 * holder's file.
 */
export function withPolicyLock<T>(
  dir: string,
  fn: () => T,
  opts: { waitMs?: number; now?: () => number } = {},
): T {
  const lock = policyLockPath(dir);
  const now = opts.now ?? Date.now;
  const deadline = Date.now() + (opts.waitMs ?? POLICY_LOCK_WAIT_MS);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let st: { ino: number; mtimeMs: number };
      try {
        st = statSync(lock);
      } catch {
        // Released between the open and the stat: try again at once.
        continue;
      }
      if (now() - st.mtimeMs >= POLICY_LOCK_STALE_MS && !holderAlive(lock)) {
        takeOver(lock, st);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${lock} is held by another capybara-device process; try again in a moment ` +
            `(delete the file if no other capybara-device is running)`,
        );
      }
      sleepSync(POLICY_LOCK_RETRY_MS);
      continue;
    }
    let ino: number;
    try {
      writeSync(fd, String(process.pid));
      ino = fstatSync(fd).ino;
    } catch (e) {
      closeSync(fd);
      rmSync(lock, { force: true });
      throw e;
    }
    try {
      return fn();
    } finally {
      try {
        // Another process may have taken the lock over meanwhile: leave its file alone.
        if (statSync(lock).ino === ino) rmSync(lock, { force: true });
      } catch {
        // Already gone.
      }
      closeSync(fd);
    }
  }
}
