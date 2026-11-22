import "server-only";
import { BRAND_COOKIE, type BrandRef, brandRefOf, decodeBrandCookie } from "../brand-cookie";
import { platformThemeQuery } from "../query/themes";
import { currentCookie } from "./page";
import { serverQueryClient } from "./query";

/**
 * The theme of a page outside a route-group layout (theme brand coverage spec §5), one rule: the
 * brand cookie when valid (what this browser last drew); else the public platform default when the
 * kernel answers (through the request's query client, so a layout's read is reused); else null,
 * the built-in theme.
 */
export async function outsideTheme(): Promise<BrandRef | null> {
  const cookie = decodeBrandCookie(await currentCookie(BRAND_COOKIE));
  if (cookie !== null) return cookie;
  try {
    const theme = await serverQueryClient().fetchQuery({ ...platformThemeQuery(), retry: false });
    return theme === null ? null : brandRefOf(theme);
  } catch {
    return null;
  }
}
