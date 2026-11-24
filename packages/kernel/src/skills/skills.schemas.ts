import { hasControlChars, MEDIA_NAME_MAX_CHARS, SKILL_LIMITS } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { SKILL_PACKAGE_UPLOAD_MAX_BYTES } from "../conversations/attachments.service.js";
import { DOWNLOAD_AS } from "../conversations/conversations.schemas.js";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** `POST /skills/uploads`: registers a skill package upload (a presigned form). */
export const SkillUploadBody = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MEDIA_NAME_MAX_CHARS)
      .refine((s) => !hasControlChars(s), "name must not contain control characters"),
    size: z.number().int().min(1).max(SKILL_PACKAGE_UPLOAD_MAX_BYTES),
  })
  .strict();
/** `POST /skills`: an uploaded skill package (`POST /skills/uploads` gives the id); no text form. */
export const SkillCreateBody = z
  .object({ uploadId: z.string().min(1).max(100), shareable: z.boolean().optional() })
  .strict();
/** `:id` where the route validates it (`@ZParam`). */
export const SkillIdParams = z.object({ id: z.string().min(1).max(100) });
/** `:id` where the route takes it as is (`@Param`). */
export const SkillPathParams = z.object({ id: z.string().min(1) });

/**
 * A path of a skill version's manifest as a request names it: at most
 * {@link SKILL_LIMITS.pathMaxChars} code points, the manifest's own unit (`chars` in the SDK). The
 * code point check is explicit rather than left to how a zod version measures strings; `max` in
 * UTF-16 code units only bounds the work before it.
 */
export const SkillFilePathSchema = z
  .string()
  .min(1)
  .max(2 * SKILL_LIMITS.pathMaxChars)
  .refine((s) => [...s].length <= SKILL_LIMITS.pathMaxChars, {
    message: `path must be at most ${SKILL_LIMITS.pathMaxChars} characters`,
  });

/** `?version=` of `GET /skills/:id/files`: a version of the skill (default: the current one). */
export const SkillFilesQuery = z
  .object({ version: z.coerce.number().int().min(1).max(2_147_483_647).optional() })
  .strict();
/**
 * `GET /skills/:id/files/content`: `path` a path of that version's manifest, `limit` at most that
 * many bytes, `inline=1` inline for a raster image (never for HTML or SVG), `as=url` a presigned
 * download URL instead of the bytes (not with `limit`).
 */
export const SkillFileContentQuery = SkillFilesQuery.extend({
  path: SkillFilePathSchema,
  limit: z.coerce.number().int().min(1).max(SKILL_LIMITS.fileBytes).optional(),
  inline: z.enum(["0", "1"]).optional(),
  as: DOWNLOAD_AS.optional(),
})
  .strict()
  .refine((q) => q.as === undefined || q.limit === undefined, {
    message: "as=url cannot be combined with limit",
    path: ["limit"],
  });

/** `?version=&path=` of `GET /skills/:id/files/previewers`: one file of a version. */
export const SkillFilePreviewersQuery = SkillFilesQuery.extend({
  path: SkillFilePathSchema,
}).strict();
/** `GET /skills/:id/files/previews/:plugin/:previewerId?version=&path=&locale=`. */
export const SkillFilePreviewQuery = SkillFilePreviewersQuery.extend({
  locale: z.enum(["zh", "en"]).default("en"),
}).strict();
export const SkillFilePreviewParams = SkillIdParams.extend({
  plugin: z.string().min(1).max(100),
  previewerId: z.string().min(1).max(100),
});

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
    route: "POST /api/v1/orgs/:orgId/agents/:agentId/skills/uploads",
    params: AgentSkillsListParams,
    body: AgentSkillUploadBody,
  },
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
    route: "POST /api/v1/orgs/:orgId/agents/:agentId/skills/:skillId/share",
    params: AgentSkillPathParams,
  },
  {
    route: "GET /api/v1/orgs/:orgId/agents/:agentId/invocable-skills",
    params: AgentSkillsListParams,
    query: InvocableSkillsQuerySchema,
  },
  { route: "GET /api/v1/orgs/:orgId/skills" },
  { route: "GET /api/v1/orgs/:orgId/skills/:id", params: SkillPathParams },
  {
    route: "GET /api/v1/orgs/:orgId/skills/:id/files",
    params: SkillIdParams,
    query: SkillFilesQuery,
  },
  {
    route: "GET /api/v1/orgs/:orgId/skills/:id/files/content",
    params: SkillIdParams,
    query: SkillFileContentQuery,
  },
  {
    route: "GET /api/v1/orgs/:orgId/skills/:id/files/previewers",
    params: SkillIdParams,
    query: SkillFilePreviewersQuery,
  },
  {
    route: "GET /api/v1/orgs/:orgId/skills/:id/files/previews/:plugin/:previewerId",
    params: SkillFilePreviewParams,
    query: SkillFilePreviewQuery,
  },
  { route: "POST /api/v1/orgs/:orgId/skills/uploads", body: SkillUploadBody },
  { route: "POST /api/v1/orgs/:orgId/skills", body: SkillCreateBody },
  {
    route: "PUT /api/v1/orgs/:orgId/skills/:id/shareable",
    params: SkillIdParams,
    body: SkillShareableSchema,
  },
  { route: "GET /api/v1/orgs/:orgId/skills/:id/delete-preview", params: SkillIdParams },
  { route: "DELETE /api/v1/orgs/:orgId/skills/:id", params: SkillPathParams },
];
