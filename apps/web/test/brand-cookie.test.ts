// Theme brand coverage spec §5: the `cb-brand` cookie holds the theme this browser last drew. It is
// attacker-controllable input rendered on error pages, so the codec takes nothing outside the
// kernel's theme delivery grammar: a single invalid field discards the whole cookie.

import { describe, expect, it } from "vitest";
import {
  BRAND_COOKIE_HTTP,
  BRAND_COOKIE_HTTPS,
  BRAND_COOKIE_MAX_AGE,
  type BrandRef,
  brandCookieHeader,
  brandCookieOf,
  brandRefOf,
  decodeBrandCookie,
  encodeBrandCookie,
  STALE_BRAND_COOKIE_CLEAR,
} from "../src/lib/brand-cookie";
import type { ThemeRef } from "../src/lib/themes";
import { themeCssUrl } from "./support/themes";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const asset = (path: string) => `/api/v1/themes/${ID}/3/assets/${encodeURIComponent(path)}`;

const FULL: BrandRef = {
  cssUrl: themeCssUrl(ID, "3"),
  markUrl: asset("logo/mark.svg"),
  wordmark: "Acme 智能",
  illustrationUrl: asset("logo/art.png"),
  faviconUrl: asset("favicon.svg"),
  decoration: "none",
  background: { dark: "#0B0D10", light: "rgba(250,250,250,0.95)" },
};

