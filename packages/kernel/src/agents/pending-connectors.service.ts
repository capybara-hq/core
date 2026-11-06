import { connectorToolKey } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { roleAtLeast } from "../orgs/roles.js";
import { AgentLookup, type AgentView, isAgentVisibleTo } from "./agent-lookup.js";
import { AgentsService } from "./agents.service.js";
import {
  type AgentDefinition,
  type AgentToolRef,
  normalizeStoredDefinition,
} from "./definition.js";
import { PendingConnectorRequests } from "./pending-connector-requests.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RANK = { ask: 1, deny: 2 } as const;

/** Why a connector does not fit a pending entry (ruling P4-T6-1). */
export type PendingMismatch = "template" | "protocol" | "tools" | "not_synced";

const MISMATCH: Record<PendingMismatch, string> = {
  template: "The connector was not made from the connector template this entry needs",
  protocol: "The connector's protocol is not the one this entry needs",
  tools: "The connector offers none of the tools this entry needs",
  not_synced:
    "The connector has not listed its tools yet; authorize the connector first, then bind it",
};

const mismatch = (reason: PendingMismatch) =>
  new ApiError("agent.pending_connector_mismatch", MISMATCH[reason], [{ reason }]);

const connectorNotFound = () => new ApiError("connector.not_found", "Connector not found");

/** What binding a pending connector did. */
export interface BindResult {
  agent: AgentView;
  /**
   * What the entry named and the connector does not offer, left out: `tools.<name>`,
   * `policies.<name>`.
   */
  dropped: string[];
}

/**
 * Resolving an agent's pending connectors (rulings P4-6, P4-7): binding a connector of the org to a
 * pending entry, and the agent's connector setup request (re-opening it, reading the latest).
 * Writes run under the org row lock and the agent row lock ({@link AgentsService.lockForWrite}: the
 * owner or an org admin+).
 */
