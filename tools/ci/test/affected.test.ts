// test-plugins-check: ignore-file -- plugin paths here are synthetic diffs, not plugin loads.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FULL_SHARDS,
  loadWorkspace,
  planAll,
  planFromFiles,
  toOutputs,
  type Workspace,
  type WorkspacePackage,
} from "../src/affected.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const pkg = (dir: string, deps: string[] = [], hasTests = true): WorkspacePackage => ({
  dir,
  name: `@x/${dir.split("/")[1]}`,
  deps: deps.map((d) => `@x/${d.split("/")[1]}`),
  hasTests,
});

/** A small workspace shaped like the real one. */
const ws: Workspace = {
  packages: [
    pkg("packages/sdk"),
    pkg("packages/kernel", ["packages/sdk", "packages/testing"]),
    pkg("packages/testing", ["packages/kernel", "packages/sdk"]),
    pkg("packages/design"),
    pkg("apps/web", ["packages/design"]),
    pkg("apps/capybara", ["packages/kernel", "packages/testing"]),
    pkg("plugins/todo", ["packages/sdk", "packages/testing"]),
    pkg("plugins/slack", ["packages/sdk", "packages/testing"]),
    pkg("plugins/lonely", ["packages/sdk"]),
    pkg("plugins/model-fake", ["packages/sdk"]),
    pkg("tools/checks", ["packages/kernel"]),
    pkg("tools/worktree"),
    pkg("tools/ci"),
    pkg("packages/plugin-tools", ["packages/sdk"]),
    pkg("tools/no-tests", [], false),
  ],
  testPlugins: {
    "packages/kernel/test": ["todo", "slack"],
    "apps/web/e2e": ["todo"],
  },
};

const plan = (...files: string[]) => planFromFiles(files, ws);

describe("planFromFiles: run everything", () => {
  it.each([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "vitest.config.ts",
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.test.json",
    "biome.json",
    ".github/workflows/ci.yml",
    ".github/scripts/anything.sh",
    "tools/ci/test-plugins.json",
    "tools/ci/src/affected.ts",
    "packages/testing/src/containers.ts",
    "packages/testing/README.md",
    // Outside every workspace package and not a doc: unknown, so everything.
    "docker/compose.dev.yaml",
    "docker/kernel.Dockerfile",
    "docker/test/compose-smoke.sh",
    ".dockerignore",
    "commitlint.config.ts",
    "tools/fixtures/vectors.json",
    "LICENSE",
  ])("%s", (f) => {
    const p = plan("plugins/slack/src/index.ts", f);
    expect(p.all).toBe(true);
    expect(p).toMatchObject({
      test: true,
      shards: FULL_SHARDS,
      web: true,
      visual: true,
      e2e: true,
      docker: true,
    });
    expect(p.testDirs).toEqual([]);
    expect(p.reason).toContain(f);
  });

  it("only root files of those names count: a package's own package.json / tsconfig does not", () => {
    expect(plan("plugins/lonely/package.json", "plugins/lonely/tsconfig.json").all).toBe(false);
  });

  it("planAll (push to main, diff unavailable)", () => {
    expect(planAll("push")).toMatchObject({
      all: true,
      test: true,
      e2e: true,
      docker: true,
      reason: "push",
    });
  });
});

describe("planFromFiles: docs-only fast path", () => {
  it.each([
    [["docs/plan.md"]],
    [["docs/design/README.md", "README.md", "AGENTS.md"]],
    [[".claude/skills/x/SKILL.md", ".gitignore", ".changeset/brave-cats.md"]],
    [[".agents/skills/writing-extensions/SKILL.md"]],
    [[".agents/skills/x/scripts/helper.sh", ".agents/skills/x/reference.json"]],
    [[]],
    [["", "  "]],
  ])("%j runs nothing", (files) => {
    expect(planFromFiles(files, ws)).toMatchObject({
      all: false,
      test: false,
      web: false,
      visual: false,
      e2e: false,
      docker: false,
      testDirs: [],
    });
  });
});

