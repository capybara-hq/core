import { isSkillName, SKILL_LIMITS } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { SKILL_WRITE_MAX_BYTES } from "../tools/builtins/skill-write.js";

/**
 * The fields of `POST /skills` before the either-or refinement: zod 4 cannot `pick` / `omit` a
 * refined object, so operations build from these and the route validates {@link SkillCreateBody}.
 */
export const SkillCreateFields = z
  .object({
    uploadId: z.string().min(1).max(100).optional(),
    name: z
      .string()
      .refine(isSkillName, "name must be 1-64 lowercase letters, digits and single hyphens")
      .optional(),
    description: z.string().min(1).max(SKILL_LIMITS.descriptionMaxChars).optional(),
    body: z.string().max(SKILL_WRITE_MAX_BYTES).optional(),
    shareable: z.boolean().optional(),
  })
  .strict();
export const SkillCreateBody = SkillCreateFields.refine(
  (v) =>
    v.uploadId !== undefined
      ? v.name === undefined && v.description === undefined && v.body === undefined
      : v.name !== undefined && v.description !== undefined && v.body !== undefined,
  "send either { uploadId } or { name, description, body }",
);
/** `:id` where the route validates it (`@ZParam`). */
export const SkillIdParams = z.object({ id: z.string().min(1).max(100) });
/** `:id` where the route takes it as is (`@Param`). */
export const SkillPathParams = z.object({ id: z.string().min(1) });

export const SkillShareableSchema = z.object({ shareable: z.boolean() }).strict();

export const SKILL_ROUTES: readonly RouteSchemas[] = [
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
