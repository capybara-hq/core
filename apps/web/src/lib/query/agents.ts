import type { UseQueryOptions } from "@tanstack/react-query";
import { type Agent, getAgent, listAgents, listAgentTemplates } from "../agents";
import type { ApiClientError } from "../api";
import { listAgentSkills } from "../skills";
import { connectorQuery, connectorsQuery, modelsQuery } from "./conversation";
import { defineQuery } from "./define";
import { keys } from "./keys";
import { membersQuery } from "./members";
import { skillsQuery } from "./skills";

/** The org's agents list. */
export const agentsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).agents(),
    fn: () => listAgents(orgId),
    freshness: "orgConfig",
  });

/** One agent (a 404 is the page's not-found). */
export const agentQuery = (orgId: string, agentId: string) =>
  defineQuery({
    key: keys.org(orgId).agent(agentId),
    fn: () => getAgent(orgId, agentId).then((r) => r.agent),
    freshness: "orgConfig",
  });

/** The agent templates the sub-agents section offers. */
export const agentTemplatesQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).agentTemplates(),
    fn: () => listAgentTemplates(orgId),
    freshness: "orgConfig",
  });

/** The skills the agent wrote itself (`{ skills }`). */
export const agentSkillsQuery = (orgId: string, agentId: string) =>
  defineQuery({
    key: keys.org(orgId).agentSkills(agentId),
    fn: () => listAgentSkills(orgId, agentId),
    freshness: "orgConfig",
  });

const any = <T>(o: UseQueryOptions<T, ApiClientError>) =>
  o as unknown as UseQueryOptions<unknown, ApiClientError>;

/**
 * The agent form's reads (new agent, or `agentId` to edit): the models (required), the connectors,
 * the org skills and the members (the role decides whether the kernel answers), the agent
 * templates and the org agents (the sub-agents section), and, editing, the agent's own skills.
 * The tools of the connectors an edited agent uses are {@link agentConnectorQueries}.
 */
export const agentFormQueries = (
  orgId: string,
  agentId?: string,
): UseQueryOptions<unknown, ApiClientError>[] => [
  any(modelsQuery(orgId)),
  any(connectorsQuery(orgId)),
  any(skillsQuery(orgId)),
  any(agentTemplatesQuery(orgId)),
  any(agentsQuery(orgId)),
  any(membersQuery(orgId)),
  ...(agentId === undefined ? [] : [any(agentSkillsQuery(orgId, agentId))]),
];

/** The ids of the connectors whose tools `agent` takes as a whole (the form lists their tools). */
export const selectedConnectors = (agent: Agent | undefined): string[] =>
  (agent?.definition.tools ?? []).flatMap((r) =>
    r.kind === "connector" && r.tools === "all" ? [r.connectorId] : [],
  );

/** The details (tools) of the connectors the edited agent uses. */
export const agentConnectorQueries = (orgId: string, agent: Agent) =>
  selectedConnectors(agent).map((id) => any(connectorQuery(orgId, id)));
