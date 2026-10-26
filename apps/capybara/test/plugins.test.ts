import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, kernelDb } from "@capybara-hq/kernel";
import {
  type FakeGitServer,
  startFakeGitServer,
  startTestPostgres,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixtureAsStrings } from "../../../packages/kernel/test/catalog/claude-fixtures.js";
import { skillPlugin, templatePlugin } from "../../../packages/kernel/test/catalog/packages.js";
import { legacyTgz, pluginTgz } from "../../../packages/kernel/test/helpers/plugin-packages.js";
import { SKILL_MD } from "../../../packages/kernel/test/skills/zip.js";
import { describeReview, parsePluginsImportTarget } from "../src/commands/plugins.js";
import { packBootstrapDir, runCli } from "./support/cli.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let pg: TestContainer;
let s3: TestS3;
let git: FakeGitServer;
let work: string;

let bootstrapDir: string;

beforeAll(async () => {
  [pg, s3, git, bootstrapDir] = await Promise.all([
    startTestPostgres(),
    startTestS3(),
    startFakeGitServer(),
    packBootstrapDir(),
  ]);
  work = await mkdtemp(join(tmpdir(), "capybara-plugins-"));
  // The deployment's object store is the bootstrap plugin object-store-s3, as after compose init
  const r = await runCli(["bootstrap", "--dir", bootstrapDir], testEnv(true, []));
  if (r.code !== 0) throw new Error(`capybara bootstrap failed: ${r.stderr}`);
}, 180_000);
afterAll(async () => {
  await Promise.all([
    bootstrapDir ? rm(bootstrapDir, { recursive: true, force: true }) : 0,
    pg?.stop(),
    s3?.stop(),
    git?.stop(),
    work ? rm(work, { recursive: true, force: true }) : 0,
  ]);
});

/**
 * The CLI's environment: the bootstrap plugin object-store-s3 (installed in `beforeAll`) is
 * configured through the deployment config; without `withStore` it is not configured.
 */
function testEnv(withStore: boolean, extensions: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("CAPYBARA_")) env[k] = v;
  }
  return {
    ...env,
    CAPYBARA_DB__URL: pg.url,
    CAPYBARA_REDIS__URL: "redis://127.0.0.1:1",
    CAPYBARA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    CAPYBARA_EXTENSIONS: JSON.stringify(extensions),
    // The fake git server is plain http on 127.0.0.1
    CAPYBARA_MARKETPLACES__ALLOW_INSECURE_LOOPBACK: "true",
    ...(withStore && {
      CAPYBARA_EXTENSION_CONFIG: JSON.stringify({
        "object-store-s3": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
      }),
    }),
  };
}

