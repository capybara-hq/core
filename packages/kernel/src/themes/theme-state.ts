// Which themes an org can use and which can be the platform default (themes spec §7), the theme
// references the web reads, and the delivery URLs (§8). Plain functions in the caller's context (a
// transaction's connection when there is one): the settings writers (deployment, org, person) and
// `ThemesService` decide with the same predicates.
import {
  type LocalizedName,
  mergeThemeSchemes,
  type ParsedTheme,
  type ThemeScheme,
} from "@capybara-hq/plugin-sdk";
import {
  type ComponentRow,
  componentOn,
  listedIn,
  loadComponents,
  loadScopeState,
  pluginFactsOf,
  type ScopeState,
  switchOf,
} from "../catalog/component-state.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { packagePath } from "../packages/tgz.js";

/** The schemes in the order they are listed. */
const SCHEMES: readonly ThemeScheme[] = ["dark", "light"];

/** A theme as the web uses it (spec §8): what to load and how to draw the logo. */
export interface ThemeRef {
  /** The `platform_themes` id (what settings and picks store). */
  id: string;
  /** Its current version. */
  version: string;
  name: LocalizedName;
  /** The schemes the theme defines, `dark` first. */
  schemes: ThemeScheme[];
  /** The only scheme of a single-scheme theme, else null. */
  singleScheme: ThemeScheme | null;
  /** null: the theme has no logo (the built-in mark and wordmark). */
  logo: { markUrl: string | null; wordmark: string | null; faviconUrl: string | null } | null;
  /** `/api/v1/themes/<id>/<version>/r<THEME_CSS_REVISION>/theme.css`. */
  cssUrl: string;
}

/** The four colors a theme picker draws per scheme. */
export interface ThemeSwatch {
  bg: string;
  panel: string;
  ink: string;
  accent: string;
}

/** A theme of an org's listing: its reference and swatches for each scheme it defines. */
export type ListedTheme = ThemeRef & { swatches: Partial<Record<ThemeScheme, ThemeSwatch>> };

/**
 * The render revision of theme stylesheets, a segment of the stylesheet URL (`r<N>/theme.css`).
 * The stylesheet is cached as immutable for a year, keyed by its URL: bump this whenever
 * `renderThemeCss`'s output format changes, so no browser keeps an older format under a URL
 * that now means the new one. The delivery route serves only the current revision (404
 * `theme.not_found` otherwise). History: (none, `<version>/theme.css`) plain rules; 2: one
 * `@layer theme { … }` block (client extensions spec §7.2).
 */
export const THEME_CSS_REVISION = 2;

/**
 * The delivery URL of a theme version (spec §8): its stylesheet (with the render revision,
 * {@link THEME_CSS_REVISION}), or with `asset` (a path inside the
 * plugin as the theme file names it, e.g. `./fonts/MiSans.woff2`) that asset, as one path segment
 * (`assets/fonts%2FMiSans.woff2`; the route decodes it back to the stored path `fonts/MiSans.woff2`).
 * The one builder of these URLs: the listing, the stylesheet and the asset routes all use it.
 */
export function themeUrl(id: string, version: string, asset?: string): string {
  const base = `/api/v1/themes/${encodeURIComponent(id)}/${encodeURIComponent(version)}`;
  return asset === undefined
    ? `${base}/r${THEME_CSS_REVISION}/theme.css`
    : `${base}/assets/${encodeURIComponent(packagePath(asset))}`;
}

/** The {@link ThemeRef} of version `version` of theme `id`. */
export function themeRefOf(id: string, version: string, def: ParsedTheme): ThemeRef {
  const url = (ref: string | undefined) => (ref === undefined ? null : themeUrl(id, version, ref));
  return {
    id,
    version,
    name: def.name,
    schemes: SCHEMES.filter((s) => def.schemes[s] !== undefined),
    singleScheme: def.singleScheme,
    logo:
      def.logo === undefined
        ? null
        : {
            markUrl: url(def.logo.mark),
            wordmark: def.logo.wordmark ?? null,
            faviconUrl: url(def.logo.favicon),
          },
    cssUrl: themeUrl(id, version),
  };
}

