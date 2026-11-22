// Theme brand coverage spec §5: the root error pages draw the theme this browser last drew (the
// brand cookie), else the built-in theme.

import { act, cleanup } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAND_COOKIE_HTTP, type BrandRef, encodeBrandCookie } from "../src/lib/brand-cookie";
import { resetNavigation } from "./support/navigation";
import { renderPage } from "./support/render";
import { themeCssUrl } from "./support/themes";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  usePathname: () => "/agents",
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));

const { default: RootError } = await import("../src/app/error");
const { default: GlobalError } = await import("../src/app/global-error");

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const REF: BrandRef = {
  cssUrl: themeCssUrl(UUID, "9"),
  markUrl: `/api/v1/themes/${UUID}/9/assets/logo.svg`,
  wordmark: "ACME",
  illustrationUrl: null,
  faviconUrl: null,
  decoration: "dither",
  background: { dark: "#101010" },
};
const setCookie = (v: string) => {
  // biome-ignore lint/suspicious/noDocumentCookie: the test writes the cookie the page reads
  document.cookie = v;
};
const themeLinks = () =>
  [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][data-precedence="theme"]')]
    .filter((l) => !l.disabled)
    .map((l) => l.getAttribute("href"));

beforeEach(() => resetNavigation("/agents"));
afterEach(() => {
  cleanup();
  setCookie(`${BRAND_COOKIE_HTTP}=; max-age=0; path=/`);
  for (const l of document.querySelectorAll('link[data-precedence="theme"]')) l.remove();
});

describe("app/error.tsx", () => {
  it("the root error page links the cookie's CSS and draws its mark", () => {
    setCookie(`${BRAND_COOKIE_HTTP}=${encodeBrandCookie(REF)}; path=/`);
    renderPage(<RootError error={new Error("x")} reset={() => {}} />);
    expect(themeLinks()).toEqual([REF.cssUrl]);
    expect(document.querySelector('[data-template="StatusPage"]')).not.toBeNull();
    expect(document.querySelector('[data-part="logo-mark"]')?.getAttribute("src")).toBe(
      REF.markUrl,
    );
  });

  it("without a valid cookie, the built-in theme", () => {
    setCookie(`${BRAND_COOKIE_HTTP}=nope; path=/`);
    renderPage(<RootError error={new Error("x")} reset={() => {}} />);
    expect(themeLinks()).toEqual([]);
    expect(document.querySelector('[data-part="logo-mark"]')).toBeNull();
  });
});

describe("app/global-error.tsx", () => {
  it("global-error links the cookie's CSS", async () => {
    // its own version: React remembers a stylesheet it hoisted once per document
    const ref = { ...REF, cssUrl: themeCssUrl(UUID, "10") };
    setCookie(`${BRAND_COOKIE_HTTP}=${encodeBrandCookie(ref)}; path=/`);
    const root = createRoot(document);
    await act(async () => root.render(<GlobalError error={new Error("x")} reset={() => {}} />));
    expect(themeLinks()).toEqual([ref.cssUrl]);
    expect(document.querySelector('[data-part="logo-mark"]')?.getAttribute("src")).toBe(
      REF.markUrl,
    );
    await act(async () => root.unmount());
  });
});
