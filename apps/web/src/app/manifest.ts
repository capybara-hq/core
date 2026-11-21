import type { MetadataRoute } from "next";
import { getPlatformMeta, type PlatformMeta } from "../lib/app-auth";
import { getPlatformTheme, type ThemeRef } from "../lib/themes";
import { webManifest } from "../lib/web-manifest";
// The kernel read goes through the server transport.
import "../lib/server/register";

/** Read per request: the name and icons are the deployment's and change at runtime. */
export const dynamic = "force-dynamic";

/**
 * `/manifest.webmanifest` (mobile layout spec §10.2): the installable PWA with the deployment's
 * name and platform icon, else the platform default theme's app icons and colours (theme brand
 * coverage spec §6), the web's defaults when the kernel cannot be read. Public: the sign-in proxy
 * skips this path (`proxy.ts`), since a browser fetches it without the session.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  // an unreachable kernel: the defaults
  const [meta, theme] = await Promise.all([
    getPlatformMeta().catch((): PlatformMeta | null => null),
    getPlatformTheme().catch((): ThemeRef | null => null),
  ]);
  return webManifest(meta, theme);
}
