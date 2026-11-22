import { describe, expect, it } from "vitest";
import { credentialKey } from "../../src/catalog/credential-key.js";
import type { ConnectorAuth } from "../../src/tools/credentials.js";

const google: ConnectorAuth = {
  type: "oauth_code",
  ownership: "personal",
  discovery: "manual",
  authorizationUrl: "https://accounts.example.com/auth",
  tokenUrl: "https://oauth2.example.com/token",
  scopes: ["openid"],
  client: "manual",
};

describe("credentialKey", () => {
  it("a change in authorizationParams alone keeps the credentials (no reset)", () => {
    const before = credentialKey(google);
    expect(
      credentialKey({
        ...google,
        authorizationParams: { access_type: "offline", prompt: "consent" },
      }),
    ).toBe(before);
    expect(credentialKey({ ...google, authorizationParams: { access_type: "online" } })).toBe(
      before,
    );
  });

  it("any other oauth_code change still resets", () => {
    const before = credentialKey({ ...google, authorizationParams: { access_type: "offline" } });
    expect(
      credentialKey({
        ...google,
        scopes: ["openid", "email"],
        authorizationParams: { access_type: "offline" },
      }),
    ).not.toBe(before);
    expect(credentialKey({ ...google, tokenUrl: "https://other.example.com/token" })).not.toBe(
      credentialKey(google),
    );
  });

  it("static presets compare by type and ownership", () => {
    expect(credentialKey({ type: "bearer", ownership: "org" })).toBe(
      credentialKey({ type: "api_key", ownership: "org", in: "header", name: "X-Key" }),
    );
    expect(credentialKey({ type: "headers", ownership: "org", names: ["b", "a"] })).toBe(
      credentialKey({ type: "headers", ownership: "org", names: ["a", "b"] }),
    );
  });
});
