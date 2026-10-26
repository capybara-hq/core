import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDeps,
  checkMigrations,
  checkPluginPack,
  checkPluginPermissions,
  checkPluginState,
  checkToolDesign,
} from "@capybara-hq/plugin-tools";
import { afterEach, describe, expect, it } from "vitest";

// plugin-tools' plugin checks (red fixtures in packages/plugin-tools/test) on core's real code: the
// fakes and fixtures of @capybara-hq/testing, the SDK, the kernel's builtin tools and migrations.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const testing = (name: string) => join(root, "packages/testing/test/fixtures", name);
const fake = (name: string) => join(root, "packages/testing/fixtures/extensions", name);

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of a fixture without its exemption markers, to prove that the markers are what passes. */
function unmarked(dir: string): string {
  const out = mkdtempSync(join(tmpdir(), "capybara-ps-"));
  tmp.push(out);
  cpSync(dir, out, { recursive: true });
  for (const name of ["index.ts", "store.ts"]) {
    try {
      const p = join(out, name);
      writeFileSync(
        p,
        readFileSync(p, "utf8").replace(/\s*\/\/ capybara:allow-module-state.*$/gm, ""),
      );
    } catch {}
  }
  return out;
}

describe("dependency boundary on core", () => {
  it("good-counter / whoami -> no findings", () => {
    expect(checkDeps([testing("good-counter"), testing("whoami")])).toEqual([]);
  });

  it("the real packages/plugin-sdk is clean", () => {
    expect(checkDeps([], [join(root, "packages/plugin-sdk")])).toEqual([]);
  });
});

describe("extension state on core", () => {
  it("good-counter / whoami -> no findings", () => {
    expect(checkPluginState([testing("good-counter"), testing("whoami")])).toEqual([]);
  });

  it("leaky-counter / leaky-sibling pass with their exemption markers", () => {
    expect(checkPluginState([testing("leaky-counter"), testing("leaky-sibling")])).toEqual([]);
  });

  it("without the markers leaky-counter and leaky-sibling (sibling store.ts) are reported", () => {
    const a = checkPluginState([unmarked(testing("leaky-counter"))]);
    expect(a.map((x) => x.rule)).toEqual(["plugin-module-state"]);
    const b = checkPluginState([unmarked(testing("leaky-sibling"))]);
    expect(b.map((x) => x.rule)).toEqual(["plugin-module-state"]);
    expect(b[0]?.file).toContain("store.ts");
  });
});

describe("the other plugin checks on core", () => {
  it("every plugin passes the permission check", () => {
    expect(checkPluginPermissions([join(root, "plugins")])).toEqual([]);
  });

  it("the kernel's migrations pass", () => {
    expect(checkMigrations([join(root, "packages/kernel/src/migrations")])).toEqual([]);
  });

  it("the builtin tools and the core fakes' tools and connector pass tool design", () => {
    expect(
      checkToolDesign([
        join(root, "packages/kernel/src/tools/builtins"),
        fake("fake-connector"),
        fake("fake-tools-ui"),
        fake("fake-storage-user"),
      ]),
    ).toEqual([]);
  });

  it("core fakes pack into valid self-contained packages", async () => {
    expect(await checkPluginPack([fake("fake-dep-provider"), fake("fake-tools-ui")])).toEqual([]);
  }, 60_000);
});
