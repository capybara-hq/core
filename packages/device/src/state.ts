import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
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

/** The default working directory of an device: `~/capybara-device/<deviceId>`. */
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

/** The local policy (defaults when absent). Throws, naming the file, on bad JSON or field types. */
export function readPolicy(dir: string): Policy {
  const file = policyPath(dir);
  if (!existsSync(file)) return { ...DEFAULT_POLICY };
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
  return {
    allowedDomains: policy.allowedDomains,
    allowCredentials: policy.allowCredentials,
    cpu: policy.cpu,
    memoryMb: policy.memoryMb,
  };
}

export function writePolicy(dir: string, policy: Policy): void {
  writePrivate(policyPath(dir), `${JSON.stringify(policy, null, 2)}\n`);
}
