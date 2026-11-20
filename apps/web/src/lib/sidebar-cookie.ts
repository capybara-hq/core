/**
 * The person's choice of the collapsed sidebar (spec §4.1): `cb-sidebar=rail`. The app layout reads
 * it like the theme cookie, so the first paint draws the chosen form and nothing jumps; the full
 * sidebar is the absence of the cookie.
 */
export const SIDEBAR_COOKIE = "cb-sidebar";

/** Whether the cookie's value is the rail choice. */
export const isSidebarCollapsed = (value: string | undefined): boolean => value === "rail";

/** The value written to `document.cookie` for the choice, for a year (expanded clears it). */
export const sidebarCookie = (collapsed: boolean): string =>
  collapsed
    ? `${SIDEBAR_COOKIE}=rail; path=/; max-age=31536000; samesite=lax`
    : `${SIDEBAR_COOKIE}=; path=/; max-age=0; samesite=lax`;
