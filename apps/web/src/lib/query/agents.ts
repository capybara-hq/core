import type { UseQueryOptions } from "@tanstack/react-query";
import {
  type Agent,
  getAgent,
  getAgentTemplate,
  listAgents,
  listAgentTemplates,
  previewAgentTemplateDelete,
} from "../agents";
import type { ApiClientError } from "../api";
import { listAvailableExtensionPoints, listExtensionTools } from "../extensions";
import { listAgentSkills } from "../skills";
import { orgComponentsQuery } from "./components";
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

/** One agent template usable in the org (a 404 when it is not). */
export const agentTemplateQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).agentTemplate(id),
    fn: () => getAgentTemplate(orgId, id).then((r) => r.template),
    freshness: "orgConfig",
  });

/** What deleting the org's own agent template does (read when its confirmation opens). */
export const agentTemplateDeletePreviewQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).agentTemplateDeletePreview(id),
    fn: () => previewAgentTemplateDelete(orgId, id),
    freshness: "live",
  });

/** The skills the agent wrote itself (`{ skills }`). */
export const agentSkillsQuery = (orgId: string, agentId: string) =>
  defineQuery({
    key: keys.org(orgId).agentSkills(agentId),
    fn: () => listAgentSkills(orgId, agentId),
    freshness: "orgConfig",
  });

/**
 * Whether each `org-default` extension point has a provider for the org now (`{ points }`): the
 * Tools section offers a web tool only while its point is available.
 */
export const availableExtensionPointsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).extensionPointsAvailable(),
    fn: () => listAvailableExtensionPoints(orgId),
    freshness: "orgConfig",
  });

/**
 * The tools of the extensions enabled in the org (`{ extensions }`): the Tools section offers them
 * as `{kind:"plugin"}` references.
 */
export const extensionToolsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).extensionTools(),
    fn: () => listExtensionTools(orgId),
    freshness: "orgConfig",
  });

const any = <T>(o: UseQueryOptions<T, ApiClientError>) =>
  o as unknown as UseQueryOptions<unknown, ApiClientError>;

/**
 * The agent form's reads (new agent, or `agentId` to edit): the models (required), the connectors,
 * the org skills and the members (the role decides whether the kernel answers), the agent
 * templates and the org agents (the sub-agents section), and, editing, the agent's own skills,
 * which web tools the org can serve and the enabled extensions' tools (the Tools section).
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
  // the platform components offered to the org: an off one's id reads as unavailable
  any(orgComponentsQuery(orgId, {})),
  ...(agentId === undefined
    ? []
    : [
        any(agentSkillsQuery(orgId, agentId)),
        any(availableExtensionPointsQuery(orgId)),
        any(extensionToolsQuery(orgId)),
      ]),
];

/** The ids of the connectors whose tools `agent` takes as a whole (the form lists their tools). */
export const selectedConnectors = (agent: Agent | undefined): string[] =>
  (agent?.definition.tools ?? []).flatMap((r) =>
    r.kind === "connector" && r.tools === "all" ? [r.connectorId] : [],
  );

/** The details (tools) of the connectors the edited agent uses. */
export const agentConnectorQueries = (orgId: string, agent: Agent) =>
  selectedConnectors(agent).map((id) => any(connectorQuery(orgId, id)));
