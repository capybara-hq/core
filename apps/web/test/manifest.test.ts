// Mobile layout spec §10.2: the PWA manifest and the page icons carry the deployment's name and
// platform icon, the web's own Capybara set when none is uploaded.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformMeta } from "../src/lib/app-auth";
import type { ThemeRef } from "../src/lib/themes";
import { themeCssUrl } from "./support/themes";

/** What the mocked `getPlatformMeta` answers (set per test). */
let readMeta: () => Promise<PlatformMeta>;
/** What the platform default theme read answers (set per test). */
let readTheme: () => Promise<ThemeRef | null>;
const req = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => req.headers }));
vi.mock("server-only", () => ({}));
vi.mock("../src/lib/server/register", () => ({}));
// The root layout's metadata: its meta and platform theme reads, and its copy.
vi.mock("../src/lib/server/query", () => ({
  serverQueryClient: () => ({
    fetchQuery: (q: { queryKey: readonly unknown[] }) =>
      JSON.stringify(q.queryKey).includes("platformTheme") ? readTheme() : readMeta(),
  }),
}));
vi.mock("../src/lib/themes", async (actual) => ({
  ...(await actual<typeof import("../src/lib/themes")>()),
  getPlatformTheme: () => readTheme(),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (k: string) =>
    ({ title: "Capybara", description: "Agent platform" })[k] ?? k,
  getLocale: async () => "en",
}));
vi.mock("../src/lib/app-auth", async (actual) => ({
  ...(await actual<typeof import("../src/lib/app-auth")>()),
  getPlatformMeta: () => readMeta(),
}));

const { default: manifest } = await import("../src/app/manifest");
const { generateMetadata } = await import("../src/app/layout");
const { DEFAULT_PLATFORM_ICONS } = await import("../src/lib/platform-icons");
const { platformIconsMetadata, webManifest } = await import("../src/lib/web-manifest");

const tokens = JSON.parse(
  readFileSync(new URL("../../../docs/design/tokens.json", import.meta.url), "utf8"),
) as { color: Record<string, { light: string; dark: string }> };

const APP = `/api/v1/platform/icon/app?v=${"a".repeat(64)}`;
const MASKABLE = `/api/v1/platform/icon/maskable?v=${"b".repeat(64)}`;
const FAVICON = `/api/v1/platform/icon/favicon?v=${"c".repeat(64)}`;

const CUSTOM: PlatformMeta = {
  name: "Example Corp",
  icons: { app: APP, maskable: MASKABLE, favicon: FAVICON },
  appSchemes: [],
};
const DEFAULT: PlatformMeta = {
  name: null,
  icons: { app: null, maskable: null, favicon: null },
  appSchemes: [],
};
/** A meta answer without `icons` (a kernel replica that does not send it yet). */
const NO_ICONS = { name: "X" } as unknown as PlatformMeta;

const TID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const T_ASSET = (f: string) => `/api/v1/themes/${TID}/2/assets/${f}`;
const THEME: ThemeRef = {
  id: TID,
  key: "acme/acme",
  version: "2",
  name: { en: "Acme" },
  schemes: ["dark", "light"],
  singleScheme: null,
  logo: {
    markUrl: null,
    wordmark: null,
    faviconUrl: T_ASSET("favicon.svg"),
    illustrationUrl: null,
    appIconUrl: T_ASSET("app.png"),
    appIconMaskableUrl: T_ASSET("app-maskable.png"),
  },
  decoration: "dither",
  background: { dark: "#0A0B0C", light: "#F0F1F2" },
  cssUrl: themeCssUrl(TID, "2"),
};
const APP_ONLY: ThemeRef = {
  ...THEME,
  logo: { ...(THEME.logo as NonNullable<ThemeRef["logo"]>), appIconMaskableUrl: null },
};

beforeEach(() => {
  readMeta = async () => DEFAULT;
  readTheme = async () => null;
  req.headers = new Headers();
});

