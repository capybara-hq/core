import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { AGENT_VISIBILITIES } from "./agents.service.js";
import { AgentDefinitionSchema, ModelRef } from "./definition.js";
import { PRESET_IDS, ProfileInputSchema } from "./profile.js";

export const AgentMemberIds = z.array(z.string().min(1).max(100)).max(1000);

/**
 * `instructions` has no default in a request: with `instructionFiles` the kernel derives it, and a
 * new agent given neither gets the `AGENTS.md` starter (`deriveInstructions`).
 */
const RequestInstructions = z.string().max(100_000).optional();
/**
 * Fields a request may not carry (tools default-on spec §2): the old enabled list, and a
 * sub-agent's key filter (written only at dispatch).
 */
const RequestOnly = {
  tools: z
    .undefined({
      error: "tools was replaced by disabledTools: an agent has every tool unless it turns it off",
    })
    .optional(),
  subagentTools: z
    .undefined({ error: "subagentTools is set only on a sub-agent's definition at dispatch" })
    .optional(),
};
/** Pending connectors come only from a template (ruling P4-6): a create request's are dropped. */
export const AgentCreateDefinition = AgentDefinitionSchema.omit({ pendingConnectors: true }).extend(
  { instructions: RequestInstructions, ...RequestOnly },
);
const UpdateDefinition = AgentDefinitionSchema.extend({
  instructions: RequestInstructions,
  ...RequestOnly,
});

export const AgentCreateBody = z
  .object({
    definition: AgentCreateDefinition,
    visibility: z.enum(AGENT_VISIBILITIES),
    memberIds: AgentMemberIds.optional(),
    /** Without an avatar the agent gets a random preset. */
    profile: ProfileInputSchema.optional(),
  })
  .strict();
export const AgentUpdateBody = z
  .object({
    definition: UpdateDefinition.optional(),
    visibility: z.enum(AGENT_VISIBILITIES).optional(),
    memberIds: AgentMemberIds.optional(),
    /**
     * Optimistic concurrency: the `currentVersion` the editor read. Given and different from the
     * current version (someone saved since) -> 409 `agent.version_conflict`, nothing overwritten.
     * Absent: not checked (older clients).
     */
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

const TemplateId = z.string().min(1).max(100);
export const AgentFromTemplatePreviewBody = z.object({ templateId: TemplateId }).strict();
export const AgentFromTemplateBody = z
  .object({
    templateId: TemplateId,
    name: z.string().min(1).max(80),
    /** Default `private`; anything else needs `agents.manage` (ruling P4-3). */
    visibility: z.enum(AGENT_VISIBILITIES).optional(),
    /** The accounts of a `members` agent. */
    members: AgentMemberIds.optional(),
    /** The person's choice; absent = the template's model resolution (P4-4). */
    model: ModelRef.strict().optional(),
    /** A preset avatar; absent = a random one. */
    avatar: z
      .object({ kind: z.literal("preset"), id: z.enum(PRESET_IDS) })
      .strict()
      .optional(),
    /** The preview's `previewHash`; another one → 409 `agent.template_preview_stale`. */
    previewHash: z.string().regex(/^[0-9a-f]{64}\.[0-9a-f]{16}$/),
  })
  .strict();

/** `:agentId` as the routes take it (`@Param`). */
export const AgentPathParams = z.object({ agentId: z.string().min(1) });

/** `:agentId` and `:key` of a pending connector's bind route. */
export const PendingConnectorParams = z.object({
  agentId: z.string().min(1),
  key: z.string().min(1),
});
export const PendingConnectorBindBody = z
  .object({ connectorId: z.string().min(1).max(100) })
  .strict();

export const AGENT_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/agents" },
  { route: "GET /api/v1/orgs/:orgId/agents/:agentId", params: AgentPathParams },
  { route: "POST /api/v1/orgs/:orgId/agents", body: AgentCreateBody },
  {
    route: "PATCH /api/v1/orgs/:orgId/agents/:agentId",
    params: AgentPathParams,
    body: AgentUpdateBody,
  },
  {
    route: "POST /api/v1/orgs/:orgId/agents/from-template/preview",
    body: AgentFromTemplatePreviewBody,
  },
  { route: "POST /api/v1/orgs/:orgId/agents/from-template", body: AgentFromTemplateBody },
  { route: "DELETE /api/v1/orgs/:orgId/agents/:agentId", params: AgentPathParams },
  { route: "GET /api/v1/orgs/:orgId/agents/:agentId/versions", params: AgentPathParams },
  {
    route: "POST /api/v1/orgs/:orgId/agents/:agentId/pending-connectors/:key/bind",
    params: PendingConnectorParams,
    body: PendingConnectorBindBody,
  },
  {
    route: "POST /api/v1/orgs/:orgId/agents/:agentId/pending-connectors/request",
    params: AgentPathParams,
  },
  {
    route: "GET /api/v1/orgs/:orgId/agents/:agentId/pending-connectors/request",
    params: AgentPathParams,
  },
  { route: "GET /api/v1/orgs/:orgId/readiness" },
];
