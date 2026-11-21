// The server-safe subpath (the main entry holds client modules): the manifest's colors cannot
// read a CSS variable, and apps/web writes no color literal.
import { PAGE_BACKGROUND } from "@capybara-hq/design/theme";
import type { MetadataRoute, Viewport } from "next";
import type { PlatformMeta } from "./app-auth";
import type { BrandRef } from "./brand-cookie";
import { DEFAULT_PLATFORM_ICONS, DEFAULT_PLATFORM_NAME } from "./platform-icons";
import type { ThemeRef, ThemeScheme } from "./themes";

/**
 * The PWA's theme and background colour (theme brand coverage spec §6): the platform default
 * theme's dark page background, else its light one, else the built-in dark page background.
 */
function manifestColor(theme: ThemeRef | null): string {
  return theme?.background.dark ?? theme?.background.light ?? PAGE_BACKGROUND.dark;
}

/**
 * The app icons (theme brand coverage spec §6, decision 8): `any` is the upload, else the platform
 * default theme's `appIcon`, else the web's; `maskable` is the uploaded one, else the maskable of
 * the source `any` came from (the theme's `appIconMaskable`, the web's own), none beside an
 * uploaded app icon.
 */
function appIconsOf(meta: PlatformMeta | null, theme: ThemeRef | null) {
  const { app, maskable } = iconsOf(meta);
  const themeApp = theme?.logo?.appIconUrl ?? null;
  if (app !== null) return { any: app, maskable };
  if (themeApp !== null)
    return { any: themeApp, maskable: maskable ?? theme?.logo?.appIconMaskableUrl ?? null };
  return { any: DEFAULT_PLATFORM_ICONS.app, maskable: maskable ?? DEFAULT_PLATFORM_ICONS.maskable };
}

/**
 * The meta's icon URLs, each null for the web's default. A meta answer without `icons` (a rolling
 * deploy may reach a kernel replica that does not send it yet) reads as no upload, never a throw:
 * the root layout's metadata runs for every page.
 */
function iconsOf(meta: PlatformMeta | null): PlatformMeta["icons"] {
  const icons = meta?.icons as Partial<PlatformMeta["icons"]> | undefined;
  return {
    app: icons?.app ?? null,
    maskable: icons?.maskable ?? null,
    favicon: icons?.favicon ?? null,
  };
}

/**
 * The web app manifest (mobile layout spec §10.2): the deployment's name ("Capybara" unset), its
 * app icons ({@link appIconsOf}: the upload, else the platform default theme's, else the web's; an
 * app icon without a maskable one is listed alone) and colours ({@link manifestColor}). `meta` and
 * `theme` null (the kernel could not be read, no platform theme): the defaults. It starts on the
 * home, `/`: the new conversation is the chat-first shell's home (a chat surface, design spec
 * §4.6), so an installed app opens on the composer.
 */
export function webManifest(
  meta: PlatformMeta | null,
  theme: ThemeRef | null,
): MetadataRoute.Manifest {
  const name = meta?.name ?? DEFAULT_PLATFORM_NAME;
  const { any, maskable } = appIconsOf(meta, theme);
  const png = { sizes: "512x512", type: "image/png" } as const;
  const icons: MetadataRoute.Manifest["icons"] = [{ src: any, ...png, purpose: "any" }];
  if (maskable !== null) icons.push({ src: maskable, ...png, purpose: "maskable" });
  const color = manifestColor(theme);
  return {
    name,
    short_name: name,
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: color,
    background_color: color,
    icons,
  };
}

/** The root layout's page icons (assignable to `Metadata["icons"]`). */
export interface PlatformIcons {
  icon: { url: string; type: string }[] | string;
  apple: { url: string; sizes: string; type: string }[];
}

/**
 * The page icons (mobile layout spec §10.2.1): the platform favicon (else the web's `icon.svg`) and
 * the app icon as the `apple-touch-icon` (iOS scales the 512): the upload, else the platform
 * default theme's `appIcon`, else the web's 512 PNG (theme brand coverage spec §6). A theme's
 * favicon replaces `icon` in the root layout (the brand cookie's) and the layouts below
 * (`lib/server/theme.ts`): the favicon follows the page, the app icon is the deployment's.
 */
export function platformIconsMetadata(
  meta: PlatformMeta | null,
  theme: ThemeRef | null,
): PlatformIcons {
  const { favicon } = iconsOf(meta);
  const { any } = appIconsOf(meta, theme);
  return {
    icon: [{ url: favicon ?? DEFAULT_PLATFORM_ICONS.favicon, type: "image/svg+xml" }],
    apple: [{ url: any, sizes: "512x512", type: "image/png" }],
  };
}

/** The colour of the browser chrome for `scheme` under a theme's backgrounds (null: built-in). */
export function themeColorOf(
  scheme: ThemeScheme,
  background: Partial<Record<ThemeScheme, string>> | null,
): string {
  const defined = Object.values(background ?? {});
  return (
    background?.[scheme] ??
    (defined.length === 1 ? defined[0] : undefined) ??
    PAGE_BACKGROUND[scheme]
  );
}

/**
 * The viewport (mobile layout spec §7.1, §7.5): edge to edge (`viewport-fit=cover`, the design
 * pads by the safe areas through `--cb-inset-*`), Chromium on Android shrinks the layout viewport
 * for the keyboard (`resizes-content`; iOS ignores it and keeps the AppShell's visualViewport
 * path). Pinch zoom stays: no `maximum-scale`, no `user-scalable`. The browser chrome takes one
 * colour (theme brand coverage spec §6, decision 9): the page colour of the scheme the page renders
 * (`scheme`, the `cb-theme` cookie's) under `ref` (a theme with one scheme: that scheme's), else the
 * built-in page background; `useThemeColorMeta` keeps it current after a toggle.
 */
export function rootViewport(scheme: ThemeScheme, ref: BrandRef | null): Viewport {
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    interactiveWidget: "resizes-content",
    themeColor: themeColorOf(scheme, ref?.background ?? null),
  };
}
