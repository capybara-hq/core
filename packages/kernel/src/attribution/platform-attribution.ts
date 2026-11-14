import { z } from "zod";
import type { KernelConfig } from "../config/schema.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelLogger } from "../log.js";

/**
 * The Capybara attribution of agent-created git commits and pull requests (spec
 * 2026-11-14-agent-attribution): the platform defaults, and the merge of an agent's own override
 * over them. Each field is read env > config file (or Nacos) > the super admin's choice in the
 * admin console (deployment setting {@link PLATFORM_ATTRIBUTION_SETTING}) > {@link
 * ATTRIBUTION_DEFAULTS}; a field set in the startup config is read-only in the admin console.
 * Nothing here is enforcement: the run records the effective values in its log and the model is
 * instructed to use them.
 */

/** The `deployment_settings` key of the super admin's choice. */
export const PLATFORM_ATTRIBUTION_SETTING = "attribution";

/** The fields, in display order. */
export const PLATFORM_ATTRIBUTION_FIELDS = ["commit", "pr", "sessionUrl"] as const;
export type PlatformAttributionField = (typeof PLATFORM_ATTRIBUTION_FIELDS)[number];

/** One attribution line: at most 500 characters, never a line break. */
const Line = z
  .string()
  .max(500)
  .refine((s) => !/[\r\n]/.test(s), { message: "one line" });

/** An agent's attribution override (`AgentDefinition.attribution`). */
export const AgentAttributionSchema = z
  .object({
    /**
     * `inherit` (or absent): the platform defaults; `custom`: this agent's values (a field it
     * leaves out follows the platform); `off`: no attribution for this agent.
     */
    mode: z.enum(["inherit", "custom", "off"]).default("inherit"),
    /** The commit trailer; `""` turns it off. Absent in `custom`: the platform's. */
    commit: Line.optional(),
    /** The pull-request line; `""` turns it off. Absent in `custom`: the platform's. */
    pr: Line.optional(),
    /** Append the conversation link when the deployment has `http.publicUrl`. */
    sessionUrl: z.boolean().optional(),
  })
  .strict();
export type AgentAttribution = z.infer<typeof AgentAttributionSchema>;

/** The stored choice: each field absent follows the default. */
export const PlatformAttributionStoredSchema = z
  .object({
    commit: Line.optional(),
    pr: Line.optional(),
    sessionUrl: z.boolean().optional(),
  })
  .strict();
export type PlatformAttributionStored = z.infer<typeof PlatformAttributionStoredSchema>;

/**
 * A change of the stored choice (`PUT /api/v1/admin/settings` `attribution`): each given field
 * replaces the stored one, null clears it (back to the default); at least one field.
 */
