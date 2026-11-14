import { copyFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";

export const LAUNCHD_LABEL = "top.capybara.device";

/**
 * Minimum seconds between launchd restarts of the agent: a program that keeps failing (exit code
 * not 0) is started again at most this often, so a fast crash loop cannot spin.
 */
export const LAUNCHD_THROTTLE_INTERVAL_SECONDS = 30;

export interface ServiceSpec {
  /** Absolute path of the node binary that runs the program. */
  nodePath: string;
  /** Absolute path of the `capybara-device` bin script. */
  binPath: string;
  /** The state directory: logs go there. */
  stateDir: string;
  /** Environment the service needs: PATH (for docker) and XDG_CONFIG_HOME when set. */
  env: Record<string, string>;
}

export function plistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function xml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The launchd agent: `node <bin> start` at login, and again after every failing exit. The program
 * exits 0 only for a deliberate stop (logout, a revoked credential, `drain`, not logged in, a
 * newer connection of this device), which must stay stopped; every exit it must recover from (a
 * crash, a deployment that needs a newer program) is non-zero, so `KeepAlive { SuccessfulExit:
 * false }` restarts exactly those. `ThrottleInterval` keeps a fast crash loop from spinning.
 */
export function plistContent(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.nodePath)}</string>
    <string>${xml(spec.binPath)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>${LAUNCHD_THROTTLE_INTERVAL_SECONDS}</integer>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(join(spec.stateDir, "service.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(spec.stateDir, "service.log"))}</string>
</dict>
</plist>
`;
}

function unxml(s: string): string {
  return s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** The bin script a plist runs (the second `ProgramArguments` string), or undefined. */
export function plistBinPath(content: string): string | undefined {
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content)?.[1];
  if (args === undefined) return undefined;
  const strings = [...args.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1] ?? ""));
  return strings[1];
}

export const SERVICE_LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Keeps `service.log` from growing without bound: past 10 MiB it is copied to `.1` and emptied. */
export function rotateServiceLog(stateDir: string, maxBytes: number = SERVICE_LOG_MAX_BYTES): void {
  const file = join(stateDir, "service.log");
  try {
    if (statSync(file).size < maxBytes) return;
    copyFileSync(file, `${file}.1`);
    truncateSync(file, 0);
  } catch {
    // No log yet, or not ours to rotate.
  }
}
