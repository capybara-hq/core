import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { insecurePublicUrlWarning } from "../../src/identity/cookies.js";

const cfg = (http: Record<string, unknown>, auth: Record<string, unknown> = {}) =>
  KernelConfigSchema.parse({
    db: { url: "postgres://x@localhost/x" },
    redis: { url: "redis://localhost" },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    http,
    auth,
  });

describe("insecurePublicUrlWarning", () => {
  it("warns for Secure cookies with a plain-http public URL, naming the settings", () => {
    const w = insecurePublicUrlWarning(cfg({ publicUrl: "http://192.168.1.20:3000" }));
    expect(w).toContain("auth.cookieSecure");
    expect(w).toContain("CAPYBARA_AUTH__COOKIE_SECURE=false");
    expect(w).toContain("http.publicUrl");
  });

  it.each([
    ["an https public URL", { publicUrl: "https://capybara.example.com" }, {}],
    ["an unset public URL", {}, {}],
    ["a localhost public URL", { publicUrl: "http://localhost:3000" }, {}],
    [
      "cookies that are not Secure",
      { publicUrl: "http://192.168.1.20:3000" },
      { cookieSecure: false },
    ],
  ])("does not warn for %s", (_n, http, auth) => {
    expect(insecurePublicUrlWarning(cfg(http, auth))).toBeNull();
  });
});