describe("planFromFiles: by diff", () => {
  it("a plugin nothing depends on: its own tests plus the kernel tests that load it", () => {
    expect(plan("plugins/slack/src/index.ts")).toMatchObject({
      all: false,
      testDirs: ["packages/kernel", "plugins/slack", "tools/checks"],
      shards: FULL_SHARDS,
      web: false,
      visual: false,
      e2e: false,
      docker: false,
    });
  });

  it("a plugin no other test loads: one shard", () => {
    expect(plan("plugins/lonely/src/index.ts")).toMatchObject({
      testDirs: ["plugins/lonely", "tools/checks"],
      shards: 1,
      e2e: false,
    });
  });

  it("files inside a package count for it, docs included", () => {
    expect(plan("plugins/lonely/README.md").testDirs).toEqual(["plugins/lonely", "tools/checks"]);
  });

  it("a plugin e2e loads runs e2e", () => {
    expect(plan("plugins/todo/src/index.ts")).toMatchObject({ e2e: true, web: false });
  });

  it("design: design and web tests, web build, visual and e2e; no kernel", () => {
    expect(plan("packages/design/src/button.tsx")).toMatchObject({
      testDirs: ["apps/web", "packages/design", "tools/checks"],
      shards: 1,
      web: true,
      visual: true,
      e2e: true,
    });
  });

  it("the sdk: every dependent, transitively", () => {
    const p = plan("packages/sdk/src/index.ts");
    expect(p.testDirs).toEqual([
      "apps/capybara",
      "packages/kernel",
      "packages/plugin-tools",
      "packages/sdk",
      "packages/testing",
      "plugins/lonely",
      "plugins/model-fake",
      "plugins/slack",
      "plugins/todo",
      "tools/checks",
    ]);
    expect(p).toMatchObject({ shards: FULL_SHARDS, web: false, visual: false, e2e: true });
  });

  it("the kernel runs e2e but not the web build or visual", () => {
    expect(plan("packages/kernel/src/kernel.ts")).toMatchObject({ e2e: true, web: false });
  });

  it("docker: the images' inputs (CLI and web closures) and the plugin the smoke test installs", () => {
    for (const f of [
      "apps/capybara/src/cli.ts",
      "apps/web/src/app/page.tsx",
      "packages/kernel/src/kernel.ts",
      "packages/sdk/src/index.ts",
      "packages/design/src/button.tsx",
      "plugins/model-fake/src/index.ts",
    ]) {
      expect(plan(f).docker, f).toBe(true);
    }
    expect(plan("plugins/model-fake/src/index.ts")).toMatchObject({ e2e: false, docker: true });
    for (const f of [
      "plugins/todo/src/index.ts",
      "plugins/lonely/src/index.ts",
      "tools/checks/x.ts",
    ]) {
      expect(plan(f).docker, f).toBe(false);
    }
  });

  it("bootstrap.json (npm pins): the CLI tests, e2e and docker, explicitly", () => {
    // A workspace where the CLI does not reach the kernel: the manifest still runs them.
    const loose: Workspace = {
      ...ws,
      packages: ws.packages.map((p) => (p.dir === "apps/capybara" ? { ...p, deps: [] } : p)),
    };
    expect(planFromFiles(["packages/kernel/bootstrap.json"], loose)).toMatchObject({
      e2e: true,
      docker: true,
      bootstrapNetwork: true,
    });
    expect(planFromFiles(["packages/kernel/bootstrap.json"], loose).testDirs).toContain(
      "apps/capybara",
    );
    expect(planFromFiles(["packages/kernel/src/x.ts"], loose).testDirs).not.toContain(
      "apps/capybara",
    );
  });

  it("packages/plugin-tools (the plugin packer): its tests, the CLI tests and docker, not e2e", () => {
    expect(plan("packages/plugin-tools/src/pack/pack.ts")).toMatchObject({
      testDirs: ["apps/capybara", "packages/plugin-tools", "tools/checks"],
      e2e: false,
      docker: true,
      web: false,
    });
  });

  it("the network half of check:bootstrap runs only when one of its inputs changes", () => {
    for (const f of [
      "packages/kernel/bootstrap.json",
      // the check's own code
      "tools/checks/src/bootstrap.ts",
      "tools/checks/src/bootstrap-network.ts",
      "tools/checks/src/bootstrap-compose.ts",
      "tools/checks/src/cli/bootstrap.ts",
      "packages/plugin-tools/src/pack/npm.ts",
      "packages/plugin-sdk/src/bootstrap.ts",
      // docker/ belongs to no package: everything runs, the network check included
      "docker/sandbox-proxy/haproxy.cfg",
      "docker/compose.yaml",
      "docker/compose.dev.yaml",
    ]) {
      expect(plan(f).bootstrapNetwork, f).toBe(true);
    }
    for (const f of [
      "tools/checks/src/terms.ts",
      "tools/checks/test/bootstrap.test.ts",
      "packages/plugin-tools/src/pack/pack.ts",
    ]) {
      expect(plan(f).bootstrapNetwork, f).toBe(false);
    }
    expect(
      plan("packages/kernel/src/kernel.ts", "plugins/model-fake/src/index.ts").bootstrapNetwork,
    ).toBe(false);
    expect(plan("docs/plan.md").bootstrapNetwork).toBe(false);
    expect(plan(".github/workflows/ci.yml").bootstrapNetwork).toBe(true);
    expect(planAll("push").bootstrapNetwork).toBe(true);
  });

  it("packages without a test dir are not passed to vitest", () => {
    expect(plan("tools/no-tests/src/x.ts")).toMatchObject({ testDirs: ["tools/checks"] });
  });

  it("extra inputs outside packages map to the package whose tests read them", () => {
    expect(plan(".claude/hooks/guard.sh").testDirs).toEqual(["tools/checks", "tools/worktree"]);
    expect(plan(".claude/settings.json").testDirs).toEqual(["tools/checks", "tools/worktree"]);
    expect(plan("docs/config.md").testDirs).toEqual(["tools/checks"]);
  });

  it("docs/design/tokens.json runs design (and what depends on it) and tools/checks", () => {
    expect(plan("docs/design/tokens.json")).toMatchObject({
      testDirs: ["apps/web", "packages/design", "tools/checks"],
      web: true,
    });
  });

  it("docs/design/spec.md runs design, web and the visual job (size tables, state lists)", () => {
    expect(plan("docs/design/spec.md")).toMatchObject({
      testDirs: ["apps/web", "packages/design", "tools/checks"],
      web: true,
      visual: true,
    });
  });

  it("web messages run the web tests and tools/checks (its error-copy test reads them)", () => {
    expect(plan("apps/web/messages/en.json").testDirs).toEqual(["apps/web", "tools/checks"]);
  });

  it("the longest package directory wins", () => {
    const nested: Workspace = { ...ws, packages: [...ws.packages, pkg("plugins/slack/sub")] };
    expect(planFromFiles(["plugins/slack/sub/x.ts"], nested).testDirs).toContain(
      "plugins/slack/sub",
    );
  });
});

