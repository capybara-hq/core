// Themes spec §8, §10: the layouts' ThemeRoot links the resolved theme's stylesheet, gives its brand
// to the design context and hides the account row's scheme toggle under a single-scheme theme.

import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import type { ThemeRef } from "../src/lib/themes";
import { resetNavigation } from "./support/navigation";
import { ME } from "./support/render";
import { renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const { themeIcons } = await import("../src/lib/server/theme");
const { ThemeLink } = await import("../src/components/theme-link");

const NIGHT_CITY: ThemeRef = {
  id: "t-night",
  version: "1.0.0",
  name: { en: "Night City", zh: "夜之城" },
  schemes: ["dark"],
  singleScheme: "dark",
  logo: {
    markUrl: "/api/v1/themes/t-night/1.0.0/assets/logo.svg",
    wordmark: "NIGHT CITY",
    faviconUrl: null,
  },
  cssUrl: "/api/v1/themes/t-night/1.0.0/theme.css",
};
const PAPER: ThemeRef = {
  id: "t-paper",
  version: "2.0.0",
  name: { en: "Paper" },
  schemes: ["dark", "light"],
  singleScheme: null,
  logo: null,
  cssUrl: "/api/v1/themes/t-paper/2.0.0/theme.css",
};

const sidebar = () => screen.getByRole("complementary");
const brandRow = () =>
  within(sidebar()).getByText((_, e) => e?.getAttribute("data-part") === "brand-row");
const schemeToggle = () => within(sidebar()).queryByRole("radiogroup", { name: zh.common.theme });
/**
 * The theme stylesheets React hoisted into `<head>` (`precedence="theme"`). React keeps a hoisted
 * stylesheet for the document's life, so each case names its own theme version.
 */
const themeLinks = () =>
  [...document.querySelectorAll('link[rel="stylesheet"][data-precedence="theme"]')].map((l) =>
    l.getAttribute("href"),
  );

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
    expect(themeLinks()).toContain(PAPER.cssUrl);
    expect(within(brandRow()).getByText("CAPYBARA")).toBeTruthy();
    expect(schemeToggle()).not.toBeNull();
  });

  it("a single-scheme theme with a logo: its brand in the sidebar, no scheme toggle", () => {
    renderFrame(shellOf(ME, { theme: NIGHT_CITY }));
    expect(themeLinks()).toContain(NIGHT_CITY.cssUrl);
    expect(within(brandRow()).getByText("NIGHT CITY")).toBeTruthy();
    expect(within(brandRow()).queryByText("CAPYBARA")).toBeNull();
    const mark = brandRow().querySelector('[data-part="logo-mark"]');
    expect(mark?.getAttribute("src")).toBe(NIGHT_CITY.logo?.markUrl);
    expect(schemeToggle()).toBeNull();
  });

  it("a settings change that updates the themes read swaps the stylesheet and the brand", () => {
    const next = { ...PAPER, version: "2.1.0", cssUrl: "/api/v1/themes/t-paper/2.1.0/theme.css" };
    const view = renderFrame(shellOf(ME, { theme: NIGHT_CITY }));
    view.update(shellOf(ME, { theme: next }));
    expect(themeLinks()).toContain(next.cssUrl);
    expect(within(brandRow()).queryByText("NIGHT CITY")).toBeNull();
    expect(within(brandRow()).getByText("CAPYBARA")).toBeTruthy();
    expect(schemeToggle()).not.toBeNull();
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
