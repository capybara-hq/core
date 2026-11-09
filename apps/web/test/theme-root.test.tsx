// Themes spec §8, §10: the layouts' ThemeRoot links the resolved theme's stylesheet, gives its brand
// to the design context and hides the account row's scheme toggle under a single-scheme theme.

import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import type { ThemeRef } from "../src/lib/themes";
import { resetNavigation } from "./support/navigation";
import { ME } from "./support/render";
import { renderFrame, shellOf } from "./support/shell";
import { themeCssUrl } from "./support/themes";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const { themeIcons } = await import("../src/lib/server/theme");
const { ThemeLink } = await import("../src/components/theme-link");

const NIGHT_CITY: ThemeRef = {
  id: "t-night",
  key: "neon/night-city",
  version: "1.0.0",
  name: { en: "Night City", zh: "夜之城" },
  schemes: ["dark"],
  singleScheme: "dark",
  logo: {
    markUrl: "/api/v1/themes/t-night/1.0.0/assets/logo.svg",
    wordmark: "NIGHT CITY",
    faviconUrl: null,
  },
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

  it("a two-scheme theme: its stylesheet in the theme precedence, the scheme toggle stays", () => {
    renderFrame(shellOf(ME, { theme: PAPER }));
    expect(themeLinks()).toEqual([PAPER.cssUrl]);
    expect(within(brandRow()).getByText("CAPYBARA")).toBeTruthy();
    expect(schemeToggle()).not.toBeNull();
  });

  it("a single-scheme theme with a logo: its brand in the sidebar, no scheme toggle", () => {
    renderFrame(shellOf(ME, { theme: NIGHT_CITY }));
    expect(themeLinks()).toEqual([NIGHT_CITY.cssUrl]);
    expect(within(brandRow()).getByText("NIGHT CITY")).toBeTruthy();
    expect(within(brandRow()).queryByText("CAPYBARA")).toBeNull();
    const mark = brandRow().querySelector('[data-part="logo-mark"]');
    expect(mark?.getAttribute("src")).toBe(NIGHT_CITY.logo?.markUrl);
    expect(schemeToggle()).toBeNull();
  });

  it("a settings change that updates the themes read swaps the stylesheet and the brand", () => {
    const next = {
      ...PAPER,
      version: "2.1.0",
      cssUrl: themeCssUrl("t-paper", "2.1.0"),
    };
    const view = renderFrame(shellOf(ME, { theme: NIGHT_CITY }));
    view.update(shellOf(ME, { theme: next }));
    expect(themeLinks()).toEqual([next.cssUrl]);
    expect(within(brandRow()).queryByText("NIGHT CITY")).toBeNull();
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
    const a = at(NIGHT_CITY, "4.0.0");
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
    renderFrame(shellOf(NO_ORG, { theme: NIGHT_CITY }));
    expect(screen.getAllByText("NIGHT CITY").length).toBeGreaterThan(0);
    expect(chooserToggle()).toBeNull();
  });
});

describe("themeIcons", () => {
  it("a theme's favicon is the page icon; none leaves the app's icon", () => {
    const favicon = "/api/v1/themes/t-night/1.0.0/assets/favicon.png";
    const logo = { markUrl: null, wordmark: null, faviconUrl: favicon };
    expect(themeIcons({ ...NIGHT_CITY, logo })).toEqual({ icons: { icon: favicon } });
    expect(themeIcons(NIGHT_CITY)).toEqual({});
    expect(themeIcons(null)).toEqual({});
  });
});
