// Themes spec §8, §10: the layouts' ThemeRoot links the resolved theme's stylesheet, gives its brand
// to the design context and hides the account row's scheme toggle under a single-scheme theme.

import { AuthPage } from "@capybara-hq/design";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import type { ThemeRef } from "../src/lib/themes";
import { resetNavigation } from "./support/navigation";
import { ME, renderPage, testQueryClient } from "./support/render";
import { renderFrame, shellOf } from "./support/shell";
import { themeCssUrl } from "./support/themes";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const { themeIcons } = await import("../src/lib/server/theme");
const { ThemeLink } = await import("../src/components/theme-link");
const { brandOf, ThemeRoot } = await import("../src/components/theme-root");
const { platformThemeQuery } = await import("../src/lib/query/themes");
const {
  BRAND_COOKIE_HTTP,
  BRAND_COOKIE_HTTPS,
  BRAND_COOKIE_MAX_AGE,
  brandRefOf,
  decodeBrandCookie,
} = await import("../src/lib/brand-cookie");

const NEON_GRID: ThemeRef = {
  id: "t-night",
  key: "neon/neon-grid",
  version: "1.0.0",
  name: { en: "Neon Grid", zh: "霓虹网格" },
  schemes: ["dark"],
  singleScheme: "dark",
  logo: {
    markUrl: "/api/v1/themes/t-night/1.0.0/assets/logo.svg",
    wordmark: "NEON GRID",
    faviconUrl: null,
    illustrationUrl: "/api/v1/themes/t-night/1.0.0/assets/art.svg",
    appIconUrl: null,
    appIconMaskableUrl: null,
  },
  decoration: "none",
  background: { dark: "#05070d" },
  cssUrl: themeCssUrl("t-night", "1.0.0"),
};
const PAPER: ThemeRef = {
  id: "t-paper",
  key: "paper/paper",
  version: "2.0.0",
  name: { en: "Paper" },
  schemes: ["dark", "light"],
  singleScheme: null,
  logo: null,
  decoration: "dither",
  background: { dark: "#101010", light: "#fafafa" },
  cssUrl: themeCssUrl("t-paper", "2.0.0"),
};

const sidebar = () => screen.getByRole("complementary");
const brandRow = () =>
  within(sidebar()).getByText((_, e) => e?.getAttribute("data-part") === "brand-row");
const schemeToggle = () => within(sidebar()).queryByRole("radiogroup", { name: zh.common.theme });
/**
 * The enabled theme stylesheets in `<head>` (`precedence="theme"`). React keeps a hoisted
 * stylesheet for the document's life (a superseded one too), so the cases assert the exact set of
 * enabled links: ThemeRoot disables every theme link but the current one.
 */
const themeLinks = () =>
  [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][data-precedence="theme"]')]
    .filter((l) => !l.disabled)
    .map((l) => l.getAttribute("href"));
/** A theme at its own version (a case-unique stylesheet: earlier cases' links stay in `<head>`). */
const at = (theme: ThemeRef, version: string): ThemeRef => ({
  ...theme,
  version,
  cssUrl: themeCssUrl(theme.id, version),
});
const linksTo = (href: string) =>
  document.querySelectorAll(`link[rel="stylesheet"][href="${href}"]`).length;

