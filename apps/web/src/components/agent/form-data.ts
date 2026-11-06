"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { ProviderModels } from "../../lib/agents";
import type { ApiClientError } from "../../lib/api";
import type { OrgComponent } from "../../lib/components";
import type { ConnectorSummary } from "../../lib/connectors";
import { agentSkillsQuery, agentsQuery, agentTemplatesQuery } from "../../lib/query/agents";
import { retryOnMountOf } from "../../lib/query/client";
import { orgComponentsQuery } from "../../lib/query/components";
import { connectorsQuery, modelsQuery } from "../../lib/query/conversation";
import { membersQuery } from "../../lib/query/members";
import { skillsQuery } from "../../lib/query/skills";
import type { SkillSummary } from "../../lib/skills";
import type { SubagentsFormData } from "../AgentSubagents";

/**
 * What the agent form shows, from its queries (`agentFormQueries` in `lib/query/agents.ts`). A
 * `null` list could not be read (the kernel refused or failed it): that part shows its own empty or
 * unavailable state.
 */
export interface AgentFormData {
  providers: ProviderModels[];
  connectors: ConnectorSummary[] | null;
  orgSkills: SkillSummary[] | null;
  /** The agent's own skills (`[]` for a new agent). */
  ownSkills: SkillSummary[] | null;
  /**
   * The platform components offered to the org (on or off), so an id of one that is off reads as
   * unavailable, not deleted (spec §5 rule 8); null when it could not be read.
   */
  offered: OrgComponent[] | null;
  subagents: SubagentsFormData;
}

/** The agent form's data as a page draws it. */
export type AgentFormState =
  | { kind: "loading" }
  | { kind: "ready"; data: AgentFormData }
  | { kind: "error"; code: string; retry(): void };

/** A read the form needs (the models): any failure fails the page. */
const REQUIRED = "required";
/** A read the role decides (connectors, org skills, members): a 403 / 404 leaves the part out. */
const OPTIONAL = "optional";
/** A section (templates, org agents, own skills): any failure is that part's own state. */
const SECTION = "section";

/**
 * The agent form's reads from the query cache (new agent, or `agentId` to edit), as one state:
 * `loading` until every read answered, `error` when a required read failed (or an optional one
 * failed otherwise than 403 / 404), else the data with `null` for the parts that could not be read.
 * An error the server already read is not read again on mount; `retry` reads the failed ones.
 */
export function useAgentFormData(orgId: string, agentId?: string): AgentFormState {
  const modelsQ = modelsQuery(orgId);
  const connectorsQ = connectorsQuery(orgId);
  const skillsQ = skillsQuery(orgId);
  const templatesQ = agentTemplatesQuery(orgId);
  const agentsQ = agentsQuery(orgId);
  const membersQ = membersQuery(orgId);
  const offeredQ = orgComponentsQuery(orgId, {});
  // A query of no agent is disabled; the key's agent id is then never read.
  const ownQ = agentSkillsQuery(orgId, agentId ?? "");
  const models = useQuery({ ...modelsQ, retryOnMount: retryOnMountOf(modelsQ.queryKey) });
  const connectors = useQuery({
    ...connectorsQ,
    retryOnMount: retryOnMountOf(connectorsQ.queryKey),
  });
  const skills = useQuery({ ...skillsQ, retryOnMount: retryOnMountOf(skillsQ.queryKey) });
  const templates = useQuery({ ...templatesQ, retryOnMount: retryOnMountOf(templatesQ.queryKey) });
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) });
  const members = useQuery({ ...membersQ, retryOnMount: retryOnMountOf(membersQ.queryKey) });
  const offered = useQuery({ ...offeredQ, retryOnMount: retryOnMountOf(offeredQ.queryKey) });
  const own = useQuery({
    ...ownQ,
    retryOnMount: retryOnMountOf(ownQ.queryKey),
    enabled: agentId !== undefined,
  });
  const all: [UseQueryResult<unknown, ApiClientError>, string][] = [
    [models, REQUIRED],
    [connectors, OPTIONAL],
    [skills, OPTIONAL],
    [members, OPTIONAL],
    [templates, SECTION],
    [agents, SECTION],
    [offered, SECTION],
    ...(agentId === undefined ? [] : ([[own, SECTION]] as [typeof own, string][])),
  ];
  if (all.some(([q]) => q.data === undefined && q.error === null)) return { kind: "loading" };
  const fatal = all.find(
    ([q, kind]) =>
      q.data === undefined &&
      q.error !== null &&
      (kind === REQUIRED ||
        (kind === OPTIONAL && q.error.status !== 403 && q.error.status !== 404)),
  );
  if (fatal?.[0].error) {
    return {
      kind: "error",
      code: fatal[0].error.code,
      retry: () => {
        for (const [q] of all) if (q.error !== null) void q.refetch();
      },
    };
  }
  return {
    kind: "ready",
    data: {
      providers: models.data?.providers ?? [],
      connectors: connectors.data?.connectors ?? null,
      orgSkills: skills.data?.skills ?? null,
      ownSkills: agentId === undefined ? [] : (own.data?.skills ?? null),
      offered: offered.data?.components ?? null,
      subagents: {
        offered: offered.data?.components ?? null,
        templates: templates.data?.templates ?? null,
        agents: agents.data?.agents ?? null,
        members: members.data?.members ?? null,
      },
    },
  };
}
