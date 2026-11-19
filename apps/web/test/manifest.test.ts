// Mobile layout spec §10.2: the PWA manifest and the page icons carry the deployment's name and
// platform icon, the web's own Capybara set when none is uploaded.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformMeta } from "../src/lib/app-auth";

/** What the mocked `getPlatformMeta` answers (set per test). */
let readMeta: () => Promise<PlatformMeta>;
vi.mock("../src/lib/server/register", () => ({}));
vi.mock("../src/lib/app-auth", async (actual) => ({
  ...(await actual<typeof import("../src/lib/app-auth")>()),
  getPlatformMeta: () => readMeta(),
}));

const { default: manifest } = await import("../src/app/manifest");
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
};
const DEFAULT: PlatformMeta = { name: null, icons: { app: null, maskable: null, favicon: null } };

beforeEach(() => {
  readMeta = async () => DEFAULT;
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
    const m = webManifest({ name: null, icons: { app: APP, maskable: null, favicon: null } });
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

describe("platformIconsMetadata", () => {
  it("points the favicon and the apple-touch-icon at the platform icons", () => {
    expect(platformIconsMetadata(CUSTOM)).toEqual({
      icon: [{ url: FAVICON, type: "image/svg+xml" }],
      apple: [{ url: APP, sizes: "512x512", type: "image/png" }],
    });
  });

  it("falls back to the web's icon.svg and 512 PNG", () => {
    expect(platformIconsMetadata(DEFAULT)).toEqual({
      icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
      apple: [{ url: "/icon-512.png", sizes: "512x512", type: "image/png" }],
    });
    expect(platformIconsMetadata(null)).toEqual(platformIconsMetadata(DEFAULT));
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
