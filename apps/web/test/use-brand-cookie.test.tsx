// Theme brand coverage spec §5: the root error pages read the brand cookie in the browser.

import { renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRAND_COOKIE_HTTP,
  BRAND_COOKIE_HTTPS,
  type BrandRef,
  encodeBrandCookie,
} from "../src/lib/brand-cookie";
import { useBrandCookie } from "../src/lib/use-brand-cookie";
import { withPageUrl } from "./support/page";
import { themeCssUrl } from "./support/themes";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const REF: BrandRef = {
  cssUrl: themeCssUrl(ID, "2"),
  markUrl: null,
  wordmark: "Acme",
  illustrationUrl: null,
  faviconUrl: null,
  decoration: "dither",
  background: { dark: "#101010" },
};

const setCookie = (v: string) => {
  // biome-ignore lint/suspicious/noDocumentCookie: the test writes the cookie the page reads
  document.cookie = v;
};

afterEach(() => {
  setCookie(`${BRAND_COOKIE_HTTP}=; max-age=0; path=/`);
  setCookie("other=; max-age=0; path=/");
});

describe("useBrandCookie", () => {
  it("reads the brand cookie among others and keeps the snapshot's identity", () => {
    setCookie("other=1; path=/");
    setCookie(`${BRAND_COOKIE_HTTP}=${encodeBrandCookie(REF)}; path=/`);
    const { result, rerender } = renderHook(() => useBrandCookie());
    const first = result.current;
    expect(first).toEqual(REF);
    rerender();
    expect(result.current).toBe(first);
  });

  it("an invalid or missing cookie is the built-in theme", () => {
    setCookie(`${BRAND_COOKIE_HTTP}=garbage; path=/`);
    expect(renderHook(() => useBrandCookie()).result.current).toBeNull();
    setCookie(`${BRAND_COOKIE_HTTP}=; max-age=0; path=/`);
    expect(renderHook(() => useBrandCookie()).result.current).toBeNull();
  });

  it("over https only __Host-cb-brand is read: a plain cb-brand is rejected", () => {
    let jar = "";
    vi.spyOn(document, "cookie", "get").mockImplementation(() => jar);
    try {
      withPageUrl("https://localhost:3000/", () => {
        jar = `${BRAND_COOKIE_HTTP}=${encodeBrandCookie(REF)}`;
        expect(renderHook(() => useBrandCookie()).result.current).toBeNull();
        jar = `${BRAND_COOKIE_HTTPS}=${encodeBrandCookie(REF)}`;
        expect(renderHook(() => useBrandCookie()).result.current).toEqual(REF);
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("the server snapshot is null", () => {
    setCookie(`${BRAND_COOKIE_HTTP}=${encodeBrandCookie(REF)}; path=/`);
    let seen: BrandRef | null | undefined;
    function Probe() {
      seen = useBrandCookie();
      return null;
    }
    renderToString(<Probe />);
    expect(seen).toBeNull();
  });
});
