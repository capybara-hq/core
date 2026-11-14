import { join } from "node:path";
import type { ServiceSpec } from "./launchd.js";

export const SYSTEMD_UNIT = "capybara-device.service";

export function unitPath(home: string): string {
  return join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

/** A systemd word: quoted, with `\`, `"` and the specifier `%` escaped. */
function word(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

/** The systemd user unit: `node <bin> start`, restarted on failure, wanted by the default target. */
export function unitContent(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${word(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=capybara-device: connects this machine to a Capybara deployment
After=network-online.target

[Service]
ExecStart=${word(spec.nodePath)} ${word(spec.binPath)} start
Restart=on-failure
RestartSec=5
${env}

[Install]
WantedBy=default.target
`;
}

/** The bin script a unit runs (the second word of `ExecStart`), or undefined. */
export function unitBinPath(content: string): string | undefined {
  const line = /^ExecStart=(.*)$/m.exec(content)?.[1];
  if (line === undefined) return undefined;
  const words = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    (m[1] ?? "").replace(/\\(.)/g, "$1").replaceAll("%%", "%"),
  );
  return words[1];
}
