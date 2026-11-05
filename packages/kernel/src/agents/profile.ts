import { randomInt } from "node:crypto";
import { z } from "zod";

/** The ten built-in pixel-animal avatars (drawn by `@capybara-hq/design`). */
export const PRESET_IDS = [
  "capybara",
  "black-bear",
  "panda",
  "elephant",
  "fox",
  "owl",
  "penguin",
  "rabbit",
  "turtle",
  "whale",
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export const PROFILE_LIMITS = {
  description: 500,
  quickActions: 9,
  title: 40,
  body: 20_000,
} as const;

/** A random preset id: the avatar of an agent created without one. */
export function randomPreset(): PresetId {
  return PRESET_IDS[randomInt(PRESET_IDS.length)] as PresetId;
}

export const AgentAvatarSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), id: z.enum(PRESET_IDS) }).strict(),
  z.object({ kind: z.literal("upload"), uploadId: z.string().min(1).max(200) }).strict(),
  // only produced by the migration of `definition.avatarUrl`; never accepted from a client
  z.object({ kind: z.literal("external"), url: z.url() }).strict(),
]);
/** `null` only for agents created before profiles existed. */
export type AgentAvatar = z.infer<typeof AgentAvatarSchema> | null;

export const QuickActionSchema = z
  .object({
    title: z.string().min(1).max(PROFILE_LIMITS.title),
    body: z.string().min(1).max(PROFILE_LIMITS.body),
  })
  .strict();
export type QuickAction = z.infer<typeof QuickActionSchema>;

export const DescriptionSchema = z.string().max(PROFILE_LIMITS.description);
export const QuickActionsSchema = z.array(QuickActionSchema).max(PROFILE_LIMITS.quickActions);

/** What a client may write (`external` is migrated data only). */
export const AvatarInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), id: z.enum(PRESET_IDS) }).strict(),
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

export interface AgentProfile {
  avatar: AgentAvatar;
  description: string;
  quickActions: QuickAction[];
  updatedAt: string;
}
