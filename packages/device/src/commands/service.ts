import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCHD_LABEL, plistContent, plistPath, type ServiceSpec } from "../service/launchd.js";
import { SYSTEMD_UNIT, unitContent, unitPath } from "../service/systemd.js";

export interface ServiceDeps {
  stateDir: string;
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Runs a system command; throws when it fails (default: execFileSync). */
  run?: (cmd: string, args: string[]) => void;
  uid?: number;
  nodePath?: string;
  binPath?: string;
}

function defaultRun(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: "pipe" });
}

/** The bin script next to this package's `dist` (or `src`) directory. */
function defaultBinPath(): string {
  return fileURLToPath(new URL("../../bin/capybara-device.mjs", import.meta.url));
}

/** What the service needs from the installing shell: PATH (docker lives there) and the state dir. */
export function serviceEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  const path = env.PATH;
  out.PATH = path !== undefined && path !== "" ? path : "/usr/local/bin:/usr/bin:/bin";
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "") out.XDG_CONFIG_HOME = xdg;
  return out;
}

/** `service install|uninstall`: runs `capybara-device start` at login (launchd) or boot (systemd user). */
export function serviceCommand(action: "install" | "uninstall", deps: ServiceDeps): number {
  const run = deps.run ?? defaultRun;
  const spec: ServiceSpec = {
    nodePath: deps.nodePath ?? process.execPath,
    binPath: deps.binPath ?? defaultBinPath(),
    stateDir: deps.stateDir,
    env: serviceEnv(deps.env),
  };
  try {
    if (deps.platform === "darwin") return launchd(action, spec, deps, run);
    if (deps.platform === "linux") return systemd(action, spec, deps, run);
  } catch (e) {
    deps.err(
      `capybara-device service ${action} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
  deps.err("capybara-device service needs macOS (launchd) or Linux (systemd).");
  return 1;
}

function launchd(
  action: "install" | "uninstall",
  spec: ServiceSpec,
  deps: ServiceDeps,
  run: (cmd: string, args: string[]) => void,
): number {
  const file = plistPath(deps.home);
  const domain = `gui/${deps.uid ?? process.getuid?.() ?? 501}`;
  const tryRun = (args: string[]): void => {
    try {
      run("launchctl", args);
    } catch {
      // Not loaded yet / already gone.
    }
  };
  if (action === "install") {
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(spec.stateDir, { recursive: true });
    if (existsSync(file)) tryRun(["bootout", `${domain}/${LAUNCHD_LABEL}`]);
    writeFileSync(file, plistContent(spec));
    run("launchctl", ["bootstrap", domain, file]);
    deps.out(`Installed ${file}; capybara-device now starts at login.`);
    return 0;
  }
  tryRun(["bootout", `${domain}/${LAUNCHD_LABEL}`]);
  rmSync(file, { force: true });
  deps.out("Removed the capybara-device login service.");
  return 0;
}

function systemd(
  action: "install" | "uninstall",
  spec: ServiceSpec,
  deps: ServiceDeps,
  run: (cmd: string, args: string[]) => void,
): number {
  const file = unitPath(deps.home);
  if (action === "install") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, unitContent(spec));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    deps.out(
      `Installed ${file}; capybara-device now starts at login. A user unit runs only while you have a session unless you run: loginctl enable-linger $USER`,
    );
    return 0;
  }
  try {
    run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
  } catch {
    // Not installed.
  }
  rmSync(file, { force: true });
  try {
    run("systemctl", ["--user", "daemon-reload"]);
  } catch {
    // No user manager: nothing is loaded.
  }
  deps.out("Removed the capybara-device user service.");
  return 0;
}
