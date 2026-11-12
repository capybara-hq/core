import { execFile } from "node:child_process";
import { connect } from "node:net";

/**
 * The macOS localhost proxy guard (spec §5.2.3). `dev` lets sandboxed commands reach any port on
 * this machine's localhost, which includes a local proxy that forwards past the network allowlist
 * (Clash and the like) or Docker's TCP API. The device looks for one at start, whenever the
 * policy is reloaded and again before a command once the last result is older than
 * {@link PROXY_GUARD_TTL_MS}; when it finds one, `dev` / `open` run without local binding unless the
 * owner set `localhost: allow`. A check that cannot run on macOS counts as a finding (fail safe).
 */

/** How long a proxy guard result is used before the next command runs the guard again. */
export const PROXY_GUARD_TTL_MS = 30_000;

/** Common local proxy ports (Clash, V2Ray, Surge, Privoxy, Tor) and Docker's TCP API ports. */
export const PROXY_PORTS: readonly number[] = Object.freeze([
  7890, 7891, 7897, 1080, 1087, 8118, 9050, 9150, 2375, 2376,
]);

/** How long one port probe waits for a connection. */
const PROBE_TIMEOUT_MS = 150;

/** The proxy variables of a program's environment, checked in any case. */
const PROXY_ENV = ["http_proxy", "https_proxy", "all_proxy"];

export interface ProxyGuardResult {
  detected: boolean;
  /** What was found, in English (for `policy show` and the log). */
  reasons: string[];
}

export interface ProxyGuardDeps {
  platform?: NodeJS.Platform;
  /** The program's environment (default: `process.env`). */
  env?: Record<string, string | undefined>;
  /** `scutil --proxy`'s output, or undefined when it cannot run (default: runs it on macOS). */
  scutil?: () => Promise<string | undefined>;
  /** Whether something accepts TCP connections on `host`:`port` (default: a short connect). */
  probe?: (port: number, host: string) => Promise<boolean>;
  ports?: readonly number[];
}

/** Whether `host` names this machine's loopback. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h.startsWith("127.") || h === "0.0.0.0";
}

/**
 * The loopback proxies `scutil --proxy` reports as enabled: `HTTPEnable`, `HTTPSEnable`,
 * `SOCKSEnable` set to 1 with their `*Proxy` host on loopback. Returns `"HTTP 127.0.0.1:7890"`
 * style entries.
 */
export function parseScutilProxy(text: string): string[] {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (m !== null) fields.set(m[1] as string, m[2] as string);
  }
  const out: string[] = [];
  for (const kind of ["HTTP", "HTTPS", "SOCKS"]) {
    if (fields.get(`${kind}Enable`) !== "1") continue;
    const host = fields.get(`${kind}Proxy`);
    if (host === undefined || !isLoopbackHost(host)) continue;
    const port = fields.get(`${kind}Port`);
    out.push(`${kind} ${host}${port !== undefined ? `:${port}` : ""}`);
  }
  return out;
}

/** `value` with the user and password of a proxy URL (`user:pass@`) replaced by `***@`. */
export function redactProxyUserinfo(value: string): string {
  return value.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)?[^@/]*@/, "$1***@");
}

/**
 * The proxy variables of `env` (any case) whose host is loopback, as `NAME=value` (credentials in
 * the value redacted: the result is printed and logged).
 */
export function loopbackProxyEnv(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!PROXY_ENV.includes(name.toLowerCase()) || value === undefined || value === "") continue;
    let host: string;
    try {
      // `127.0.0.1:7890` without a scheme is common too.
      host = new URL(value.includes("://") ? value : `http://${value}`).hostname;
    } catch {
      continue;
    }
    if (isLoopbackHost(host)) out.push(`${name}=${redactProxyUserinfo(value)}`);
  }
  return out;
}

function runScutil(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("/usr/sbin/scutil", ["--proxy"], { timeout: 2_000 }, (e, stdout) =>
      resolve(e === null ? stdout : undefined),
    );
  });
}

/** The loopback addresses probed: a proxy may listen on either. */
export const PROBE_HOSTS: readonly string[] = Object.freeze(["127.0.0.1", "::1"]);

/** Whether something accepts a TCP connection on `host`:`port` within a short time. */
export function probeLoopbackPort(
  port: number,
  host = "127.0.0.1",
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Looks for a local forwarding proxy: the system proxy (macOS `scutil --proxy`), loopback proxy
 * variables in the program's environment, and a listener on {@link PROXY_PORTS} of 127.0.0.1 or
 * ::1. A proxy configured only through a PAC file (automatic proxy configuration) is not read.
 * Never throws. On macOS a system proxy setting that cannot be read counts as found (fail safe);
 * a port probe that cannot run finds nothing.
 */
export async function detectLocalProxy(deps: ProxyGuardDeps = {}): Promise<ProxyGuardResult> {
  const platform = deps.platform ?? process.platform;
  const reasons: string[] = [];
  if (platform === "darwin") {
    const text = await (deps.scutil ?? runScutil)().catch(() => undefined);
    if (text === undefined) reasons.push("the system proxy settings could not be read");
    else for (const p of parseScutilProxy(text)) reasons.push(`system proxy ${p}`);
  }
  for (const v of loopbackProxyEnv(deps.env ?? process.env)) reasons.push(`environment ${v}`);
  const probe = deps.probe ?? ((port: number, host: string) => probeLoopbackPort(port, host));
  const ports = deps.ports ?? PROXY_PORTS;
  const targets = PROBE_HOSTS.flatMap((host) => ports.map((port) => ({ host, port })));
  const open = await Promise.all(targets.map((t) => probe(t.port, t.host).catch(() => false)));
  targets.forEach((t, i) => {
    const where = t.host.includes(":") ? `[${t.host}]` : t.host;
    if (open[i]) reasons.push(`a listener on ${where}:${t.port}`);
  });
  return { detected: reasons.length > 0, reasons };
}
