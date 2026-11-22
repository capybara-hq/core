// Theme brand coverage spec §6, decision 9: the browser chrome takes one colour, the page colour of
// the scheme the page renders, from the theme (else the built-in page background).

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrandRef } from "../src/lib/brand-cookie";
import { themeCssUrl } from "./support/themes";

const req = vi.hoisted(() => ({ headers: new Headers() }));
let readTheme: () => Promise<unknown>;
vi.mock("next/headers", () => ({
  headers: async () => req.headers,
  cookies: async () => ({
    get: (name: string) => {
      const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(req.headers.get("cookie") ?? "");
      return m ? { value: m[1] } : undefined;
    },
  }),
}));
vi.mock("server-only", () => ({}));
vi.mock("../src/lib/server/register", () => ({}));
vi.mock("../src/lib/server/query", () => ({
  serverQueryClient: () => ({ fetchQuery: () => readTheme() }),
}));

const { rootViewport } = await import("../src/lib/web-manifest");
const { generateViewport } = await import("../src/app/layout");
const { BRAND_COOKIE, encodeBrandCookie } = await import("../src/lib/brand-cookie");

const tokens = JSON.parse(
  readFileSync(new URL("../../../docs/design/tokens.json", import.meta.url), "utf8"),
) as { color: Record<string, { light: string; dark: string }> };

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const REF: BrandRef = {
  cssUrl: themeCssUrl(ID, "1"),
  markUrl: null,
  wordmark: null,
  illustrationUrl: null,
  faviconUrl: null,
  decoration: "dither",
  background: { dark: "#0A0B0C", light: "#F0F1F2" },
};

beforeEach(() => {
  req.headers = new Headers();
  readTheme = async () => null;
});

describe("rootViewport", () => {
  it("rootViewport writes one colour for the cookie's scheme", () => {
    expect(rootViewport("dark", REF).themeColor).toBe("#0A0B0C");
    expect(rootViewport("light", REF).themeColor).toBe("#F0F1F2");
  });

  it("a single-scheme theme uses its scheme's colour", () => {
    const single = { ...REF, background: { dark: "#0A0B0C" } };
    expect(rootViewport("light", single).themeColor).toBe("#0A0B0C");
  });

  it("the built-in theme: the built-in page background of the scheme", () => {
    expect(rootViewport("dark", null).themeColor).toBe(tokens.color.bg?.dark);
    expect(rootViewport("light", null).themeColor).toBe(tokens.color.bg?.light);
    expect(rootViewport("light", { ...REF, background: {} }).themeColor).toBe(
      tokens.color.bg?.light,
    );
  });

  it("keeps the edge-to-edge viewport (mobile layout spec §7.1)", () => {
    expect(rootViewport("dark", null)).toMatchObject({
      width: "device-width",
      initialScale: 1,
      viewportFit: "cover",
      interactiveWidget: "resizes-content",
    });
  });
});

describe("the root layout's generateViewport", () => {
  it("the cb-theme scheme and the brand cookie's colour", async () => {
    req.headers = new Headers({
      cookie: `cb-theme=light; ${BRAND_COOKIE}=${encodeBrandCookie(REF)}`,
    });
    expect((await generateViewport()).themeColor).toBe("#F0F1F2");
  });

  it("without a cookie, the platform default's colour; the kernel down, the built-in", async () => {
    readTheme = async () => ({ ...REF, id: ID, logo: null, schemes: ["dark"] });
    expect((await generateViewport()).themeColor).toBe("#0A0B0C");
    readTheme = async () => {
      throw new Error("down");
    };
    expect((await generateViewport()).themeColor).toBe(tokens.color.bg?.dark);
  });
});
