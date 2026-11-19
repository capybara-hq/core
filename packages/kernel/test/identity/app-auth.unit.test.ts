import { describe, expect, it } from "vitest";
import { buildRedirect, isAllowedRedirect, s256 } from "../../src/identity/app-auth.js";

/** The pure helpers of native-app sign-in (desktop client spec §6.5): PKCE and the redirect. */

describe("s256", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("isAllowedRedirect", () => {
  const allowed = ["capybara://auth/callback"];

  it("accepts an exact entry", () => {
    expect(isAllowedRedirect("capybara://auth/callback", allowed)).toBe(true);
  });

  it("refuses prefixes, extensions and case variants", () => {
    for (const uri of [
      "capybara://auth/callbac",
      "capybara://auth/callback/x",
      "capybara://auth/callback?x=1",
      "capybara://auth/callback#x",
      "Capybara://auth/callback",
      "capybara://AUTH/callback",
      "capybara://evil",
      "",
    ]) {
      expect(isAllowedRedirect(uri, allowed), uri).toBe(false);
    }
  });

  it("refuses everything when the list is empty", () => {
    expect(isAllowedRedirect("capybara://auth/callback", [])).toBe(false);
  });
});

describe("buildRedirect", () => {
  it("adds encoded parameters with a question mark", () => {
    expect(
      buildRedirect("capybara://auth/callback", {
        code: "cap_ac_x",
        state: "a b&c=d",
        iss: "https://cap.example.com",
      }),
    ).toBe(
      "capybara://auth/callback?code=cap_ac_x&state=a+b%26c%3Dd&iss=https%3A%2F%2Fcap.example.com",
    );
  });

  it("keeps existing query parameters", () => {
    expect(buildRedirect("capybara://auth/callback?profile=1", { state: "s" })).toBe(
      "capybara://auth/callback?profile=1&state=s",
    );
  });

  it("does not double a trailing separator", () => {
    expect(buildRedirect("capybara://auth/callback?", { state: "s" })).toBe(
      "capybara://auth/callback?state=s",
    );
    expect(buildRedirect("capybara://auth/callback?a=1&", { state: "s" })).toBe(
      "capybara://auth/callback?a=1&state=s",
    );
  });
});