/** The cookie value of `raw` as JSON, base64url-encoded as the codec writes it. */
function rawCookie(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** FULL as a cookie with `patch` applied (the encoder would refuse most of these). */
const withField = (patch: Record<string, unknown>) => rawCookie({ v: 1, ...FULL, ...patch });

describe("the brand cookie codec", () => {
  it("round trip of a full ref", () => {
    const raw = encodeBrandCookie(FULL);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeBrandCookie(raw ?? undefined)).toEqual(FULL);
  });

  it("round trip of a minimal ref (only the stylesheet)", () => {
    const min: BrandRef = {
      cssUrl: themeCssUrl(ID, "1"),
      markUrl: null,
      wordmark: null,
      illustrationUrl: null,
      faviconUrl: null,
      decoration: "dither",
      background: {},
    };
    expect(decodeBrandCookie(encodeBrandCookie(min) ?? undefined)).toEqual(min);
  });

  it("the hand-built cookie of the tests reads like the encoder's", () => {
    expect(decodeBrandCookie(withField({}))).toEqual(FULL);
  });

  it("no cookie and an empty cookie read as none", () => {
    expect(decodeBrandCookie(undefined)).toBeNull();
    expect(decodeBrandCookie("")).toBeNull();
  });

  const red: [string, Record<string, unknown>][] = [
    ["an external URL", { markUrl: "https://evil.example/api/v1/themes/x.svg" }],
    ["an external stylesheet", { cssUrl: `https://evil.example${themeCssUrl(ID, "3")}` }],
    ["a protocol-relative URL", { markUrl: `//evil.example${asset("a.svg")}` }],
    ["javascript:", { faviconUrl: "javascript:alert(1)" }],
    ["a data: URL", { illustrationUrl: "data:image/svg+xml,<svg/>" }],
    ["a query string", { markUrl: `${asset("a.svg")}?x=1` }],
    ["a fragment", { markUrl: `${asset("a.svg")}#x` }],
    ["a .. segment", { markUrl: `/api/v1/themes/${ID}/3/assets/..` }],
    ["a .. inside the asset path", { markUrl: `/api/v1/themes/${ID}/3/assets/a%2F..%2Fb.svg` }],
    ["a %2e%2e segment", { markUrl: `/api/v1/themes/${ID}/3/assets/%2e%2e%2Fb.svg` }],
    ["a path traversal before the asset", { markUrl: `/api/v1/themes/${ID}/3/../../admin` }],
    ["a quote in a path", { markUrl: `/api/v1/themes/${ID}/3/assets/a".svg` }],
    ["a parenthesis in a path", { illustrationUrl: `/api/v1/themes/${ID}/3/assets/a).svg` }],
    ["a backslash in a path", { markUrl: `/api/v1/themes/${ID}/3/assets/a\\b.svg` }],
    ["a newline in a path", { markUrl: `/api/v1/themes/${ID}/3/assets/a\nb.svg` }],
    ["a space in a path", { markUrl: `/api/v1/themes/${ID}/3/assets/a b.svg` }],
    ["a CSS URL without r<int>", { cssUrl: `/api/v1/themes/${ID}/3/theme.css` }],
    ["a CSS URL as an asset", { markUrl: themeCssUrl(ID, "3") }],
    ["an asset as the stylesheet", { cssUrl: asset("theme.css") }],
    ["a theme id that is no uuid", { cssUrl: "/api/v1/themes/abc/3/r2/theme.css" }],
    ["a version that is no int", { cssUrl: `/api/v1/themes/${ID}/v3/r2/theme.css` }],
    ["another route", { markUrl: "/api/v1/platform/icon/app" }],
    ["a missing stylesheet", { cssUrl: null }],
    ["a wordmark with a forbidden character", { wordmark: "Acme‮" }],
    ["a wordmark with a newline", { wordmark: "Ac\nme" }],
    ["a blank wordmark", { wordmark: "   " }],
    ["a wordmark over 24 characters", { wordmark: "x".repeat(25) }],
    ["a wordmark that is no string", { wordmark: 42 }],
    ["a colour outside the grammar (red)", { background: { dark: "red" } }],
    ["a colour outside the grammar (#fff)", { background: { light: "#fff" } }],
    ["a colour with a CSS escape", { background: { dark: "#000000;}" } }],
    ["an rgba channel over 255", { background: { dark: "rgba(256,0,0,1)" } }],
    ["an unknown scheme", { background: { dim: "#000000" } }],
    ["background that is no object", { background: "#000000" }],
    ['decoration "stars"', { decoration: "stars" }],
    ["wrong version", { v: 2 }],
    ["an unknown field", { extra: 1 }],
    ["a __proto__ field", JSON.parse('{"__proto__": {"x": 1}}')],
    ["a __proto__ scheme", { background: JSON.parse('{"__proto__": "#000000"}') }],
    ["a constructor field", { constructor: "x" }],
    ["a lower-case %2f", { markUrl: `/api/v1/themes/${ID}/3/assets/a%2fb.svg` }],
    ["a double-encoded %252F", { markUrl: `/api/v1/themes/${ID}/3/assets/a%252Fb.svg` }],
    ["an empty asset part", { markUrl: `/api/v1/themes/${ID}/3/assets/a%2F%2Fb.svg` }],
    ["an upper-case uuid", { cssUrl: themeCssUrl(ID.toUpperCase(), "3") }],
    ["a trailing newline after the URL", { cssUrl: `${themeCssUrl(ID, "3")}\n` }],
    ["a non-canonical rgba", { background: { dark: "rgba(001,0,0,0.5000)" } }],
    ["a lower-case hex", { background: { dark: "#0b0d10" } }],
  ];
  for (const [name, patch] of red) {
    it(`discards the whole cookie: ${name}`, () => {
      expect(decodeBrandCookie(withField(patch))).toBeNull();
    });
  }

  it("discards the whole cookie: a missing field (not null)", () => {
    const { markUrl: _, ...rest } = FULL;
    expect(decodeBrandCookie(rawCookie({ v: 1, ...rest }))).toBeNull();
  });

  it("discards the whole cookie: invalid UTF-8", () => {
    const bad = btoa(`{"v":1,"wordmark":"\xff"}`).replace(/=+$/, "");
    expect(decodeBrandCookie(bad)).toBeNull();
  });

  it("discards the whole cookie: not base64url", () => {
    expect(decodeBrandCookie(`${encodeBrandCookie(FULL)}=`)).toBeNull();
    expect(decodeBrandCookie("!!!")).toBeNull();
    expect(decodeBrandCookie("a+b/c")).toBeNull();
  });

  it("discards the whole cookie: not JSON, or JSON that is no object", () => {
    expect(decodeBrandCookie(rawCookie("x").slice(0, 3))).toBeNull();
    expect(decodeBrandCookie(rawCookie(null))).toBeNull();
    expect(decodeBrandCookie(rawCookie([1, 2]))).toBeNull();
    expect(decodeBrandCookie(rawCookie("string"))).toBeNull();
  });

  it("discards the whole cookie: oversized (> 1 KB)", () => {
    const long = asset(`${"a".repeat(900)}.svg`);
    const raw = withField({ markUrl: long });
    expect(raw.length).toBeGreaterThan(1024);
    expect(decodeBrandCookie(raw)).toBeNull();
    // the encoder writes no cookie it could not read back
    expect(encodeBrandCookie({ ...FULL, markUrl: long })).toBeNull();
  });

  it("the encoder writes no cookie for a ref outside the grammar", () => {
    expect(encodeBrandCookie({ ...FULL, markUrl: "https://evil.example/a.svg" })).toBeNull();
  });
});

