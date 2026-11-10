import { hasControlChars, MEDIA_NAME_MAX_CHARS } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { SKILL_PACKAGE_UPLOAD_MAX_BYTES } from "../conversations/attachments.service.js";
import type { RouteSchemas } from "../platform/route-schemas.js";
/** `POST /skills`: an uploaded skill package (`POST /skills/uploads` gives the id); no text form. */
export const SkillCreateBody = z
  .object({ uploadId: z.string().min(1).max(100), shareable: z.boolean().optional() })
  .strict();
/** `:id` where the route validates it (`@ZParam`). */
export const SkillIdParams = z.object({ id: z.string().min(1).max(100) });
/** `:id` where the route takes it as is (`@Param`). */
export const SkillPathParams = z.object({ id: z.string().min(1) });

export const SkillShareableSchema = z.object({ shareable: z.boolean() }).strict();

/** `:id` of `GET /skill-changes/:id` (taken as is). */
export const SkillChangePathParams = z.object({ id: z.string().min(1).max(100) });
/** `:agentId` of the agent's skills and invocable skills routes (taken as is). */
export const AgentSkillsListParams = z.object({ agentId: z.string().min(1).max(100) });
export const AgentSkillPathParams = AgentSkillsListParams.extend({
  skillId: z.string().min(1).max(100),
});
/** `POST /agents/:agentId/skills/uploads`: a skill package upload onto the agent. */
export const AgentSkillUploadBody = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MEDIA_NAME_MAX_CHARS)
      .refine((s) => !hasControlChars(s), "name must not contain control characters"),
    size: z.number().int().min(1).max(SKILL_PACKAGE_UPLOAD_MAX_BYTES),
  })
  .strict();
/** `POST /agents/:agentId/skills`: an uploaded package registered as one of the agent's skills. */
export const AgentSkillRegisterBody = z.object({ uploadId: z.string().min(1).max(100) }).strict();
/** `?conversationId=` of `GET /agents/:agentId/invocable-skills`. */
export const InvocableSkillsQuerySchema = z
  .object({ conversationId: z.string().min(1).max(100).optional() })
  .strict();

export const SKILL_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/skill-changes/:id", params: SkillChangePathParams },
  { route: "GET /api/v1/orgs/:orgId/agents/:agentId/skills", params: AgentSkillsListParams },
  {
    route: "POST /api/v1/orgs/:orgId/agents/:agentId/skills",
    params: AgentSkillsListParams,
    body: AgentSkillRegisterBody,
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/agents/:agentId/skills/:skillId",
    params: AgentSkillPathParams,
  },
  {
    route: "GET /api/v1/orgs/:orgId/agents/:agentId/invocable-skills",
    params: AgentSkillsListParams,
    query: InvocableSkillsQuerySchema,
  },
  { route: "GET /api/v1/orgs/:orgId/skills" },
  { route: "GET /api/v1/orgs/:orgId/skills/:id", params: SkillPathParams },
  { route: "POST /api/v1/orgs/:orgId/skills", body: SkillCreateBody },
  {
    route: "PUT /api/v1/orgs/:orgId/skills/:id/shareable",
    params: SkillIdParams,
    body: SkillShareableSchema,
  },
  { route: "GET /api/v1/orgs/:orgId/skills/:id/delete-preview", params: SkillIdParams },
  { route: "DELETE /api/v1/orgs/:orgId/skills/:id", params: SkillPathParams },
];
