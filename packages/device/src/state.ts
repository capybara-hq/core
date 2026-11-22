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
import { isAbsolute, join, normalize } from "node:path";
import type { DeviceNetworkMode } from "@capybara-hq/plugin-sdk/device-protocol";
import type { DeviceMode } from "./args.js";
import type { ProjectReach } from "./exec/read-model.js";

/** What `login` stores: how to reach the deployment and who this machine is there. */
export interface Credential {
  url: string;
  connectUrl: string;
  credential: string;
  orgId: string;
  deviceId: string;
  dir: string;
  mode: DeviceMode;
  /** The deployment's `devices.dialIn.reconnectGraceSeconds`, returned with the credential. */
  reconnectGraceSeconds: number;
  /** The deployment's `devices.dialIn.maxFrameBytes`: no frame this program sends is larger. */
  maxFrameBytes: number;
}

/**
 * How commands run on this machine: `auto` (no OS sandbox; the owner's files, credentials and
 * network, with every command reviewed by the deployment) or `sandbox` (today's strict
 * `sandbox-runtime` profile). Not `DeviceMode`, which is the run mode (`os | docker`).
 */
export type SandboxMode = "auto" | "sandbox";

/**
 * The owner's own ceiling for this machine (approval-only profiles design, "Settings model"): the
 * device sandbox for every profile. `outsideSandbox` is whether a call may be granted escalation
 * outside the sandbox; `network` is the sandbox network (`open` public internet, or the
 * `allowedDomains` allowlist); `projectReach` is what sandboxed work and project browsing read
 * (`machine`: the whole machine minus the deny list; `paths`: the workspace plus
 * {@link Policy.projectPaths}; `workspace`: the workspace only). Only the owner widens it on the
 * machine (`capybara-device ceiling set`); the deployment may only narrow.
 */
export interface OwnerCeilingPolicy {
  outsideSandbox: boolean;
  network: DeviceNetworkMode;
  projectReach: ProjectReach;
}

/** The persisted local policy format (`version: 4`); a file in any other version is refused. */
export const POLICY_VERSION = 4;

/** The most project paths one policy lists. */
export const MAX_PROJECT_PATHS = 100;

/**
 * When the program keeps this computer awake: never, only while operations run, or the whole
 * time it is connected to the deployment.
 */
export type KeepAwakeMode = "off" | "while-busy" | "connected";
export const KEEP_AWAKE_MODES: readonly KeepAwakeMode[] = ["off", "while-busy", "connected"];
export const isKeepAwakeMode = (v: unknown): v is KeepAwakeMode =>
  typeof v === "string" && (KEEP_AWAKE_MODES as readonly string[]).includes(v);

/** Local limits the person sets for this machine. */
export interface Policy {
  /** The sandbox allowlist: what sandboxed work may reach while the network is `allowlist`. */
  allowedDomains: string[];
  allowCredentials: string[];
  cpu: number | null;
  memoryMb: number | null;
  /** The owner ceiling. The platform and organization settings only narrow it. */
  ownerCeiling: OwnerCeilingPolicy;
  /** Keep-awake (spec §9.7); absent in a file means the default. */
  keepAwake: KeepAwakeMode;
  /**
   * The directories sandboxed work reads besides the workspace while the reach is `paths`:
   * absolute, normalized, without a trailing slash, at most {@link MAX_PROJECT_PATHS}, no
   * duplicates. Kept (and ignored) under the other reaches.
   */
  projectPaths: string[];
}

const DEFAULT_RECONNECT_GRACE_SECONDS = 120;
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const DEFAULT_POLICY: Policy = {
  allowedDomains: [],
  allowCredentials: [],
  cpu: null,
  memoryMb: null,
  // A new setup's owner ceiling: no running outside the sandbox, the open network (the design's
  // shipped default), sandboxed work reads the whole machine minus the deny list.
  ownerCeiling: { outsideSandbox: false, network: "open", projectReach: "machine" },
  keepAwake: "while-busy",
  projectPaths: [],
};

