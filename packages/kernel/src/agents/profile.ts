import {
  BUILTIN_AVATAR_PRESET_IDS,
  type BuiltinAvatarPresetId,
  THEME_AVATAR_ID_RE,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { THEME_PRESET_KEY_RE } from "../themes/avatar-preset-key.js";

/** The ten built-in pixel-animal avatars (drawn by `@capybara-hq/design`). */
export const PRESET_IDS = BUILTIN_AVATAR_PRESET_IDS;
export type PresetId = BuiltinAvatarPresetId;

/** Whether `id` is a built-in preset id (else, in an avatar input, a theme preset key). */
export const isBuiltinPresetId = (id: string): id is PresetId =>
  (PRESET_IDS as readonly string[]).includes(id);

export const PROFILE_LIMITS = {
  description: 500,
  quickActions: 9,
  title: 40,
  body: 20_000,
} as const;

export const AgentAvatarSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), id: z.enum(PRESET_IDS) }).strict(),
  z.object({ kind: z.literal("upload"), uploadId: z.string().min(1).max(200) }).strict(),
  // a theme preset pinned to the theme version it was chosen from (theme brand coverage spec §4);
  // only produced by the kernel from a preset key, never accepted from a client
  z
    .object({
      kind: z.literal("theme"),
      themeId: z.string().min(1).max(200),
      version: z.string().min(1).max(64),
      preset: z.string().regex(THEME_AVATAR_ID_RE),
      file: z.string().min(1).max(512),
    })
    .strict(),
  // only produced by the migration of `definition.avatarUrl`; never accepted from a client
  z.object({ kind: z.literal("external"), url: z.url() }).strict(),
]);
/**
 * A stored avatar; `null`: no avatar (agents created before profiles existed, or a random default
 * with no preset visible).
 */
export type AgentAvatar = z.infer<typeof AgentAvatarSchema> | null;
/** A theme preset as stored: pinned to the theme version it was chosen from. */
export type ThemeAvatar = Extract<z.infer<typeof AgentAvatarSchema>, { kind: "theme" }>;
/** An avatar as the agent API returns it: a `theme` one carries its immutable asset URL. */
export type AgentAvatarView =
  | Exclude<z.infer<typeof AgentAvatarSchema>, { kind: "theme" }>
  | (ThemeAvatar & { url: string })
  | null;

export const QuickActionSchema = z
  .object({
    title: z.string().min(1).max(PROFILE_LIMITS.title),
    body: z.string().min(1).max(PROFILE_LIMITS.body),
  })
  .strict();
export type QuickAction = z.infer<typeof QuickActionSchema>;

export const DescriptionSchema = z.string().max(PROFILE_LIMITS.description);
export const QuickActionsSchema = z.array(QuickActionSchema).max(PROFILE_LIMITS.quickActions);

/**
 * A preset avatar: the only kind the `Platform` tool sets (an upload is the web's). `id` is a
 * built-in preset id or a theme preset key ({@link THEME_PRESET_KEY_RE}; the org's theme listing
 * returns the keys it offers).
 */
export const PresetAvatarSchema = z
  .object({
    kind: z.literal("preset"),
    id: z.union([
      z.enum(PRESET_IDS),
      z.string().regex(THEME_PRESET_KEY_RE, {
        message:
          "id must be a built-in preset id or a theme preset key <plugin>/<theme>/<preset> from the org's theme listing (avatars.presets[].key)",
      }),
    ]),
  })
  .strict();

/** What a client may write (`external` is migrated data only, `theme` the kernel's). */
export const AvatarInputSchema = z.discriminatedUnion("kind", [
  PresetAvatarSchema,
  z.object({ kind: z.literal("upload"), uploadId: z.string().min(1).max(200) }).strict(),
]);

export const ProfileInputSchema = z
  .object({
    avatar: AvatarInputSchema.nullable().optional(),
    description: DescriptionSchema.optional(),
    quickActions: QuickActionsSchema.optional(),
  })
  .strict();
export type ProfileInput = z.infer<typeof ProfileInputSchema>;
/** What `PATCH …/profile` writes: the description is saved with the definition (run context §3.5). */
export type ProfilePatch = Omit<ProfileInput, "description">;

export type AvatarInput = z.infer<typeof AvatarInputSchema>;

export interface AgentProfile {
  avatar: AgentAvatarView;
  description: string;
  quickActions: QuickAction[];
  updatedAt: string;
}
