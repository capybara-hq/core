import { isAgentVisibleTo } from "../../agents/agent-lookup.js";
import { type AgentDefinition, normalizeStoredDefinition } from "../../agents/definition.js";
import type { KernelSchemaDb } from "../../db/kernel-schema.js";
import { audit } from "../../identity/audit.js";

/**
 * The gates an org agent sub-agent passes (spec §5.5), checked at every dispatch and every
 * follow-up: `deleted` (the agent is gone, or not of this org), `allowlist` (the parent agent's
 * current version lists it in `subagents.agents`), `dispatchable` (its current version has
 * `subagents.dispatchable: true`) and `visibility` (the person who started the parent run can use
 * it, the normal agent visibility rule).
 */
export type OrgAgentGate = "allowlist" | "dispatchable" | "visibility" | "deleted";

export type OrgAgentCheck =
  | { ok: true; version: number; definition: AgentDefinition }
  | { ok: false; gate: OrgAgentGate };

/**
 * Checks the gates for dispatching `agentId` from a parent whose current definition is
 * `parentDefinition` (read live by the caller: R5, removing an allowlist entry stops new
 * dispatches at once). On success returns the agent's current version and definition, which the
 * caller freezes as is (never read again, so the frozen version is the one the gates saw).
 */
export async function checkOrgAgent(
  db: KernelSchemaDb,
  a: {
    orgId: string;
    parentDefinition: Pick<AgentDefinition, "subagents">;
    agentId: string;
    triggerAccountId: string;
  },
): Promise<OrgAgentCheck> {
  const row = await db
    .selectFrom("agents")
    .innerJoin("agent_versions", (j) =>
      j
        .onRef("agent_versions.agent_id", "=", "agents.id")
        .onRef("agent_versions.version", "=", "agents.current_version"),
    )
    .select(["agents.current_version", "agent_versions.definition"])
    .where("agents.id", "=", a.agentId)
    .where("agents.org_id", "=", a.orgId)
    .where("agents.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return { ok: false, gate: "deleted" };
  if (!(a.parentDefinition.subagents?.agents ?? []).some((x) => x.agentId === a.agentId)) {
    return { ok: false, gate: "allowlist" };
  }
  const definition = normalizeStoredDefinition(row.definition);
  if (definition.subagents?.dispatchable !== true) return { ok: false, gate: "dispatchable" };
  if (!(await isAgentVisibleTo(db, a.agentId, a.triggerAccountId))) {
    return { ok: false, gate: "visibility" };
  }
  return { ok: true, version: row.current_version, definition };
}

/**
 * The parent agent's current definition (the allowlist gate reads it, not the run's version), or
 * null when the agent no longer exists or is deleted.
 */
export async function currentAgentDefinition(
  db: KernelSchemaDb,
  agentId: string,
): Promise<AgentDefinition | null> {
  const row = await db
    .selectFrom("agents")
    .innerJoin("agent_versions", (j) =>
      j
        .onRef("agent_versions.agent_id", "=", "agents.id")
        .onRef("agent_versions.version", "=", "agents.current_version"),
    )
    .select("agent_versions.definition")
    .where("agents.id", "=", agentId)
    // a deleted parent agent's running run allowlists nothing (batch 9 review M2)
    .where("agents.deleted_at", "is", null)
    .executeTakeFirst();
  return row ? normalizeStoredDefinition(row.definition) : null;
}

/**
 * Audits a refused org agent dispatch (`subagent.refused`, spec §5.5): actor the person who
 * started the parent run, target the refused agent, so its owner can see attempts to use it.
 */
export async function auditRefusal(
  db: KernelSchemaDb,
  a: {
    orgId: string;
    triggerAccountId: string;
    agentId: string;
    gate: OrgAgentGate;
    parentConversationId: string;
    parentRunId: string;
    callId: string;
    agentType: string;
    resumed: boolean;
  },
): Promise<void> {
  await audit(db, {
    actorAccountId: a.triggerAccountId,
    orgId: a.orgId,
    action: "subagent.refused",
    target: a.agentId,
    detail: {
      gate: a.gate,
      parentConversationId: a.parentConversationId,
      parentRunId: a.parentRunId,
      callId: a.callId,
      agentType: a.agentType,
      resumed: a.resumed,
    },
  });
}
