/**
 * The theme stylesheet's render revision as the kernel serves it (`THEME_CSS_REVISION` in
 * packages/kernel/src/themes/theme-state.ts): the web never builds the URL itself (it gets
 * `cssUrl` from the kernel), so the tests' fixtures build it from this one copy. Bump it with the
 * kernel's.
 */
export const THEME_CSS_REVISION = 2;

/** A theme's stylesheet URL as the kernel answers it. */
export const themeCssUrl = (id: string, version: string): string =>
  `/api/v1/themes/${id}/${version}/r${THEME_CSS_REVISION}/theme.css`;
