/**
 * The address classes of the sandbox network (approval-only profiles design, "Open network"): pure
 * data plus {@link classifyAddress}. The device workers (macOS SRT, the Linux forwarder) and the
 * cloud providers' egress proxies decide every sandboxed connection on the resolved address with
 * this one table, so the classes cannot drift between them.
 *
 * The table ({@link ADDRESS_CLASS_RANGES}) is data a copy in another language can mirror (the Linux
 * forwarder's Python): the class of an address is that of the longest-prefix range containing it.
 * Every family ends with a catch-all, so the table is total.
 */

/**
 * The class of one IP address.
 *
 * - `public`: globally routable; the only class open in `open-public` mode.
 * - `private`: `10/8`, `172.16/12`, `192.168/16`.
 * - `cgnat`: `100.64/10`.
 * - `ula`: IPv6 unique local `fc00::/7` (except the metadata address).
 * - `link-local`: `169.254/16` and `fe80::/10` (except the metadata addresses).
 * - `metadata`: cloud metadata endpoints (`169.254.169.254`, `fd00:ec2::254`).
 * - `loopback`: `127/8`, `::1`.
 * - `multicast`, `broadcast`, `unspecified` (`0/8`, `::`), `nat64` (the NAT64 prefixes),
 *   `reserved` (every other special-purpose range).
 *
 * The host's own interface addresses are not a class of the table: the worker that knows them
 * closes them in addition (a placeholder in the table test).
 */
export type AddressClass =
  | "public"
  | "private"
  | "cgnat"
  | "ula"
  | "link-local"
  | "metadata"
  | "loopback"
  | "multicast"
  | "broadcast"
  | "unspecified"
  | "nat64"
  | "reserved";

/** Every class closed in `open-public` mode: reachable only by running outside the sandbox. */
export const OPEN_PUBLIC_DENIED_CLASSES: readonly AddressClass[] = Object.freeze([
  "private",
  "cgnat",
  "ula",
  "link-local",
  "metadata",
  "loopback",
  "multicast",
  "broadcast",
  "unspecified",
  "nat64",
  "reserved",
]);

/**
 * One range of the address-class table. A range with `embeddedIpv4At` is an IPv6 form that carries
 * an IPv4 address (v4-mapped, SIIT, v4-compatible, 6to4): the address classifies as the 32-bit IPv4
 * address starting at that bit offset (from the most significant bit). The NAT64 prefixes are not
 * such ranges: the design closes them whatever they embed.
 */
export type AddressClassRange =
  | {
      readonly family: "ipv4" | "ipv6";
      /** `address/prefix`, the address in its canonical lower-case form. */
      readonly cidr: string;
      readonly class: AddressClass;
    }
  | { readonly family: "ipv6"; readonly cidr: string; readonly embeddedIpv4At: number };

const range = (family: "ipv4" | "ipv6", cidr: string, cls: AddressClass): AddressClassRange =>
  Object.freeze({ family, cidr, class: cls });
const embedded = (cidr: string, at: number): AddressClassRange =>
  Object.freeze({ family: "ipv6", cidr, embeddedIpv4At: at });

/**
 * The address-class table, most specific range first within each family (longest prefix wins).
 * IPv4 follows the kernel's `net/public-address.ts` (and the sandbox-docker egress proxy); IPv6
 * does too, plus closures the design adds: the well-known NAT64 prefixes (`64:ff9b::/96`,
 * `64:ff9b:1::/48`) whatever they embed, `2001::/23` (Teredo, ORCHID and the other IETF
 * assignments), `3fff::/20`, and everything outside global unicast `2000::/3`.
 *
 * Not covered: an operator-specific NAT64 prefix (a network-specific prefix, RFC 6052, announced
 * by the local DNS64) is ordinary global unicast here, so a private IPv4 address reached through
 * it classifies as public. A worker on such a network resolves through a resolver it trusts or adds
 * the prefix to its own deny list.
 */
