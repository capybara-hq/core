import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { AGENT_VISIBILITIES } from "./agents.service.js";
import {
  AgentDefinitionSchema,
  AgentToolRef,
  DEFAULT_AGENT_TOOLS,
  ModelRef,
} from "./definition.js";
import { PRESET_IDS, ProfileInputSchema } from "./profile.js";

export const AgentMemberIds = z.array(z.string().min(1).max(100)).max(1000);

/**
 * A create without `tools` gets the default tools (ruling P7); an update injects no default, so a
 * version always stores explicit tools. `instructions` has no default in a request: with
 * `instructionFiles` the kernel derives it, and a new agent given neither gets the `AGENTS.md`
 * starter (`deriveInstructions`).
 */
const RequestInstructions = z.string().max(100_000).optional();
/** Pending connectors come only from a template (ruling P4-6): a create request's are dropped. */
export const AgentCreateDefinition = AgentDefinitionSchema.omit({ pendingConnectors: true }).extend(
  {
    instructions: RequestInstructions,
    tools: z.array(AgentToolRef).default(() => structuredClone(DEFAULT_AGENT_TOOLS)),
  },
);
const UpdateDefinition = AgentDefinitionSchema.extend({ instructions: RequestInstructions });

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
];