describe("brandCookieHeader", () => {
  it("the header has Path=/, SameSite=Lax, max-age, Secure only when asked", () => {
    const plain = brandCookieHeader(FULL, false);
    expect(plain.startsWith(`${BRAND_COOKIE_HTTP}=${encodeBrandCookie(FULL)};`)).toBe(true);
    expect(plain).toContain("Path=/");
    expect(plain).toContain("SameSite=Lax");
    expect(plain).toContain(`Max-Age=${BRAND_COOKIE_MAX_AGE}`);
    expect(plain).not.toContain("Secure");
    expect(brandCookieHeader(FULL, true)).toMatch(/; Secure$/);
    expect(BRAND_COOKIE_MAX_AGE).toBe(2_592_000);
  });

  it("null deletes the cookie (as does a ref the encoder refuses)", () => {
    const del = brandCookieHeader(null, false);
    expect(del.startsWith(`${BRAND_COOKIE_HTTP}=;`)).toBe(true);
    expect(del).toContain("Max-Age=0");
    expect(del).toContain("Path=/");
    expect(brandCookieHeader({ ...FULL, markUrl: "//evil" }, true)).toBe(
      brandCookieHeader(null, true),
    );
  });
});

describe("the cookie name by mode (__Host- over https)", () => {
  const raw = encodeBrandCookie(FULL) ?? "";
  const OTHER: BrandRef = { ...FULL, wordmark: "Planted" };
  const planted = encodeBrandCookie(OTHER) ?? "";

  it("over https the header names __Host-cb-brand: Secure, Path=/, no Domain", () => {
    const set = brandCookieHeader(FULL, true);
    expect(BRAND_COOKIE_HTTPS).toBe("__Host-cb-brand");
    expect(set.startsWith(`__Host-cb-brand=${raw};`)).toBe(true);
    expect(set).toContain("; Path=/;");
    expect(set).toMatch(/; Secure$/);
    expect(set).not.toMatch(/domain=/i);
    expect(brandCookieHeader(null, true).startsWith("__Host-cb-brand=; Max-Age=0;")).toBe(true);
  });

  it("over plain http the header names cb-brand without Secure", () => {
    expect(BRAND_COOKIE_HTTP).toBe("cb-brand");
    expect(brandCookieHeader(FULL, false).startsWith(`cb-brand=${raw};`)).toBe(true);
    expect(brandCookieHeader(FULL, false)).not.toMatch(/Secure|domain=/i);
  });

  it("the stale plain cookie's clear deletes cb-brand at Path=/", () => {
    expect(STALE_BRAND_COOKIE_CLEAR).toMatch(/^cb-brand=; Max-Age=0; Path=\//);
  });

  it("over http only cb-brand is read", () => {
    expect(brandCookieOf(`a=1; cb-brand=${raw}`, false)).toEqual(FULL);
    expect(brandCookieOf(null, false)).toBeNull();
  });

  it("over https only __Host-cb-brand is read: a plain cb-brand is rejected", () => {
    expect(brandCookieOf(`__Host-cb-brand=${raw}`, true)).toEqual(FULL);
    expect(brandCookieOf(`cb-brand=${planted}`, true)).toBeNull();
    expect(brandCookieOf(`cb-brand=${planted}; __Host-cb-brand=${raw}`, true)).toEqual(FULL);
  });

  it("a request carrying __Host-cb-brand came over https: the plain one is ignored", () => {
    // a TLS proxy the web tier cannot see: the browser sends a Secure cookie only over https
    expect(brandCookieOf(`cb-brand=${planted}; __Host-cb-brand=${raw}`, false)).toEqual(FULL);
    // an invalid __Host- cookie still means https: no fallback to the plain one
    expect(brandCookieOf(`cb-brand=${planted}; __Host-cb-brand=nope`, false)).toBeNull();
  });
});

describe("brandRefOf", () => {
  const theme: ThemeRef = {
    id: ID,
    key: "acme/acme",
    version: "3",
    name: { en: "Acme" },
    schemes: ["dark", "light"],
    singleScheme: null,
    logo: {
      markUrl: FULL.markUrl,
      wordmark: FULL.wordmark,
      faviconUrl: FULL.faviconUrl,
      illustrationUrl: FULL.illustrationUrl,
      appIconUrl: asset("icon-512.png"),
      appIconMaskableUrl: null,
    },
    decoration: "none",
    background: FULL.background,
    cssUrl: FULL.cssUrl,
  };

  it("takes what an outside page draws from a theme", () => {
    expect(brandRefOf(theme)).toEqual(FULL);
  });

  it("a theme without a logo has no mark, wordmark, art or favicon", () => {
    expect(brandRefOf({ ...theme, logo: null, decoration: "dither" })).toEqual({
      ...FULL,
      markUrl: null,
      wordmark: null,
      illustrationUrl: null,
      faviconUrl: null,
      decoration: "dither",
    });
  });
});
