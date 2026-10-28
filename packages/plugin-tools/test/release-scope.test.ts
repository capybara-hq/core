import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPublish, selectPlugins } from "../src/release/publish.js";
import type { WorkspacePackage } from "../src/release/publish-plan.js";

// Core's release after the split (A3b): the libraries and one plugin only (core passes `--plugins`
// with model-fake's directory; here a plugin "kept" stands in for it and "moved" for one that
// capybara-hq/plugins publishes), and the first release is the rc 0.1.0-rc.0, then 0.1.0.

const RC = "0.1.0-rc.0";
let root: string;
const writePkg = async (dir: string, pkg: Record<string, unknown>) => {
  await mkdir(join(root, dir, "dist"), { recursive: true });
  await writeFile(join(root, dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
};

/** Core's layout at `version`: the four libraries, a kept plugin, a moved one and an example. */
async function core(version: string) {
  await writePkg("packages/plugin-sdk", { name: "@capybara-hq/plugin-sdk", version });
  await writePkg("packages/kernel", { name: "@capybara-hq/kernel", version });
  await writePkg("packages/testing", { name: "@capybara-hq/testing", version });
  await writePkg("packages/plugin-tools", { name: "@capybara-hq/plugin-tools", version });
  await writePkg("packages/design", { name: "@capybara-hq/design", version, private: true });
  await writePkg("apps/capybara", { name: "@capybara-hq/capybara", version, private: true });
  await writePkg("plugins/kept", { name: "@capybara-hq/plugin-kept", version });
  await writePkg("plugins/moved", { name: "@capybara-hq/plugin-moved", version });
  await writePkg("plugins/example-x", {
    name: "@capybara-hq/plugin-example-x",
    version,
    private: true,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "release-scope-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A release run against a fake registry; records every lookup and `npm publish` with its tag. */
async function release(
  registry: Record<string, string[]>,
  opts: { auto?: boolean; plugins?: string[] } = {},
) {
  const looked: string[] = [];
  const publishes: string[] = [];
  const r = await runPublish({
    dryRun: false,
    provenance: true,
    out: join(root, "out"),
    root,
    refuseFirstRelease: opts.auto === true,
    ...(opts.plugins !== undefined && { plugins: opts.plugins }),
    publishedVersions: async (name) => {
      looked.push(name);
      return registry[name] ?? [];
    },
    exec: async (cmd, args, cwd) => {
      if (cmd === "pnpm") {
        const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
        const file = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`;
        await writeFile(join(args[2] as string, file), "lib");
        return;
      }
      const file = (args[1] ?? "").split(/[/\\]/).pop();
      publishes.push(`${file} --tag ${args[args.indexOf("--tag") + 1]}`);
    },
    packPluginTgz: async (dir, o) => {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      const file = join(o, `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`);
      await writeFile(file, "plugin");
      return file;
    },
    readPackedManifest: () => ({ name: "x", version: RC }),
  });
  return { ...r, looked, publishes };
}

describe("selectPlugins", () => {
  const pkg = (dir: string, isPlugin = dir.startsWith("plugins/")): WorkspacePackage => ({
    name: dir,
    version: "1.0.0",
    dir,
    private: false,
    isPlugin,
  });
  const pkgs = [pkg("packages/kernel"), pkg("plugins/kept"), pkg("plugins/moved")];

  it("keeps every library and the matching plugins only", () => {
    expect(selectPlugins(pkgs, ["plugins/kept"]).map((p) => p.dir)).toEqual([
      "packages/kernel",
      "plugins/kept",
    ]);
    expect(selectPlugins(pkgs, ["plugins/kept/"]).map((p) => p.dir)).toEqual([
      "packages/kernel",
      "plugins/kept",
    ]);
    expect(selectPlugins(pkgs, ["plugins/*"])).toEqual(pkgs);
    expect(selectPlugins(pkgs, undefined)).toEqual(pkgs);
  });

  it("refuses a pattern that matches no plugin (a typo must not publish nothing quietly)", () => {
    expect(() => selectPlugins(pkgs, ["plugins/kep"])).toThrow(
      /--plugins plugins\/kep matches no plugin/,
    );
    expect(() => selectPlugins(pkgs, ["packages/kernel"])).toThrow(/matches no plugin/);
  });
});

describe("core's release scope (--plugins <one plugin>)", () => {
  it("publishes the four libraries and the kept plugin, never a moved one", async () => {
    await core(RC);
    const r = await release({}, { plugins: ["plugins/kept"] });
    expect(r.published).toEqual([
      `@capybara-hq/plugin-sdk@${RC}`,
      `@capybara-hq/kernel@${RC}`,
      `@capybara-hq/testing@${RC}`,
      `@capybara-hq/plugin-tools@${RC}`,
      `@capybara-hq/plugin-kept@${RC}`,
    ]);
    expect(r.looked).not.toContain("@capybara-hq/plugin-moved");
  });
});

describe("release candidate first (0.1.0-rc.0, then 0.1.0)", () => {
  const scope = { plugins: ["plugins/kept"] };

  it("a push never publishes the rc: nothing is on npm yet (the first release is manual)", async () => {
    await core(RC);
    const r = await release({}, { ...scope, auto: true });
    expect(r).toMatchObject({ published: [], publishes: [] });
  });

  it("the manual first release publishes every package at the rc under the dist-tag next", async () => {
    await core(RC);
    const r = await release({}, scope);
    expect(r.publishes).toHaveLength(5);
    for (const p of r.publishes) expect(p).toMatch(/-0\.1\.0-rc\.0\.tgz --tag next$/);
  });

  it("after the rc, a push publishes a further rc (next) or the final 0.1.0 (latest)", async () => {
    const onNpm = {
      "@capybara-hq/plugin-sdk": [RC],
      "@capybara-hq/kernel": [RC],
      "@capybara-hq/testing": [RC],
      "@capybara-hq/plugin-tools": [RC],
      "@capybara-hq/plugin-kept": [RC],
    };
    await core("0.1.0-rc.1");
    const rc1 = await release(onNpm, { ...scope, auto: true });
    expect(rc1.publishes).toHaveLength(5);
    for (const p of rc1.publishes) expect(p).toMatch(/--tag next$/);

    await core("0.1.0");
    const final = await release(onNpm, { ...scope, auto: true });
    expect(final.publishes).toHaveLength(5);
    for (const p of final.publishes) expect(p).toMatch(/-0\.1\.0\.tgz --tag latest$/);
  });
});