beforeEach(() => resetNavigation("/agents"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("brandOf (theme brand coverage §3)", () => {
  it("the brand carries the illustration and the decoration", () => {
    expect(brandOf(NEON_GRID, "Acme")).toEqual({
      markUrl: NEON_GRID.logo?.markUrl,
      wordmark: "NEON GRID",
      illustrationUrl: NEON_GRID.logo?.illustrationUrl,
      decoration: "none",
      productName: "Acme",
    });
  });

  it("the built-in theme, or a theme that replaces nothing, gives a null brand", () => {
    expect(brandOf(null, "Acme")).toBeNull();
    expect(brandOf(PAPER, "Acme")).toBeNull();
  });

  it("a theme that only turns the decoration off is a brand", () => {
    expect(brandOf({ ...PAPER, decoration: "none" }, null)).toMatchObject({
      markUrl: null,
      decoration: "none",
    });
  });

  it("decoration none reaches AuthPage under the platform theme", () => {
    const client = testQueryClient();
    client.setQueryData(platformThemeQuery().queryKey, NEON_GRID);
    renderPage(
      <ThemeRoot orgId={null}>
        <AuthPage title="Sign in">
          <p>form</p>
        </AuthPage>
      </ThemeRoot>,
      { client },
    );
    expect(document.querySelector('[data-template="AuthPage"]')).not.toBeNull();
    expect(document.querySelector(".cb-dither")).toBeNull();
  });

  it("a theme that keeps the decoration draws both dither columns", () => {
    const client = testQueryClient();
    client.setQueryData(platformThemeQuery().queryKey, PAPER);
    renderPage(
      <ThemeRoot orgId={null}>
        <AuthPage title="Sign in">
          <p>form</p>
        </AuthPage>
      </ThemeRoot>,
      { client },
    );
    expect(document.querySelectorAll(".cb-dither")).toHaveLength(2);
  });
});

describe("ThemeLink", () => {
  it("links nothing for the built-in theme", () => {
    expect(ThemeLink({ theme: null })).toBeNull();
  });
});

describe("ThemeRoot in the workspace frame", () => {
  it("the built-in theme: the pixel capybara and the scheme toggle", () => {
    renderFrame(shellOf(ME));
    expect(within(brandRow()).getByText("CAPYBARA")).toBeTruthy();
    expect(brandRow().querySelector('[data-part="logo-mark"]')).toBeNull();
    expect(schemeToggle()).not.toBeNull();
  });

  it("a deployment named by platform.name keeps the built-in CAPYBARA wordmark; the theme mark's alt is the name", () => {
    renderFrame(shellOf(ME), undefined, { productName: "Acme Agents" });
    expect(within(brandRow()).getByText("CAPYBARA")).toBeTruthy();
    expect(within(brandRow()).queryByText("Acme Agents")).toBeNull();
    cleanup();
    renderFrame(shellOf(ME, { theme: NEON_GRID }), undefined, { productName: "Acme Agents" });
    expect(within(brandRow()).getByText("NEON GRID")).toBeTruthy();
    const mark = brandRow().querySelector('[data-part="logo-mark"]');
    expect(mark?.getAttribute("alt")).toBe("Acme Agents");
  });

  it("a two-scheme theme: its stylesheet in the theme precedence, the scheme toggle stays", () => {
    renderFrame(shellOf(ME, { theme: PAPER }));
    expect(themeLinks()).toEqual([PAPER.cssUrl]);
    expect(within(brandRow()).getByText("CAPYBARA")).toBeTruthy();
    expect(schemeToggle()).not.toBeNull();
  });

  it("a single-scheme theme with a logo: its brand in the sidebar, no scheme toggle", () => {
    renderFrame(shellOf(ME, { theme: NEON_GRID }));
    expect(themeLinks()).toEqual([NEON_GRID.cssUrl]);
    expect(within(brandRow()).getByText("NEON GRID")).toBeTruthy();
    expect(within(brandRow()).queryByText("CAPYBARA")).toBeNull();
    const mark = brandRow().querySelector('[data-part="logo-mark"]');
    expect(mark?.getAttribute("src")).toBe(NEON_GRID.logo?.markUrl);
    expect(schemeToggle()).toBeNull();
  });

  it("a settings change that updates the themes read swaps the stylesheet and the brand", () => {
    const next = {
      ...PAPER,
      version: "2.1.0",
      cssUrl: themeCssUrl("t-paper", "2.1.0"),
    };
    const view = renderFrame(shellOf(ME, { theme: NEON_GRID }));
    view.update(shellOf(ME, { theme: next }));
    expect(themeLinks()).toEqual([next.cssUrl]);
    expect(within(brandRow()).queryByText("NEON GRID")).toBeNull();
    expect(within(brandRow()).getByText("CAPYBARA")).toBeTruthy();
    expect(schemeToggle()).not.toBeNull();
  });
});

describe("switching themes leaves only the current stylesheet enabled", () => {
  it("a theme, then the built-in theme: no theme stylesheet stays enabled", () => {
    const paper = at(PAPER, "3.0.0");
    const view = renderFrame(shellOf(ME, { theme: paper }));
    expect(themeLinks()).toEqual([paper.cssUrl]);
    view.update(shellOf(ME, { theme: null }));
    expect(themeLinks()).toEqual([]);
    // React keeps the node; it is disabled, not removed
    expect(linksTo(paper.cssUrl)).toBe(1);
  });

  it("A, then B, then A: only the current theme's stylesheet is enabled each time", () => {
    const a = at(NEON_GRID, "4.0.0");
    const b = at(PAPER, "4.0.0");
    const view = renderFrame(shellOf(ME, { theme: a }));
    expect(themeLinks()).toEqual([a.cssUrl]);
    view.update(shellOf(ME, { theme: b }));
    expect(themeLinks()).toEqual([b.cssUrl]);
    // React reuses A's node (it sits before B's, so only disabling B lets A win)
    view.update(shellOf(ME, { theme: a }));
    expect(themeLinks()).toEqual([a.cssUrl]);
    expect([linksTo(a.cssUrl), linksTo(b.cssUrl)]).toEqual([1, 1]);
  });
});

describe("the scheme toggle under a single-scheme theme (usePreferences)", () => {
  const NO_ORG = { ...ME, currentOrgId: null };
  const chooserToggle = () => screen.queryByRole("radiogroup", { name: zh.common.theme });

  it("the org chooser (no org: the platform theme) keeps the toggle under a two-scheme theme", () => {
    renderFrame(shellOf(NO_ORG, { theme: PAPER }));
    expect(screen.getByRole("main")).toBeTruthy();
    expect(chooserToggle()).not.toBeNull();
  });

  it("the org chooser has no toggle under a single-scheme platform theme", () => {
    renderFrame(shellOf(NO_ORG, { theme: NEON_GRID }));
    expect(screen.getAllByText("NEON GRID").length).toBeGreaterThan(0);
    expect(chooserToggle()).toBeNull();
  });
});

describe("themeIcons", () => {
  const favicon = "/api/v1/themes/t-night/1.0.0/assets/favicon.png";
  const logo = {
    markUrl: null,
    wordmark: null,
    faviconUrl: favicon,
    illustrationUrl: null,
    appIconUrl: null,
    appIconMaskableUrl: null,
  };
  const base = {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon-512.png", sizes: "512x512", type: "image/png" }],
  };

  it("a theme's favicon replaces the base icon and keeps its apple-touch-icon", () => {
    expect(themeIcons({ ...NEON_GRID, logo }, base)).toEqual({
      icons: { icon: favicon, apple: base.apple },
    });
  });

  it("a route-group layout always sets icon: without a theme favicon, the platform's", () => {
    // a stale cookie favicon in the root layout's icons never survives a themed document
    expect(themeIcons(NEON_GRID, base)).toEqual({ icons: base });
    expect(themeIcons(null, base)).toEqual({ icons: base });
  });
});

describe("the brand cookie (theme brand coverage §5)", () => {
  const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const BRANDED: ThemeRef = {
    ...NEON_GRID,
    id: UUID,
    version: "7",
    logo: {
      markUrl: `/api/v1/themes/${UUID}/7/assets/logo.svg`,
      wordmark: "NEON GRID",
      faviconUrl: null,
      illustrationUrl: null,
      appIconUrl: null,
      appIconMaskableUrl: null,
    },
    background: { dark: "#05070D" },
    cssUrl: themeCssUrl(UUID, "7"),
  };
  /** Every `document.cookie` write of the brand cookie. */
  let writes: string[];
  beforeEach(() => {
    writes = [];
    const proto = Document.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "cookie");
    vi.spyOn(document, "cookie", "set").mockImplementation((v: string) => {
      if (v.startsWith(`${BRAND_COOKIE_HTTP}=`)) writes.push(v);
      desc?.set?.call(document, v);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("ThemeRoot writes cb-brand for a theme and deletes it for the built-in theme", () => {
    const view = renderFrame(shellOf(ME, { theme: BRANDED }));
    expect(writes).toHaveLength(1);
    const value = writes[0]?.split(";")[0]?.slice(BRAND_COOKIE_HTTP.length + 1);
    expect(decodeBrandCookie(value)).toEqual(brandRefOf(BRANDED));
    expect(writes[0]).toContain(`Max-Age=${BRAND_COOKIE_MAX_AGE}`);
    view.update(shellOf(ME, { theme: null }));
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatch(/^cb-brand=; Max-Age=0/);
  });

  it("the cookie is rewritten only when the drawn theme changes", () => {
    const view = renderFrame(shellOf(ME, { theme: BRANDED }));
    // the same theme again (a refetch with an equal answer, another commit)
    view.update(shellOf(ME, { theme: { ...BRANDED } }));
    expect(writes).toHaveLength(1);
    const next = { ...BRANDED, version: "8", cssUrl: themeCssUrl(UUID, "8") };
    view.update(shellOf(ME, { theme: next }));
    expect(writes).toHaveLength(2);
  });

  it("a theme the cookie cannot hold (outside the delivery grammar) deletes it", () => {
    renderFrame(shellOf(ME, { theme: NEON_GRID }));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^cb-brand=; Max-Age=0/);
  });

  it("nothing is written while the theme read has no answer", () => {
    renderPage(
      <ThemeRoot orgId={null}>
        <p>page</p>
      </ThemeRoot>,
      { client: testQueryClient() },
    );
    expect(writes).toEqual([]);
  });

  it("over https ThemeRoot writes __Host-cb-brand (Secure) and deletes a plain cb-brand", () => {
    const all: string[] = [];
    vi.spyOn(document, "cookie", "set").mockImplementation((v: string) => {
      all.push(v);
    });
    const real = window.location;
    vi.stubGlobal(
      "location",
      new Proxy(real, { get: (t, k) => (k === "protocol" ? "https:" : Reflect.get(t, k)) }),
    );
    try {
      renderFrame(shellOf(ME, { theme: BRANDED }));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(all).toHaveLength(2);
    const value = all[0]?.split(";")[0]?.slice(`${BRAND_COOKIE_HTTPS}=`.length);
    expect(all[0]?.startsWith(`${BRAND_COOKIE_HTTPS}=`)).toBe(true);
    expect(decodeBrandCookie(value)).toEqual(brandRefOf(BRANDED));
    expect(all[0]).toMatch(/; Path=\/; SameSite=Lax; Secure$/);
    expect(all[1]).toMatch(/^cb-brand=; Max-Age=0; Path=\//);
  });
});
