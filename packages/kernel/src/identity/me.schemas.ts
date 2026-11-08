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

/** The `/me` routes the Platform operations mirror (`check:platform-ops` keys). */
export const ME_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/me/preferences" },
  { route: "PUT /api/v1/me/preferences", body: PreferencesSchema },
];
