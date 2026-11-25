import { isIP } from "node:net";
import {
  type NetworkBlockedHost,
  sandboxProxyRefusalLayer,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { MAX_NETWORK_BLOCKED_HOSTS } from "@capybara-hq/plugin-sdk/device-protocol";

/**
 * The proxy's outbound refusal in @anthropic-ai/sandbox-runtime 0.0.81 (`recordOutboundDeny`,
 * kept in the runtime's violation store): `deny network-outbound <host>:<port> (<reason>)`.
 */
const OUTBOUND_DENY = /^deny network-outbound (\S+) \((.*)\)$/;

/** The most violation lines the macOS worker hands back with a command's completion. */
export const MAX_NETWORK_DENIAL_LINES = 64;
/** The longest violation line kept (a longer one is no refusal this module reads). */
export const MAX_NETWORK_DENIAL_LINE_CHARS = 1024;

/** Lowercase, without the trailing dot of a fully qualified name. */
function normalizeHost(host: string): string {
  const h = host.toLowerCase();
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

/**
 * Parses one outbound refusal line; undefined for any other line. IPv6 hosts arrive bracketed
 * (HTTP) or bare (SOCKS) and are returned bracketed, as an exec result's report carries them.
 */
export function parseNetworkDenial(
  line: string,
): { host: string; port: number; reason: string } | undefined {
  const m = OUTBOUND_DENY.exec(line.trim());
  if (m === null) return undefined;
  const target = m[1] as string;
  const reason = m[2] as string;
  let host: string;
  let portText: string;
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(target);
  if (bracketed !== null) {
    host = bracketed[1] as string;
    portText = bracketed[2] as string;
  } else {
    // the SOCKS side writes IPv6 unbracketed: the port follows the last colon
    const at = target.lastIndexOf(":");
    if (at <= 0) return undefined;
    host = target.slice(0, at);
    portText = target.slice(at + 1);
    if (host.includes(":") && isIP(host) !== 6) return undefined;
  }
  if (!/^\d+$/.test(portText)) return undefined;
  const port = Number(portText);
  if (port < 1 || port > 65535) return undefined;
  const h = normalizeHost(host);
  return { host: isIP(h) === 6 ? `[${h}]` : h, port, reason };
}

/**
 * The hosts a restricted command was refused, from the operation proxy's violation lines: the
 * layer from the proxy's reason (`sandboxProxyRefusalLayer`: a closed address, an IP literal or a
 * private-resolving name, is `address`; a host off the allowlist is `device`), and any host that
 * is no valid allowlist name (an IP literal, a single label, a wildcard) is `address` whatever the
 * reason, since nobody can allow it. Deduped by host (the most restrictive refusal wins, then the
 * first port), at most `MAX_NETWORK_BLOCKED_HOSTS`. Only a report: the kernel recomputes the org
 * layer and decides what may be asked.
 */
export function networkBlocked(lines: readonly unknown[]): NetworkBlockedHost[] {
  const out = new Map<string, NetworkBlockedHost>();
  for (const line of lines.slice(0, MAX_NETWORK_DENIAL_LINES)) {
    if (typeof line !== "string" || line.length > MAX_NETWORK_DENIAL_LINE_CHARS) continue;
    const v = parseNetworkDenial(line);
    if (v === undefined) continue;
    const layer =
      v.host.startsWith("*") || validateAllowHost(v.host).length > 0
        ? "address"
        : sandboxProxyRefusalLayer(v.reason);
    const had = out.get(v.host);
    if (had !== undefined) {
      // an address refusal of a host seen before under another reason: the address holds
      if (layer === "address") had.layer = "address";
      continue;
    }
    if (out.size >= MAX_NETWORK_BLOCKED_HOSTS) continue;
    out.set(v.host, { host: v.host, port: v.port, layer });
  }
  return [...out.values()];
}
