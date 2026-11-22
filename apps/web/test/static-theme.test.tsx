// Theme brand coverage spec §5: StaticTheme draws a theme from a reference (the brand cookie or the
// platform default) on the pages outside the route-group layouts, without a query.

import { Logo } from "@capybara-hq/design";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BrandRef } from "../src/lib/brand-cookie";
import { renderPage } from "./support/render";
import { themeCssUrl } from "./support/themes";

const { StaticTheme } = await import("../src/components/static-theme");

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const REF: BrandRef = {
  cssUrl: themeCssUrl(UUID, "5"),
  markUrl: `/api/v1/themes/${UUID}/5/assets/logo.svg`,
  wordmark: "ACME",
  illustrationUrl: null,
  faviconUrl: null,
  decoration: "dither",
  background: { dark: "#101010" },
};
const enabledThemeLinks = () =>
  [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][data-precedence="theme"]')]
    .filter((l) => !l.disabled)
    .map((l) => l.getAttribute("href"));

afterEach(cleanup);

describe("StaticTheme", () => {
  it("StaticTheme links the CSS and draws the mark", () => {
    renderPage(
      <StaticTheme brand={REF}>
        <Logo wordmark />
      </StaticTheme>,
    );
    expect(enabledThemeLinks()).toEqual([REF.cssUrl]);
    expect(screen.getByText("ACME")).toBeTruthy();
    const mark = document.querySelector('[data-part="logo-mark"]');
    expect(mark?.getAttribute("src")).toBe(REF.markUrl);
  });

  it("StaticTheme with null renders the built-in brand", () => {
    renderPage(
      <StaticTheme brand={null}>
        <Logo wordmark />
      </StaticTheme>,
    );
    expect(enabledThemeLinks()).toEqual([]);
    expect(screen.getByText("CAPYBARA")).toBeTruthy();
    expect(document.querySelector('[data-part="logo-mark"]')).toBeNull();
  });
});
