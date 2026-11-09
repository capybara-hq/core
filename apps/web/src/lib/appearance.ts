import { apiFetch } from "./api";

/**
 * 应用此插件的外观 (client extensions spec §6.5): what a plugin suggests (its `plugin.json`
 * `suggestedAppearance`) and what applying it changes at a level. Types copied from the kernel's
 * `packages/kernel/src/catalog/appearance.service.ts` and the SDK's `SuggestedAppearance` (the web
 * imports neither); keep them in step.
 */

/** A plugin's suggestion: one of its themes and, per replaceable slot, one of its components. */
export interface SuggestedAppearance {
  theme?: string;
  replacements?: Record<string, string>;
}

/** Why a replacement of the suggestion was left out. */
export type AppearanceSkipReason = "unknown-slot" | "not-available" | "not-eligible";

/**
 * What applying a suggestion changes (or, with `dryRun`, would change) at its level: the default
 * theme (`from` null: none stored; ids are `platform_themes` ids), each replaceable slot's `use`
 * (`from` null: the built-in; `to` a contribution key `<extension>/<contribution>`) in the order the
 * kernel answers (the plugin's), and what was skipped.
 */
export interface AppearanceResult {
  theme: { from: string | null; to: string } | null;
  replacements: { slot: string; from: string | null; to: string }[];
  skipped: { what: string; reason: AppearanceSkipReason }[];
}

/** Whether applying changes nothing (the level already looks as suggested). */
export const appearanceUnchanged = (r: AppearanceResult): boolean =>
  r.theme === null && r.replacements.length === 0;

const body = (dryRun: boolean): RequestInit => ({
  method: "POST",
  body: JSON.stringify({ dryRun }),
});

/** `POST /api/v1/admin/catalog/items/:id/appearance` (super admins): the platform defaults. */
export const applyPlatformAppearance = (itemId: string, dryRun: boolean) =>
  apiFetch<AppearanceResult>(
    `/api/v1/admin/catalog/items/${encodeURIComponent(itemId)}/appearance`,
    body(dryRun),
  );

/** `POST /api/v1/orgs/:orgId/extensions/:extension/appearance` (org admins): the org's defaults. */
export const applyOrgAppearance = (orgId: string, extension: string, dryRun: boolean) =>
  apiFetch<AppearanceResult>(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/extensions/${encodeURIComponent(extension)}/appearance`,
    body(dryRun),
  );
