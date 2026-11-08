import { getOrgThemes, getPlatformTheme } from "../themes";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The org's themes and the viewer's resolved theme (the workspace layout's shell read). */
export const orgThemesQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).themes(),
    fn: () => getOrgThemes(orgId),
    freshness: "orgConfig",
  });

/** The platform default theme (the auth layout's read; a deployment-wide setting). */
export const platformThemeQuery = () =>
  defineQuery({
    key: keys.deployment().platformTheme(),
    fn: getPlatformTheme,
    freshness: "deployment",
  });
