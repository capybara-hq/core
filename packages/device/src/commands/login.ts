import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { DeviceNetworkMode } from "@capybara-hq/plugin-sdk";
import { ApiError, authorize, type FetchFn, programVersion, token } from "../api.js";
import type { Command } from "../args.js";
import { SANDBOX_INSTALL_HINT } from "../exec/sandbox-messages.js";
import { prepareDeviceDir } from "../exec/shared.js";
import { resetOwnerReport } from "../owner-report.js";
import { hasLoginService } from "../service/installed.js";
import {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_POLICY,
  defaultWorkDir,
  type OwnerCeilingPolicy,
  policyPath,
  readCredential,
  readPolicy,
  withPolicyLock,
  writeCredential,
  writePolicy,
} from "../state.js";

/**
 * Shown once at login when the owner ceiling allows running outside the sandbox in an organization
 * that allows it: an escalated call's trust model is its approval and the command review, not the
 * OS sandbox.
 */
export const OUTSIDE_SANDBOX_RISK_TEXT =
  "A call approved to run outside the sandbox runs on this computer as you: it can read and " +
  "write all your files, use your credentials (SSH keys, cloud accounts, keychain), Docker and " +
  "any network. The person, the review model or a Full access auto-grant approves each such " +
  "call, and the deployment reviews every command before it runs. Prompt injection can make an " +
  "agent try to delete files or send your credentials away; the review blocks or asks about the " +
  "dangerous ones. Such commands can also read this program's own credential: if you suspect " +
  "misuse, run capybara-device logout and log in again.";

/** The OS sandbox check `login` uses (default: the runtime's, loaded on demand). */
export type SandboxCheck = () => { ok: true } | { ok: false; reason: string };

async function checkSandbox(
  check: SandboxCheck | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (check !== undefined) return check();
  const { sandboxAvailability } = await import("../exec/sandbox-check.js");
  return sandboxAvailability();
}

/** How the owner widens the ceiling, on this machine only (the deployment may only narrow it). */
export const WIDEN_CEILING_HINT =
  "Only you can widen it, on this machine: `capybara-device ceiling set --outside-sandbox on` " +
  "(see `capybara-device ceiling show`).";

/** The sandbox network line of the login output. */
export function networkLoginLine(network: DeviceNetworkMode): string {
  return network === "open"
    ? "Sandboxed commands reach the public internet (private, local and metadata addresses stay " +
        "closed); `capybara-device ceiling set --network allowlist` limits them to allowedDomains."
    : "Sandboxed commands reach only allowedDomains; open the network with " +
        "`capybara-device ceiling set --network open`.";
}

/**
 * The line `login` prints when the owner ceiling keeps every call in the sandbox (the default of a
 * new setup): commands run in the sandbox under every profile, Full access included.
 */
export const SANDBOX_ONLY_LOGIN_LINE =
  "This machine's owner ceiling keeps every command in the sandbox, Full access included: no " +
  `call runs outside it. ${WIDEN_CEILING_HINT}`;

/** The line `login` prints when the owner ceiling allows running outside the sandbox. */
export const OUTSIDE_SANDBOX_LOGIN_LINE =
  "This machine's owner ceiling allows running outside the sandbox: commands still run in the " +
  "sandbox, and one approved call may run as you. Turn it off with " +
  "`capybara-device ceiling set --outside-sandbox off`.";

/** Added when the organization does not allow running outside the sandbox while the owner does. */
export const OUTSIDE_SANDBOX_NOT_ALLOWED_LOGIN_LINE =
  "This organization does not allow running outside the sandbox, so every call stays in the " +
  "sandbox here.";

/** The line `login` prints when sandboxed work cannot run here (no OS sandbox). */
export function restrictedUnavailableLoginLine(reason: string): string {
  return (
    `The OS sandbox is unavailable on this machine (${reason}), so sandboxed work cannot run ` +
    `here yet: ${SANDBOX_INSTALL_HINT}; or log in again with --mode docker. ${WIDEN_CEILING_HINT}`
  );
}