export const ADDRESS_CLASS_RANGES: readonly AddressClassRange[] = Object.freeze([
  range("ipv4", "100.100.100.200/32", "metadata"), // Alibaba Cloud, inside CGNAT
  range("ipv4", "168.63.129.16/32", "metadata"), // Azure WireServer
  range("ipv4", "169.254.169.254/32", "metadata"),
  range("ipv4", "255.255.255.255/32", "broadcast"),
  range("ipv4", "192.0.0.0/24", "reserved"), // IETF protocol assignments
  range("ipv4", "192.0.2.0/24", "reserved"), // TEST-NET-1
  range("ipv4", "192.88.99.0/24", "reserved"), // 6to4 relay anycast
  range("ipv4", "198.51.100.0/24", "reserved"), // TEST-NET-2
  range("ipv4", "203.0.113.0/24", "reserved"), // TEST-NET-3
  range("ipv4", "169.254.0.0/16", "link-local"),
  range("ipv4", "192.168.0.0/16", "private"),
  range("ipv4", "198.18.0.0/15", "reserved"), // benchmarking
  range("ipv4", "172.16.0.0/12", "private"),
  range("ipv4", "100.64.0.0/10", "cgnat"),
  range("ipv4", "0.0.0.0/8", "unspecified"),
  range("ipv4", "10.0.0.0/8", "private"),
  range("ipv4", "127.0.0.0/8", "loopback"),
  range("ipv4", "224.0.0.0/4", "multicast"),
  range("ipv4", "240.0.0.0/4", "reserved"),
  range("ipv4", "0.0.0.0/0", "public"),
  range("ipv6", "::/128", "unspecified"),
  range("ipv6", "::1/128", "loopback"),
  range("ipv6", "fd00:ec2::254/128", "metadata"), // AWS IMDS over IPv6, inside ULA
  embedded("::ffff:0:0/96", 96), // v4-mapped
  embedded("::ffff:0:0:0/96", 96), // SIIT IPv4-translated
  range("ipv6", "64:ff9b::/96", "nat64"),
  embedded("::/96", 96), // v4-compatible (deprecated)
  range("ipv6", "100::/64", "reserved"), // discard-only
  range("ipv6", "64:ff9b:1::/48", "nat64"), // local-use NAT64
  range("ipv6", "2001:db8::/32", "reserved"), // documentation
  range("ipv6", "2001::/23", "reserved"), // IETF protocol assignments: Teredo, ORCHID, …
  range("ipv6", "3fff::/20", "reserved"), // documentation (RFC 9637)
  embedded("2002::/16", 16), // 6to4
  range("ipv6", "fe80::/10", "link-local"),
  range("ipv6", "fec0::/10", "reserved"), // deprecated site-local
  range("ipv6", "ff00::/8", "multicast"),
  range("ipv6", "fc00::/7", "ula"),
  range("ipv6", "2000::/3", "public"),
  range("ipv6", "::/0", "reserved"), // unallocated outside global unicast
]);

const OCTET = /^(0|[1-9][0-9]{0,2})$/;
const GROUP = /^[0-9a-fA-F]{1,4}$/;
const ZONE = /^[0-9A-Za-z._~-]+$/;

/** A strict dotted-quad IPv4 address as a number; null otherwise (no octal, hex or short forms). */
function ipv4Value(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!OCTET.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** An IPv6 address (optionally with a trailing dotted IPv4 address) as a 128-bit value; or null. */
function ipv6Value(ip: string): bigint | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const side = (s: string | undefined): string[] | null => {
    if (s === undefined || s === "") return [];
    const parts = s.split(":");
    const groups: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as string;
      if (i === parts.length - 1 && part.includes(".")) {
        const v4 = ipv4Value(part);
        if (v4 === null) return null;
        groups.push((v4 >>> 16).toString(16), (v4 & 0xffff).toString(16));
      } else if (GROUP.test(part)) groups.push(part);
      else return null;
    }
    return groups;
  };
  const head = side(halves[0]);
  const tail = halves.length === 2 ? side(halves[1]) : [];
  if (head === null || tail === null) return null;
  // a trailing IPv4 address may only end the address
  if (halves.length === 2 && halves[0]?.includes(".")) return null;
  const count = head.length + tail.length;
  if (halves.length === 2 ? count > 7 : count !== 8) return null;
  const groups = [...head, ...Array<string>(8 - count).fill("0"), ...tail];
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(Number.parseInt(g, 16));
  return value;
}