@Injectable()
export class PendingConnectorsService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(AgentsService) private readonly agents: Pick<AgentsService, "lockForWrite">,
    @Inject(AgentLookup) private readonly lookup: Pick<AgentLookup, "view">,
    @Inject(PendingConnectorRequests)
    private readonly requests: Pick<PendingConnectorRequests, "open" | "settleIn">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** The current version's definition of a locked agent. */
  private async currentDefinition(agentId: string, version: number): Promise<AgentDefinition> {
    const row = await this.kdb.db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", agentId)
      .where("version", "=", version)
      .executeTakeFirstOrThrow();
    return normalizeStoredDefinition(row.definition);
  }

  /**
   * Binds connector `connectorId` to the agent's pending entry `key` (ruling P4-6; P4-T6-1,
   * P4-T6-2): a new agent version with a connector ref to it (merged into an existing ref of that
   * connector) for the entry's tools the connector offers (all of them when the entry names none),
   * the entry's policies on those tools (the tighter one wins), and without the entry; then the
   * setup request narrows or closes (`approved`). Refused: no entry `key` -> 404
   * `agent.pending_connector_not_found`; a connector that is missing, deleted or of another org ->
   * 404 `connector.not_found`; another connector template (a `template` entry), another protocol
   * (a `needs` entry), no tool snapshot yet (`not_synced`: an authorization-code connector nobody
   * authorized) or none of the entry's tools -> 400 `agent.pending_connector_mismatch`.
   * Audits `agent.pending_connector_bound`.
   */
  @Transactional()
  async bind(
    orgId: string,
    agentId: string,
    key: string,
    connectorId: string,
    actor: string,
    actorTokenId?: string,
  ): Promise<BindResult> {
    const t = this.kdb.db;
    const before = await this.agents.lockForWrite(orgId, agentId, actor);
    const def = await this.currentDefinition(agentId, before.current_version);
    const pending = def.pendingConnectors ?? [];
    const entry = pending.find((c) => c.key === key);
    if (!entry) {
      throw new ApiError(
        "agent.pending_connector_not_found",
        "The agent has no pending connector with this key",
      );
    }
    if (!UUID_RE.test(connectorId)) throw connectorNotFound();
    const c = await t
      .selectFrom("connectors")
      .select(["id", "slug", "connector", "platform_template_id", "tools_synced_at"])
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!c) throw connectorNotFound();
    if ("template" in entry.source) {
      if (c.platform_template_id !== entry.source.template) throw mismatch("template");
    } else if (c.connector !== entry.source.needs.protocol) {
      throw mismatch("protocol");
    }
    // an authorization-code connector before its first snapshot has no tools to pick from: never
    // bind "all" blind and drop the entry's policies; the entry stays pending (fix round 1)
    if (c.tools_synced_at === null) throw mismatch("not_synced");
    const offered = (
      await t
        .selectFrom("connector_tools")
        .select("name")
        .where("connector_id", "=", c.id)
        .orderBy("name")
        .execute()
    ).map((r) => r.name);
    const dropped: string[] = [];
    // an entry naming no tools takes them all (P4-T6-2)
    let names: "all" | string[] = "all";
    if (entry.tools !== undefined && entry.tools.length > 0) {
      const present = entry.tools.filter((n) => offered.includes(n));
      if (present.length === 0) throw mismatch("tools");
      for (const n of entry.tools) if (!present.includes(n)) dropped.push(`tools.${n}`);
      names = present;
    }
    const kept = names === "all" ? offered : names;
    const toolPolicies = { ...def.toolPolicies };
    for (const [n, p] of Object.entries(entry.policies ?? {})) {
      if (!kept.includes(n)) {
        dropped.push(`policies.${n}`);
        continue;
      }
      const k = connectorToolKey(c.slug, n);
      const prev = toolPolicies[k];
      if (prev === undefined || RANK[p] > RANK[prev]) toolPolicies[k] = p;
    }
    let merged = false;
    const tools: AgentToolRef[] = def.tools.map((r) => {
      if (r.kind !== "connector" || r.connectorId !== c.id || merged) return r;
      merged = true;
      if (r.tools === "all") return r;
      return {
        ...r,
        tools: names === "all" ? "all" : [...new Set([...(r.tools as string[]), ...names])],
      };
    });
    if (!merged) tools.push({ kind: "connector", connectorId: c.id, tools: names });
    const left = pending.filter((x) => x.key !== key);
    const { pendingConnectors: _old, ...rest } = def;
    const next: AgentDefinition = {
      ...rest,
      tools,
      toolPolicies,
      ...(left.length > 0 && { pendingConnectors: left }),
    };
    const toVersion = before.current_version + 1;
    await t
      .insertInto("agent_versions")
      .values({
        agent_id: agentId,
        version: toVersion,
        definition: JSON.stringify(next),
        created_by: actor,
      })
      .execute();
    await t
      .updateTable("agents")
      .set({ current_version: toVersion, updated_at: sql`now()` })
      .where("id", "=", agentId)
      .execute();
    await audit(t, {
      actorAccountId: actor,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "agent.pending_connector_bound",
      target: agentId,
      detail: { key, connectorId: c.id, fromVersion: before.current_version, toVersion },
    });
    await this.requests.settleIn({
      orgId,
      agentId,
      keys: left.map((x) => x.key),
      close: "approved",
      actor,
      actorTokenId,
    });
    return { agent: await this.lookup.view(agentId), dropped };
  }

  /**
   * (Re-)opens the agent's connector setup request (ruling P4-T6-7; the owner or an org admin+):
   * the pending one when it has one (`created` false), else a new one for the current pending
   * keys, requested by the agent's owner (P4-T6-4). No pending connectors -> 409
   * `agent.no_pending_connectors`.
   */
  @Transactional()
  async reopen(
    orgId: string,
    agentId: string,
    actor: string,
    actorTokenId?: string,
  ): Promise<{ id: string; created: boolean }> {
    const before = await this.agents.lockForWrite(orgId, agentId, actor);
    const def = await this.currentDefinition(agentId, before.current_version);
    const keys = (def.pendingConnectors ?? []).map((c) => c.key);
    if (keys.length === 0) {
      throw new ApiError(
        "agent.no_pending_connectors",
        "The agent has no connectors waiting to be configured",
      );
    }
    const owner = await this.kdb.db
      .selectFrom("agents")
      .select("owner_account_id")
      .where("id", "=", agentId)
      .executeTakeFirstOrThrow();
    const r = await this.requests.open({
      orgId,
      agentId,
      requestedBy: owner.owner_account_id,
      actor,
      actorTokenId,
    });
    // the agent row is locked above, so the keys read there are still pending
    if (r === null) throw new Error(`agent ${agentId} lost its pending connectors under its lock`);
    return r;
  }

  /**
   * The id of the agent's latest connector setup request (any status), or null. Authorized as the
   * writes are (fix round 1): the agent's owner or an org admin+, whether or not the agent is
   * visible to them; a member who sees the agent otherwise -> 403 `forbidden`; anyone else, or a
   * deleted agent -> 404 `agent.not_found`.
   */
  async latestRequest(orgId: string, agentId: string, viewer: string): Promise<string | null> {
    const t = this.kdb.db;
    const [agent, member] = await Promise.all([
      t
        .selectFrom("agents")
        .select("owner_account_id")
        .where("id", "=", agentId)
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst(),
      t
        .selectFrom("memberships")
        .select("role")
        .where("org_id", "=", orgId)
        .where("account_id", "=", viewer)
        .executeTakeFirst(),
    ]);
    if (!agent || !member) throw new ApiError("agent.not_found", "Agent not found");
    if (agent.owner_account_id !== viewer && !roleAtLeast(member.role, "admin")) {
      if (await isAgentVisibleTo(t, agentId, viewer)) {
        throw new ApiError(
          "forbidden",
          "Only the agent owner or an organization admin can see its connector setup request",
        );
      }
      throw new ApiError("agent.not_found", "Agent not found");
    }
    const row = await this.kdb.db
      .selectFrom("catalog_requests")
      .select("id")
      .where("org_id", "=", orgId)
      .where("agent_id", "=", agentId)
      .where("kind", "=", "connector_setup")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    return row?.id ?? null;
  }
}