/**
 * The owner ceiling of a machine without policy.json. A new setup has one from `login`; before
 * rc.58 `login` wrote none, and such a device ran with no reachable host. So a missing file is
 * never the open default: no running outside the sandbox, the allowlist network with no host, the
 * workspace reach. `start` writes it once ({@link createMissingPolicyFile}) and says how to open it.
 */
export const MISSING_POLICY_OWNER_CEILING: OwnerCeilingPolicy = Object.freeze({
  outsideSandbox: false,
  network: "allowlist",
  projectReach: "workspace",
});

/**
 * The closed policy: {@link MISSING_POLICY_OWNER_CEILING}, no domains, no project paths. Every
 * reader sees it while policy.json is missing, and `capybara-device ceiling set` starts from it
 * when it replaces a file in another version.
 */
export function closedPolicy(): Policy {
  return {
    ...DEFAULT_POLICY,
    allowedDomains: [],
    allowCredentials: [],
    ownerCeiling: { ...MISSING_POLICY_OWNER_CEILING },
    projectPaths: [],
  };
}

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

const POLICY_KEYS: readonly string[] = ["version", ...Object.keys(DEFAULT_POLICY)];
const OWNER_CEILING_KEYS: readonly string[] = ["outsideSandbox", "network", "projectReach"];

/** The command that rewrites a policy file this version cannot read. */
export const POLICY_REWRITE_COMMAND = "capybara-device ceiling set";

/**
 * policy.json is in another format version than {@link POLICY_VERSION}. No old format is
 * converted: the owner rewrites the file with {@link POLICY_REWRITE_COMMAND}, which starts from
 * the closed policy ({@link closedPolicy}).
 */
export class PolicyVersionError extends Error {}

/**
 * Why `paths` cannot be the project paths, or undefined when it can: a list of absolute,
 * normalized paths without a trailing slash (`/` itself allowed), at most
 * {@link MAX_PROJECT_PATHS}, without duplicates.
 */
export function projectPathsProblem(paths: unknown): string | undefined {
  if (!isStringList(paths)) return "a list of strings";
  if (paths.length > MAX_PROJECT_PATHS) return `at most ${MAX_PROJECT_PATHS} entries`;
  const seen = new Set<string>();
  for (const p of paths) {
    if (!isAbsolute(p) || p.includes("\0") || normalize(p) !== p || (p !== "/" && p.endsWith("/")))
      return `absolute normalized paths without a trailing slash (got ${JSON.stringify(p)})`;
    if (seen.has(p)) return `a list without duplicates (${JSON.stringify(p)} twice)`;
    seen.add(p);
  }
  return undefined;
}

const isProjectReach = (v: unknown): v is ProjectReach =>
  v === "machine" || v === "paths" || v === "workspace";

/**
 * The local policy (the closed {@link MISSING_POLICY_OWNER_CEILING} when absent, never the open
 * default). Throws, naming the file, on bad JSON, another version or bad field types.
 */
export function readPolicy(dir: string): Policy {
  return readPolicyFile(dir).policy;
}

/** {@link readPolicyFile}'s result. */
export interface PolicyFile {
  policy: Policy;
  /** The file's top-level keys this version does not know. */
  extra: Record<string, unknown>;
}

/**
 * The local policy plus the file's top-level keys this version does not know (kept on every
 * write, so an older program never drops a newer one's settings). This file is the owner's
 * authority, so reading fails closed: anything but a well-formed `version: 4` file throws, naming
 * the file ({@link PolicyVersionError} for another version).
 */
