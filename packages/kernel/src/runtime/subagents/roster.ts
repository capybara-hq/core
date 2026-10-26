import { SUBAGENT_ROSTER_MAX } from "../../agents/agents.service.js";
import type { AgentDefinition } from "../../agents/definition.js";
import type { KernelDb } from "../../db/kernel-schema.js";

/**
 * The sub-agent roster of an agent version (phase C, spec §4.3, §5.1): the agent types its `agent`
 * tool offers, in the order the description lists them.
 */
export interface RosterEntry {
  /** `general-purpose` | inline name | `<plugin>:<name>` | an org agent's roster name (`as`). */
  type: string;
  source: "general" | "inline" | "plugin" | "agent";
  /** When to use it (shown in the tool description), cut to {@link ROSTER_DESCRIPTION_MAX}. */
  description: string;
  /** Plugin templates: the `agent_templates` id. */
  templateId?: string;
  /** Org agents: the allowlisted agent id. */
  agentId?: string;
  /** Org agents: the agent's current name, when it is still a live agent of the org. */
  agentName?: string;
  /** Plugin templates: the plugin name. */
  plugin?: string;
}

export const ROSTER_DESCRIPTION_MAX = 1024;

/** The description of `general-purpose` in the roster (spec §4.3, model-visible). */
export const GENERAL_PURPOSE_DESCRIPTION =
  "a copy of you with your tools and skills, for multi-step work.";

const cut = (s: string) => s.slice(0, ROSTER_DESCRIPTION_MAX);

/** Plugin template type: `<plugin>:<name>`, or the bare name for a template without a plugin. */
export const templateType = (plugin: string | null, name: string) =>
  plugin === null ? name : `${plugin}:${name}`;

/**
 * Resolves the roster of `parent` (spec §4.3): `general-purpose` first unless
 * `subagents.general === false`, then the plugin templates, inline templates and allowlisted org
 * agents, each in the owner's order, at most {@link SUBAGENT_ROSTER_MAX} entries. Templates deleted
 * since the save are skipped; allowlisted org agents stay listed (the dispatch checks their gates
 * and refuses with the §4.5 text), with `agentName` only while the agent is live.
 */
export async function resolveRoster(
  db: KernelDb,
  orgId: string,
  parent: AgentDefinition,
): Promise<RosterEntry[]> {
  const sub = parent.subagents;
  const out: RosterEntry[] = [];
  if (sub?.general !== false) {
    out.push({
      type: "general-purpose",
      source: "general",
      description: GENERAL_PURPOSE_DESCRIPTION,
    });
  }
  const templateIds = sub?.templates ?? [];
  if (templateIds.length > 0) {
    const rows = await db
      .selectFrom("agent_templates as t")
      .innerJoin("agent_template_versions as v", (j) =>
        j.onRef("v.template_id", "=", "t.id").onRef("v.version", "=", "t.current_version"),
      )
      .select(["t.id", "t.name", "t.plugin_name", "v.definition"])
      .where("t.org_id", "=", orgId)
      .where("t.deleted_at", "is", null)
      .where("t.id", "in", templateIds)
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of templateIds) {
      const r = byId.get(id);
      if (!r) continue;
      const description = (r.definition as { description?: unknown }).description;
      out.push({
        type: templateType(r.plugin_name, r.name),
        source: "plugin",
        description: cut(typeof description === "string" ? description : ""),
        templateId: r.id,
        ...(r.plugin_name !== null && { plugin: r.plugin_name }),
      });
    }
  }
  for (const t of sub?.inline ?? []) {
    out.push({ type: t.name, source: "inline", description: cut(t.description) });
  }
  const agents = sub?.agents ?? [];
  if (agents.length > 0) {
    const rows = await db
      .selectFrom("agents")
      .innerJoin("agent_versions", (j) =>
        j
          .onRef("agent_versions.agent_id", "=", "agents.id")
          .onRef("agent_versions.version", "=", "agents.current_version"),
      )
      .select(["agents.id", "agent_versions.definition"])
      .where("agents.org_id", "=", orgId)
      .where("agents.deleted_at", "is", null)
      .where(
        "agents.id",
        "in",
        agents.map((a) => a.agentId),
      )
      .execute();
    const names = new Map(rows.map((r) => [r.id, (r.definition as AgentDefinition).name]));
    for (const a of agents) {
      const agentName = names.get(a.agentId);
      out.push({
        type: a.as,
        source: "agent",
        description: cut(a.description),
        agentId: a.agentId,
        ...(agentName !== undefined && { agentName }),
      });
    }
  }
  return out.slice(0, SUBAGENT_ROSTER_MAX);
}

/**
 * The roster entry for a requested `subagent_type`: an exact type first; else a bare `<name>`
 * matches the plugin template `<plugin>:<name>` when exactly one has it (as Claude Code accepts
 * `reviewer` for `my-plugin:reviewer`). Null when nothing matches.
 */
export function findType(roster: RosterEntry[], requested: string): RosterEntry | null {
  const exact = roster.find((e) => e.type === requested);
  if (exact) return exact;
  if (requested.includes(":")) return null;
  const bare = roster.filter((e) => e.source === "plugin" && e.type.endsWith(`:${requested}`));
  return bare.length === 1 ? (bare[0] as RosterEntry) : null;
}
