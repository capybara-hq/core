import { z } from "zod";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { IanaTimeZone } from "../time-zone.js";

/** `PUT /me/preferences`: the person's preferences (run context spec §3.4). */
export const PreferencesSchema = z
  .object({
    /** The person's time zone (IANA); null = follow the browser (run context spec §3.4). */
    timeZone: IanaTimeZone.nullable(),
  })
  .strict();
export class PreferencesBody extends createZodDto(PreferencesSchema, "PreferencesBody") {}

/** The `/me` routes the Platform operations mirror (`check:platform-ops` keys). */
export const ME_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/me/preferences" },
  { route: "PUT /api/v1/me/preferences", body: PreferencesSchema },
];
