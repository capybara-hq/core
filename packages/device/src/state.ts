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
import type { DeviceNetworkMode } from "@capybara-hq/plugin-sdk";
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

/**
 * How commands run on this machine: `auto` (no OS sandbox; the owner's files, credentials and
 * network, with every command reviewed by the deployment) or `sandbox` (today's strict
 * `sandbox-runtime` profile). Not `DeviceMode`, which is the run mode (`os | docker`).
 */
export type SandboxMode = "auto" | "sandbox";

/** How far sandboxed operations and project browsing may reach on this machine. */
export type RestrictedProjectReach = "workspace" | "os-user";

/**
 * The owner's own ceiling for this machine (approval-only profiles design, "Settings model"): the
 * device sandbox for every profile. `outsideSandbox` is whether a call may be granted escalation
 * outside the sandbox; `network` is the sandbox network (`open` public internet, or the
 * `allowedDomains` allowlist); `restrictedProjectReach` is how far sandboxed work reaches. Only the
 * owner widens it on the machine (`capybara-device ceiling set`); the deployment may only narrow.
 */
export interface OwnerCeilingPolicy {
  outsideSandbox: boolean;
  network: DeviceNetworkMode;
  restrictedProjectReach: RestrictedProjectReach;
}

/** The persisted local policy format (`version: 3`). */
export const POLICY_VERSION = 3;

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
}

/** The exact old `mode: auto` ceiling, as the conversion table translates it. */
export const FULL_OWNER_CEILING: OwnerCeilingPolicy = Object.freeze({
  outsideSandbox: true,
  network: "open",
  restrictedProjectReach: "os-user",
});
/** The exact old `mode: sandbox` ceiling, as the conversion table translates it. */
export const SANDBOX_OWNER_CEILING: OwnerCeilingPolicy = Object.freeze({
  outsideSandbox: false,
  network: "allowlist",
  restrictedProjectReach: "workspace",
});

/** The owner ceiling an old `mode` translates to exactly. */
export function ownerCeilingOfMode(mode: SandboxMode): OwnerCeilingPolicy {
  return { ...(mode === "auto" ? FULL_OWNER_CEILING : SANDBOX_OWNER_CEILING) };
}

/**
 * The version 2 owner ceiling converted (approval-only profiles design, "Migration"), never wider:
 * Full access allowed becomes `outsideSandbox` with the open network; Full access denied keeps the
 * sandbox allowlist (the old `allowedDomains`). The project reach is kept.
 */
export function convertV2OwnerCeiling(v2: {
  fullAccess: boolean;
  restrictedProjectReach: RestrictedProjectReach;
}): OwnerCeilingPolicy {
  return {
    outsideSandbox: v2.fullAccess,
    network: v2.fullAccess ? "open" : "allowlist",
    restrictedProjectReach: v2.restrictedProjectReach,
  };
}