export interface LoginDeps {
  stateDir: string;
  home: string;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => void;
  out?: (line: string) => void;
  err?: (line: string) => void;
  platform?: NodeJS.Platform;
  arch?: string;
  hostname?: string;
  /** Whether the OS sandbox can run here (default: the runtime's check); injectable for tests. */
  sandboxAvailable?: SandboxCheck;
}

const SLOW_DOWN_STEP_SECONDS = 5;

function defaultOpen(platform: NodeJS.Platform) {
  return (url: string): void => {
    const bin = platform === "darwin" ? "open" : "xdg-open";
    try {
      const child = spawn(bin, [url], { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    } catch {
      // The URL is printed anyway.
    }
  };
}

/**
 * A new setup writes the default policy: no running outside the sandbox, the open network and the
 * workspace as the project reach. Written under the policy lock, and only while no policy file
 * exists: an existing policy is the owner's choice and is never changed here (an old format still
 * converts exactly at start). Returns whether this call created the file.
 */
function persistDefaultPolicy(stateDir: string): boolean {
  const file = policyPath(stateDir);
  if (existsSync(file)) return false;
  return withPolicyLock(stateDir, () => {
    if (existsSync(file)) return false;
    writePolicy(stateDir, { ...DEFAULT_POLICY, ownerCeiling: { ...DEFAULT_POLICY.ownerCeiling } });
    return true;
  });
}

/** Normalises the deployment URL: http(s) origin plus optional path prefix, no trailing slash. */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`--url is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("--url must start with https:// or http://");
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** `login`: the device authorization flow. Returns the exit code. */
export async function login(
  cmd: Extract<Command, { command: "login" }>,
  deps: LoginDeps,
): Promise<number> {
  const stdout = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  const json = cmd.json === true;
  // With --json stdout carries only JSON events; the human lines go to stderr.
  const out = json ? err : stdout;
  const emit = (event: Record<string, unknown>): void => {
    if (json) stdout(JSON.stringify(event));
  };
  /** A failed login: the human line, plus the JSON error event. */
  const fail = (code: string, message: string, exit: number): number => {
    err(message);
    emit({ event: "error", code, message });
    return exit;
  };
  const fetchFn = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;

  let baseUrl: string;
  try {
    baseUrl = normalizeUrl(cmd.url);
  } catch (e) {
    return fail("invalid_url", (e as Error).message, 2);
  }
  if (platform !== "darwin" && platform !== "linux") {
    return fail(
      "unsupported_platform",
      "capybara-device runs on macOS and Linux. On Windows use WSL or Docker.",
      1,
    );
  }
  try {
    if (readCredential(deps.stateDir) !== undefined) {
      return fail(
        "already_logged_in",
        "This machine is already logged in. Run `capybara-device logout` first.",
        1,
      );
    }
  } catch (e) {
    err(`Replacing the unusable credential file: ${(e as Error).message}`);
  }

  try {
    const auth = await authorize(fetchFn, baseUrl, {
      name: (deps.hostname ?? hostname()).slice(0, 64) || "device",
      os: platform,
      arch,
      programVersion: programVersion(),
    });
    out(`Open ${auth.verificationUriComplete} and confirm the code ${auth.userCode}`);
    emit({
      event: "verification",
      url: auth.verificationUriComplete,
      userCode: auth.userCode,
      expiresIn: auth.expiresIn,
    });
    if (cmd.browser && !json)
      (deps.openBrowser ?? defaultOpen(platform))(auth.verificationUriComplete);

    let interval = Number.isFinite(auth.interval) && auth.interval >= 1 ? auth.interval : 5;
    const expiresIn = Number.isFinite(auth.expiresIn) && auth.expiresIn > 0 ? auth.expiresIn : 600;
    let waited = 0;
    for (;;) {
      await sleep(interval * 1000);
      waited += interval;
      try {
        const granted = await token(fetchFn, baseUrl, auth.deviceCode);
        const dir =
          cmd.dir === undefined
            ? defaultWorkDir(granted.deviceId, deps.home)
            : isAbsolute(cmd.dir)
              ? cmd.dir
              : resolve(cmd.dir);
        // Recreates a lost directory, marker or root: the device starts afresh.
        prepareDeviceDir(dir);
        // A new setup gets the default written before the credential makes the login final; the
        // printed lines follow the policy this machine actually has.
        let ceiling: OwnerCeilingPolicy = { ...DEFAULT_POLICY.ownerCeiling };
        try {
          persistDefaultPolicy(deps.stateDir);
        } catch (e) {
          err(`Cannot set the local policy in ${deps.stateDir}: ${(e as Error).message}`);
        }
        try {
          ceiling = readPolicy(deps.stateDir).ownerCeiling;
        } catch (e) {
          err(`Cannot read the local policy in ${deps.stateDir}: ${(e as Error).message}`);
        }
        /** Why sandboxed work cannot run here: the OS sandbox is missing (OS mode only). */
        let noSandbox: string | undefined;
        if (cmd.mode !== "docker") {
          const available = await checkSandbox(deps.sandboxAvailable);
          if (!available.ok) noSandbox = available.reason;
        }
        // a new credential is a new machine at the deployment: its owner reports start a new
        // sequence (also repairs a lost or corrupt sidecar)
        // A failure (the policy lock held) never fails the login: the old sequence then continues
        // under the new credential, which the deployment accepts as a new machine's first report
        // (it keeps reports per machine credential); a corrupt sidecar still issues no report
        // until a later login resets it
        try {
          resetOwnerReport(deps.stateDir);
        } catch (e) {
          err(
            `Cannot reset the owner report sequence in ${deps.stateDir}: ${(e as Error).message}; ` +
              "run capybara-device login again once no other capybara-device runs",
          );
        }
        writeCredential(deps.stateDir, {
          url: baseUrl,
          connectUrl: granted.connectUrl,
          credential: granted.credential,
          orgId: granted.orgId,
          deviceId: granted.deviceId,
          dir,
          mode: cmd.mode,
          reconnectGraceSeconds: granted.reconnectGraceSeconds,
          maxFrameBytes: granted.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
        });
        emit({ event: "done", deviceId: granted.deviceId, orgId: granted.orgId, dir });
        out(`Logged in. Device ${granted.deviceId}, working directory ${dir}`);
        if (ceiling.outsideSandbox) {
          out(OUTSIDE_SANDBOX_LOGIN_LINE);
          // the token's `outsideSandbox` is the platform and organization outside-sandbox setting
          if (granted.outsideSandbox === "off") out(OUTSIDE_SANDBOX_NOT_ALLOWED_LOGIN_LINE);
          // the risk text is shown once at login, and only when an escalated call runs as the
          // owner on this machine (outside Docker)
          else if (cmd.mode !== "docker") out(OUTSIDE_SANDBOX_RISK_TEXT);
        } else {
          out(SANDBOX_ONLY_LOGIN_LINE);
        }
        out(networkLoginLine(ceiling.network));
        if (noSandbox !== undefined) out(restrictedUnavailableLoginLine(noSandbox));
        // An installed service stays stopped after a deliberate exit (not logged in, logged out):
        // it needs starting again, not a second program.
        out(
          hasLoginService(deps.home, platform)
            ? "The login service is installed: bring it online with `capybara-device service restart`."
            : "Run `capybara-device start` to bring it online (or `capybara-device service install` to connect at login).",
        );
        return 0;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.code === "device_sign_in.slow_down") interval += SLOW_DOWN_STEP_SECONDS;
        else if (
          e.code === "device_sign_in.authorization_pending" ||
          e.status === 0 ||
          e.status >= 500
        ) {
          // Keep polling at the normal interval: pending, a network blip or a server error.
        } else if (e.code === "device_sign_in.expired") {
          return fail(
            "device_sign_in.expired",
            "The code expired before it was approved. Run `capybara-device login` again.",
            1,
          );
        } else if (e.code === "device_sign_in.denied") {
          return fail("device_sign_in.denied", "The login was denied in the browser.", 1);
        } else throw e;
        if (waited >= expiresIn) {
          return fail(
            "device_sign_in.expired",
            "The code expired before it was approved. Run `capybara-device login` again.",
            1,
          );
        }
      }
    }
  } catch (e) {
    return fail(
      e instanceof ApiError ? e.code : "login_failed",
      `login failed: ${(e as Error).message}`,
      1,
    );
  }
}
