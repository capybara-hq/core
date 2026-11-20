import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootstrapExtraManifest, BootstrapManifest } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrapManifestSha256 } from "../../src/extensions/bootstrap.js";
import {
  loadBootstrapManifest,
  mergeBootstrapManifests,
  readBootstrapExtraManifest,
  syncExtraMarketplaces,
} from "../../src/extensions/bootstrap-extra.js";

const SRI = `sha512-${"A".repeat(86)}==`;
const COMMIT = "a".repeat(40);

const builtin: BootstrapManifest = {
  schemaVersion: 1,
  plugins: [
    {
      name: "core-a",
      source: "npm",
      npm: "@x/core-a",
      version: "1.0.0",
      integrity: SRI,
      required: true,
    },
  ],
};
const npmExtra = (name: string) => ({
  name,
  source: "npm" as const,
  npm: `@x/${name}`,
  version: "1.0.0",
  integrity: SRI,
});
const extra = (over: Partial<BootstrapExtraManifest> = {}): BootstrapExtraManifest => ({
  schemaVersion: 1,
  marketplaces: [],
  plugins: [npmExtra("extra-b")],
  ...over,
});
const gitEntry = {
  name: "git-c",
  source: "git" as const,
  marketplace: "dist",
  commit: COMMIT,
  path: "./plugins/git-c",
  version: "1.0.0",
  integrity: SRI,
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bootstrap-extra-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
const write = async (name: string, json: unknown) => {
  const file = join(dir, name);
  await writeFile(file, JSON.stringify(json));
  return file;
};

describe("mergeBootstrapManifests", () => {
  it("merge keeps built-in entries first then extra", () => {
    const merged = mergeBootstrapManifests(
      builtin,
      extra({
        marketplaces: [{ name: "dist", url: "https://example.com/o/r.git" }],
        plugins: [npmExtra("extra-b"), gitEntry],
        defaultTheme: { plugin: "extra-b", theme: "t" },
      }),
    );
    expect(merged.plugins.map((p) => p.name)).toEqual(["core-a", "extra-b", "git-c"]);
    expect(merged.plugins[1]).toMatchObject({ source: "npm", required: false });
    expect(merged.extra?.marketplaces).toEqual([
      { name: "dist", url: "https://example.com/o/r.git" },
    ]);
    expect(merged.extra?.defaultTheme).toEqual({ plugin: "extra-b", theme: "t" });
  });

  it("merge fails bootstrap.extra_conflict on a shared name", () => {
    expect(() =>
      mergeBootstrapManifests(builtin, extra({ plugins: [npmExtra("core-a")] })),
    ).toThrow(expect.objectContaining({ code: "bootstrap.extra_conflict" }));
  });

  it("no extra manifest gives the built-in manifest and sha unchanged", () => {
    const merged = mergeBootstrapManifests(builtin, undefined);
    expect(merged).toEqual(builtin);
    expect(bootstrapManifestSha256(merged)).toBe(bootstrapManifestSha256(builtin));
  });

  it("an extra manifest changes the sha", () => {
    expect(bootstrapManifestSha256(mergeBootstrapManifests(builtin, extra()))).not.toBe(
      bootstrapManifestSha256(builtin),
    );
  });

  it("a git entry whose marketplace is not git form is bootstrap.extra_invalid naming it", () => {
    const bad = extra({
      marketplaces: [{ name: "dist", url: "https://example.com/marketplace" }],
      plugins: [gitEntry],
    });
    expect(() => mergeBootstrapManifests(builtin, bad)).toThrow(
      expect.objectContaining({
        code: "bootstrap.extra_invalid",
        message: expect.stringContaining("dist"),
      }),
    );
  });
});

describe("readBootstrapExtraManifest / loadBootstrapManifest", () => {
  it("a missing file is bootstrap.extra_invalid naming the path", async () => {
    const file = join(dir, "missing.json");
    await expect(readBootstrapExtraManifest(file)).rejects.toMatchObject({
      code: "bootstrap.extra_invalid",
      message: expect.stringContaining(file),
    });
  });

  it("a parse error lists the problems and names the file", async () => {
    const file = await write("bad.json", { schemaVersion: 2 });
    await expect(readBootstrapExtraManifest(file)).rejects.toMatchObject({
      code: "bootstrap.extra_invalid",
      message: expect.stringContaining(file),
    });
  });

  it("a git entry over an http marketplace url is refused when read", async () => {
    const file = await write("http.json", {
      schemaVersion: 1,
      marketplaces: [{ name: "dist", url: "https://example.com/marketplace" }],
      plugins: [gitEntry],
    });
    await expect(readBootstrapExtraManifest(file)).rejects.toMatchObject({
      code: "bootstrap.extra_invalid",
      message: expect.stringContaining("dist"),
    });
  });

  it("loadBootstrapManifest merges the file; without one it is the built-in manifest", async () => {
    const file = await write("ok.json", extra());
    const merged = await loadBootstrapManifest({ builtin, extraManifest: file });
    expect(merged.plugins.map((p) => p.name)).toEqual(["core-a", "extra-b"]);
    expect(await loadBootstrapManifest({ builtin })).toBe(builtin);
  });
});

describe("git entries", () => {
  it("loadBootstrapManifest keeps them, required defaulting to false", async () => {
    const file = await write("git.json", {
      schemaVersion: 1,
      marketplaces: [{ name: "dist", url: "https://example.com/o/r.git" }],
      plugins: [gitEntry],
    });
    const merged = await loadBootstrapManifest({ builtin, extraManifest: file });
    expect(merged.plugins.at(-1)).toEqual({ ...gitEntry, required: false });
  });
});

describe("syncExtraMarketplaces", () => {
  const log = () => ({ warn: vi.fn() });
  const contention = (code: string) => Object.assign(new Error("boom"), { code });

  it("retries a deadlock once", async () => {
    const sync = vi
      .fn()
      .mockRejectedValueOnce(contention("40P01"))
      .mockResolvedValueOnce(undefined);
    const l = log();
    await syncExtraMarketplaces(sync, [], l);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(l.warn).not.toHaveBeenCalled();
  });

  it("a failure that remains is a warning, not a failed start", async () => {
    const sync = vi.fn().mockRejectedValue(contention("40001"));
    const l = log();
    await expect(syncExtraMarketplaces(sync, [], l)).resolves.toBeUndefined();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(l.warn).toHaveBeenCalledOnce();
  });

  it("reads the pg code from a wrapped error's cause", async () => {
    const wrapped = Object.assign(new Error("wrapped"), { cause: contention("40P01") });
    const sync = vi.fn().mockRejectedValue(wrapped);
    await syncExtraMarketplaces(sync, [], log());
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("any other error is thrown", async () => {
    const sync = vi.fn().mockRejectedValue(new Error("invalid configuration"));
    await expect(syncExtraMarketplaces(sync, [], log())).rejects.toThrow("invalid configuration");
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
