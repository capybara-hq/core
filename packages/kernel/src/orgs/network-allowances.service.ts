import { randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { Inject, Injectable, Module } from "@nestjs/common";
import { publicSuffixWildcard } from "../devices/public-suffix.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { normalizeHost, parseCidr, privateHostEntryProblem } from "../net/public-address.js";

/**
 * Org network allowances (plugin safe fetch spec): the internal endpoints a super admin lets one
 * org's extension requests (`ctx.net.fetch` made for that org) reach although they resolve to
 * private or loopback addresses. Stored in `capybara.org_network_allowances`, read from PG on every
 * call (no in-process cache: a removal takes effect on the next request on every replica).
 *
 * An entry is one of:
 * - a hostname or a `*.domain` wildcard (https, any port; the domain has at least two labels and is
 *   not a known public suffix);
 * - an IP address or a CIDR (IP-literal URL hosts only, within `MIN_CIDR_PREFIX`);
 * - an origin `http(s)://host[:port]`: exactly that scheme, host and port, plain http included.
 * Link-local and cloud metadata addresses (`100.100.100.200`, `fd00:ec2::254`), loopback and
 * unspecified addresses are never allowed (`localhost` names included), nor IPv6 forms that embed an IPv4 address, so entries naming them are refused.
 */

/** The most entries one org may hold. */
export const ORG_NETWORK_ALLOWANCES_MAX = 200;

const ENTRY_MAX_LENGTH = 300;

/** How much of a refused entry an error echoes back. */
const ECHO_MAX_LENGTH = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Cidr = [string, number, "ipv4" | "ipv6"];

/**
 * Ranges no entry may overlap, with the reason. Only ranges of the entry's own family are compared
 * (Node's `BlockList` matches v4-mapped addresses across families, which would refuse every IPv4
 * entry against `::ffff:0:0/96`). `inside` ranges (single metadata addresses inside private ranges)
 * refuse only entries within them: a CIDR such as `fd00::/16` stays valid, and the runtime check
 * (`net/public-address.ts`) refuses the metadata address itself whatever the entries.
 */
const REFUSED_RANGES: readonly { cidr: Cidr; reason: string; inside?: true }[] = [
  ...(
    [
      ["169.254.0.0", 16, "ipv4"],
      ["fe80::", 10, "ipv6"],
    ] as Cidr[]
  ).map((cidr) => ({
    cidr,
    reason: "link-local addresses (including cloud metadata) are never allowed",
  })),
  ...(
    [
      ["100.100.100.200", 32, "ipv4"], // Alibaba Cloud
      ["fd00:ec2::254", 128, "ipv6"], // AWS IMDS over IPv6
    ] as Cidr[]
  ).map((cidr) => ({
    cidr,
    reason: "cloud metadata endpoints are never allowed",
    inside: true as const,
  })),
  ...(
    [
      ["127.0.0.0", 8, "ipv4"],
      ["0.0.0.0", 8, "ipv4"],
      ["::", 128, "ipv6"],
      ["::1", 128, "ipv6"],
    ] as Cidr[]
  ).map((cidr) => ({
    cidr,
    reason: "loopback and unspecified addresses (the kernel's own host) are never allowed",
  })),
  ...(
    [
      ["::ffff:0:0", 96, "ipv6"], // v4-mapped
      ["::ffff:0:0:0", 96, "ipv6"], // SIIT
      ["::", 96, "ipv6"], // v4-compatible
      ["64:ff9b::", 96, "ipv6"], // NAT64
      ["2002::", 16, "ipv6"], // 6to4
    ] as Cidr[]
  ).map((cidr) => ({
    cidr,
    reason: "IPv6 addresses that embed an IPv4 address are not accepted: write the IPv4 address",
  })),
];

const LOOPBACK_NAME = "localhost names (the kernel's own host) are never allowed";

/** Whether two CIDRs of one family overlap: aligned ranges overlap iff one holds the other's start. */
function overlaps([a, ap, af]: Cidr, [b, bp, bf]: Cidr): boolean {
  if (af !== bf) return false;
  const ra = new BlockList();
  ra.addSubnet(a, ap, af);
  const rb = new BlockList();
  rb.addSubnet(b, bp, bf);
  return ra.check(b, bf) || rb.check(a, af);
}

/** Whether `inner` lies within `outer` (one family). */
function within(inner: Cidr, outer: Cidr): boolean {
  return overlaps(inner, outer) && inner[1] >= outer[1];
}

/** The reason an IP or CIDR (as a CIDR) touches a refused range, or null. */
function refusedRangeProblem(cidr: Cidr): string | null {
  return (
    REFUSED_RANGES.find((r) => (r.inside ? within(cidr, r.cidr) : overlaps(cidr, r.cidr)))
      ?.reason ?? null
  );
}

const asCidr = (ip: string): Cidr =>
  isIP(ip) === 4 ? [ip, 32, "ipv4"] : [ip.toLowerCase(), 128, "ipv6"];

/** The canonical spelling of an IPv6 address (`FD00:0::1` -> `fd00::1`). */
const canonicalV6 = (ip: string) => new URL(`http://[${ip}]`).hostname.slice(1, -1);

const isLocalhostName = (h: string) => h === "localhost" || h.endsWith(".localhost");

/** A last label a URL parser reads as a number (`2130706433`, `0x7f.1`): an IP in disguise. */
const numericLastLabel = (h: string) => /^(\d+|0x[0-9a-f]*)$/i.test(h.split(".").pop() ?? "");

const isOrigin = (entry: string) => entry.includes("://");

/** Why a hostname or IP (normalized, no wildcard, no CIDR) may not be allowed, or null. */
function hostProblem(host: string): string | null {
  if (isIP(host) !== 0) return refusedRangeProblem(asCidr(host));
  if (privateHostEntryProblem(host) !== null) return null; // the caller reports the syntax
  if (isLocalhostName(host)) return LOOPBACK_NAME;
  if (numericLastLabel(host)) return "a numeric host must be written as a dotted IP address";
  return null;
}

/** Why a plain host entry (hostname, IP or CIDR, no wildcard or scheme) is invalid, or null. */
function hostEntryProblem(entry: string): string | null {
  const cidr = parseCidr(entry);
  if (cidr) return privateHostEntryProblem(entry) ?? refusedRangeProblem(cidr);
  const host = normalizeHost(entry);
  if (/^[^/[\]]+:\d+$/.test(host) && isIP(host) === 0) {
    return "a host with a port must be written as an origin such as http://host:8080";
  }
  if (privateHostEntryProblem(entry) !== null) {
    return "must be a hostname, a *.domain wildcard, an IP address, a CIDR such as 10.1.0.0/16 or an origin such as http://host:8080";
  }
  return hostProblem(host);
}

/** Why a `*.domain` entry is invalid, or null. */
function wildcardProblem(entry: string): string | null {
  const base = normalizeHost(entry.slice(2));
  if (
    !entry.startsWith("*.") ||
    base === "" ||
    isIP(base) !== 0 ||
    parseCidr(base) ||
    privateHostEntryProblem(base) !== null ||
    numericLastLabel(base)
  ) {
    return "a wildcard must be written *.domain, e.g. *.corp.example";
  }
  if (isLocalhostName(base)) return LOOPBACK_NAME;
  return publicSuffixWildcard(`*.${base}`);
}

/** The origin's host: WHATWG-normalized (numeric forms become dotted IPs), without trailing dots. */
const originHost = (url: URL) => normalizeHost(url.hostname);

/** Why an origin entry is invalid, or null. */
function originProblem(entry: string): string | null {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return "is not a valid origin such as http://host:8080";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "an origin must use http or https";
  }
  if (url.username !== "" || url.password !== "") return "an origin must not carry credentials";
  if (url.search !== "" || entry.includes("?")) return "an origin has no query";
  if (url.hash !== "" || entry.includes("#")) return "an origin has no fragment";
  if (url.pathname !== "/") return "an origin has no path: allow the whole origin";
  const host = originHost(url);
  if (parseCidr(host) || privateHostEntryProblem(host) !== null) {
    return "an origin's host must be a hostname or an IP address";
  }
  return hostProblem(host);
}

