import { execFile } from "node:child_process";
import { connect } from "node:net";

/**
 * The macOS localhost proxy guard (spec §5.2.3). `dev` lets sandboxed commands reach any port on
 * this machine's localhost, which includes a local proxy that forwards past the network allowlist
 * (Clash and the like) or Docker's TCP API. The device looks for one at start and whenever the
 * policy is reloaded; when it finds one, `dev` / `open` run without local binding unless the owner
 * set `localhost: allow`.
 */

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
  /** Whether something accepts TCP connections on 127.0.0.1:`port` (default: a short connect). */
  probe?: (port: number) => Promise<boolean>;
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

/** The proxy variables of `env` (any case) whose host is loopback, as `NAME=value`. */
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
    if (isLoopbackHost(host)) out.push(`${name}=${value}`);
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

/** Whether something accepts a TCP connection on 127.0.0.1:`port` within a short time. */
export function probeLoopbackPort(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
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
 * variables in the program's environment, and a listener on {@link PROXY_PORTS}. Never throws:
 * a check that cannot run finds nothing.
 */
export async function detectLocalProxy(deps: ProxyGuardDeps = {}): Promise<ProxyGuardResult> {
  const platform = deps.platform ?? process.platform;
  const reasons: string[] = [];
  if (platform === "darwin") {
    const text = await (deps.scutil ?? runScutil)().catch(() => undefined);
    if (text !== undefined) {
      for (const p of parseScutilProxy(text)) reasons.push(`system proxy ${p}`);
    }
  }
  for (const v of loopbackProxyEnv(deps.env ?? process.env)) reasons.push(`environment ${v}`);
  const probe = deps.probe ?? ((port: number) => probeLoopbackPort(port));
  const ports = deps.ports ?? PROXY_PORTS;
  const open = await Promise.all(ports.map((p) => probe(p).catch(() => false)));
  ports.forEach((p, i) => {
    if (open[i]) reasons.push(`a listener on 127.0.0.1:${p}`);
  });
  return { detected: reasons.length > 0, reasons };
}
