// Theme brand coverage spec §5, §6: the route-group layouts always set the page icon and the
// browser colour from their resolved theme, so the root layout's brand-cookie values (a hint)
// never outlive a themed document's own answer.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeRef } from "../src/lib/themes";
import { themeCssUrl } from "./support/themes";

const req = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => req.headers }));
vi.mock("../src/lib/server/register", () => ({}));
type Routes = Record<string, () => unknown>;
let routes: Routes = {};
vi.mock("../src/lib/server/query", () => ({
  serverQueryClient: () => ({
    fetchQuery: async (q: { queryKey: readonly unknown[] }) => {
      const key = JSON.stringify(q.queryKey);
      const hit = Object.entries(routes).find(([k]) => key.includes(k));
      if (hit === undefined) throw new Error(`unexpected ${key}`);
      return hit[1]();
    },
  }),
}));

const { platformThemeMetadata, platformViewport, workspaceThemeMetadata, workspaceViewport } =
  await import("../src/lib/server/theme");
const { platformIconsMetadata } = await import("../src/lib/web-manifest");

const tokens = JSON.parse(
  readFileSync(new URL("../../../docs/design/tokens.json", import.meta.url), "utf8"),
) as { color: Record<string, { light: string; dark: string }> };

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const FAVICON = `/api/v1/themes/${ID}/1/assets/favicon.svg`;
const THEME: ThemeRef = {
  id: ID,
  key: "acme/acme",
  version: "1",
  name: { en: "Acme" },
  schemes: ["dark", "light"],
  singleScheme: null,
  logo: {
    markUrl: null,
    wordmark: null,
    faviconUrl: FAVICON,
    illustrationUrl: null,
    appIconUrl: null,
    appIconMaskableUrl: null,
  },
  decoration: "dither",
  background: { dark: "#0A0B0C", light: "#F0F1F2" },
  cssUrl: themeCssUrl(ID, "1"),
};
const ME = { memberships: [{ orgId: "o1" }], currentOrgId: "o1" };
const META = { name: null, icons: { app: null, maskable: null, favicon: null }, appSchemes: [] };
const down = () => {
  throw new Error("upstream_unavailable");
};

beforeEach(() => {
  req.headers = new Headers();
  routes = { platformMeta: () => META, platformTheme: () => null };
});

describe("the (app) layout's head", () => {
  it("the theme's favicon; without one, the platform's (always set)", async () => {
    routes = { ...routes, '"me"': () => ME, themes: () => ({ resolved: THEME }) };
    expect((await workspaceThemeMetadata()).icons).toEqual({
      ...platformIconsMetadata(META, null),
      icon: FAVICON,
    });
    routes = { ...routes, themes: () => ({ resolved: null }) };
    expect((await workspaceThemeMetadata()).icons).toEqual(platformIconsMetadata(META, null));
  });

  it("(app) generateViewport uses the resolved theme's background", async () => {
    routes = { ...routes, '"me"': () => ME, themes: () => ({ resolved: THEME }) };
    req.headers = new Headers({ cookie: "cb-theme=light" });
    expect((await workspaceViewport()).themeColor).toBe("#F0F1F2");
    routes = { ...routes, themes: () => ({ resolved: null }) };
    expect((await workspaceViewport()).themeColor).toBe(tokens.color.bg?.light);
  });

  it("an unanswered shell read leaves the root's values (the starting frame draws the cookie)", async () => {
    routes = { ...routes, '"me"': down };
    expect(await workspaceThemeMetadata()).toEqual({});
    expect(await workspaceViewport()).toEqual({});
  });
});

describe("the (auth) layout's head", () => {
  it("the platform default's favicon and colour; the built-in when it has none", async () => {
    routes = { ...routes, platformTheme: () => THEME };
    expect((await platformThemeMetadata()).icons).toMatchObject({ icon: FAVICON });
    expect((await platformViewport()).themeColor).toBe("#0A0B0C");
    routes = { ...routes, platformTheme: () => null };
    expect((await platformThemeMetadata()).icons).toEqual(platformIconsMetadata(META, null));
    expect((await platformViewport()).themeColor).toBe(tokens.color.bg?.dark);
  });

  it("a failed platform theme read: the built-in values the page draws", async () => {
    routes = { platformMeta: down, platformTheme: down };
    expect((await platformThemeMetadata()).icons).toEqual(platformIconsMetadata(null, null));
    expect((await platformViewport()).themeColor).toBe(tokens.color.bg?.dark);
  });
});
