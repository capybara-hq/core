import { StaticTheme } from "../components/static-theme";
import { outsideTheme } from "../lib/server/outside-theme";
import NotFound from "./(app)/not-found";

/**
 * The root 404 (theme brand coverage spec §5): a path no layout serves, or a route-group layout's
 * `notFound()`. The `StatusPage` 404 of the workspace with its home link, under the theme of
 * `outsideTheme()`: the brand cookie, else the platform default, else the built-in theme.
 */
export default async function RootNotFound() {
  return (
    <StaticTheme brand={await outsideTheme()}>
      <NotFound />
    </StaticTheme>
  );
}
