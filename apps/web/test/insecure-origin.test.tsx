import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { InsecureOriginNotice } from "../src/components/login-form";
import { secureCookiesBlocked } from "../src/lib/secure-origin";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const at = (url: string, isSecureContext?: boolean) => {
  const u = new URL(url);
  return {
    ...(isSecureContext !== undefined && { isSecureContext }),
    location: { protocol: u.protocol, hostname: u.hostname },
  };
};

describe("secureCookiesBlocked", () => {
  it("follows isSecureContext when the browser reports it", () => {
    expect(secureCookiesBlocked(at("http://10.0.0.5:3000", false))).toBe(true);
    expect(secureCookiesBlocked(at("http://10.0.0.5:3000", true))).toBe(false);
  });

  it.each([
    ["http://192.168.1.10:3000", true],
    ["http://capybara.lan", true],
    ["https://capybara.example.com", false],
    ["http://localhost:3000", false],
    ["http://127.0.0.1:3000", false],
    ["http://[::1]:3000", false],
    ["http://app.localhost:3000", false],
  ])("without isSecureContext: %s -> %s", (url, blocked) => {
    expect(secureCookiesBlocked(at(url))).toBe(blocked);
  });
});

describe("InsecureOriginNotice", () => {
  const renderNotice = (locale: "zh" | "en") =>
    render(
      <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
        <InsecureOriginNotice />
      </NextIntlClientProvider>,
    );

  it.each(["zh", "en"] as const)("names the setting on an insecure origin (%s)", async (locale) => {
    vi.stubGlobal("isSecureContext", false);
    renderNotice(locale);
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("CAPYBARA_AUTH__COOKIE_SECURE=false");
    expect(status.textContent).toContain(
      (locale === "zh" ? zh : en).login.insecureOrigin.slice(0, 10),
    );
  });

  it("renders nothing in a secure context", () => {
    vi.stubGlobal("isSecureContext", true);
    renderNotice("en");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
