import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Public-address checks for downloads whose URL comes from a marketplace or an admin (spec §5.1).
 * A host is resolved once, every resolved address must be public, and the caller connects to the
 * checked addresses only (see `safe-fetch.ts`), so a DNS answer that changes between check and
 * connect (DNS rebinding, e.g. `10.0.0.1.nip.io`) cannot reach a private address.
 *
 * The blocked ranges are those of `plugins/sandbox-docker/egress-proxy/proxy.mjs`, ported here
 * because the kernel must not import from a plugin. IPv6 addresses that embed an IPv4 address
 * (v4-mapped `::ffff:0:0/96`, v4-compatible `::/96`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) are
 * judged by the embedded IPv4 address; anything unparseable is refused. One addition over proxy.mjs:
 * SIIT IPv4-translated addresses (`::ffff:0:a.b.c.d`, `::ffff:0:0:0/96`, RFC 2765) are also judged by
 * the embedded IPv4 address (proxy.mjs falls through to the IPv6 table, where they are not blocked);
 * a host behind a SIIT translator could otherwise reach a private IPv4 address.
 *
 * Link-local addresses (`169.254.0.0/16`, including cloud metadata, and `fe80::/10`) stay forbidden
 * whatever the exemptions: no internal mirror lives there.
 */

const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // unspecified / this network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
];

const BLOCKED_V6: readonly (readonly [string, number])[] = [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7], // ULA
  ["fe80::", 10], // link-local
  ["fec0::", 10],
  ["ff00::", 8], // multicast
];

// Read-only after construction: address tables, not shared mutable state.
const blocked = new BlockList();
for (const [a, p] of BLOCKED_V4) blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of BLOCKED_V6) blocked.addSubnet(a, p, "ipv6");
const linkLocal = new BlockList();
linkLocal.addSubnet("169.254.0.0", 16, "ipv4");
linkLocal.addSubnet("fe80::", 10, "ipv6");

/** An IPv6 address as its 8 16-bit groups; null when it cannot be parsed. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // a trailing dotted IPv4 (::ffff:1.2.3.4)
  const m = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m) {
    const [a = 0, b = 0, c = 0, d = 0] = m.slice(2).map(Number);
    if ([a, b, c, d].some((x) => x > 255)) return null;
    s = `${m[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (!parts.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const groups = parts.map((g) => Number.parseInt(g, 16));
  return groups.length === 8 ? groups : null;
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * Whether `ip` falls in `table`, judging an IPv6 address that embeds an IPv4 address by the
 * embedded one. Anything unparseable (including an IPv4 address with a `%` zone) counts as inside.
 */
function inTable(ip: string, table: BlockList): boolean {
  if (isIP(ip) === 4) return table.check(ip, "ipv4");
  if (isIP(ip.split("%")[0] ?? "") !== 6) return true;
  const g = v6Groups(ip);
  if (g === null) return true;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const [g0, g1, g2, , g4, g5, g6 = 0, g7 = 0] = g;
  // v4-mapped ::ffff:a.b.c.d
  if (zeros(0, 5) && g5 === 0xffff) return inTable(v4Of(g6, g7), table);
  // SIIT ::ffff:0:a.b.c.d (not unwrapped by proxy.mjs; see the file header)
  if (zeros(0, 4) && g4 === 0xffff && g5 === 0) return inTable(v4Of(g6, g7), table);
  // v4-compatible ::a.b.c.d (:: and ::1 are left to the IPv6 table)
  if (zeros(0, 6) && (g6 !== 0 || g7 > 1)) return inTable(v4Of(g6, g7), table);
  // NAT64 64:ff9b::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b) return inTable(v4Of(g6, g7), table);
  // 6to4 2002:AABB:CCDD::
  if (g0 === 0x2002) return inTable(v4Of(g1 ?? 0, g2 ?? 0), table);
  return table.check(g.map((x) => x.toString(16)).join(":"), "ipv6");
}

/** Whether connecting to this (resolved) IP is forbidden: private, loopback, reserved, or unparseable. */
export function isForbiddenAddress(ip: string): boolean {
  return inTable(ip, blocked);
}

/** Link-local (incl. cloud metadata 169.254.169.254) or unparseable: forbidden whatever the exemptions. */
export function isLinkLocalAddress(ip: string): boolean {
  return inTable(ip, linkLocal);
}

/** A hostname normalized for comparison: lower case, no IPv6 brackets, no trailing dots. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** `localhost`, `127.0.0.0/8` or `::1` (as written in a URL). */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  return h === "localhost" || h === "::1" || (isIP(h) === 4 && h.startsWith("127."));
}

/** Where downloads may go besides public addresses. */
export type NetPolicy = {
  /** Testing only: plain http and loopback addresses for loopback hosts. */
  allowInsecureLoopback: boolean;
  /**
   * `marketplaces.allowPrivateHosts`: a hostname entry (exact, case-insensitive) exempts that host's
   * resolved addresses; an IP or CIDR entry exempts IP-literal URL hosts inside it only, never a DNS
   * name that resolves there (an attacker's name could point into the range).
   */
  allowPrivateHosts: string[];
  /** Origins configured by the admin (the npm registry): their hosts may resolve to private addresses. */
  trustedOrigins: string[];
};

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

export type NetDeniedCode =
  | "net.private_address"
  | "net.dns_failed"
  | "net.redirect"
  | "net.insecure_url";

