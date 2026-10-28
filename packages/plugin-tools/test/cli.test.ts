import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// `capybara-plugin` on repositories that are not this one (Review Focus 3 of the phase A3a plan): a
// temp directory with one plugin, found without any plugins/* layout, checked by every plugin check
// and packed reproducibly. The CLI runs as a child process, the way a plugin repository runs it.

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const CLI = join(here, "../src/cli.ts");
const TSX = join(repo, "node_modules/.bin/tsx");

/** Every check `capybara-plugin check` runs (pluginChecks). */
const CHECKS = [
  "Migrations",
  "Dependency boundary",
  "Extension state",
  "Extension permissions",
  "Plugin pack",
  "Tool design",
  "Plugin test imports",
  "Plugin release metadata",
];

/** The repository a test plugin names (npm provenance: it must equal the root's). */
const SOLO_REPO = { type: "git", url: "git+https://github.com/example/solo.git" };

function cli(cwd: string, ...args: string[]): { code: number; out: string } {
  // INIT_CWD points elsewhere, as under a workspace script run from the workspace root: paths must
  // resolve against the process's current directory, never INIT_CWD.
  const env: NodeJS.ProcessEnv = { ...process.env, INIT_CWD: tmpdir() };
  const r = spawnSync(
    TSX,
    [
      "--tsconfig",
      join(repo, "tsconfig.base.json"),
      "--conditions=@capybara-hq/source",
      CLI,
      ...args,
    ],
    { cwd, env, encoding: "utf8" },
  );
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const CLEAN_TOOL = `import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "solo",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { tools: ["greet"] },
  setup(ctx) {
    ctx.tools.register(
      {
        name: "greet",
        description: "Return a greeting for the given name. Test fixture only.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      async () => ({ content: [{ type: "text", text: "Hello." }] }),
    );
  },
});
`;

/** One violation per check: a kernel import, module state, an undeclared hook, a short tool description. */
const BAD_TOOL = `import type { KernelConfig } from "@capybara-hq/kernel";
import { defineExtension } from "@capybara-hq/plugin-sdk";

let calls = 0;
export type Config = KernelConfig;

export default defineExtension({
  name: "solo",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { tools: ["greet"] },
  setup(ctx) {
    ctx.hooks.on("model.request", () => undefined, { mode: "observe" });
    ctx.tools.register(
      {
        name: "greet",
        description: "Greets.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      async () => ({ content: [{ type: "text", text: \`Hello \${++calls}.\` }] }),
    );
  },
});
`;

let work: string;
/** A plugin repository that is just one plugin: no plugins/ directory, no workspace. */
let solo: string;

function writePlugin(dir: string, source: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, ".capybara-plugin"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@example/plugin-solo",
      version: "0.1.0",
      type: "module",
      license: "MIT",
      description: "A plugin outside the Capybara repository",
      homepage: "https://example.com/solo",
      repository: SOLO_REPO,
      dependencies: { "@capybara-hq/plugin-sdk": "^0.1.0-rc.0", zod: "^4.6.7" },
      // As the README installs it: the toolchain is a plugin repository's devDependency.
      devDependencies: { "@capybara-hq/plugin-tools": "^0.1.0" },
      ...extra,
    }),
  );
  writeFileSync(
    join(dir, ".capybara-plugin/plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "solo",
      version: "0.1.0",
      publisher: "Example",
      description: "A plugin outside the Capybara repository",
    }),
  );
  writeFileSync(join(dir, "src/index.ts"), source);
  // What `npm install` gives a plugin repository: the host-provided packages in node_modules.
  const modules = join(dir, "node_modules");
  mkdirSync(join(modules, "@capybara-hq"), { recursive: true });
  symlinkSync(join(repo, "packages/plugin-sdk"), join(modules, "@capybara-hq/plugin-sdk"), "dir");
  symlinkSync(realpathSync(join(here, "../node_modules/zod")), join(modules, "zod"), "dir");
}

