import {
  type DeviceExecGrants,
  type NetworkBlockedHost,
  type SandboxLimits,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { budgetRunOf } from "../runtime/subagents/limits.js";

/** The most hosts one exec's grants carry (the device protocol's limit). */
export const MAX_GRANT_HOSTS = 100;

/** The statuses of a run that has not ended: its run grants still apply. */
const LIVE_RUN = ["queued", "running", "waiting"] as const;

/** The statuses of a network ask that refuse its hosts for the rest of the run tree (§6.8). */
const REFUSING = new Set(["denied", "expired", "skipped", "cancelled"]);

/** What a run tree's network asks add up to (network ask-to-allow spec §6.8). */
export interface NetworkRunState {
  /** Hosts allowed for the rest of the run tree (「这次允许」). */
  granted: Set<string>;
  /** Hosts refused in the run tree (denied, expired, skipped, cancelled, or unchecked): never asked again. */
  refused: Set<string>;
  /** Network asks of this run (the per-run cap counts them). */
  asks: number;
  /** A network ask of the run tree is still pending (at most one at a time). */
  pending: boolean;
}

/** An exact host a grant may carry: no wildcard, valid. */
const exactHost = (h: unknown): h is string =>
  typeof h === "string" && !h.startsWith("*.") && validateAllowHost(h).length === 0;

/** `detail.deviceId` of a network ask: the device it asked about. */
function deviceOf(detail: unknown): string | undefined {
  const d = (detail as { deviceId?: unknown } | null)?.deviceId;
  return typeof d === "string" ? d : undefined;
}

/** `detail.grantedHosts` of a decided network ask: what the decision allowed (absent: none). */
function grantedOf(detail: unknown): string[] {
  const g = (detail as { grantedHosts?: unknown } | null)?.grantedHosts;
  return Array.isArray(g) ? g.filter(exactHost) : [];
}

/** `detail.hosts[].host` of a network ask: what it asked about. */
function askedOf(detail: unknown): string[] {
  const hs = (detail as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(hs)) return [];
  return hs.flatMap((h) => {
    const host = (h as { host?: unknown } | null)?.host;
    return typeof host === "string" ? [host] : [];
  });
}

/**
 * Network hosts the kernel allows a run beyond a device's local policy (network ask-to-allow spec
 * §6.3): the hosts of the run tree's approved `network` asks with scope `once` (「这次允许」), read
 * from PG for every exec, so a grant decided on one replica reaches a command on any other. A run
 * tree is the runs of one budget window (`runs.budget_run_id` lineage): a sub-agent's run sees the
 * root's grants, another run tree never does. The hosts a decision allowed are its
 * `detail.grantedHosts`; a decision without them grants nothing.
 */
@Injectable()
export class NetworkGrants {
  constructor(@Inject(KernelDb) private readonly db: KernelDb) {}

  /**
   * Hosts allowed for this exec on `deviceId`: the run tree's once-approved network asks in
   * `orgId` about that device, while the tree's root run has not ended (a grant ends with its run;
   * a later run of the same budget window does not inherit it), with the root run as their source
   * and the latest decider as its account; undefined when none. The device applies them only when
   * its owner allows remote grants and only within the org's limits.
   */
  async forExec(input: {
    orgId: string;
    runId: string;
    deviceId: string;
  }): Promise<DeviceExecGrants | undefined> {
    return (await this.runGrants(input)) ?? (await this.taskGrants(input));
  }

  /**
   * The run tree's network asks (spec §6.8): what was granted and refused, the run's asks, a
   * pending ask. With `deviceId`, granted and refused count only the asks about that device (a
   * host allowed on one device is not allowed on another); the cap and the pending ask count all.
   */
  async runState(runId: string, deviceId?: string): Promise<NetworkRunState> {
    const root = await budgetRunOf(this.db.db, runId);
    const rows = await this.db
      .selectFrom("approvals")
      .select(["run_id", "status", "scope", "detail"])
      .where("kind", "=", "network")
      .where("run_id", "in", this.treeOf(root))
      .execute();
    const state: NetworkRunState = {
      granted: new Set(),
      refused: new Set(),
      asks: 0,
      pending: false,
    };
    for (const r of rows) {
      if (r.run_id === runId) state.asks++;
      if (r.status === "pending") {
        state.pending = true;
      } else if (deviceId !== undefined && deviceOf(r.detail) !== deviceId) {
        // another device's decision says nothing about this one
      } else if (r.status === "approved") {
        const granted = grantedOf(r.detail);
        if (r.scope === "once") for (const h of granted) state.granted.add(h);
        // the hosts left unchecked in a partial decision count as denied (P-D5)
        for (const h of askedOf(r.detail)) if (!granted.includes(h)) state.refused.add(h);
      } else if (REFUSING.has(r.status)) {
        for (const h of askedOf(r.detail)) state.refused.add(h);
      }
    }
    return state;
  }

  /** The run tree's once-approved hosts as exec grants (source: the root run). */
  private async runGrants(input: {
    orgId: string;
    runId: string;
    deviceId: string;
  }): Promise<DeviceExecGrants | undefined> {
    const root = await budgetRunOf(this.db.db, input.runId);
    const live = await this.db
      .selectFrom("runs")
      .select("id")
      .where("id", "=", root)
      .where("status", "in", LIVE_RUN)
      .executeTakeFirst();
    if (live === undefined) return undefined;
    const rows = await this.db
      .selectFrom("approvals")
      .select(["decided_by", "detail"])
      .where("kind", "=", "network")
      .where("org_id", "=", input.orgId)
      .where("status", "=", "approved")
      .where("scope", "=", "once")
      .where("decided_by", "is not", null)
      .where(sql<string>`detail->>'deviceId'`, "=", input.deviceId)
      .where("run_id", "in", this.treeOf(root))
      .orderBy("decided_at", "desc")
      .orderBy("id", "desc")
      .execute();
    const hosts = [...new Set(rows.flatMap((r) => grantedOf(r.detail)))].slice(0, MAX_GRANT_HOSTS);
    const latest = rows.find((r) => grantedOf(r.detail).length > 0);
    if (hosts.length === 0 || latest?.decided_by == null) return undefined;
    return { hosts, source: { kind: "run", id: root, accountId: latest.decided_by } };
  }

  /**
   * A scheduled task's network grants for an unattended run (spec §8.1): the second source of
   * exec grants, filled by the task grants of phase 2; none yet.
   */
  private async taskGrants(_input: {
    orgId: string;
    runId: string;
    deviceId: string;
  }): Promise<DeviceExecGrants | undefined> {
    return undefined;
  }

  /** The runs of the tree whose budget run is `root`. */
  private treeOf(root: string) {
    return this.db
      .selectFrom("runs")
      .select("id")
      .where((eb) => eb.or([eb("id", "=", root), eb("budget_run_id", "=", root)]));
  }
}

const normalize = (host: string): string => {
  const h = host.toLowerCase();
  return h.endsWith(".") ? h.slice(0, -1) : h;
};

/** Whether the allowlist entry `pattern` admits `host` (`*.x.com`: subdomains, never the apex). */
const covers = (pattern: string, host: string): boolean =>
  pattern === host || (pattern.startsWith("*.") && host.endsWith(pattern.slice(1)));

/** Whether the org's effective egress lets a command reach `host`. */
export function orgAllows(
  host: string,
  limits: Pick<SandboxLimits, "egress" | "allowHosts">,
): boolean {
  if (limits.egress === "none") return false;
  if (limits.egress === "open") return true;
  const h = normalize(host);
  return limits.allowHosts.some((p) => covers(p.toLowerCase(), h));
}

/**
 * The kernel's own layer for a device's report (spec §4.1 item 3): it trusts the device's word that
 * a host was refused, never its word that the org allows it. A host the device calls `device` that
 * the org's effective egress (`limits`, read for this exec) does not allow becomes `org`; one that
 * is no valid host name becomes `address`. Other layers are kept.
 */
export function relayer(
  blocked: NetworkBlockedHost[],
  limits: Pick<SandboxLimits, "egress" | "allowHosts">,
): NetworkBlockedHost[] {
  return blocked.map((b) => {
    if (b.layer !== "device") return b;
    const h = normalize(b.host);
    if (validateAllowHost(h).length > 0 || h.startsWith("*.")) {
      return { ...b, layer: "address" };
    }
    return orgAllows(b.host, limits) ? b : { ...b, layer: "org" };
  });
}

/**
 * `grants` cut to the hosts the org's effective egress (`limits`, read for this exec) admits, or
 * undefined when none is left. The device intersects them with the limits too; the kernel does
 * it first so a grant never reaches a device beyond what the org allows.
 */
export function grantsWithin(
  grants: DeviceExecGrants | undefined,
  limits: Pick<SandboxLimits, "egress" | "allowHosts">,
): DeviceExecGrants | undefined {
  if (grants === undefined) return undefined;
  const hosts = grants.hosts.filter((h) => orgAllows(h, limits));
  return hosts.length === 0 ? undefined : { ...grants, hosts };
}
