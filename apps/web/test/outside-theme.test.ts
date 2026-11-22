// Theme brand coverage spec §5: one rule for every page outside a route-group layout: the brand
// cookie when valid, else the public platform default when the kernel answers, else the built-in
// theme (null).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeRef } from "../src/lib/themes";
import { themeCssUrl } from "./support/themes";

const req = vi.hoisted(() => ({ headers: new Headers() }));
/** What the platform default read answers (set per test). */
let readPlatform: () => Promise<ThemeRef | null>;
const reads: unknown[] = [];

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => req.headers }));
vi.mock("../src/lib/server/register", () => ({}));
vi.mock("../src/lib/server/query", () => ({
  serverQueryClient: () => ({
    fetchQuery: (q: { queryKey: unknown }) => {
      reads.push(q.queryKey);
      return readPlatform();
    },
  }),
}));

const { outsideTheme } = await import("../src/lib/server/outside-theme");
const { BRAND_COOKIE, brandRefOf, encodeBrandCookie } = await import("../src/lib/brand-cookie");
const { keys } = await import("../src/lib/query/keys");

const COOKIE_ID = "11111111-1111-4111-8111-111111111111";
const PLATFORM_ID = "22222222-2222-4222-8222-222222222222";
const PLATFORM: ThemeRef = {
  id: PLATFORM_ID,
  key: "acme/acme",
  version: "1",
  name: { en: "Acme" },
  schemes: ["dark"],
  singleScheme: "dark",
  logo: null,
  decoration: "dither",
  background: { dark: "#101010" },
  cssUrl: themeCssUrl(PLATFORM_ID, "1"),
};
const COOKIE_REF = brandRefOf({ ...PLATFORM, id: COOKIE_ID, cssUrl: themeCssUrl(COOKIE_ID, "4") });

const withCookie = (value: string) => {
  req.headers = new Headers({ cookie: `cb-theme=dark; ${BRAND_COOKIE}=${value}` });
};

beforeEach(() => {
  req.headers = new Headers();
  reads.length = 0;
  readPlatform = async () => PLATFORM;
});

describe("outsideTheme()", () => {
  it("cookie wins over the platform default (no kernel read)", async () => {
    withCookie(encodeBrandCookie(COOKIE_REF) ?? "");
    expect(await outsideTheme()).toEqual(COOKIE_REF);
    expect(reads).toEqual([]);
  });

  it("the platform default when no cookie", async () => {
    expect(await outsideTheme()).toEqual(brandRefOf(PLATFORM));
    expect(reads).toEqual([keys.deployment().platformTheme()]);
  });

  it("null (the built-in theme) when the platform has no default", async () => {
    readPlatform = async () => null;
    expect(await outsideTheme()).toBeNull();
  });

  it("null when the kernel throws", async () => {
    readPlatform = async () => {
      throw new Error("upstream_unavailable");
    };
    expect(await outsideTheme()).toBeNull();
  });

  it("an invalid cookie falls through to the platform default", async () => {
    withCookie("not-a-brand-cookie");
    expect(await outsideTheme()).toEqual(brandRefOf(PLATFORM));
  });
});
