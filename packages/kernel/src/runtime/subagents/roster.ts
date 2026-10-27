import { SUBAGENT_ROSTER_MAX } from "../../agents/agents.service.js";
import type { AgentDefinition } from "../../agents/definition.js";
import { loadTemplates } from "../../agents/templates.js";
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

/** Plugin template type: `<plugin>:<name>`. */
export const templateType = (plugin: string, name: string) => `${plugin}:${name}`;

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
  parent: Pick<AgentDefinition, "subagents">,
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
  const templates = await loadTemplates(db, orgId, templateIds);
  for (const id of templateIds) {
    const r = templates.get(id);
    if (!r) continue;
    const description = r.template.description;
    out.push({
      type: templateType(r.plugin, r.name),
      source: "plugin",
      description: cut(typeof description === "string" ? description : ""),
      templateId: r.id,
      plugin: r.plugin,
    });
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

/** Claude Code's built-in agent types a forked skill may name; they run as `general-purpose`. */
const GENERAL_ALIASES: ReadonlySet<string> = new Set(["general-purpose", "Explore", "Plan"]);

/**
 * The sub-agent type a forked skill (`context: fork`, phase D spec §6.2) runs as for `parent`:
 * `general-purpose` for no `agent` and Claude's built-in types; else a roster type (a bare name
 * prefers the skill's own plugin's template `<plugin>:<name>`, then {@link findType}). An `agent`
 * that does not resolve falls back to `general-purpose` and is returned as `unknown`. `inRoster`:
 * the type is one the parent's `agent` tool offers (`general-purpose` is not when
 * `subagents.general === false`, which does not block a person's fork invocation).
 */
export async function resolveSkillForkType(
  db: KernelDb,
  orgId: string,
  parent: Pick<AgentDefinition, "subagents">,
  agent: string | undefined,
  plugin: string | undefined,
): Promise<{ agentType: string; unknown?: string; inRoster: boolean }> {
  const roster = await resolveRoster(db, orgId, parent);
  const general = () => ({
    agentType: "general-purpose",
    inRoster: roster.some((e) => e.type === "general-purpose"),
  });
  if (agent === undefined || GENERAL_ALIASES.has(agent)) return general();
  if (plugin !== undefined && !agent.includes(":")) {
    const own = roster.find((e) => e.type === templateType(plugin, agent));
    if (own) return { agentType: own.type, inRoster: true };
  }
  const e = findType(roster, agent);
  return e ? { agentType: e.type, inRoster: true } : { ...general(), unknown: agent };
}