/**
 * The swatches of each scheme the theme defines: its overrides merged onto the current built-in
 * values (a stored definition holds only the theme file's own values, themes spec §6).
 */
export function themeSwatches(def: ParsedTheme): Partial<Record<ThemeScheme, ThemeSwatch>> {
  const out: Partial<Record<ThemeScheme, ThemeSwatch>> = {};
  const merged = mergeThemeSchemes(def);
  for (const s of SCHEMES) {
    const c = merged[s]?.color;
    if (def.schemes[s] === undefined || c === undefined) continue;
    out[s] = { bg: c.bg ?? "", panel: c.panel ?? "", ink: c.ink ?? "", accent: c.accent ?? "" };
  }
  return out;
}

/** The current definitions of live themes `ids`, by id. */
export async function themeDefinitions(
  db: KernelSchemaDb,
  ids: readonly string[],
): Promise<Map<string, { version: string; definition: ParsedTheme }>> {
  const out = new Map<string, { version: string; definition: ParsedTheme }>();
  if (ids.length === 0) return out;
  const rows = await db
    .selectFrom("platform_themes as p")
    .innerJoin("platform_theme_versions as v", (j) =>
      j.onRef("v.theme_id", "=", "p.id").onRef("v.version", "=", "p.current_version"),
    )
    .select(["p.id", "p.current_version", "v.definition"])
    .where("p.id", "in", [...ids])
    .where("p.deleted_at", "is", null)
    .execute();
  for (const r of rows) {
    out.set(r.id, { version: String(r.current_version), definition: r.definition as ParsedTheme });
  }
  return out;
}

/** Whether theme `c` is on in the org (offered in its pickers, spec §6), from `st`. */
const onIn = (st: ScopeState, c: ComponentRow, orgId: string): boolean =>
  componentOn(
    c,
    pluginFactsOf(st, c.itemId, orgId),
    listedIn(st, c.id, orgId),
    switchOf(st, c.id, orgId),
  );

/** The live themes on in the org, sorted by id. */
export async function themesOnIn(db: KernelSchemaDb, orgId: string): Promise<ComponentRow[]> {
  const comps = await loadComponents(db, "theme");
  if (comps.length === 0) return [];
  const st = await loadScopeState(db, "theme", comps);
  return comps.filter((c) => onIn(st, c, orgId));
}

/**
 * Whether theme `c` can be the platform default (spec §7): platform-owned, not disabled, its
 * plugin live and not disabled, and its effective scope `all` (its own, or its plugin's when it
 * follows; a builtin plugin is `all`).
 */
function platformDefaultEligible(st: ScopeState, c: ComponentRow): boolean {
  if (c.ownerOrgId !== null || c.disabled) return false;
  const p = c.itemId === null ? undefined : st.plugins.get(c.itemId);
  if (c.itemId !== null && (p === undefined || p.disabled)) return false;
  if (c.scopeMode === "own") return c.scope === "all";
  return p !== undefined && (p.builtin || p.scope === "all");
}

/** The live theme `id` if it can be the platform default, else null. */
export async function eligiblePlatformDefault(
  db: KernelSchemaDb,
  id: string,
): Promise<ComponentRow | null> {
  const [c] = await loadComponents(db, "theme", { ids: [id] });
  if (!c) return null;
  const st = await loadScopeState(db, "theme", [c]);
  return platformDefaultEligible(st, c) ? c : null;
}

/**
 * 400 `theme.not_available`: theme `id` cannot be chosen where it was set; `orgs`: the live orgs
 * where it is off (a platform default must be on in every org).
 */
export const themeNotAvailable = (
  id: string,
  where: string,
  orgs?: { orgId: string; orgName: string }[],
): ApiError =>
  new ApiError(
    "theme.not_available",
    orgs === undefined
      ? `Theme ${id} is not available ${where}; choose one of the themes listed for it`
      : `Theme ${id} is off in ${orgs.length} organization(s) (${orgs.map((o) => o.orgName).join(", ")}), so it cannot be the platform default; choose a theme that is on in every organization`,
    [{ theme: id, ...(orgs !== undefined && { orgs }) }],
  );

