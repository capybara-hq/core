import { minTier, type SandboxTier, tierAtMost } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { KernelConfig } from "../config/schema.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelLogger } from "../log.js";

/**
 * The platform's sandbox tiers (sandbox dev tiers spec §4.1): `max`, `default` and
 * `allowUnsandboxed`. Each field is read env > config file (or Nacos) > the super admin's choice in
 * the admin console (deployment setting {@link PLATFORM_TIERS_SETTING}) > {@link PLATFORM_TIER_DEFAULTS}.
 * A field set in the startup config is read-only in the admin console. Read live from PG at every
 * use, so a change applies on every replica at once.
 */

/** The `deployment_settings` key of the super admin's choice. */
export const PLATFORM_TIERS_SETTING = "sandboxTiers";

/** The fields, in display order. */
export const PLATFORM_TIER_FIELDS = ["max", "default", "allowUnsandboxed"] as const;
export type PlatformTierField = (typeof PLATFORM_TIER_FIELDS)[number];

const Tier = z.enum(["strict", "dev", "open"]);

/** The stored choice: each field absent follows the default. */
export const PlatformTiersStoredSchema = z
  .object({
    max: Tier.optional(),
    default: Tier.optional(),
    allowUnsandboxed: z.boolean().optional(),
  })
  .strict();
export type PlatformTiersStored = z.infer<typeof PlatformTiersStoredSchema>;

/**
 * A change of the stored choice (`PUT /api/v1/admin/settings` `sandboxTiers`): each given field
 * replaces the stored one, null clears it (back to the default); at least one field.
 */
export const PLATFORM_TIERS_PATCH = z
  .object({
    max: Tier.nullable().optional(),
    default: Tier.nullable().optional(),
    allowUnsandboxed: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((o) => Object.values(o).some((v) => v !== undefined), {
    message: "give max, default, allowUnsandboxed or several",
  });
export type PlatformTiersPatch = z.infer<typeof PLATFORM_TIERS_PATCH>;

/** The platform's effective tiers. */
export interface PlatformTiers {
  max: SandboxTier;
  /** At most {@link max}. */
  default: SandboxTier;
  allowUnsandboxed: boolean;
}

/** What a field falls back to when neither the startup config nor the admin console sets it. */
export const PLATFORM_TIER_DEFAULTS: Readonly<PlatformTiers> = Object.freeze({
  max: "dev",
  default: "dev",
  allowUnsandboxed: true,
});

/** Where a field's effective value comes from. */
export type PlatformTierSource = "env" | "file" | "nacos" | "db" | "default";

/** The admin console's view: the effective values and where each comes from. */
export interface PlatformTiersView extends PlatformTiers {
  sources: Record<PlatformTierField, PlatformTierSource>;
}

/** The startup config's `sandbox.tiers` (each field undefined when not set there). */
export type ConfigTiers = KernelConfig["sandbox"]["tiers"];

/**
 * Parses the stored choice: missing -> `{}`; invalid -> `{ max: "strict" }`, narrower, never
 * wider (the same rule an org's invalid `sandboxTier` follows), with a warning on `log`.
 */
export function parseStoredPlatformTiers(
  value: unknown,
  log?: Pick<KernelLogger, "warn">,
): PlatformTiersStored {
  if (value === undefined) return {};
  const parsed = PlatformTiersStoredSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  log?.warn("invalid deployment setting; it reads as max strict", { key: PLATFORM_TIERS_SETTING });
  return { max: "strict" };
}

/** The default the layers choose before it is cut to the max. */
export const chosenPlatformDefault = (config: ConfigTiers, stored: PlatformTiersStored) =>
  config.default ?? stored.default ?? PLATFORM_TIER_DEFAULTS.default;

/** The effective tiers of the startup config over the stored choice; the default is cut to the max. */
export function resolvePlatformTiers(
  config: ConfigTiers,
  stored: PlatformTiersStored,
): PlatformTiers {
  const max = config.max ?? stored.max ?? PLATFORM_TIER_DEFAULTS.max;
  return {
    max,
    default: minTier(chosenPlatformDefault(config, stored), max),
    allowUnsandboxed:
      config.allowUnsandboxed ?? stored.allowUnsandboxed ?? PLATFORM_TIER_DEFAULTS.allowUnsandboxed,
  };
}

/** Whether `next` reaches further than `prev` anywhere: a higher max or default, or unsandboxed allowed. */
export function platformTiersWiden(prev: PlatformTiers, next: PlatformTiers): boolean {
  return (
    !tierAtMost(next.max, prev.max) ||
    !tierAtMost(next.default, prev.default) ||
    (next.allowUnsandboxed && !prev.allowUnsandboxed)
  );
}

/** The stored choice with `patch` applied (null clears a field). */
export function applyPlatformTiersPatch(
  stored: PlatformTiersStored,
  patch: PlatformTiersPatch,
): PlatformTiersStored {
  const out: Record<string, unknown> = { ...stored };
  for (const f of PLATFORM_TIER_FIELDS) {
    const v = patch[f];
    if (v === null) delete out[f];
    else if (v !== undefined) out[f] = v;
  }
  return out as PlatformTiersStored;
}

/** The stored choice, read live (in the caller's transaction when there is one). */
export async function readStoredPlatformTiers(
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
): Promise<PlatformTiersStored> {
  const row = await db
    .selectFrom("deployment_settings")
    .select("value")
    .where("key", "=", PLATFORM_TIERS_SETTING)
    .executeTakeFirst();
  return parseStoredPlatformTiers(row?.value, log);
}

/** The platform's effective tiers, read live: see {@link resolvePlatformTiers}. */
export async function readPlatformTiers(
  db: KernelSchemaDb,
  config: { get(): Pick<KernelConfig, "sandbox"> },
  log?: Pick<KernelLogger, "warn">,
): Promise<PlatformTiers> {
  return resolvePlatformTiers(config.get().sandbox.tiers, await readStoredPlatformTiers(db, log));
}
