import type { Metadata, MetadataRoute } from "next";
// The design tokens' source of truth (`pnpm gen:tokens` renders the CSS from it): the manifest's
// colors cannot read a CSS variable, and apps/web writes no color literal. Kept out of
// `platform-icons.ts`, which the settings page loads in the browser.
import tokens from "../../../../docs/design/tokens.json";
import type { PlatformMeta } from "./app-auth";
import { DEFAULT_PLATFORM_ICONS, DEFAULT_PLATFORM_NAME } from "./platform-icons";

/** The PWA's theme and background color: the built-in theme's dark page background. */
const MANIFEST_COLOR = tokens.color.bg.dark;

/**
 * The web app manifest (mobile layout spec §10.2): the deployment's name ("Capybara" unset), its
 * app icon (`any`) and maskable icon by their versioned URLs, else the web's default for each; an
 * uploaded app icon without a maskable one is listed alone. `meta` null (the kernel could not be
 * read): the defaults.
 */
export function webManifest(meta: PlatformMeta | null): MetadataRoute.Manifest {
  const name = meta?.name ?? DEFAULT_PLATFORM_NAME;
  const app = meta?.icons.app ?? null;
  const maskable = meta?.icons.maskable ?? null;
  const png = { sizes: "512x512", type: "image/png" } as const;
  const icons: MetadataRoute.Manifest["icons"] = [
    { src: app ?? DEFAULT_PLATFORM_ICONS.app, ...png, purpose: "any" },
  ];
  if (maskable !== null || app === null) {
    icons.push({ src: maskable ?? DEFAULT_PLATFORM_ICONS.maskable, ...png, purpose: "maskable" });
  }
  return {
    name,
    short_name: name,
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: MANIFEST_COLOR,
    background_color: MANIFEST_COLOR,
    icons,
  };
}

/**
 * The page icons (mobile layout spec §10.2.1): the platform favicon (else the web's `icon.svg`) and
 * the app icon as the `apple-touch-icon` (iOS scales the 512; else the web's 512 PNG). A theme's
 * favicon replaces `icon` in the layouts below (`lib/server/theme.ts`).
 */
export function platformIconsMetadata(meta: PlatformMeta | null): NonNullable<Metadata["icons"]> {
  return {
    icon: [{ url: meta?.icons.favicon ?? DEFAULT_PLATFORM_ICONS.favicon, type: "image/svg+xml" }],
    apple: [
      { url: meta?.icons.app ?? DEFAULT_PLATFORM_ICONS.app, sizes: "512x512", type: "image/png" },
    ],
  };
}