describe("toOutputs", () => {
  it("full run: no filter, four shards", () => {
    expect(toOutputs(planAll("push"))).toMatchObject({
      test: "true",
      "test-dirs": "",
      "test-shards": "[1,2,3,4]",
      "test-shard-total": "4",
      e2e: "true",
      docker: "true",
      "bootstrap-network": "true",
    });
  });

  it("by diff: directories end with a slash so plugins/openai doesn't match openai-compatible", () => {
    expect(toOutputs(plan("plugins/lonely/src/index.ts"))).toMatchObject({
      "test-dirs": "plugins/lonely/ tools/checks/",
      "test-shards": "[1]",
      "test-shard-total": "1",
      web: "false",
      docker: "false",
    });
  });
});

describe("the real workspace", () => {
  const real = loadWorkspace(repoRoot);

  it("reads every workspace package and the test-plugins mapping", () => {
    const dirs = real.packages.map((p) => p.dir);
    expect(dirs).toEqual(
      expect.arrayContaining(["packages/kernel", "apps/web", "plugins/model-fake"]),
    );
    // The official plugins live in capybara-hq/plugins; model-fake is the only plugin in core.
    expect(dirs.filter((d) => d.startsWith("plugins/"))).toEqual(["plugins/model-fake"]);
    expect(real.packages.find((p) => p.dir === "packages/testing")?.deps).toContain(
      "@capybara-hq/kernel",
    );
    // After phase A3a core tests load only model-fake (check:test-plugins, test-plugins-official)
    expect(real.testPlugins["packages/kernel/test"]).toEqual(["model-fake"]);
    expect(real.testPlugins).not.toHaveProperty("$comment");
    // bootstrap.json holds npm pins only: no workspace plugin directory is an input any more.
    expect(real).not.toHaveProperty("bootstrapPlugins");
  });

  it("a model-fake change reruns the core tests that load it", () => {
    const dirs = planFromFiles(["plugins/model-fake/src/index.ts"], real).testDirs;
    for (const dir of ["packages/kernel", "packages/plugin-tools", "packages/testing"]) {
      expect(dirs).toContain(dir);
    }
  });

  it("a testing change runs every test (plugin tests use its kernel helpers and fakes)", () => {
    const p = planFromFiles(["packages/testing/src/kernel-helpers.ts"], real);
    expect(p.all).toBe(true);
    expect(p.test).toBe(true);
  });

  it("docker runs for every directory the images or the compose smoke test are built from (P-12)", () => {
    for (const dir of [
      "apps/capybara",
      "apps/web",
      "packages/kernel",
      "packages/plugin-sdk",
      "packages/design",
      "plugins/model-fake",
      "packages/plugin-tools",
    ]) {
      expect(planFromFiles([`${dir}/src/x.ts`], real).docker, dir).toBe(true);
    }
    expect(planFromFiles(["tools/worktree/src/x.ts"], real).docker).toBe(false);
  });

  it("the CLI prints the outputs and runs everything when asked", () => {
    const run = (args: string[], input: string) =>
      execFileSync(process.execPath, [`${repoRoot}/tools/ci/src/cli.ts`, ...args], {
        input,
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: "" },
      });
    expect(run([], "packages/design/src/x.tsx\n")).toContain(
      "test-dirs=apps/web/ packages/design/ tools/checks/",
    );
    expect(run(["--all", "push to main"], "")).toContain("reason=push to main");
  });
});