function run(
  args: string[],
  stdin = "",
  withStore = true,
  extensions: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--silent", "capybara", ...args], {
      cwd: REPO_ROOT,
      env: testEnv(withStore, extensions),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function query<T>(f: (db: ReturnType<typeof kernelDb>) => Promise<T>): Promise<T> {
  const raw = createDb(pg.url, 1);
  try {
    return await f(kernelDb(raw));
  } finally {
    await raw.destroy();
  }
}

const LEGACY = /pre-0\.1\.0 package format/;

describe("capybara plugins list / import", () => {
  it("list shows the bootstrap plugins (imported into the catalog by bootstrap)", async () => {
    const r = await run(["plugins", "list"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n").slice(1).sort()).toEqual([
      "",
      expect.stringMatching(/^object-store-s3\t0\.1\.0\textension\t\w+$/),
      expect.stringMatching(/^openai-compatible\t0\.1\.0\textension\t\w+$/),
    ]);
  }, 90_000);

  it("import prints the review and asks; an interactive no imports nothing", async () => {
    const file = join(work, "notes.tgz");
    await writeFile(file, await skillPlugin("notes", { version: "1.2.0" }));
    const r = await run(["plugins", "import", file], "n\n");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("notes 1.2.0");
    expect(r.stdout).toContain("Skill notes");
    expect(r.stdout).toMatch(/Import notes 1\.2\.0\? \[y\/N\]/);
    expect(r.stdout).toContain("Not imported");
    expect((await run(["plugins", "list"])).stdout).not.toContain("notes");
  }, 90_000);

  it("import --yes puts the item into the catalog and list shows it", async () => {
    const file = join(work, "notes.tgz");
    const r = await run(["plugins", "import", file, "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Imported notes 1.2.0");
    const list = await run(["plugins", "list"]);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toMatch(/notes\t1\.2\.0\t1 skill\t\w+/);
  }, 90_000);

  it("a template of another connector extension is imported with static checks only", async () => {
    const file = join(work, "github.tgz");
    await writeFile(file, await templatePlugin("github"));
    const r = await run(["plugins", "import", file, "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Connector template github: fake-connector / fake");
    expect((await run(["plugins", "list"])).stdout).toMatch(
      /github\t1\.0\.0\t1 connector template/,
    );
  }, 90_000);

  it("a plugin with an extension: the review lists permissions; the snapshot is written with source cli", async () => {
    const file = join(work, "withext.tgz");
    await writeFile(file, await pluginTgz({ manifest: { name: "withext" }, extension: {} }));
    const r = await run(["plugins", "import", file, "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Extension withext 1.0.0: not installed on this deployment");
    expect(r.stdout).toContain("permissions");
    const snap = await query((db) =>
      db
        .selectFrom("extension_permission_snapshots")
        .select(["source", "approved_by"])
        .where("plugin", "=", "withext")
        .executeTakeFirst(),
    );
    expect(snap).toEqual({ source: "cli", approved_by: null });
    const installed = await query((db) =>
      db.selectFrom("extension_installs").select("name").where("name", "=", "withext").execute(),
    );
    expect(installed).toEqual([]);
  }, 90_000);

  it("--deploy-extension installs and enables the plugin's extension", async () => {
    const file = join(work, "deployed.tgz");
    await writeFile(file, await pluginTgz({ manifest: { name: "deployed" }, extension: {} }));
    const r = await run(["plugins", "import", file, "--yes", "--deploy-extension"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Extension deployed 1.0.0 installed and enabled.");
    const row = await query((db) =>
      db
        .selectFrom("extension_installs")
        .select(["name", "desired_state"])
        .where("name", "=", "deployed")
        .executeTakeFirst(),
    );
    expect(row).toEqual({ name: "deployed", desired_state: "enabled" });
  }, 90_000);

  it("a plugin with files needs object storage; the error says so", async () => {
    const file = join(work, "more.tgz");
    await writeFile(file, await skillPlugin("more"));
    const r = await run(["plugins", "import", file, "--yes"], "", false);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/capybara: plugins import failed: .*Object storage is not available/);
  }, 90_000);

  it("a pre-0.1.0 tgz gets the legacy-format message from plugins import", async () => {
    for (const appYaml of [false, true]) {
      const file = join(work, `legacy-${appYaml}.tgz`);
      await writeFile(file, await legacyTgz({ appYaml }));
      const r = await run(["plugins", "import", file, "--yes"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^capybara: plugins import failed: /);
      expect(r.stderr).toMatch(LEGACY);
      expect(r.stderr).not.toContain("    at ");
    }
  }, 90_000);

  it("extensions install: a pre-0.1.0 tgz gets the legacy-format message", async () => {
    const file = join(work, "legacy-false.tgz");
    const r = await run(["extensions", "install", file, "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^capybara: extensions install failed: /);
    expect(r.stderr).toMatch(LEGACY);
  }, 90_000);

  it("extensions install: a declarative plugin is refused with the no-extension message", async () => {
    const file = join(work, "notes.tgz");
    const r = await run(["extensions", "install", file, "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/plugin notes has no extension .*import it into the catalog instead/);
  }, 90_000);
});

describe("capybara plugins import git:", () => {
  it("parses git:<url>[#ref][:path]", () => {
    expect(parsePluginsImportTarget("git:https://git.example.com/a/b.git")).toEqual({
      kind: "git",
      url: "https://git.example.com/a/b.git",
    });
    expect(parsePluginsImportTarget("git:https://git.example.com:8443/a/b.git#v1.2.0")).toEqual({
      kind: "git",
      url: "https://git.example.com:8443/a/b.git",
      ref: "v1.2.0",
    });
    expect(
      parsePluginsImportTarget("git:https://git.example.com:8443/a/b.git#main:plugins/alpha"),
    ).toEqual({
      kind: "git",
      url: "https://git.example.com:8443/a/b.git",
      ref: "main",
      path: "plugins/alpha",
    });
    expect(parsePluginsImportTarget("git:https://git.example.com:8443/a/b.git:plugins/x")).toEqual({
      kind: "git",
      url: "https://git.example.com:8443/a/b.git",
      path: "plugins/x",
    });
    expect(parsePluginsImportTarget("git:acme/plugins#main:tools")).toEqual({
      kind: "git",
      url: "acme/plugins",
      ref: "main",
      path: "tools",
    });
    expect(parsePluginsImportTarget("npm:@acme/x@1.0.0")).toEqual({
      kind: "npm",
      package: "@acme/x",
      version: "1.0.0",
    });
    expect(parsePluginsImportTarget("./x.tgz")).toEqual({ kind: "file", path: "./x.tgz" });
    for (const bad of ["git:", "git:#main", "git:https://h/a.git#", "git:https://h/a.git#main:"]) {
      expect(() => parsePluginsImportTarget(bad), bad).toThrow(/git:<url>\[#<ref>\]\[:<path>\]/);
    }
  });

  it("describeReview prints the git source detail, digest and provenance", () => {
    const lines = describeReview({
      name: "alpha",
      format: "capybara",
      version: "1.0.0+git.0123456789ab",
      pluginVersion: "1.0.0",
      contentDigest: "f".repeat(64),
      packageName: null,
      publisher: "git.example.com/acme",
      description: "Alpha",
      skills: [],
      connectorTemplates: [],
      dependencies: [],
      source: {
        kind: "git",
        ref: "https://git.example.com/acme/multi.git@0123@plugins/alpha",
        detail: {
          host: "git.example.com",
          repo: "acme/multi.git",
          path: "plugins/alpha",
          ref: "main",
          commit: "0123456789abcdef0123456789abcdef01234567",
          followsBranch: true,
        },
      },
      provenance: { checked: false, reason: "not an npm package" },
      sensitive: false,
      reviewHash: "h",
    });
    expect(lines[0]).toBe("alpha 1.0.0+git.0123456789ab by git.example.com/acme");
    expect(lines).toContain(
      "  version: 1.0.0+git.0123456789ab (plugin.json says 1.0.0; that version is already imported with other content)",
    );
    expect(lines).toContain(
      "  git: git.example.com acme/multi.git path plugins/alpha, commit 0123456789abcdef0123456789abcdef01234567 (ref main, follows the branch)",
    );
    expect(lines).toContain(`  content digest: ${"f".repeat(64)}`);
    expect(lines).toContain("  provenance not checked: not an npm package");
    const npm = describeReview({
      ...({} as Parameters<typeof describeReview>[0]),
      name: "x",
      version: "1.0.0",
      contentDigest: "e".repeat(64),
      packageName: "@acme/x",
      publisher: "acme",
      description: "X",
      skills: [],
      connectorTemplates: [],
      dependencies: [],
      source: { kind: "npm", ref: "@acme/x@1.0.0", detail: { registry: "https://r.example" } },
      provenance: {
        checked: true,
        repository: "https://github.com/acme/x",
        commit: "a".repeat(40),
        workflow: ".github/workflows/release.yml",
        buildType: "gha",
      },
      provenanceWarning: "repository_mismatch",
      sensitive: false,
      reviewHash: "h",
    });
    expect(npm[0]).toBe("x 1.0.0 (@acme/x) by acme");
    expect(npm).toContain(
      `  provenance: built from https://github.com/acme/x@${"a".repeat(40)} by .github/workflows/release.yml`,
    );
    expect(npm.some((l) => l.includes("differs from the attested repository"))).toBe(true);
  });

  it("imports a plugin folder from a git repo: the review shows the source, --yes imports it", async () => {
    const head = await git.commit("multi", {
      "plugins/gitnotes/skills/gitnotes/SKILL.md": SKILL_MD("gitnotes"),
      "README.md": "multi\n",
    });
    const target = `git:${git.url("multi")}#main:plugins/gitnotes`;
    const r = await run(["plugins", "import", target], "n\n");
    expect(r.code, r.stderr).toBe(1);
    expect(r.stdout).toContain(`gitnotes 0.0.0-git.g${head.slice(0, 12)}`);
    expect(r.stdout).toContain(`commit ${head} (ref main, follows the branch)`);
    expect(r.stdout).toContain("path plugins/gitnotes");
    expect(r.stdout).toContain("Skill gitnotes");
    expect(r.stdout).toContain("Not imported");

    const ok = await run(["plugins", "import", target, "--yes"]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toContain(`Imported gitnotes 0.0.0-git.g${head.slice(0, 12)}`);
    const row = await query((db) =>
      db
        .selectFrom("catalog_item_versions")
        .innerJoin("catalog_items", "catalog_items.id", "catalog_item_versions.item_id")
        .select(["catalog_item_versions.source", "catalog_item_versions.source_detail"])
        .where("catalog_items.name", "=", "gitnotes")
        .executeTakeFirst(),
    );
    expect(row).toMatchObject({
      source: "git",
      source_detail: { path: "plugins/gitnotes", commit: head, followsBranch: true },
    });
  }, 90_000);

  it("a Claude Code plugin from git: the review prints the translation report", async () => {
    await git.commit("superpowers", loadFixtureAsStrings("superpowers"));
    const r = await run(["plugins", "import", `git:${git.url("superpowers")}`], "n\n");
    expect(r.code, r.stderr).toBe(1);
    expect(r.stdout).toContain("superpowers 7.0.1 by Jesse Vincent");
    expect(r.stdout).toContain(
      "Translated from a Claude Code plugin: imported 4, converted 0, needs input 0, ignored 4, warnings 1",
    );
    expect(r.stdout).toContain(
      "  ignored: hooks_not_run SessionStart (hooks/hooks.json) handlers=command",
    );
    expect(r.stdout).toContain(
      "  ignored: command_manual_invocation brainstorm (commands/brainstorm.md)",
    );
    expect(r.stdout).toContain("  warnings: session_start_pin_hint SessionStart");
    expect(r.stdout).toContain("  license text: 1070 bytes (stored with the version)");
    expect(r.stdout).toContain("Skill using-superpowers");
  }, 90_000);

  it("a git failure is reported with the kernel's message", async () => {
    const r = await run(["plugins", "import", `git:${git.url("missing")}`, "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^capybara: plugins import failed: /);
    expect(r.stderr).not.toContain("    at ");
  }, 90_000);
});
