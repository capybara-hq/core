// Theme brand coverage spec §5: the root error pages read the brand cookie in the browser.

import { renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { BRAND_COOKIE, type BrandRef, encodeBrandCookie } from "../src/lib/brand-cookie";
import { useBrandCookie } from "../src/lib/use-brand-cookie";
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
  setCookie(`${BRAND_COOKIE}=; max-age=0; path=/`);
  setCookie("other=; max-age=0; path=/");
});

describe("useBrandCookie", () => {
  it("reads the brand cookie among others and keeps the snapshot's identity", () => {
    setCookie("other=1; path=/");
    setCookie(`${BRAND_COOKIE}=${encodeBrandCookie(REF)}; path=/`);
    const { result, rerender } = renderHook(() => useBrandCookie());
    const first = result.current;
    expect(first).toEqual(REF);
    rerender();
    expect(result.current).toBe(first);
  });

  it("an invalid or missing cookie is the built-in theme", () => {
    setCookie(`${BRAND_COOKIE}=garbage; path=/`);
    expect(renderHook(() => useBrandCookie()).result.current).toBeNull();
    setCookie(`${BRAND_COOKIE}=; max-age=0; path=/`);
    expect(renderHook(() => useBrandCookie()).result.current).toBeNull();
  });

  it("the server snapshot is null", () => {
    setCookie(`${BRAND_COOKIE}=${encodeBrandCookie(REF)}; path=/`);
    let seen: BrandRef | null | undefined;
    function Probe() {
      seen = useBrandCookie();
      return null;
    }
    renderToString(<Probe />);
    expect(seen).toBeNull();
  });
});
