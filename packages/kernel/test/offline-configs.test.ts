import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KernelConfigSchema, MARKETPLACE_OFFICIAL_URL_DEFAULT } from "../src/config/schema.js";
import { runConfig, startKernel } from "./helpers/runs.js";

// The official marketplace is on by default (spec §5.5) and lives on the internet. Test kernels must
// never reach it: every config a test builds sets `marketplaces.official.enabled: false`, unless the
// test is about it and points it at a fake.
const URLS = { pg: "postgres://u:p@localhost/db", redis: "redis://localhost:6379" };

describe("runConfig", () => {
  it("keeps the official marketplace off", () => {
    expect(runConfig(URLS).marketplaces.official.enabled).toBe(false);
  });

  it("keeps it off when a test passes other marketplace settings", () => {
    const c = runConfig(URLS, { marketplaces: { allowInsecureLoopback: true } });
    expect(c.marketplaces.official.enabled).toBe(false);
    expect(c.marketplaces.allowInsecureLoopback).toBe(true);
  });

  it("a test about the official marketplace turns it on explicitly", () => {
    const url = "https://example.com/marketplace.json";
    const c = runConfig(URLS, { marketplaces: { official: { enabled: true, url } } });
    expect(c.marketplaces.official).toMatchObject({ enabled: true, url });
  });
});

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "fixtures") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("kernels started by tests", () => {
  it("every file that creates a kernel sets the official marketplace or uses a test config helper", () => {
    const roots = ["packages/kernel/test", "packages/testing/src", "apps/capybara/test"];
    const offenders = roots
      .flatMap((r) => walk(join(REPO, r)))
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        // Creates a kernel itself, or parses its own config and starts it through a helper.
        const starts =
          /\bcreateKernel\(/.test(text) ||
          (/KernelConfigSchema\.parse\(/.test(text) && /\bstart(?:Test)?Kernel\(/.test(text));
        return (
          starts &&
          !/official:\s*\{\s*enabled:/.test(text) &&
          !/\b(?:testKernelConfig|runConfig)\(/.test(text)
        );
      })
      .map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
  });
});

describe("startKernel", () => {
  const raw = {
    db: { url: URLS.pg },
    redis: { url: URLS.redis },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  };

  it("refuses a config that would reach the real official marketplace, before starting anything", async () => {
    const config = KernelConfigSchema.parse(raw);
    expect(config.marketplaces.official).toMatchObject({
      enabled: true,
      url: MARKETPLACE_OFFICIAL_URL_DEFAULT,
    });
    await expect(startKernel(config)).rejects.toThrow(/official marketplace/);
  });
});
