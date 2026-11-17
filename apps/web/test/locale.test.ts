import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { localeCookie, negotiateLocale } from "../src/i18n/routing";
import proxy from "../src/proxy";

describe("negotiateLocale (Accept-Language)", () => {
  it("picks the best supported language by q-value, then order; regions match their language", () => {
    expect(negotiateLocale("en-US,en;q=0.9,zh;q=0.8")).toBe("en");
    expect(negotiateLocale("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh");
    expect(negotiateLocale("fr;q=1, en;q=0.5, zh;q=0.7")).toBe("zh");
    expect(negotiateLocale("de, fr")).toBeUndefined();
    expect(negotiateLocale("en;q=0, zh;q=0")).toBeUndefined();
    expect(negotiateLocale("")).toBeUndefined();
    expect(negotiateLocale(null)).toBeUndefined();
  });

  it("the cookie a language choice writes lasts a year on every path", () => {
    expect(localeCookie("en")).toBe("NEXT_LOCALE=en; path=/; max-age=31536000; samesite=lax");
  });
});

describe("proxy: language prefix", () => {
  it("is not redirected (no compatibility for old /zh/… links)", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/en/agents/new?agent=a1"));
    expect(res.status).not.toBe(308);
  });
});
