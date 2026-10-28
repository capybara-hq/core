import { describe, expect, it } from "vitest";
import { testKernelConfig } from "../src/kernel-helpers.js";

// The official marketplace is on by default (spec §5.5). Test kernels must never reach it: every
// config a test builds sets `marketplaces.official.enabled: false` unless the test is about it.
const URLS = { pg: "postgres://u:p@localhost/db", redis: "redis://localhost:6379" };

describe("testKernelConfig", () => {
  it("keeps the official marketplace off", () => {
    expect(testKernelConfig(URLS, { extensions: [] }).marketplaces.official.enabled).toBe(false);
  });

  it("keeps it off when a test passes other marketplace settings", () => {
    const c = testKernelConfig(URLS, {
      extensions: [],
      marketplaces: { allowInsecureLoopback: true, allowedHosts: ["127.0.0.1"] },
    });
    expect(c.marketplaces.official.enabled).toBe(false);
    expect(c.marketplaces.allowInsecureLoopback).toBe(true);
    expect(c.marketplaces.allowedHosts).toEqual(["127.0.0.1"]);
  });

  it("a test about the official marketplace turns it on explicitly", () => {
    const c = testKernelConfig(URLS, {
      extensions: [],
      marketplaces: { official: { enabled: true, url: "https://example.com/marketplace.json" } },
    });
    expect(c.marketplaces.official).toMatchObject({
      enabled: true,
      url: "https://example.com/marketplace.json",
    });
  });
});
