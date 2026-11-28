import { PUSH_LIMITS } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** The push categories a person switches (mobile app spec §9.4); an absent preference is on. */
export const PUSH_CATEGORIES = ["waiting", "replies", "tasks", "automations", "inbox"] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

/**
 * `POST /me/push-registrations`: what the app's shell returns from `push@1.register()`, plus the
 * person's locale and a device name. The token is sealed at rest and never echoed.
 */
export const PushRegistrationSchema = z
  .object({
    platform: z.enum(["ios", "android"]),
    /** The bundle id / application id of the app build. */
    appId: z
      .string()
      .min(1)
      .max(PUSH_LIMITS.appIdChars)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    /** The push-provider extension (plugin name) the token belongs to. */
    provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    token: z.string().min(1).max(PUSH_LIMITS.tokenChars),
    locale: z.enum(["zh", "en"]),
    /** Shown in the person's notification settings; no control or format characters. */
    deviceName: z
      .string()
      .min(1)
      .max(PUSH_LIMITS.deviceNameChars)
      .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u),
  })
  .strict();
export type PushRegistrationBody = z.infer<typeof PushRegistrationSchema>;
export class PushRegistrationDto extends createZodDto(
  PushRegistrationSchema,
  "PushRegistrationBody",
) {}

export const PushRegistrationParams = z.object({ id: z.string().min(1).max(100) }).strict();
export class PushRegistrationParamsDto extends createZodDto(
  PushRegistrationParams,
  "PushRegistrationParams",
) {}

/** One of the person's registrations as the settings page lists it (never the token). */
export interface PushRegistrationView {
  id: string;
  platform: "ios" | "android";
  appId: string;
  provider: string;
  deviceName: string;
  locale: "zh" | "en";
  createdAt: string;
  lastSeenAt: string;
  /** Posted by the session making the request. */
  current: boolean;
}

/** The person's five push switches, as `GET` / `PUT /me/push-preferences` answer them. */
export const PushPreferencesSchema = z
  .object({
    waiting: z.boolean(),
    replies: z.boolean(),
    tasks: z.boolean(),
    automations: z.boolean(),
    inbox: z.boolean(),
  })
  .strict();
export type PushPreferences = z.infer<typeof PushPreferencesSchema>;

/** `PUT /me/push-preferences`: the switches to change, at least one. */
export const PushPreferencesPatchSchema = PushPreferencesSchema.partial().refine(
  (p) => Object.values(p).some((v) => v !== undefined),
  { message: "give at least one of waiting, replies, tasks, automations, inbox" },
);
export type PushPreferencesPatch = z.infer<typeof PushPreferencesPatchSchema>;
export class PushPreferencesPatchDto extends createZodDto(
  PushPreferencesPatchSchema,
  "PushPreferencesPatch",
) {}

/** The push routes the Platform operations mirror (`check:platform-ops` keys). */
export const PUSH_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/me/push-preferences" },
  { route: "PUT /api/v1/me/push-preferences", body: PushPreferencesPatchSchema },
];