interface CompiledRange {
  readonly bits: 32 | 128;
  readonly network: bigint;
  readonly prefix: number;
  readonly entry: AddressClassRange;
}

const compiled: readonly CompiledRange[] = ADDRESS_CLASS_RANGES.map((entry) => {
  const [address = "", prefix = ""] = entry.cidr.split("/");
  const bits = entry.family === "ipv4" ? 32 : 128;
  const value = entry.family === "ipv4" ? ipv4Value(address) : ipv6Value(address);
  if (value === null) throw new Error(`Invalid address-class range ${entry.cidr}`);
  return { bits, network: BigInt(value), prefix: Number(prefix), entry };
});

function lookup(bits: 32 | 128, value: bigint): AddressClass {
  for (const r of compiled) {
    if (r.bits !== bits) continue;
    const shift = BigInt(bits - r.prefix);
    if (value >> shift !== r.network >> shift) continue;
    const e = r.entry;
    if ("class" in e) return e.class;
    return lookup(32, (value >> BigInt(128 - 32 - e.embeddedIpv4At)) & 0xffffffffn);
  }
  // unreachable: each family ends with a catch-all range
  throw new Error("The address-class table is not total");
}

/**
 * Classifies one IPv4 or IPv6 address literal by {@link ADDRESS_CLASS_RANGES}. IPv6 may carry a
 * zone (`fe80::1%en0`) and a trailing dotted IPv4 address; an IPv6 form that embeds an IPv4 address
 * (v4-mapped and the others in the table) classifies as that IPv4 address, except NAT64. Throws on a
 * string that is not an IP address: brackets, ports, short, octal or hex IPv4 forms, and an IPv4
 * address with a zone.
 */
export function classifyAddress(ip: string): AddressClass {
  const v4 = ipv4Value(ip);
  if (v4 !== null) return lookup(32, BigInt(v4));
  const zone = ip.indexOf("%");
  const address = zone >= 0 ? ip.slice(0, zone) : ip;
  if (zone >= 0 && !ZONE.test(ip.slice(zone + 1))) return notAnAddress(ip);
  const v6 = address.includes(":") ? ipv6Value(address) : null;
  if (v6 === null) return notAnAddress(ip);
  return lookup(128, v6);
}

function notAnAddress(ip: string): never {
  throw new Error(`${JSON.stringify(ip.slice(0, 64))} is not an IP address`);
}

const formatAddress = (bits: 32 | 128, v: bigint): string => {
  if (bits === 32) return [24n, 16n, 8n, 0n].map((sh) => ((v >> sh) & 0xffn).toString()).join(".");
  const groups = Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(112 - 16 * i)) & 0xffffn));
  // RFC 5952: the first longest run of two or more zero groups becomes "::"
  let best = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      best = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = (gs: number[]) => gs.map((g) => g.toString(16)).join(":");
  if (best < 0) return hex(groups);
  return `${hex(groups.slice(0, best))}::${hex(groups.slice(best + bestLength))}`;
};

