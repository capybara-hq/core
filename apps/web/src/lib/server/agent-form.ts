import "server-only";
import type { AgentFormData } from "../../components/AgentForm";
import { type Agent, listAgents, listAgentTemplates, listModels } from "../agents";
import { getConnector, listConnectors } from "../connectors";
import { listMembers } from "../members";
import { listAgentSkills, listSkills } from "../skills";
import { optional, read, section } from "./page";

/**
 * What the agent form needs for its first paint (new agent, or `existing` to edit), read in
 * parallel (web-SSR spec §6, ruling R5): the models are required; the connectors, the org skills
 * and the members depend on the role (`optional`); the agent templates, the org agents, the
 * selected connectors' tools and the agent's own skills are sections (`section`). A `null` piece is
 * that part's own empty or unavailable state, never a read after mount.
 */
export async function loadAgentForm(orgId: string, existing?: Agent): Promise<AgentFormData> {
  const selected = (existing?.definition.tools ?? []).flatMap((r) =>
    r.kind === "connector" && r.tools === "all" ? [r.connectorId] : [],
  );
  const [models, connectors, skills, ownSkills, templates, agents, members, details] =
    await Promise.all([
      read(listModels(orgId)),
      optional(listConnectors(orgId)),
      optional(listSkills(orgId)),
      existing === undefined
        ? Promise.resolve({ skills: [] })
        : section(listAgentSkills(orgId, existing.id)),
      section(listAgentTemplates(orgId)),
      section(listAgents(orgId)),
      optional(listMembers(orgId)),
      Promise.all(selected.map((id) => section(getConnector(orgId, id)))),
    ]);
  return {
    providers: models.providers,
    connectors: connectors?.connectors ?? null,
    connectorDetails: Object.fromEntries(
      details.flatMap((d) => (d === null ? [] : [[d.connector.id, d.connector]])),
    ),
    orgSkills: skills?.skills ?? null,
    ownSkills: ownSkills?.skills ?? null,
    subagents: {
      templates: templates?.templates ?? null,
      agents: agents?.agents ?? null,
      members: members?.members ?? null,
    },
  };
}
