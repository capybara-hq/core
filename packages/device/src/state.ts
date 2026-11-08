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
  environmentId: string;
  dir: string;
  mode: DeviceMode;
  /** The deployment's `environments.device.reconnectGraceSeconds`, returned with the credential. */
  reconnectGraceSeconds: number;
}

/** Local limits the person sets for this machine. */
export interface Policy {
  allowedDomains: string[];
  allowCredentials: string[];
  cpu: number | null;
  memoryMb: number | null;
}

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

/** The default working directory of an environment: `~/capybara-device/<environmentId>`. */
export function defaultWorkDir(environmentId: string, home: string = homedir()): string {
  return join(home, "capybara-device", environmentId);
}

function writePrivate(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
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
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Credential>;
  for (const key of ["url", "connectUrl", "credential", "orgId", "environmentId", "dir", "mode"]) {
    if (typeof raw[key as keyof Credential] !== "string") {
      throw new Error(`${file} is invalid: missing ${key}; log in again`);
    }
  }
  return raw as Credential;
}

export function removeCredential(dir: string): boolean {
  const file = credentialPath(dir);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

export function readPolicy(dir: string): Policy {
  const file = policyPath(dir);
  if (!existsSync(file)) return { ...DEFAULT_POLICY };
  return { ...DEFAULT_POLICY, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<Policy>) };
}

export function writePolicy(dir: string, policy: Policy): void {
  writePrivate(policyPath(dir), `${JSON.stringify(policy, null, 2)}\n`);
}
