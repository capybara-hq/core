// Theme brand coverage spec §5: the root 404 (a path no layout serves, a layout's notFound()) draws
// the theme of outsideTheme(): the brand cookie, else the platform default, else the built-in.

import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import type { ThemeRef } from "../src/lib/themes";
import { json } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderServer, serverRoutes } from "./support/server";
import { themeCssUrl } from "./support/themes";

const req = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => req.headers }));
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const { default: RootNotFound } = await import("../src/app/not-found");
const { BRAND_COOKIE, brandRefOf, encodeBrandCookie } = await import("../src/lib/brand-cookie");

const theme = (id: string, version: string): ThemeRef => ({
  id,
  key: "acme/acme",
  version,
  name: { en: "Acme" },
  schemes: ["dark"],
  singleScheme: "dark",
  logo: {
    markUrl: `/api/v1/themes/${id}/${version}/assets/logo.svg`,
    wordmark: "ACME",
    faviconUrl: null,
    illustrationUrl: null,
    appIconUrl: null,
    appIconMaskableUrl: null,
  },
  decoration: "dither",
  background: { dark: "#101010" },
  cssUrl: themeCssUrl(id, version),
});
const COOKIE_THEME = theme("11111111-1111-4111-8111-111111111111", "4");
const PLATFORM = theme("22222222-2222-4222-8222-222222222222", "6");
const PLATFORM_THEME = "GET /api/v1/platform/theme";

const enabledThemeLinks = () =>
  [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][data-precedence="theme"]')]
    .filter((l) => !l.disabled)
    .map((l) => l.getAttribute("href"));
const mark = () => document.querySelector('[data-part="logo-mark"]')?.getAttribute("src") ?? null;

beforeEach(() => {
  req.headers = new Headers();
  resetNavigation("/nope");
});
afterEach(cleanup);

describe("the root 404", () => {
  it("the cookie's theme first (no kernel read)", async () => {
    req.headers = new Headers({
      cookie: `${BRAND_COOKIE}=${encodeBrandCookie(brandRefOf(COOKIE_THEME))}`,
    });
    const calls = serverRoutes({});
    renderServer(await RootNotFound());
    expect(calls).toEqual([]);
    expect(enabledThemeLinks()).toEqual([COOKIE_THEME.cssUrl]);
    expect(mark()).toBe(COOKIE_THEME.logo?.markUrl);
  });

  it("else the platform default, and it links home", async () => {
    serverRoutes({ [PLATFORM_THEME]: () => json(200, PLATFORM) });
    renderServer(await RootNotFound());
    expect(enabledThemeLinks()).toEqual([PLATFORM.cssUrl]);
    expect(mark()).toBe(PLATFORM.logo?.markUrl);
    expect(document.querySelector('[data-template="StatusPage"]')?.getAttribute("data-kind")).toBe(
      "404",
    );
    await userEvent.click(screen.getByRole("button", { name: en.notFound.back }));
    expect(router.push).toHaveBeenCalledWith("/");
  });

  it("else the built-in theme (the kernel down)", async () => {
    serverRoutes({ [PLATFORM_THEME]: () => json(503, { error: { code: "x", message: "x" } }) });
    renderServer(await RootNotFound());
    expect(enabledThemeLinks()).toEqual([]);
    expect(mark()).toBeNull();
  });
});