/** The class shared by every address of the block, or null when the table splits it. */
function blockClass(bits: 32 | 128, network: bigint, prefix: number): AddressClass | null {
  let containing: CompiledRange | undefined;
  for (const r of compiled) {
    if (r.bits !== bits) continue;
    if (r.prefix > prefix) {
      const shift = BigInt(bits - prefix);
      if (r.network >> shift === network >> shift) return null; // a range inside the block
    } else if (containing === undefined) {
      const shift = BigInt(bits - r.prefix);
      if (r.network >> shift === network >> shift) containing = r;
    }
  }
  if (containing === undefined) return null;
  const e = containing.entry;
  if ("class" in e) return e.class;
  const at = e.embeddedIpv4At;
  const v4 = (network >> BigInt(128 - 32 - at)) & 0xffffffffn;
  return blockClass(32, v4, Math.min(32, Math.max(0, prefix - at)));
}

/** The closed CIDRs of a block, merged where both halves are closed ("full" = all closed). */
function closedOf(bits: 32 | 128, network: bigint, prefix: number): "full" | string[] {
  const cls = blockClass(bits, network, prefix);
  if (cls !== null) return OPEN_PUBLIC_DENIED_CLASSES.includes(cls) ? "full" : [];
  const half = 1n << BigInt(bits - prefix - 1);
  const halves = [network, network | half].map((n) => ({
    n,
    closed: closedOf(bits, n, prefix + 1),
  }));
  if (halves.every((h) => h.closed === "full")) return "full";
  return halves.flatMap((h) =>
    h.closed === "full" ? [`${formatAddress(bits, h.n)}/${prefix + 1}`] : h.closed,
  );
}

/**
 * Every address closed in `open-public` mode as one CIDR list (IPv4, then IPv6), computed from
 * {@link ADDRESS_CLASS_RANGES}: for a consumer that can only deny ranges (the macOS runtime's
 * resolved-address deny list). Embedded forms are expanded (the v4-mapped, SIIT, v4-compatible and
 * 6to4 sub-ranges of every closed IPv4 range), and adjacent closed blocks are merged. An address
 * is in a listed CIDR exactly when {@link classifyAddress} gives it a closed class.
 */
export const OPEN_PUBLIC_DENIED_CIDRS: readonly string[] = Object.freeze(
  ([32, 128] as const).flatMap((bits) => {
    const closed = closedOf(bits, 0n, 0);
    return closed === "full" ? [`${formatAddress(bits, 0n)}/0`] : closed;
  }),
);

/**
 * Encrypted DNS for a network whose resolver answers with fake IPs (maintainer decision
 * 2026-11-19): a router running a fake-IP proxy (OpenClash and the like) intercepts every port-53
 * query and answers each name with an address in {@link fakeIpCidr} (`198.18.0.0/15`, a reserved
 * class), so in open mode every name would resolve to a closed address. When the system
 * resolver's answer for a name contains such an address, a sandbox egress proxy re-resolves the
 * name (A and AAAA) through DNS-over-HTTPS at these IP-literal endpoints, in order (Cloudflare,
 * then Google as the fallback), verifying TLS against the endpoint's IP SAN so no DNS is needed
 * to reach them. Each request waits at most {@link timeoutMs}; answers are cached for their TTL,
 * at most {@link cacheTtlCapSeconds}. The real address is classified like any resolved address
 * and dialled as checked. When encrypted DNS fails the connection is refused, naming the fake-IP
 * resolver; the fake address is never dialled. The same rule applies to an allowlisted name.
 * Shared by the macOS worker and the Linux forwarder, so both keep identical endpoints and limits.
 */
export const SANDBOX_FAKE_IP_DNS: {
  readonly fakeIpCidr: string;
  readonly endpoints: readonly string[];
  readonly timeoutMs: number;
  readonly cacheTtlCapSeconds: number;
} = Object.freeze({
  fakeIpCidr: "198.18.0.0/15",
  endpoints: Object.freeze([
    "https://1.1.1.1/dns-query",
    "https://1.0.0.1/dns-query",
    "https://8.8.8.8/dns-query",
  ]),
  timeoutMs: 3000,
  cacheTtlCapSeconds: 300,
});