/**
 * Locks theme `id`'s catalog item, then its `platform_themes` row, FOR SHARE (the one theme lock
 * order: catalog item, then theme row, then the `uiTheme` setting row; the scope, disable, switch
 * and removal writers hold the item or theme row FOR UPDATE before they read `uiTheme`), so the
 * check that follows reads a state no such writer changes before the caller commits.
 */
export async function lockThemeShared(db: KernelSchemaDb, id: string): Promise<void> {
  const row = await db
    .selectFrom("platform_themes")
    .select("catalog_item_id")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return;
  if (row.catalog_item_id !== null) {
    await db
      .selectFrom("catalog_items")
      .select("id")
      .where("id", "=", row.catalog_item_id)
      .forShare()
      .execute();
  }
  await db.selectFrom("platform_themes").select("id").where("id", "=", id).forShare().execute();
}

/**
 * Refuses (400 `theme.not_available`) a platform default that is not a platform-owned theme with
 * effective scope `all`, live and not disabled, or that is off in some live org (an org switched it
 * off, or does not have the plugin a `follow` theme comes with; details list those orgs): the
 * default is locked on in every org and every org falls back to it (spec §7). Call it in the
 * setting's transaction after {@link lockThemeShared} and the `uiTheme` row lock.
 */
export async function assertPlatformDefaultEligible(db: KernelSchemaDb, id: string): Promise<void> {
  const [c] = await loadComponents(db, "theme", { ids: [id] });
  const st = c && (await loadScopeState(db, "theme", [c]));
  if (!c || !st || !platformDefaultEligible(st, c)) {
    throw themeNotAvailable(id, "as the platform default (a platform theme whose scope is all)");
  }
  const orgs = await db
    .selectFrom("orgs")
    .select(["id", "name"])
    .where("deleted_at", "is", null)
    .orderBy("name")
    .orderBy("id")
    .execute();
  const off = orgs.filter((o) => !onIn(st, c, o.id)).map((o) => ({ orgId: o.id, orgName: o.name }));
  if (off.length > 0) throw themeNotAvailable(id, "as the platform default", off);
}

/**
 * Refuses (400 `theme.not_available`) an org default that is not on in the org. Call it in the
 * setting's transaction after the org lock: it locks the theme's rows FOR SHARE before reading.
 */
export async function assertThemeOnIn(
  db: KernelSchemaDb,
  orgId: string,
  id: string,
): Promise<void> {
  await lockThemeShared(db, id);
  const [c] = await loadComponents(db, "theme", { ids: [id] });
  const st = c && (await loadScopeState(db, "theme", [c]));
  if (!c || !st || !onIn(st, c, orgId)) throw themeNotAvailable(id, "in this organization");
}

/** Whether theme `id` is on in the org (no locks: a read for display). */
export async function themeOnIn(db: KernelSchemaDb, orgId: string, id: string): Promise<boolean> {
  const [c] = await loadComponents(db, "theme", { ids: [id] });
  if (!c) return false;
  return onIn(await loadScopeState(db, "theme", [c]), c, orgId);
}

/** Whether theme `id` is on in at least one of the person's live orgs. */
export async function themeOnForAccount(
  db: KernelSchemaDb,
  accountId: string,
  id: string,
): Promise<boolean> {
  const orgs = await db
    .selectFrom("memberships as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .select("m.org_id")
    .where("m.account_id", "=", accountId)
    .where("o.deleted_at", "is", null)
    .execute();
  const [c] = await loadComponents(db, "theme", { ids: [id] });
  if (!c || orgs.length === 0) return false;
  const st = await loadScopeState(db, "theme", [c]);
  return orgs.some((o) => onIn(st, c, o.org_id));
}

/**
 * Refuses (400 `theme.not_available`) a person's pick that is on in none of their live orgs (the
 * pick is one value across their orgs, spec §7; where it is off, the org's default applies).
 */
export async function assertThemeOnForAccount(
  db: KernelSchemaDb,
  accountId: string,
  id: string,
): Promise<void> {
  if (!(await themeOnForAccount(db, accountId, id))) {
    throw themeNotAvailable(id, "in any of your organizations");
  }
}
