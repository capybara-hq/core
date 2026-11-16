import { isDeviceProjectName } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
export const PermissionProfileSchema = z.enum([
  "request-approval",
  "approve-for-me",
  "full-access",
]);
export const PermissionSelectionSchema = z
  .object({
    profile: PermissionProfileSchema,
    consentScopeRevision: z.string().min(1).max(128).optional(),
  })
  .strict();
export const PermissionPatchBody = PermissionSelectionSchema.extend({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export const PermissionGetParams = z.object({ id: z.string().min(1).max(100) });
export const PermissionPreviewQuery = z
  .object({
    deviceId: z.string().min(1).max(100),
    project: z.string().refine(isDeviceProjectName).optional(),
  })
  .strict();
export type PermissionSelection = z.infer<typeof PermissionSelectionSchema>;