beforeAll(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "capybara-plugin-cli-")));
  solo = join(work, "solo");
  writePlugin(solo, CLEAN_TOOL);
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("capybara-plugin check outside this repository", () => {
  it("finds the plugin at the root and runs every plugin check", () => {
    const r = cli(solo, "check");
    expect(r.out).toContain("checking 1 plugin(s): .");
    for (const name of CHECKS) expect(r.out).toContain(`[${name}] passed`);
    expect(r.code).toBe(0);
  }, 120_000);

  it("reports seeded violations, one per check, and fails", () => {
    const bad = join(work, "bad");
    writePlugin(bad, BAD_TOOL, { files: ["assets"], description: undefined });
    mkdirSync(join(bad, "test"));
    writeFileSync(
      join(bad, "test/kernel.test.ts"),
      'import { createKernel } from "@capybara-hq/kernel";\nexport { createKernel };\n',
    );
    mkdirSync(join(bad, "migrations"));
    writeFileSync(join(bad, "migrations/0001_init.sql"), "CREATE TABLE solo_t (id int);\n");
    const r = cli(work, "check", "--root", "bad");
    expect(r.code).toBe(1);
    for (const rule of [
      "idempotent", // Migrations
      "plugin-imports-kernel", // Dependency boundary
      "plugin-module-state", // Extension state
      "perm-hooks", // Extension permissions
      "plugin-pack-dropped", // Plugin pack
      "tool-description", // Tool design
      "plugin-test-imports", // Plugin test imports
      "plugin-release-metadata", // Plugin release metadata
    ]) {
      expect(r.out).toContain(` ${rule} `);
    }
    for (const name of CHECKS) expect(r.out).not.toContain(`[${name}] passed`);
  }, 120_000);

  it("finds plugins/* in a multi-plugin repository, or the ones --plugins names", () => {
    const multi = join(work, "multi");
    const repository = { ...SOLO_REPO, directory: "plugins/a" };
    writePlugin(join(multi, "plugins/a"), CLEAN_TOOL, { repository });
    writeFileSync(
      join(multi, "package.json"),
      JSON.stringify({ name: "multi", private: true, repository: SOLO_REPO }),
    );
    writePlugin(join(multi, "extras/b"), BAD_TOOL);
    const r = cli(multi, "check");
    expect(r.out).toContain("checking 1 plugin(s): plugins/a");
    expect(r.code).toBe(0);
    const g = cli(multi, "check", "--plugins", "extras/*");
    expect(g.out).toContain("checking 1 plugin(s): extras/b");
    expect(g.code).toBe(1);
  }, 120_000);

  it("fails when it finds no plugin (an empty scan checks nothing)", () => {
    const empty = join(work, "empty");
    mkdirSync(empty);
    const r = cli(empty, "check");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no plugin found/);
  }, 60_000);

  it("--base reports an edited applied migration", () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
    const repoDir = join(work, "migrating");
    writePlugin(repoDir, CLEAN_TOOL);
    writeFileSync(join(repoDir, ".gitignore"), "node_modules\n");
    mkdirSync(join(repoDir, "migrations"));
    const sql = join(repoDir, "migrations/0001_init.sql");
    writeFileSync(sql, "CREATE TABLE IF NOT EXISTS solo_t (id int);\n");
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "base");
    writeFileSync(sql, "CREATE TABLE IF NOT EXISTS solo_t (id bigint);\n");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-am", "edit");
    const r = cli(repoDir, "check", "--base", "HEAD~1");
    expect(r.out).toMatch(/migrations\/0001_init\.sql:1 applied-migration-edited/);
    expect(r.code).toBe(1);
  }, 120_000);
});

describe("capybara-plugin pack outside this repository", () => {
  it("packs the plugin into the same bytes twice (reproducible)", () => {
    const a = cli(work, "pack", "solo", "--out", "out-a");
    const b = cli(solo, "pack", ".", "--out", "../out-b");
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const sha = (out: string) => /sha256=([0-9a-f]{64})/.exec(out)?.[1];
    expect(sha(a.out)).toBeDefined();
    expect(sha(a.out)).toBe(sha(b.out));
    expect(readdirSync(join(work, "out-a"))).toEqual(["example-plugin-solo-0.1.0.tgz"]);
  }, 120_000);

  it("--all <root> packs every plugin the repository has", () => {
    const r = cli(work, "pack", "--all", "solo", "--out", "out-all");
    expect(r.code).toBe(0);
    expect(readdirSync(join(work, "out-all"))).toEqual(["example-plugin-solo-0.1.0.tgz"]);
  }, 120_000);
});

describe("capybara-plugin sync-versions and --help", () => {
  it("copies the package.json version into plugin.json and the extension manifest", () => {
    const dir = join(work, "versions");
    writePlugin(dir, CLEAN_TOOL);
    const pkgFile = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as Record<string, unknown>;
    writeFileSync(pkgFile, JSON.stringify({ ...pkg, version: "0.2.0" }));
    const r = cli(dir, "sync-versions");
    expect(r.code).toBe(0);
    expect(r.out).toContain(".capybara-plugin/plugin.json, src/index.ts");
    expect(
      JSON.parse(readFileSync(join(dir, ".capybara-plugin/plugin.json"), "utf8")).version,
    ).toBe("0.2.0");
    expect(readFileSync(join(dir, "src/index.ts"), "utf8")).toContain('  version: "0.2.0",');
    expect(cli(dir, "sync-versions").out).toContain("already match");
  }, 60_000);

  it("prints one command's usage with <command> --help", () => {
    for (const [command, text] of [
      ["pack", "capybara-plugin pack [<dir>...]"],
      ["check", "capybara-plugin check [--root <dir>]"],
      ["sync-versions", "capybara-plugin sync-versions"],
      ["release", "capybara-plugin release [--dry-run]"],
    ] as const) {
      const r = cli(work, command, "--help");
      expect(r.code, command).toBe(0);
      expect(r.out, command).toContain(text);
    }
  }, 120_000);

  it("release refuses a directory without workspace packages instead of publishing nothing", () => {
    const r = cli(join(work, "solo"), "release", "--dry-run");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no workspace package found under .*packages\/\*, apps\/\*, plugins\/\*/);
  }, 60_000);
});
