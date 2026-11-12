import { isIP } from "node:net";
import { type SandboxLimits, validateAllowHost } from "@capybara-hq/plugin-sdk";
import { covers } from "./policy.js";
import type { Policy } from "./state.js";

/** What refused a host (spec §3). */
export type BlockedLayer = "device" | "org" | "address" | "unknown";

export interface BlockedHost {
  host: string;
  port: number;
  layer: BlockedLayer;
}

/** At most this many blocked hosts are reported per command. */
export const MAX_BLOCKED_HOSTS = 20;

type Limits = Pick<SandboxLimits, "egress" | "allowHosts">;
/** The local policy fields that decide network access (`network` arrives with remote grants). */
type NetworkPolicy = Pick<Policy, "allowedDomains"> & { network?: "allowlist" | "open" };

// The proxy's line in @anthropic-ai/sandbox-runtime 0.0.81 (`recordOutboundDeny`):
// `deny network-outbound <host>:<port> (<reason>)`. Pinned by test/network.test.ts.
const OUTBOUND_DENY = /^deny network-outbound (\S+) \((.*)\)$/;

/**
 * Parses one sandbox-runtime 0.0.81 violation line `deny network-outbound <host>:<port> (<reason>)`;
 * undefined for other lines. IPv6 hosts arrive bracketed and are returned without the brackets.
 */
export function parseNetworkViolation(
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
    // The SOCKS path writes IPv6 unbracketed: the port follows the last colon.
    const at = target.lastIndexOf(":");
    if (at <= 0) return undefined;
    host = target.slice(0, at);
    portText = target.slice(at + 1);
    if (host.includes(":") && isIP(host) !== 6) return undefined;
  }
  if (!/^\d+$/.test(portText)) return undefined;
  const port = Number(portText);
  if (port > 65535) return undefined;
  return { host: normalizeHost(host), port, reason };
}

/** Lowercase, without the trailing dot of a fully qualified name. */
function normalizeHost(host: string): string {
  const h = host.toLowerCase();
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

/**
 * Whether `host` is a public DNS name a command may reach when nothing narrows it (device and org
 * both open): never an IP literal, a single-label or internal name, or a wildcard.
 */
export function isPublicName(host: string): boolean {
  const h = normalizeHost(host);
  return !h.startsWith("*") && validateAllowHost(h).length === 0;
}

function admittedBy(list: readonly string[], host: string): boolean {
  return list.some((p) => covers(p.toLowerCase(), host));
}

/** IP literals, single-label and internal names: the runtime's guard refuses them for good. */
function isAddress(host: string, reason: string): boolean {
  return reason.startsWith("resolved to ") || validateAllowHost(host).length > 0;
}

function orgAllows(host: string, limits: Limits): boolean {
  if (limits.egress === "none") return false;
  if (limits.egress === "open") return true;
  return admittedBy(limits.allowHosts, host);
}

function deviceAllows(host: string, policy: NetworkPolicy): boolean {
  return policy.network === "open" || admittedBy(policy.allowedDomains, host);
}

/**
 * The layer that refused `host`: `address` (an IP literal, a name `validateAllowHost` refuses, or
 * a resolved-address reason), `org` (not in the org's effective egress, or egress none; also when
 * the device lacks it too), `device` (the org allows it, the local policy does not), else `unknown`.
 */
export function classifyHost(
  host: string,
  reason: string,
  limits: Limits,
  policy: NetworkPolicy,
): BlockedLayer {
  const h = normalizeHost(host);
  if (isAddress(h, reason)) return "address";
  if (!orgAllows(h, limits)) return "org";
  if (!deviceAllows(h, policy)) return "device";
  return "unknown";
}

/** The refused hosts in `lines`, deduped by host (first port kept), at most {@link MAX_BLOCKED_HOSTS}. */
export function blockedHosts(
  lines: readonly string[],
  limits: Limits,
  policy: NetworkPolicy,
): BlockedHost[] {
  const out = new Map<string, BlockedHost>();
  for (const line of lines) {
    if (out.size >= MAX_BLOCKED_HOSTS) break;
    const v = parseNetworkViolation(line);
    if (v === undefined || out.has(v.host)) continue;
    out.set(v.host, {
      host: v.host,
      port: v.port,
      layer: classifyHost(v.host, v.reason, limits, policy),
    });
  }
  return [...out.values()];
}

function target(b: Pick<BlockedHost, "host" | "port">): string {
  return b.host.includes(":") ? `[${b.host}]:${b.port}` : `${b.host}:${b.port}`;
}

function explain(b: BlockedHost): string {
  switch (b.layer) {
    case "device":
      return (
        "not in this device's allowed domains. Only the device owner can allow it " +
        `(capybara-device policy add allowedDomains ${b.host}, or the device page).`
      );
    case "org":
      return "not in the organization's network allowlist. Only an organization admin can add it.";
    case "address":
      return "a private or local address; commands can never reach it.";
    case "unknown":
      return "refused by the sandbox's network proxy.";
  }
}

/** The stderr trailer of spec §9.2 (English, model-visible); "" for an empty list. */
export function networkTrailer(blocked: readonly BlockedHost[]): string {
  if (blocked.length === 0) return "";
  return [
    "[capybara-device] Network access was blocked:",
    ...blocked.slice(0, MAX_BLOCKED_HOSTS).map((b) => `- ${target(b)}: ${explain(b)}`),
  ].join("\n");
}

/**
 * The reason the sandbox's ask callback answers (spec §9.1). The callback has no command id, so
 * `limits` are the last ones seen (a device belongs to one org); without any, the org layer is
 * not judged.
 */
export function denyReason(
  host: string,
  limits: Limits | undefined,
  policy: NetworkPolicy,
): string {
  const h = normalizeHost(host);
  let layer: BlockedLayer;
  if (limits !== undefined) layer = classifyHost(h, "", limits, policy);
  else if (isAddress(h, "")) layer = "address";
  else layer = deviceAllows(h, policy) ? "unknown" : "device";
  switch (layer) {
    case "device":
      return `capybara: ${host} is not in this device's allowed domains`;
    case "org":
      return `capybara: ${host} is not in the organization's network allowlist`;
    case "address":
      return `capybara: ${host} is a private or local address`;
    case "unknown":
      return `capybara: ${host} is not allowed by the network policy`;
  }
}
