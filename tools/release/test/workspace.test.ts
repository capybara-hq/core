import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { discoverWorkspace, integrityOf } from "../src/publish.js";
import { planPublish } from "../src/publish-plan.js";

describe("the repository's release set (F2)", () => {
  const plan = planPublish(discoverWorkspace(), new Map());

  it("publishes the SDK, kernel, testing and every official plugin except example-*", () => {
    const names = plan.map((s) => s.name);
    expect(names.slice(0, 3)).toEqual([
      "@capybara-hq/plugin-sdk",
      "@capybara-hq/kernel",
      "@capybara-hq/testing",
    ]);
    expect(names).toContain("@capybara-hq/plugin-model-fake");
    expect(names.filter((n) => n.includes("example"))).toEqual([]);
    expect(names).not.toContain("@capybara-hq/design");
    expect(names).not.toContain("@capybara-hq/capybara");
    expect(names).not.toContain("@capybara-hq/web");
    expect(
      names.filter((n) => !n.startsWith("@capybara-hq/plugin-") || n.endsWith("-sdk")),
    ).toHaveLength(3);
  });

  it("publishes everything under plugins/ as a plugin tgz and nothing else", () => {
    for (const s of plan) expect(s.kind === "plugin-tgz").toBe(s.dir.startsWith("plugins/"));
  });
});

describe("integrityOf", () => {
  it("is the sha512 SRI that catalogs pin", () => {
    const bytes = new TextEncoder().encode("capybara");
    const i = integrityOf(bytes);
    expect(i).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(i).toBe(`sha512-${createHash("sha512").update(bytes).digest("base64")}`);
  });
});
