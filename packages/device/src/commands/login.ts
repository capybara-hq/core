import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ApiError, authorize, type FetchFn, programVersion, token } from "../api.js";
import type { Command } from "../args.js";
import { defaultWorkDir, readCredential, writeCredential } from "../state.js";

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
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  const fetchFn = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;

  let baseUrl: string;
  try {
    baseUrl = normalizeUrl(cmd.url);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  if (platform !== "darwin" && platform !== "linux") {
    err("capybara-device runs on macOS and Linux. On Windows use WSL or Docker.");
    return 1;
  }
  try {
    if (readCredential(deps.stateDir) !== undefined) {
      err("This machine is already logged in. Run `capybara-device logout` first.");
      return 1;
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
    if (cmd.browser) (deps.openBrowser ?? defaultOpen(platform))(auth.verificationUriComplete);

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
            ? defaultWorkDir(granted.environmentId, deps.home)
            : isAbsolute(cmd.dir)
              ? cmd.dir
              : resolve(cmd.dir);
        for (const sub of ["workspace", "skills", "tmp"]) {
          mkdirSync(join(dir, sub), { recursive: true });
        }
        writeCredential(deps.stateDir, {
          url: baseUrl,
          connectUrl: granted.connectUrl,
          credential: granted.credential,
          orgId: granted.orgId,
          environmentId: granted.environmentId,
          dir,
          mode: cmd.mode,
          reconnectGraceSeconds: granted.reconnectGraceSeconds,
        });
        out(`Logged in. Environment ${granted.environmentId}, working directory ${dir}`);
        return 0;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.code === "device.slow_down") interval += SLOW_DOWN_STEP_SECONDS;
        else if (e.code === "device.authorization_pending" || e.status === 0 || e.status >= 500) {
          // Keep polling at the normal interval: pending, a network blip or a server error.
        } else if (e.code === "device.expired") {
          err("The code expired before it was approved. Run `capybara-device login` again.");
          return 1;
        } else if (e.code === "device.denied") {
          err("The login was denied in the browser.");
          return 1;
        } else throw e;
        if (waited >= expiresIn) {
          err("The code expired before it was approved. Run `capybara-device login` again.");
          return 1;
        }
      }
    }
  } catch (e) {
    err(`login failed: ${(e as Error).message}`);
    return 1;
  }
}