const DEFAULT_RECONNECT_GRACE_SECONDS = 120;
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const DEFAULT_POLICY: Policy = {
  allowedDomains: [],
  allowCredentials: [],
  cpu: null,
  memoryMb: null,
  // A new setup's owner ceiling: no running outside the sandbox, the open network (the design's
  // shipped default), sandboxed work in the workspace. An old policy file converts never wider
  // (convertPolicyFile).
  ownerCeiling: { outsideSandbox: false, network: "open", restrictedProjectReach: "workspace" },
  keepAwake: "while-busy",
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

/** The outcomes of the latest `policy` ops by op id (written under the policy lock). */
export function policyOpsPath(dir: string): string {
  return join(dir, "policy-ops.json");
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
/**
 * Keys of older policy files: ignored on read and dropped on the next write. `tier` / `isolation` /
 * `localhost` / `remoteGrants` are the auto-mode migration (spec §4.4): a file without `mode` runs
 * in auto when it asked for no sandbox, else in sandbox.
 */
const LEGACY_POLICY_KEYS: readonly string[] = [
  "mode",
  "network",
  "allowLocalBinding",
  "allowUnixSockets",
  "tier",
  "isolation",
  "localhost",
  "remoteGrants",
];

const isMode = (v: unknown): v is SandboxMode => v === "auto" || v === "sandbox";

/** The local policy (defaults when absent). Throws, naming the file, on bad JSON or field types. */
export function readPolicy(dir: string): Policy {
  return readPolicyFile(dir).policy;
}

/** {@link readPolicyFile}'s result. */
export interface PolicyFile {
  policy: Policy;
  /** The file's keys this version does not know (legacy keys excluded). */
  extra: Record<string, unknown>;
  /**
   * The file is in an old format (not `version: 3`): its owner ceiling was converted never wider
   * from its version 2 `fullAccess` or its older `mode` (or, before `mode`, its legacy keys).
   * {@link convertPolicyFile} rewrites it; so does the next change.
   */
  legacy: boolean;
}

/**
 * The local policy plus the file's keys this version does not know (kept on every write, so an
 * older program never drops a newer one's settings). Throws like {@link readPolicy}.
 */
export function readPolicyFile(dir: string): PolicyFile {
  const file = policyPath(dir);
  if (!existsSync(file)) {
    return {
      policy: { ...DEFAULT_POLICY, ownerCeiling: { ...DEFAULT_POLICY.ownerCeiling } },
      extra: {},
      legacy: false,
    };
  }
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
  const bad = (key: string, want: string): Error =>
    new Error(`${file} is invalid: ${key} must be ${want} (fix or delete the file)`);
  let ownerCeiling: OwnerCeilingPolicy;
  const ceilingObject = (): Record<string, unknown> => {
    const c = o.ownerCeiling;
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      throw bad("ownerCeiling", "an object");
    }
    return c as Record<string, unknown>;
  };
  const reachOf = (r: Record<string, unknown>): RestrictedProjectReach => {
    if (r.restrictedProjectReach !== "workspace" && r.restrictedProjectReach !== "os-user") {
      throw bad("ownerCeiling.restrictedProjectReach", '"workspace" or "os-user"');
    }
    return r.restrictedProjectReach;
  };
  // Every format before version 3 is converted, never wider (approval-only profiles design,
  // "Migration"); `legacy` makes start rewrite the file once.
  const legacy = o.version !== POLICY_VERSION;
  if (o.version === undefined) {
    // Before version 2: `mode` exactly (auto -> outside the sandbox, open network, os-user reach;
    // sandbox -> none of them); before `mode`, `isolation: none` or `tier: open` asked for no
    // sandbox (spec §4.4).
    const rawMode: unknown =
      o.mode === undefined
        ? o.isolation === "none" || o.tier === "open"
          ? "auto"
          : "sandbox"
        : o.mode;
    if (!isMode(rawMode)) throw bad("mode", '"auto" or "sandbox"');
    ownerCeiling = ownerCeilingOfMode(rawMode);
  } else if (o.version === 2) {
    if (o.mode !== undefined) throw bad("mode", "absent in version 2 (use ownerCeiling)");
    const r = ceilingObject();
    if (Object.keys(r).some((k) => k !== "fullAccess" && k !== "restrictedProjectReach")) {
      throw bad("ownerCeiling", "only fullAccess and restrictedProjectReach in version 2");
    }
    if (typeof r.fullAccess !== "boolean") throw bad("ownerCeiling.fullAccess", "a boolean");
    ownerCeiling = convertV2OwnerCeiling({
      fullAccess: r.fullAccess,
      restrictedProjectReach: reachOf(r),
    });
  } else {
    if (o.version !== POLICY_VERSION) throw bad("version", String(POLICY_VERSION));
    if (o.mode !== undefined) throw bad("mode", "absent (use ownerCeiling)");
    const r = ceilingObject();
    if (
      Object.keys(r).some(
        (k) => k !== "outsideSandbox" && k !== "network" && k !== "restrictedProjectReach",
      )
    ) {
      throw bad("ownerCeiling", "only outsideSandbox, network and restrictedProjectReach");
    }
    if (typeof r.outsideSandbox !== "boolean") {
      throw bad("ownerCeiling.outsideSandbox", "a boolean");
    }
    if (r.network !== "open" && r.network !== "allowlist") {
      throw bad("ownerCeiling.network", '"open" or "allowlist"');
    }
    ownerCeiling = {
      outsideSandbox: r.outsideSandbox,
      network: r.network,
      restrictedProjectReach: reachOf(r),
    };
  }
  const policy: Policy = {
    allowedDomains: o.allowedDomains === undefined ? [] : (o.allowedDomains as string[]),
    allowCredentials: o.allowCredentials === undefined ? [] : (o.allowCredentials as string[]),
    cpu: o.cpu === undefined ? null : (o.cpu as number | null),
    memoryMb: o.memoryMb === undefined ? null : (o.memoryMb as number | null),
    ownerCeiling,
    keepAwake:
      o.keepAwake === undefined ? DEFAULT_POLICY.keepAwake : (o.keepAwake as KeepAwakeMode),
  };
  if (!isKeepAwakeMode(policy.keepAwake)) {
    throw bad("keepAwake", '"off", "while-busy" or "connected"');
  }
  if (!isStringList(policy.allowedDomains)) throw bad("allowedDomains", "a list of strings");
  if (!isStringList(policy.allowCredentials)) throw bad("allowCredentials", "a list of strings");
  if (!isCeiling(policy.cpu)) throw bad("cpu", "a positive number or null");
  if (!isCeiling(policy.memoryMb)) throw bad("memoryMb", "a positive number or null");
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!POLICY_KEYS.includes(k) && !LEGACY_POLICY_KEYS.includes(k)) extra[k] = v;
  }
  return { policy, extra, legacy };
}

/** Writes policy.json atomically (owner-only); `extra` are unknown keys to keep (never legacy ones). */
export function writePolicy(
  dir: string,
  policy: Policy,
  extra: Record<string, unknown> = {},
): void {
  const kept = Object.fromEntries(
    Object.entries(extra).filter(([k]) => !LEGACY_POLICY_KEYS.includes(k)),
  );
  const { allowedDomains, allowCredentials, cpu, memoryMb, ownerCeiling, keepAwake } = policy;
  const body = {
    ...kept,
    version: POLICY_VERSION,
    allowedDomains,
    allowCredentials,
    cpu,
    memoryMb,
    ownerCeiling: {
      outsideSandbox: ownerCeiling.outsideSandbox,
      network: ownerCeiling.network,
      restrictedProjectReach: ownerCeiling.restrictedProjectReach,
    },
    keepAwake,
  };
  writePrivate(policyPath(dir), `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * The one-time explicit conversion of policy.json to version 3, under the policy lock and atomic:
 * an old ceiling converts never wider ({@link convertV2OwnerCeiling}, {@link ownerCeilingOfMode});
 * domains, resources and unknown keys are kept. `absent`: no file (nothing written); `current`:
 * already version 3. Throws, writing nothing, on a malformed file.
 */
export function convertPolicyFile(dir: string): "absent" | "current" | "converted" {
  return withPolicyLock(dir, () => {
    if (!existsSync(policyPath(dir))) return "absent";
    const { policy, extra, legacy } = readPolicyFile(dir);
    if (!legacy) return "current";
    writePolicy(dir, policy, extra);
    return "converted";
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