describe("manifest()", () => {
  it("names the platform and lists its uploaded app and maskable icons by their versioned URLs", async () => {
    readMeta = async () => CUSTOM;
    const m = await manifest();
    expect(m).toMatchObject({
      name: "Example Corp",
      short_name: "Example Corp",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    expect(m.icons).toEqual([
      { src: APP, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: MASKABLE, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
  });

  it("without a name or icons: Capybara and the web's default set", async () => {
    const m = await manifest();
    expect(m.name).toBe("Capybara");
    expect(m.short_name).toBe("Capybara");
    expect(m.icons).toEqual([
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
  });

  it("an uploaded app icon without a maskable one is listed with purpose any only", () => {
    const m = webManifest(
      { name: null, icons: { app: APP, maskable: null, favicon: null }, appSchemes: [] },
      null,
    );
    expect(m.icons).toEqual([{ src: APP, sizes: "512x512", type: "image/png", purpose: "any" }]);
  });

  it("an unreachable kernel still gives a manifest: the defaults", async () => {
    readMeta = async () => {
      throw new Error("down");
    };
    const m = await manifest();
    expect(m.name).toBe("Capybara");
    expect(m.icons?.map((i) => i.src)).toEqual(["/icon-512.png", "/icon-maskable-512.png"]);
  });

  it("colors are the built-in theme's dark bg token", async () => {
    const m = await manifest();
    expect(m.theme_color).toBe(tokens.color.bg?.dark);
    expect(m.background_color).toBe(tokens.color.bg?.dark);
  });
});

describe("app icons follow the platform default theme (theme brand coverage §6)", () => {
  const png = { sizes: "512x512", type: "image/png" } as const;
  const UPLOADED: PlatformMeta = {
    name: null,
    icons: { app: APP, maskable: MASKABLE, favicon: null },
    appSchemes: [],
  };

  it("manifest icons: upload > theme appIcon > built-in", async () => {
    // the upload wins over the theme
    expect(webManifest(UPLOADED, THEME).icons).toEqual([
      { src: APP, ...png, purpose: "any" },
      { src: MASKABLE, ...png, purpose: "maskable" },
    ]);
    // the theme's pair without an upload
    readTheme = async () => THEME;
    expect((await manifest()).icons).toEqual([
      { src: T_ASSET("app.png"), ...png, purpose: "any" },
      { src: T_ASSET("app-maskable.png"), ...png, purpose: "maskable" },
    ]);
    // neither: the built-in pair
    expect(webManifest(DEFAULT, null).icons).toEqual([
      { src: "/icon-512.png", ...png, purpose: "any" },
      { src: "/icon-maskable-512.png", ...png, purpose: "maskable" },
    ]);
  });

  it("a theme with appIcon only lists any from the theme and no built-in maskable", () => {
    expect(webManifest(DEFAULT, APP_ONLY).icons).toEqual([
      { src: T_ASSET("app.png"), ...png, purpose: "any" },
    ]);
  });

  it("an uploaded maskable icon is listed beside the theme's app icon", () => {
    const meta = {
      name: null,
      icons: { app: null, maskable: MASKABLE, favicon: null },
      appSchemes: [],
    };
    expect(webManifest(meta, APP_ONLY).icons).toEqual([
      { src: T_ASSET("app.png"), ...png, purpose: "any" },
      { src: MASKABLE, ...png, purpose: "maskable" },
    ]);
  });

  it("an uploaded app icon is not paired with the theme's maskable one", () => {
    const meta = { name: null, icons: { app: APP, maskable: null, favicon: null }, appSchemes: [] };
    expect(webManifest(meta, THEME).icons).toEqual([{ src: APP, ...png, purpose: "any" }]);
  });

  it("apple-touch: upload > theme > built-in", () => {
    expect(platformIconsMetadata(UPLOADED, THEME).apple).toEqual([{ url: APP, ...png }]);
    expect(platformIconsMetadata(DEFAULT, THEME).apple).toEqual([
      { url: T_ASSET("app.png"), ...png },
    ]);
    expect(platformIconsMetadata(DEFAULT, null).apple).toEqual([{ url: "/icon-512.png", ...png }]);
  });

  it("favicon order unchanged: the platform theme does not replace the root favicon", () => {
    expect(platformIconsMetadata(CUSTOM, THEME).icon).toEqual([
      { url: FAVICON, type: "image/svg+xml" },
    ]);
    expect(platformIconsMetadata(DEFAULT, THEME).icon).toEqual([
      { url: "/icon.svg", type: "image/svg+xml" },
    ]);
  });

  it("manifest colours: background.dark, else light, else PAGE_BACKGROUND.dark", () => {
    const dark = webManifest(DEFAULT, THEME);
    expect([dark.theme_color, dark.background_color]).toEqual(["#0A0B0C", "#0A0B0C"]);
    const light = webManifest(DEFAULT, { ...THEME, background: { light: "#F0F1F2" } });
    expect(light.theme_color).toBe("#F0F1F2");
    const none = webManifest(DEFAULT, { ...THEME, background: {} });
    expect(none.theme_color).toBe(tokens.color.bg?.dark);
  });

  it("the root metadata reads the platform theme for the apple-touch-icon", async () => {
    readTheme = async () => THEME;
    const md = await generateMetadata();
    // without a brand cookie the platform default is the page's theme: its favicon too
    expect(md.icons).toEqual({
      ...platformIconsMetadata(DEFAULT, THEME),
      icon: T_ASSET("favicon.svg"),
    });
  });

  it("the root metadata's favicon is the brand cookie's, else the platform's", async () => {
    const { BRAND_COOKIE_HTTP, brandRefOf, encodeBrandCookie } = await import(
      "../src/lib/brand-cookie"
    );
    req.headers = new Headers({
      cookie: `${BRAND_COOKIE_HTTP}=${encodeBrandCookie(brandRefOf(THEME))}`,
    });
    readMeta = async () => CUSTOM;
    const md = await generateMetadata();
    expect(md.icons).toEqual({
      ...platformIconsMetadata(CUSTOM, null),
      icon: T_ASSET("favicon.svg"),
    });
  });

  it("a failed theme read keeps the meta's icons", async () => {
    readMeta = async () => CUSTOM;
    readTheme = async () => {
      throw new Error("down");
    };
    expect((await generateMetadata()).icons).toEqual(platformIconsMetadata(CUSTOM, null));
    expect((await manifest()).name).toBe("Example Corp");
  });
});

describe("platformIconsMetadata", () => {
  it("points the favicon and the apple-touch-icon at the platform icons", () => {
    expect(platformIconsMetadata(CUSTOM, null)).toEqual({
      icon: [{ url: FAVICON, type: "image/svg+xml" }],
      apple: [{ url: APP, sizes: "512x512", type: "image/png" }],
    });
  });

  it("falls back to the web's icon.svg and 512 PNG", () => {
    expect(platformIconsMetadata(DEFAULT, null)).toEqual({
      icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
      apple: [{ url: "/icon-512.png", sizes: "512x512", type: "image/png" }],
    });
    expect(platformIconsMetadata(null, null)).toEqual(platformIconsMetadata(DEFAULT, null));
  });

  it("the default PNGs exist in public/ at 512 × 512 (the proxy lets them through by name)", () => {
    for (const path of [DEFAULT_PLATFORM_ICONS.app, DEFAULT_PLATFORM_ICONS.maskable]) {
      const png = readFileSync(new URL(`../public${path}`, import.meta.url));
      expect(png.subarray(1, 4).toString("latin1"), path).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], path).toEqual([512, 512]);
    }
    expect(DEFAULT_PLATFORM_ICONS.favicon).toBe("/icon.svg");
  });
});

describe("a meta answer without icons", () => {
  it("the manifest keeps the name and uses the default icons", async () => {
    readMeta = async () => NO_ICONS;
    const m = await manifest();
    expect(m.name).toBe("X");
    expect(m.icons?.map((i) => i.src)).toEqual(["/icon-512.png", "/icon-maskable-512.png"]);
  });

  it("the root layout's metadata keeps the name and uses the default icons", async () => {
    readMeta = async () => NO_ICONS;
    const md = await generateMetadata();
    expect(md.title).toBe("X");
    expect(md.appleWebApp).toMatchObject({ title: "X" });
    expect(md.icons).toEqual(platformIconsMetadata(DEFAULT, null));
  });
});

describe("the root layout's metadata", () => {
  it("names the platform and points the icons at its uploads", async () => {
    readMeta = async () => CUSTOM;
    const md = await generateMetadata();
    expect(md.title).toBe("Example Corp");
    expect(md.appleWebApp).toEqual({
      capable: true,
      title: "Example Corp",
      statusBarStyle: "black-translucent",
    });
    expect(md.icons).toEqual(platformIconsMetadata(CUSTOM, null));
  });

  it("an unreachable kernel: the Capybara title and the default icons", async () => {
    readMeta = async () => {
      throw new Error("down");
    };
    const md = await generateMetadata();
    expect(md.title).toBe("Capybara");
    expect(md.icons).toEqual(platformIconsMetadata(DEFAULT, null));
  });
});
