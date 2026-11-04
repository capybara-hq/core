import { describe, expect, it } from "vitest";
import {
  EXTENSION_POINTS,
  isPublicHostname,
  WEB_FETCH_EXTENSION_POINT,
  WEB_SEARCH_EXTENSION_POINT,
  WebProviderError,
} from "../src/index.js";

describe("isPublicHostname", () => {
  it.each(["example.com", "8.8.8.8", "[2606:4700::1111]", "sub.example.co.uk"])("accepts %s", (h) =>
    expect(isPublicHostname(h)).toBe(true),
  );
  it.each([
    "localhost",
    "intranet",
    "a.localhost",
    "printer.local",
    "svc.internal",
    "10.0.0.1",
    "172.16.5.4",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "192.0.2.1",
    "240.0.0.1",
    "[::1]",
    "[::]",
    "[fe80::1]",
    "[fc00::1]",
    "[ff02::1]",
    "[2001:db8::1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
    "",
  ])("rejects %s", (h) => expect(isPublicHostname(h)).toBe(false));
});

describe("WebProviderError", () => {
  it("carries its kind", () => {
    const e = new WebProviderError("x", { kind: "auth" });
    expect(e.kind).toBe("auth");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("extension point refs", () => {
  it("names the refs", () => {
    expect(WEB_SEARCH_EXTENSION_POINT).toBe("web-search@1");
    expect(WEB_FETCH_EXTENSION_POINT).toBe("web-fetch@1");
  });
  it("registers both with org-default selection, and no other point has selection", () => {
    const want = {
      cardinality: "multi",
      brokered: true,
      orgScoped: true,
      selection: "org-default",
    };
    expect(EXTENSION_POINTS["web-search"]).toEqual(want);
    expect(EXTENSION_POINTS["web-fetch"]).toEqual(want);
    for (const [k, v] of Object.entries(EXTENSION_POINTS)) {
      if (k !== "web-search" && k !== "web-fetch") expect(v.selection).toBeUndefined();
    }
  });
});
