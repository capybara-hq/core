import { describe, expect, it } from "vitest";
import {
  CdnOrigin,
  effectiveExternalSharing,
  HTML_CDN_ALLOWLIST_DEFAULT,
} from "../../src/shares/settings.js";

describe("effectiveExternalSharing", () => {
  it("the platform's deny wins over the org's on", () => {
    expect(effectiveExternalSharing("deny", "on")).toBe("platform_denied");
    expect(effectiveExternalSharing("deny", undefined)).toBe("platform_denied");
  });

  it("an org that never turned it on (absent) or turned it off is off", () => {
    expect(effectiveExternalSharing("allow", undefined)).toBe("org_off");
    expect(effectiveExternalSharing("allow", "off")).toBe("org_off");
  });

  it("allowed only when the platform allows and the org is on", () => {
    expect(effectiveExternalSharing("allow", "on")).toBe("allowed");
  });
});

describe("CdnOrigin", () => {
  it("accepts https origins with an optional port and lower-cases them", () => {
    expect(CdnOrigin.parse("https://cdn.jsdelivr.net")).toBe("https://cdn.jsdelivr.net");
    expect(CdnOrigin.parse("https://example.com:8443")).toBe("https://example.com:8443");
    expect(CdnOrigin.parse("HTTPS://CDN.X.COM")).toBe("https://cdn.x.com");
  });

  it("refuses other schemes, paths, queries, fragments, wildcards and user info", () => {
    for (const bad of [
      "http://a.com",
      "https://a.com/path",
      "https://a.com/",
      "https://*.a.com",
      "https://a.com?x",
      "https://a.com#x",
      "data:",
      "https://user@a.com",
      "https://a.com:0",
      "https://a.com:70000",
      "https://",
      "",
    ]) {
      expect(CdnOrigin.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("the default allowlist is the five public CDNs and every entry is a valid origin", () => {
    expect([...HTML_CDN_ALLOWLIST_DEFAULT]).toEqual([
      "https://cdnjs.cloudflare.com",
      "https://cdn.jsdelivr.net",
      "https://unpkg.com",
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
    ]);
    for (const o of HTML_CDN_ALLOWLIST_DEFAULT) expect(CdnOrigin.parse(o)).toBe(o);
  });
});
