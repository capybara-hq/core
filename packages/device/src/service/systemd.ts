import { join } from "node:path";
import type { ServiceSpec } from "./launchd.js";

export const SYSTEMD_TEMPLATE = "capybara-device@.service";

/** The unit instance of one connection. */
export function systemdUnit(deviceId: string): string {
  return `capybara-device@${deviceId}.service`;
}

function userUnitDir(home: string): string {
  return join(home, ".config", "systemd", "user");
}

/** The template file every connection's instance runs. */
export function unitPath(home: string): string {
  return join(userUnitDir(home), SYSTEMD_TEMPLATE);
}

/** Directory of the links `systemctl --user enable` makes for units wanted by the default target. */
export function unitWantsDir(home: string): string {
  return join(userUnitDir(home), "default.target.wants");
}

/** The link that enables one connection's instance. */
export function unitWantsLink(home: string, deviceId: string): string {
  return join(unitWantsDir(home), systemdUnit(deviceId));
}

/** A systemd word: quoted, with `\`, `"` and the specifier `%` escaped. */
function word(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

/** The systemd user unit: `node <bin> start --connection %i` (one instance per connection), restarted on failure, wanted by the default target. */
export function unitContent(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${word(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=capybara-device: connects this machine to a Capybara deployment
After=network-online.target

[Service]
ExecStart=${word(spec.nodePath)} ${word(spec.binPath)} start --connection %i
Restart=on-failure
RestartSec=5
${env}

[Install]
WantedBy=default.target
`;
}

/** The bin script a unit runs (the second word of `ExecStart`), or undefined. */
export function unitBinPath(content: string): string | undefined {
  return unitExecWords(content)?.[1];
}

/** The node binary a unit runs (the first `ExecStart` word), or undefined. */
export function unitNodePath(content: string): string | undefined {
  return unitExecWords(content)?.[0];
}

function unitExecWords(content: string): string[] | undefined {
  const line = /^ExecStart=(.*)$/m.exec(content)?.[1];
  if (line === undefined) return undefined;
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    (m[1] ?? "").replace(/\\(.)/g, "$1").replaceAll("%%", "%"),
  );
}
