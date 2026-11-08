import { join } from "node:path";

export const LAUNCHD_LABEL = "top.capybara.device";

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

/** The launchd agent: `node <bin> start`, at login, restarted when it exits. */
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
  <true/>
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