export const PLATFORM_ATTRIBUTION_PATCH = z
  .object({
    commit: Line.nullable().optional(),
    pr: Line.nullable().optional(),
    sessionUrl: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((o) => Object.values(o).some((v) => v !== undefined), {
    message: "give commit, pr, sessionUrl or several",
  });
export type PlatformAttributionPatch = z.infer<typeof PLATFORM_ATTRIBUTION_PATCH>;

/** The platform's effective attribution defaults. */
export interface PlatformAttribution {
  /** The trailer ending an agent-created commit message; `""` = none. */
  commit: string;
  /** The line ending an agent-created pull-request body; `""` = none. */
  pr: string;
  /** Whether agent-created pull requests also carry the conversation link. */
  sessionUrl: boolean;
}

/** What a field falls back to when neither the startup config nor the admin console sets it. */
export const ATTRIBUTION_DEFAULTS: Readonly<PlatformAttribution> = Object.freeze({
  commit: "Co-Authored-By: Capybara <noreply@capybarahq.com>",
  pr: "🤖 Generated with [Capybara](https://github.com/capybara-hq/core)",
  sessionUrl: false,
});

/** Where a field's effective value comes from. */
export type PlatformAttributionSource = "env" | "file" | "nacos" | "db" | "default";

/** The admin console's view: the effective defaults and where each comes from. */
export interface PlatformAttributionView extends PlatformAttribution {
  sources: Record<PlatformAttributionField, PlatformAttributionSource>;
}

/** The startup config's `attribution` (each field undefined when not set there). */
export type ConfigAttribution = KernelConfig["attribution"];

/**
 * Parses the stored choice: missing -> `{}`; invalid -> `{}` (the defaults), with a warning on
 * `log`. Unlike the sandbox tiers there is no narrower reading: the worst case is a visible
 * attribution line on a commit or a pull request.
 */
export function parseStoredPlatformAttribution(
  value: unknown,
  log?: Pick<KernelLogger, "warn">,
): PlatformAttributionStored {
  if (value === undefined) return {};
  const parsed = PlatformAttributionStoredSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  log?.warn("invalid deployment setting; it reads as the defaults", {
    key: PLATFORM_ATTRIBUTION_SETTING,
  });
  return {};
}

/** The effective defaults of the startup config over the stored choice. */
export function resolvePlatformAttribution(
  config: ConfigAttribution,
  stored: PlatformAttributionStored,
): PlatformAttribution {
  return {
    commit: config.commit ?? stored.commit ?? ATTRIBUTION_DEFAULTS.commit,
    pr: config.pr ?? stored.pr ?? ATTRIBUTION_DEFAULTS.pr,
    sessionUrl: config.sessionUrl ?? stored.sessionUrl ?? ATTRIBUTION_DEFAULTS.sessionUrl,
  };
}

/** The stored choice with `patch` applied (null clears a field). */
export function applyPlatformAttributionPatch(
  stored: PlatformAttributionStored,
  patch: PlatformAttributionPatch,
): PlatformAttributionStored {
  const out: Record<string, unknown> = { ...stored };
  for (const f of PLATFORM_ATTRIBUTION_FIELDS) {
    const v = patch[f];
    if (v === null) delete out[f];
    else if (v !== undefined) out[f] = v;
  }
  return out as PlatformAttributionStored;
}

/** The stored choice, read live (in the caller's transaction when there is one). */
export async function readStoredPlatformAttribution(
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
): Promise<PlatformAttributionStored> {
  const row = await db
    .selectFrom("deployment_settings")
    .select("value")
    .where("key", "=", PLATFORM_ATTRIBUTION_SETTING)
    .executeTakeFirst();
  return parseStoredPlatformAttribution(row?.value, log);
}

/** The platform's effective defaults, read live: see {@link resolvePlatformAttribution}. */
export async function readPlatformAttribution(
  db: KernelSchemaDb,
  config: { get(): Pick<KernelConfig, "attribution"> },
  log?: Pick<KernelLogger, "warn">,
): Promise<PlatformAttribution> {
  return resolvePlatformAttribution(
    config.get().attribution,
    await readStoredPlatformAttribution(db, log),
  );
}

/**
 * The link that ends an agent-created pull request when the deployment set `http.publicUrl` (a
 * conversation is `/chat/<id>` in the web app; conversation ids are URL-safe). null: no link.
 */
export function conversationLink(
  publicUrl: string | undefined,
  conversationId: string,
): string | null {
  if (publicUrl === undefined || publicUrl === "") return null;
  try {
    return new URL(`/chat/${encodeURIComponent(conversationId)}`, publicUrl).toString();
  } catch {
    return null;
  }
}

/** The attribution a run's requests carry: the effective values, with the link resolved. */
export interface RunAttribution {
  /** Empty: no commit trailer. */
  commit: string;
  /** Empty: no pull-request line. */
  pr: string;
  /** The absolute conversation link, or null. */
  sessionUrl: string | null;
}

/**
 * The effective attribution of a run: the platform defaults, the agent's own values for a
 * `custom` override (a field it leaves out follows the platform), nothing for `off`. The link is
 * `conversationLink(publicUrl, conversationId)`; it is added only while the source asks for it.
 */
export function effectiveAttribution(
  platform: PlatformAttribution,
  agent: AgentAttribution | undefined,
  link: string | null,
): RunAttribution {
  const chosen =
    agent === undefined || agent.mode === "inherit"
      ? platform
      : agent.mode === "off"
        ? { commit: "", pr: "", sessionUrl: false }
        : {
            commit: agent.commit ?? platform.commit,
            pr: agent.pr ?? platform.pr,
            sessionUrl: agent.sessionUrl ?? platform.sessionUrl,
          };
  return {
    commit: chosen.commit,
    pr: chosen.pr,
    sessionUrl: chosen.sessionUrl && link !== null ? link : null,
  };
}