/**
 * Why an allowance entry is invalid (English, shown to the super admin), or null when it is valid
 * (see the file header for the accepted forms). Reuses `privateHostEntryProblem` for hosts, IPs and
 * CIDRs; refuses link-local, loopback and unspecified addresses (also as `localhost` names, numeric
 * hosts and inside origins), IPv6 forms that embed IPv4, wildcards over a public suffix, and
 * origins with a path, query, fragment or credentials.
 */
export function allowanceEntryProblem(entry: string): string | null {
  const e = entry.trim();
  if (e === "") return "must not be empty";
  if (e.length > ENTRY_MAX_LENGTH) return `must be at most ${ENTRY_MAX_LENGTH} characters`;
  if (isOrigin(e)) return originProblem(e);
  if (e.startsWith("*")) return wildcardProblem(e);
  return hostEntryProblem(e);
}

/**
 * The stored form of a valid entry: hosts lower case without brackets or trailing dots, IPv6
 * addresses and CIDRs in canonical spelling, origins as scheme, host and port (default ports
 * dropped), so one endpoint is stored once.
 */
export function normalizeAllowanceEntry(entry: string): string {
  const e = entry.trim();
  if (isOrigin(e)) {
    const url = new URL(e);
    const host = originHost(url);
    url.hostname = isIP(host) === 6 ? `[${host}]` : host;
    return url.origin;
  }
  if (e.startsWith("*.")) return `*.${normalizeHost(e.slice(2))}`;
  const cidr = parseCidr(e);
  if (cidr) {
    const [addr, prefix, family] = cidr;
    return `${family === "ipv6" ? canonicalV6(addr) : addr}/${prefix}`;
  }
  const host = normalizeHost(e);
  return isIP(host) === 6 ? canonicalV6(host) : host;
}

export type OrgNetworkAllowance = {
  id: string;
  entry: string;
  createdAt: Date;
  createdBy: string | null;
};

