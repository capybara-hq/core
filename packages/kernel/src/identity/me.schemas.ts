import { z } from "zod";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { IanaTimeZone } from "../time-zone.js";

/**
 * `PUT /me/preferences`: a partial update of the person's preferences; a field left out keeps its
 * stored value (themes spec §9).
 */
export const PreferencesSchema = z
  .object({
    /** The person's time zone (IANA); null = follow the browser (run context spec §3.4). */
    timeZone: IanaTimeZone.nullable().optional(),
    /**
     * The person's theme (a `platform_themes` id on in at least one of their orgs, else 400
     * `theme.not_available`); null = follow the org (themes spec §7).
     */
    theme: z.string().min(1).max(200).nullable().optional(),
  })
  .strict();

/** The person's preferences as `GET` / `PUT /me/preferences` return them. */
export interface Preferences {
  timeZone: string | null;
  theme: string | null;
}
export class PreferencesBody extends createZodDto(PreferencesSchema, "PreferencesBody") {}

/**
 * `POST /me/avatar/uploads`: the image to upload. The type (png / jpeg / webp) and the 2 MB limit
 * are checked by the service, so they answer `attachment.type_not_allowed` / `attachment.too_large`
 * like the agent avatar's codes.
 */
export const AvatarUploadSchema = z
  .object({
    contentType: z.string().min(1).max(200),
    size: z.number().int().min(1),
  })
  .strict();
export class AvatarUploadBody extends createZodDto(AvatarUploadSchema, "AccountAvatarUploadBody") {}

/**
 * `PATCH /me/profile`: a field left out keeps its value. `displayName` is trimmed; the 1000 bound
 * is a body sanity bound, a changed name must have at most 64 code points (the service checks,
 * `account.display_name_too_long`). `avatar: null` removes the own avatar.
 */
export const ProfilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(1000).optional(),
    avatar: z
      .object({ kind: z.literal("upload"), uploadId: z.string().min(1).max(100) })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export class ProfilePatchBody extends createZodDto(ProfilePatchSchema, "ProfilePatchBody") {}

/** The `/me` routes the Platform operations mirror (`check:platform-ops` keys). */
export const ME_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/me/preferences" },
  { route: "PUT /api/v1/me/preferences", body: PreferencesSchema },
];
