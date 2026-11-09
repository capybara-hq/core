import { ApiClientError, apiFetch } from "./api";

/** A color scheme a theme defines. */
export type ThemeScheme = "dark" | "light";

/**
 * A theme as the web uses it (kernel `ThemeRef`, themes spec §8): the stylesheet to link and the
 * brand to draw. `id` is the `platform_themes` id settings store.
 */
export interface ThemeRef {
  id: string;
  /** `<plugin>/<theme file id>`: the `theme=` state token's value (`useTheme().key`). */
  key: string;
  version: string;
  name: { en: string; zh?: string };
  /** The schemes the theme defines, `dark` first. */
  schemes: ThemeScheme[];
  /** The only scheme of a single-scheme theme (the scheme toggle is hidden), else null. */
  singleScheme: ThemeScheme | null;
  /** null: the built-in mark and wordmark. */
  logo: { markUrl: string | null; wordmark: string | null; faviconUrl: string | null } | null;
  /**
   * `/api/v1/themes/<id>/<version>/r<revision>/theme.css` (public, immutable per version and render
   * revision); opaque here.
   */
  cssUrl: string;
}

/** The four colors a theme picker draws per scheme. */
export interface ThemeSwatch {
  bg: string;
  panel: string;
  ink: string;
  accent: string;
}

/** A theme of an org's listing, with swatches for each scheme it defines. */
export type ListedTheme = ThemeRef & { swatches: Partial<Record<ThemeScheme, ThemeSwatch>> };

/** `GET /api/v1/orgs/:orgId/themes` (members). */
export interface OrgThemes {
  /** The themes on in the org. */
  themes: ListedTheme[];
  /** The viewer's theme; null: the built-in theme. */
  resolved: ThemeRef | null;
  /** The org's setting as stored: its default (null: follow the platform) and the personal lock. */
  org: { id: string | null; personal: "allowed" | "locked" };
}

/** A theme's name in the UI locale (its English name when it has none in Chinese). */
export const themeName = (t: Pick<ThemeRef, "name">, locale: string): string =>
  locale === "zh" ? (t.name.zh ?? t.name.en) : t.name.en;

export const getOrgThemes = (orgId: string) =>
  apiFetch<OrgThemes>(`/api/v1/orgs/${encodeURIComponent(orgId)}/themes`);

/**
 * The platform default theme for pages before sign-in (public); null: the built-in theme (an empty
 * body reads as null too: a query's data is never undefined).
 */
export const getPlatformTheme = () =>
  apiFetch<ThemeRef | null | undefined>("/api/v1/platform/theme").then((t) => t ?? null);

/**
 * The orgs a `theme.not_available` refusal of a platform default names (the theme is off there), by
 * name; empty for any other error or a refusal that names none.
 */
export function themeOffOrgs(e: unknown): string[] {
  if (!(e instanceof ApiClientError) || e.code !== "theme.not_available") return [];
  const d = e.rawDetails[0] as { orgs?: { orgName: string }[] } | undefined;
  return (d?.orgs ?? []).map((o) => o.orgName);
}