export function readPolicyFile(dir: string): PolicyFile {
  const file = policyPath(dir);
  if (!existsSync(file)) return { policy: closedPolicy(), extra: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} is invalid: expected a JSON object`);
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== POLICY_VERSION) {
    throw new PolicyVersionError(
      `${file} is in policy format ${o.version === undefined ? "(none)" : JSON.stringify(o.version)}; ` +
        `this program reads only format ${POLICY_VERSION}. Rewrite it with ${POLICY_REWRITE_COMMAND} ` +
        "(it starts from the closed ceiling: workspace reach, allowlist network, nothing outside " +
        "the sandbox)",
    );
  }
  const bad = (key: string, want: string): Error =>
    new Error(`${file} is invalid: ${key} must be ${want} (fix or delete the file)`);
  const c = o.ownerCeiling;
  if (typeof c !== "object" || c === null || Array.isArray(c))
    throw bad("ownerCeiling", "an object");
  const r = c as Record<string, unknown>;
  if (Object.keys(r).some((k) => !OWNER_CEILING_KEYS.includes(k))) {
    throw bad("ownerCeiling", "only outsideSandbox, network and projectReach");
  }
  if (typeof r.outsideSandbox !== "boolean") throw bad("ownerCeiling.outsideSandbox", "a boolean");
  if (r.network !== "open" && r.network !== "allowlist") {
    throw bad("ownerCeiling.network", '"open" or "allowlist"');
  }
  if (!isProjectReach(r.projectReach)) {
    throw bad("ownerCeiling.projectReach", '"machine", "paths" or "workspace"');
  }
  const ownerCeiling: OwnerCeilingPolicy = {
    outsideSandbox: r.outsideSandbox,
    network: r.network,
    projectReach: r.projectReach,
  };
  const policy: Policy = {
    allowedDomains: o.allowedDomains === undefined ? [] : (o.allowedDomains as string[]),
    allowCredentials: o.allowCredentials === undefined ? [] : (o.allowCredentials as string[]),
    cpu: o.cpu === undefined ? null : (o.cpu as number | null),
    memoryMb: o.memoryMb === undefined ? null : (o.memoryMb as number | null),
    ownerCeiling,
    keepAwake:
      o.keepAwake === undefined ? DEFAULT_POLICY.keepAwake : (o.keepAwake as KeepAwakeMode),
    projectPaths: o.projectPaths === undefined ? [] : (o.projectPaths as string[]),
  };
  if (!isKeepAwakeMode(policy.keepAwake)) {
    throw bad("keepAwake", '"off", "while-busy" or "connected"');
  }
  if (!isStringList(policy.allowedDomains)) throw bad("allowedDomains", "a list of strings");
  if (!isStringList(policy.allowCredentials)) throw bad("allowCredentials", "a list of strings");
  if (!isCeiling(policy.cpu)) throw bad("cpu", "a positive number or null");
  if (!isCeiling(policy.memoryMb)) throw bad("memoryMb", "a positive number or null");
  const pathsProblem = projectPathsProblem(policy.projectPaths);
  if (pathsProblem !== undefined) throw bad("projectPaths", pathsProblem);
  policy.projectPaths = [...policy.projectPaths];
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!POLICY_KEYS.includes(k)) extra[k] = v;
  }
  return { policy, extra };
}

/**
 * Writes policy.json atomically (owner-only) in format {@link POLICY_VERSION}; `extra` are
 * unknown keys to keep. Refuses, writing nothing, project paths {@link readPolicyFile} would
 * refuse.
 */
export function writePolicy(
  dir: string,
  policy: Policy,
  extra: Record<string, unknown> = {},
): void {
  const { allowedDomains, allowCredentials, cpu, memoryMb, ownerCeiling, keepAwake, projectPaths } =
    policy;
  const pathsProblem = projectPathsProblem(projectPaths);
  if (pathsProblem !== undefined) throw new Error(`projectPaths must be ${pathsProblem}`);
  const body = {
    ...extra,
    version: POLICY_VERSION,
    allowedDomains,
    allowCredentials,
    cpu,
    memoryMb,
    ownerCeiling: {
      outsideSandbox: ownerCeiling.outsideSandbox,
      network: ownerCeiling.network,
      projectReach: ownerCeiling.projectReach,
    },
    keepAwake,
    projectPaths,
  };
  writePrivate(policyPath(dir), `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * Writes the closed policy ({@link closedPolicy}) when policy.json is missing (a device set up
 * before rc.58, whose `login` wrote none), under the policy lock. Returns whether it wrote one.
 * An existing file is left as it is, whatever its content.
 */
export function createMissingPolicyFile(dir: string): boolean {
  return withPolicyLock(dir, () => {
    if (existsSync(policyPath(dir))) return false;
    writePolicy(dir, closedPolicy());
    return true;
  });
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
      try {
        closeSync(fd);
      } catch {
        // `fn` ran (a policy write may have happened): a failed close must not turn it into an error
      }
    }
  }
}