/** What an org's allowances exempt, in the shape of `NetPolicy` (`net/public-address.ts`). */
export type OrgNetworkPolicy = { allowPrivateHosts: string[]; trustedOrigins: string[] };

@Injectable()
export class OrgNetworkAllowances {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** The org's entries, oldest first. */
  async list(orgId: string): Promise<OrgNetworkAllowance[]> {
    const rows = await this.db
      .selectFrom("org_network_allowances")
      .select(["id", "entry", "created_at", "created_by"])
      .where("org_id", "=", orgId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map(toAllowance);
  }

  /**
   * Adds an entry (super admin only; the route enforces it). Refuses an invalid entry with
   * `org.network_allowance_invalid` and the reason; an entry already listed is returned as is,
   * without a second audit event.
   */
  @Transactional()
  async add(orgId: string, entry: string, actorId: string): Promise<OrgNetworkAllowance> {
    const problem = allowanceEntryProblem(entry);
    if (problem !== null) {
      const shown = echoed(entry);
      throw new ApiError("org.network_allowance_invalid", `${shown}: ${problem}`, [
        { entry: shown, reason: problem },
      ]);
    }
    const normalized = normalizeAllowanceEntry(entry);
    // locks the org row: concurrent adds count against the cap one at a time
    const org = await this.db
      .selectFrom("orgs")
      .select("id")
      .where("id", "=", orgId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!org) throw new ApiError("org.not_found", "Organization not found");

    const existing = await this.db
      .selectFrom("org_network_allowances")
      .select(["id", "entry", "created_at", "created_by"])
      .where("org_id", "=", orgId)
      .where("entry", "=", normalized)
      .executeTakeFirst();
    if (existing) return toAllowance(existing);

    const { count } = await this.db
      .selectFrom("org_network_allowances")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow();
    if (Number(count) >= ORG_NETWORK_ALLOWANCES_MAX) {
      const reason = `an organization may list at most ${ORG_NETWORK_ALLOWANCES_MAX} internal endpoints`;
      throw new ApiError("org.network_allowance_invalid", reason, [
        { entry: echoed(entry), reason },
      ]);
    }

    const row = await this.db
      .insertInto("org_network_allowances")
      .values({ id: randomUUID(), org_id: orgId, entry: normalized, created_by: actorId })
      .returning(["id", "entry", "created_at", "created_by"])
      .executeTakeFirstOrThrow();
    await audit(this.db.db, {
      actorAccountId: actorId,
      orgId,
      action: "org.network_allowance_added",
      target: row.id,
      detail: { entry: normalized },
    });
    return toAllowance(row);
  }

  /** Removes the org's entry `id`; false (and no audit event) when the org has no such entry. */
  @Transactional()
  async remove(orgId: string, id: string, actorId: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const row = await this.db
      .deleteFrom("org_network_allowances")
      .where("org_id", "=", orgId)
      .where("id", "=", id)
      .returning(["entry"])
      .executeTakeFirst();
    if (!row) return false;
    await audit(this.db.db, {
      actorAccountId: actorId,
      orgId,
      action: "org.network_allowance_removed",
      target: id,
      detail: { entry: row.entry },
    });
    return true;
  }

  /**
   * The exemptions of an org-bound request: origins become `trustedOrigins`, hosts, wildcards, IPs
   * and CIDRs `allowPrivateHosts`. A deleted (or unknown) org allows nothing.
   */
  async policyFor(orgId: string): Promise<OrgNetworkPolicy> {
    const rows = await this.db
      .selectFrom("org_network_allowances as a")
      .innerJoin("orgs as o", "o.id", "a.org_id")
      .select("a.entry")
      .where("a.org_id", "=", orgId)
      .where("o.deleted_at", "is", null)
      .orderBy("a.created_at")
      .execute();
    const policy: OrgNetworkPolicy = { allowPrivateHosts: [], trustedOrigins: [] };
    for (const { entry } of rows) {
      (isOrigin(entry) ? policy.trustedOrigins : policy.allowPrivateHosts).push(entry);
    }
    return policy;
  }
}

/** The raw entry as echoed in an error, cut to {@link ECHO_MAX_LENGTH} characters. */
function echoed(entry: string): string {
  const e = entry.trim();
  return e.length > ECHO_MAX_LENGTH ? `${e.slice(0, ECHO_MAX_LENGTH)}…` : e;
}

function toAllowance(row: {
  id: string;
  entry: string;
  created_at: Date;
  created_by: string | null;
}): OrgNetworkAllowance {
  return { id: row.id, entry: row.entry, createdAt: row.created_at, createdBy: row.created_by };
}

/**
 * {@link OrgNetworkAllowances} alone (its only dependencies are the global database providers), so
 * the extension host (`ctx.net`) can read the allowances without importing the orgs domain, which
 * itself imports the extensions domain.
 */
@Module({ providers: [OrgNetworkAllowances], exports: [OrgNetworkAllowances] })
export class OrgNetworkAllowancesModule {}
