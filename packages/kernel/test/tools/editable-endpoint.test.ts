import { describe, expect, it } from "vitest";
import { destinationChanged } from "../../src/tools/editable-endpoint.js";

describe("destinationChanged", () => {
  it("a change under headers only keeps the destination", () => {
    expect(
      destinationChanged(
        { url: "https://a.example.com", headers: { "X-Tenant": "a" } },
        { url: "https://a.example.com", headers: { "X-Tenant": "b", "X.Dotted": "c" } },
      ),
    ).toBe(false);
  });

  it("any other field moves it: url, a base URL, a field added or removed", () => {
    const base = { url: "https://a.example.com", apiUrl: "https://api.example.com" };
    expect(destinationChanged(base, { ...base, url: "https://b.example.com" })).toBe(true);
    expect(destinationChanged(base, { ...base, apiUrl: "https://evil.example.com" })).toBe(true);
    expect(destinationChanged(base, { url: base.url })).toBe(true);
    expect(destinationChanged(base, { ...base, region: "eu" })).toBe(true);
  });

  it("a record key that contains a dot is compared as a key, not a path", () => {
    expect(
      destinationChanged(
        { hosts: { "api.example.com": "https://a.example.com" } },
        { hosts: { "api.example.com": "https://evil.example.com" } },
      ),
    ).toBe(true);
    expect(destinationChanged({ "base.url": "https://a" }, { "base.url": "https://b" })).toBe(true);
  });

  it("key order alone is no change", () => {
    expect(
      destinationChanged(
        { url: "https://a", nested: { x: 1, y: 2 } },
        { nested: { y: 2, x: 1 }, url: "https://a" },
      ),
    ).toBe(false);
  });
});