/** A download refused by the network rules. English message, safe to show. */
export class NetDeniedError extends Error {
  constructor(
    readonly code: NetDeniedCode,
    readonly host: string,
    message: string,
  ) {
    super(message);
    this.name = "NetDeniedError";
  }
}

const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true, verbatim: true });

/** The shortest prefix an `allowPrivateHosts` CIDR may have, per family. */
export const MIN_CIDR_PREFIX = { ipv4: 8, ipv6: 16 } as const;

/** A syntactically valid `addr/prefix` CIDR as [address, prefix, family], else undefined. */
export function parseCidr(s: string): [string, number, "ipv4" | "ipv6"] | undefined {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(s.trim());
  if (!m) return undefined;
  const addr = (m[1] as string).toLowerCase();
  const prefix = Number(m[2]);
  const family = isIP(addr);
  if (family === 4 && prefix <= 32) return [addr, prefix, "ipv4"];
  if (family === 6 && prefix <= 128) return [addr, prefix, "ipv6"];
  return undefined;
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Why a `marketplaces.allowPrivateHosts` entry is invalid (English), or null when it is a hostname,
 * an IP address or a CIDR no broader than /8 (IPv4) or /16 (IPv6).
 */
export function privateHostEntryProblem(entry: string): string | null {
  const cidr = parseCidr(entry);
  if (cidr) {
    const [, prefix, family] = cidr;
    const min = MIN_CIDR_PREFIX[family];
    return prefix < min
      ? `the CIDR ${entry.trim()} is too broad: use a prefix of at least /${min} for ${family === "ipv4" ? "IPv4" : "IPv6"}`
      : null;
  }
  const h = normalizeHost(entry);
  if (isIP(h) !== 0 || HOSTNAME.test(h)) return null;
  return "must be a hostname, an IP address or a CIDR such as 10.1.0.0/16";
}

/** A valid `marketplaces.allowPrivateHosts` entry (see {@link privateHostEntryProblem}). */
export function isPrivateHostEntry(entry: string): boolean {
  return privateHostEntryProblem(entry) === null;
}

function exemptions(host: string, policy: NetPolicy): { all: boolean; cidrs: BlockList } {
  const cidrs = new BlockList();
  let all = false;
  const literal = isIP(host) !== 0;
  // a loopback host under allowInsecureLoopback may resolve to loopback addresses only
  if (policy.allowInsecureLoopback && isLoopbackHost(host)) {
    cidrs.addSubnet("127.0.0.0", 8, "ipv4");
    cidrs.addAddress("::1", "ipv6");
  }
  for (const entry of policy.allowPrivateHosts) {
    if (!isPrivateHostEntry(entry)) continue;
    const cidr = parseCidr(entry);
    const name = normalizeHost(entry);
    if (cidr) {
      // IP and CIDR entries match IP-literal hosts only
      if (literal) cidrs.addSubnet(...cidr);
    } else if (isIP(name) !== 0) {
      if (literal) cidrs.addAddress(name, isIP(name) === 4 ? "ipv4" : "ipv6");
    } else if (name === host) {
      all = true;
    }
  }
  for (const origin of policy.trustedOrigins) {
    try {
      if (normalizeHost(new URL(origin).hostname) === host) all = true;
    } catch {
      // an unparseable origin trusts nothing
    }
  }
  return { all, cidrs };
}

function allowedBy(cidrs: BlockList, ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return cidrs.check(ip, "ipv4");
  if (family === 6) {
    if (cidrs.check(ip, "ipv6")) return true;
    // a v4-mapped answer also matches an IPv4 CIDR
    const g = v6Groups(ip);
    if (g?.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return cidrs.check(v4Of(g[6] ?? 0, g[7] ?? 0), "ipv4");
    }
  }
  return false;
}

/**
 * Resolves `host` (an IP literal is taken as is) and returns every address, in resolution order,
 * after checking that each is public or exempt by `policy`. Throws {@link NetDeniedError}
 * `net.dns_failed` (no answer) or `net.private_address` (some address is private and not exempt).
 */
export async function resolvePublic(
  host: string,
  policy: NetPolicy,
  lookup: LookupFn = defaultLookup,
): Promise<string[]> {
  const h = normalizeHost(host);
  let addrs: string[];
  if (isIP(h) !== 0) {
    addrs = [h];
  } else {
    try {
      addrs = (await lookup(h)).map((a) => a.address);
    } catch {
      throw new NetDeniedError("net.dns_failed", h, `Cannot resolve ${h}.`);
    }
    if (addrs.length === 0) throw new NetDeniedError("net.dns_failed", h, `Cannot resolve ${h}.`);
  }
  const ex = exemptions(h, policy);
  const refused = (a: string) =>
    isForbiddenAddress(a) && (isLinkLocalAddress(a) || (!ex.all && !allowedBy(ex.cidrs, a)));
  if (addrs.some(refused)) {
    throw new NetDeniedError(
      "net.private_address",
      h,
      addrs.some(isLinkLocalAddress)
        ? `Access to ${h} is refused: it resolves to a link-local address, which is never allowed.`
        : `Access to ${h} is refused: it resolves to a private or reserved address (add the hostname to marketplaces.allowPrivateHosts to allow an internal host).`,
    );
  }
  return addrs;
}
