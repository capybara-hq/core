import { randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import {
  isLinkLocalAddress,
  normalizeHost,
  parseCidr,
  privateHostEntryProblem,
} from "../net/public-address.js";

/**
 * Org network allowances (plugin safe fetch spec): the internal endpoints a super admin lets one
 * org's extension requests (`ctx.net.fetch` made for that org) reach although they resolve to
 * private or loopback addresses. Stored in `capybara.org_network_allowances`, read from PG on every
 * call (no in-process cache: a removal takes effect on the next request on every replica).
 *
 * An entry is one of:
 * - a hostname or a `*.domain` wildcard (https, any port);
 * - an IP address or a CIDR (IP-literal URL hosts only, within `MIN_CIDR_PREFIX`);
 * - an origin `http(s)://host[:port]`: exactly that scheme, host and port, plain http included.
 * Link-local addresses (cloud metadata) are never allowed, so entries naming them are refused.
 */

/** The most entries one org may hold. */
export const ORG_NETWORK_ALLOWANCES_MAX = 200;

const ENTRY_MAX_LENGTH = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const linkLocal = new BlockList();
linkLocal.addSubnet("169.254.0.0", 16, "ipv4");
linkLocal.addSubnet("fe80::", 10, "ipv6");

const LINK_LOCAL_REFUSED = "link-local addresses (including cloud metadata) are never allowed";

const isOrigin = (entry: string) => entry.includes("://");

/** A CIDR that overlaps the link-local ranges (inside them, or containing them). */
function cidrTouchesLinkLocal([addr, prefix, family]: [string, number, "ipv4" | "ipv6"]): boolean {
  if (linkLocal.check(addr, family)) return true;
  const range = new BlockList();
  range.addSubnet(addr, prefix, family);
  return family === "ipv4" ? range.check("169.254.0.0", "ipv4") : range.check("fe80::", "ipv6");
}

/** Why a plain host entry (hostname, IP or CIDR, no wildcard or scheme) is invalid, or null. */
function hostEntryProblem(entry: string): string | null {
  const cidr = parseCidr(entry);
  if (cidr) {
    const problem = privateHostEntryProblem(entry);
    if (problem !== null) return problem;
    return cidrTouchesLinkLocal(cidr) ? `the CIDR ${entry.trim()}: ${LINK_LOCAL_REFUSED}` : null;
  }
  const host = normalizeHost(entry);
  if (/^[^/[\]]+:\d+$/.test(host) && isIP(host) === 0) {
    return "a host with a port must be written as an origin such as http://host:8080";
  }
  if (privateHostEntryProblem(entry) !== null) {
    return "must be a hostname, a *.domain wildcard, an IP address, a CIDR such as 10.1.0.0/16 or an origin such as http://host:8080";
  }
  if (isIP(host) !== 0 && isLinkLocalAddress(host)) return LINK_LOCAL_REFUSED;
  return null;
}

/** Why an origin entry is invalid, or null; `parsed` is set when it is valid. */
function originProblem(entry: string): { problem: string | null; parsed?: URL } {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return { problem: "is not a valid origin such as http://host:8080" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { problem: "an origin must use http or https" };
  }
  if (url.username !== "" || url.password !== "") {
    return { problem: "an origin must not carry credentials" };
  }
  if (url.search !== "" || entry.includes("?")) return { problem: "an origin has no query" };
  if (url.hash !== "" || entry.includes("#")) return { problem: "an origin has no fragment" };
  if (url.pathname !== "/") return { problem: "an origin has no path: allow the whole origin" };
  const host = normalizeHost(url.hostname);
  if (parseCidr(host) || privateHostEntryProblem(host) !== null) {
    return { problem: "an origin's host must be a hostname or an IP address" };
  }
  if (isIP(host) !== 0 && isLinkLocalAddress(host)) return { problem: LINK_LOCAL_REFUSED };
  return { problem: null, parsed: url };
}

/**
 * Why an allowance entry is invalid (English, shown to the super admin), or null when it is valid
 * (see the file header for the accepted forms). Reuses `privateHostEntryProblem` for hosts, IPs and
 * CIDRs; refuses link-local addresses and origins with a path, query, fragment or credentials.
 */
export function allowanceEntryProblem(entry: string): string | null {
  const e = entry.trim();
  if (e === "") return "must not be empty";
  if (e.length > ENTRY_MAX_LENGTH) return `must be at most ${ENTRY_MAX_LENGTH} characters`;
  if (isOrigin(e)) return originProblem(e).problem;
  if (e.startsWith("*")) {
    const rest = e.slice(2);
    if (!e.startsWith("*.") || rest === "" || parseCidr(rest) || isIP(normalizeHost(rest)) !== 0) {
      return "a wildcard must be written *.domain, e.g. *.corp.example";
    }
    return privateHostEntryProblem(rest) === null
      ? null
      : "a wildcard must be written *.domain, e.g. *.corp.example";
  }
  return hostEntryProblem(e);
}

/**
 * The stored form of a valid entry: hosts lower case without brackets or trailing dots, origins as
 * their URL origin (default ports dropped), so one endpoint is stored once.
 */
export function normalizeAllowanceEntry(entry: string): string {
  const e = entry.trim();
  if (isOrigin(e)) return new URL(e).origin;
  if (e.startsWith("*.")) return `*.${normalizeHost(e.slice(2))}`;
  if (parseCidr(e)) return e.toLowerCase();
  return normalizeHost(e);
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
      throw new ApiError("org.network_allowance_invalid", `${entry.trim()}: ${problem}`, [
        { entry, reason: problem },
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
      throw new ApiError("org.network_allowance_invalid", reason, [{ entry, reason }]);
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

function toAllowance(row: {
  id: string;
  entry: string;
  created_at: Date;
  created_by: string | null;
}): OrgNetworkAllowance {
  return { id: row.id, entry: row.entry, createdAt: row.created_at, createdBy: row.created_by };
}
