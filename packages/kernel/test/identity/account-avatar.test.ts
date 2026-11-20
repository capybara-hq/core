import { describe, expect, it } from "vitest";
import { accountAvatarUrl, safeSsoUrl } from "../../src/identity/account-avatar.js";

const PREFIX = "/api/v1/accounts/a1/avatar?v=";
const upload = (uploadId: string) => ({ kind: "upload", uploadId }) as const;
const vOf = (url: string | null) => {
  expect(url?.startsWith(PREFIX)).toBe(true);
  return (url as string).slice(PREFIX.length);
};

describe("accountAvatarUrl", () => {
  it("an upload gives the avatar route with a 10-char base64url version", () => {
    const url = accountAvatarUrl({ id: "a1", avatar: upload("u1"), ssoAvatarUrl: null });
    expect(vOf(url)).toMatch(/^[A-Za-z0-9_-]{10}$/);
  });

  it("the same upload id gives the same version, another id another", () => {
    const a = accountAvatarUrl({ id: "a1", avatar: upload("u1"), ssoAvatarUrl: null });
    const b = accountAvatarUrl({ id: "a1", avatar: upload("u1"), ssoAvatarUrl: null });
    const c = accountAvatarUrl({ id: "a1", avatar: upload("u2"), ssoAvatarUrl: null });
    expect(vOf(a)).toBe(vOf(b));
    expect(vOf(c)).not.toBe(vOf(a));
  });

  it("an upload wins over an SSO URL", () => {
    const own = accountAvatarUrl({ id: "a1", avatar: upload("u1"), ssoAvatarUrl: null });
    const both = accountAvatarUrl({
      id: "a1",
      avatar: upload("u1"),
      ssoAvatarUrl: "https://idp/x.png",
    });
    expect(both).toBe(own);
  });

  it("an https SSO URL alone gives a URL whose version differs from an upload's", () => {
    const sso = accountAvatarUrl({ id: "a1", avatar: null, ssoAvatarUrl: "https://idp/x.png" });
    const own = accountAvatarUrl({ id: "a1", avatar: upload("u1"), ssoAvatarUrl: null });
    expect(vOf(sso)).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(vOf(sso)).not.toBe(vOf(own));
  });

  it("an http, javascript, malformed or missing SSO URL gives null", () => {
    for (const ssoAvatarUrl of ["http://idp/x.png", "javascript:alert(1)", "not a url", null]) {
      expect(accountAvatarUrl({ id: "a1", avatar: null, ssoAvatarUrl }), String(ssoAvatarUrl)).toBe(
        null,
      );
    }
  });

  it("no avatar and no SSO URL gives null", () => {
    expect(accountAvatarUrl({ id: "a1", avatar: null, ssoAvatarUrl: null })).toBe(null);
  });
});

describe("safeSsoUrl", () => {
  it("keeps only https URLs", () => {
    expect(safeSsoUrl("https://idp/x.png")).toBe("https://idp/x.png");
    for (const raw of ["http://idp/x.png", "javascript:alert(1)", "not a url", null, 7, {}])
      expect(safeSsoUrl(raw), String(raw)).toBe(null);
  });
});
