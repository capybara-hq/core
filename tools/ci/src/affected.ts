/**
 * Decides what the CI workflow runs on a pull request, from the list of changed files.
 *
 * Pushes to main always run everything (`planAll`). On a PR:
 * - docs-only diffs run nothing heavy (the old docs-only fast path);
 * - "run everything" triggers (root config, lockfile, `.github/**`, `packages/testing/**`, files that
 *   belong to no workspace package) run everything;
 * - otherwise tests run for the changed workspace packages, everything that depends on them
 *   (all dependency kinds, transitively), and every package whose tests load an affected plugin by
 *   path (tools/ci/test-plugins.json, kept honest by `pnpm check`); web / visual / e2e / docker run
 *   only when one of their input packages changed.
 *
 * Erasable TypeScript only (no enums, no parameter properties): CI runs this file with plain
 * `node`, before any `pnpm install`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkspacePackage {
  /** Directory relative to the repo root, e.g. `packages/kernel`. */
  dir: string;
  name: string;
  /** Names of the workspace packages it depends on (any dependency kind). */
  deps: string[];
  /** Has a `test/` directory, i.e. vitest picks up files under it. */
  hasTests: boolean;
}

export interface Workspace {
  packages: WorkspacePackage[];
  /**
   * Test root (`<package dir>/test` or `apps/web/e2e`) -> plugin directory names (`plugins/<name>`) its
   * tests load by path without declaring them as dependencies. From tools/ci/test-plugins.json.
   */
  testPlugins: Record<string, string[]>;
}

export interface Plan {
  /** Why this plan: shown in the job log. */
  reason: string;
  /** Run the whole suite (no path filter). */
  all: boolean;
  /** Package directories whose vitest tests run (empty when `all` or when no test runs). */
  testDirs: string[];
  test: boolean;
  /** Number of vitest shards. */
  shards: number;
  web: boolean;
  visual: boolean;
  e2e: boolean;
  /** Build the amd64 images and run docker/test/compose-smoke.sh. */
  docker: boolean;
  /**
   * Run the network half of check:bootstrap (`pnpm check:bootstrap --network`: npm entries against
   * the registry, the official marketplace commit, the sandbox-docker plugin's copy of the socket
   * proxy config and the compose build contexts there). It needs GitHub and npm, so on a PR only
   * when one of its inputs changed ({@link BOOTSTRAP_NETWORK_INPUTS}: the pins, the socket proxy
   * config, the compose files); always on main.
   */
  bootstrapNetwork: boolean;
}

/** Shard count for the full suite, or whenever the kernel tests (the bulk of the suite) run. */
export const FULL_SHARDS = 4;

/** Root files whose change can affect any test or build. */
const RUN_ALL_ROOT_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "biome.json",
]);
const RUN_ALL_ROOT_PATTERNS = [/^vitest\.config\.[^/]+$/, /^tsconfig[^/]*\.json$/];
/**
 * Directories whose change can affect any test: CI itself (workflows, and this script with its
 * test-plugins.json), and the test kit every package uses.
 */
const RUN_ALL_DIRS = [".github/", "tools/ci/", "packages/testing/"];

/**
 * Files outside any workspace package that tests or checks read, and the package whose tests read them.
 * When adding a test or check that reads such a file, add it here (otherwise it is either a doc and
 * ignored, or unknown and runs everything).
 */
const EXTRA_INPUTS: { match: (f: string) => boolean; dirs: string[] }[] = [
  // tools/worktree's tests execute the hooks directly.
  {
    match: (f) => f.startsWith(".claude/hooks/") || f === ".claude/settings.json",
    dirs: ["tools/worktree"],
  },
  // check:config-docs compares it with the kernel config schema.
  { match: (f) => f === "docs/config.md", dirs: ["tools/checks"] },
  // gen:tokens renders packages/design's tokens.css / tokens.ts from it; check:tokens (tools/checks)
  // and packages/design's token tests read it.
  {
    match: (f) => f === "docs/design/tokens.json",
    dirs: ["tools/checks", "packages/design", "apps/web"],
  },
  // The design spec's size tables and state lists: packages/design's spec-tables test checks them
  // against tokens.json, and the visual job's fidelity spec (apps/web) measures /dev/ui with them.
  { match: (f) => f === "docs/design/spec.md", dirs: ["packages/design", "apps/web"] },
];

/**
 * tools/checks' tests read across the repo (every plugin, kernel migrations, web messages) in ways a
 * static scan can't follow, and they take seconds, so they join every PR that runs tests.
 */
const ALWAYS_WITH_TESTS = "tools/checks";

/**
 * The docker job builds the images from the CLI (kernel, plugin SDK) and the web app (design); the
 * kernel image downloads the bootstrap plugins pinned in packages/kernel/bootstrap.json with
 * packages/plugin-tools (`pnpm pack-bootstrap`), and docker/test/compose-smoke.sh packs model-fake
 * and installs it into the running stack. Everything under docker/ (Dockerfiles, compose files, the
 * smoke script) and the root .dockerignore belong to no package, so they already run everything.
 */
const DOCKER_ROOTS = ["apps/capybara", "apps/web", "plugins/model-fake", "packages/plugin-tools"];

/** The CLI package: its tests run `capybara bootstrap` (on packed fakes). */
const CLI_DIR = "apps/capybara";

/**
 * `pnpm pack-bootstrap` (@capybara-hq/plugin-tools; the e2e setup downloads the bootstrap plugins
 * with it, the CLI tests pack fakes with it): neither the CLI nor the web app depends on it, so it
 * is an explicit input of the CLI tests and of e2e.
 */
const PACK_PLUGIN_DIR = "packages/plugin-tools";

/**
 * The bootstrap manifest. Its pins are downloaded by the image build and the e2e setup, and only the
 * CLI tests, e2e and docker install them (the kernel tests run on fakes), so a change to it runs
 * those explicitly (it also runs everything that depends on the kernel, whose package holds it).
 */
const BOOTSTRAP_MANIFEST = "packages/kernel/bootstrap.json";

/**
 * Inputs of the network half of check:bootstrap: the pins, core's socket proxy config (the
 * sandbox-docker plugin's copy at marketplace.commit must equal it, rule bootstrap-haproxy) and the
 * compose files (their git build contexts must exist at that commit, bootstrap-compose-ref). The
 * docker/ files belong to no package, so they also run everything.
 */
const BOOTSTRAP_NETWORK_INPUTS: ((f: string) => boolean)[] = [
  (f) => f === BOOTSTRAP_MANIFEST,
  (f) => f.startsWith("docker/sandbox-proxy/"),
  (f) => /^docker\/compose(?:\.[\w-]+)?\.yaml$/.test(f),
];
const isBootstrapNetworkInput = (f: string) => BOOTSTRAP_NETWORK_INPUTS.some((m) => m(f.trim()));

/** Docs: no test, build or check reads them. Same rules as the former code-changed.sh. */
function isDoc(f: string): boolean {
  if (f.startsWith("docs/")) return true;
  if (f === ".gitignore") return true;
  if (f.startsWith(".claude/") || f.startsWith(".agents/")) return true;
  return f.endsWith(".md");
}

function isRunAll(f: string): boolean {
  if (RUN_ALL_ROOT_FILES.has(f)) return true;
  if (RUN_ALL_ROOT_PATTERNS.some((re) => re.test(f))) return true;
  return RUN_ALL_DIRS.some((d) => f.startsWith(d));
}

export function planAll(reason: string): Plan {
  return {
    reason,
    all: true,
    testDirs: [],
    test: true,
    shards: FULL_SHARDS,
    web: true,
    visual: true,
    e2e: true,
    docker: true,
    bootstrapNetwork: true,
  };
}

function planNone(reason: string): Plan {
  return {
    reason,
    all: false,
    testDirs: [],
    test: false,
    shards: 1,
    web: false,
    visual: false,
    e2e: false,
    docker: false,
    bootstrapNetwork: false,
  };
}

/** The workspace package a file belongs to (longest matching directory), if any. */
function owningPackage(f: string, ws: Workspace): WorkspacePackage | undefined {
  let best: WorkspacePackage | undefined;
  for (const p of ws.packages) {
    if (f.startsWith(`${p.dir}/`) && (best === undefined || p.dir.length > best.dir.length))
      best = p;
  }
  return best;
}

/** `start` plus everything reachable through `next`. */
function closure(start: Iterable<string>, next: (dir: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...start];
  for (let d = queue.pop(); d !== undefined; d = queue.pop()) {
    if (seen.has(d)) continue;
    seen.add(d);
    queue.push(...next(d));
  }
  return seen;
}

export function planFromFiles(files: string[], ws: Workspace): Plan {
  const changed = new Set<string>();
  for (const f of files.map((x) => x.trim()).filter((x) => x !== "")) {
    if (isRunAll(f)) return planAll(`run-everything trigger changed: ${f}`);
    const extra = EXTRA_INPUTS.find((e) => e.match(f));
    if (extra !== undefined) {
      for (const d of extra.dirs) changed.add(d);
      continue;
    }
    const pkg = owningPackage(f, ws);
    if (pkg !== undefined) {
      changed.add(pkg.dir);
      continue;
    }
    if (isDoc(f)) continue;
    return planAll(`file outside any workspace package: ${f}`);
  }
  if (changed.size === 0) return planNone("docs-only change");

  const byName = new Map(ws.packages.map((p) => [p.name, p]));
  const byDir = new Map(ws.packages.map((p) => [p.dir, p]));
  const dependents = new Map<string, string[]>();
  for (const p of ws.packages) {
    for (const dep of p.deps) {
      const d = byName.get(dep);
      if (d !== undefined) dependents.set(d.dir, [...(dependents.get(d.dir) ?? []), p.dir]);
    }
  }
  const depsOf = (dir: string): string[] =>
    (byDir.get(dir)?.deps ?? []).flatMap((n) => {
      const d = byName.get(n);
      return d === undefined ? [] : [d.dir];
    });

  // Tests: changed packages, their dependents, and packages whose tests load an affected plugin.
  const affected = closure(changed, (d) => dependents.get(d) ?? []);
  const tested = new Set(affected);
  for (const [root, plugins] of Object.entries(ws.testPlugins)) {
    if (!root.endsWith("/test")) continue;
    if (plugins.some((name) => affected.has(`plugins/${name}`))) tested.add(root.slice(0, -5));
  }
  const manifestChanged = files.some((f) => f.trim() === BOOTSTRAP_MANIFEST);
  if (manifestChanged || affected.has(PACK_PLUGIN_DIR)) tested.add(CLI_DIR);
  tested.add(ALWAYS_WITH_TESTS);
  const testDirs = [...tested].filter((d) => byDir.get(d)?.hasTests === true).sort();

  // web / visual / e2e / docker: run when any package they are built from or load changed.
  const hits = (roots: string[]) => [...closure(roots, depsOf)].some((d) => changed.has(d));
  const e2ePlugins = (ws.testPlugins["apps/web/e2e"] ?? []).map((n) => `plugins/${n}`);
  const web = hits(["apps/web"]);

  return {
    reason: `changed packages: ${[...changed].sort().join(", ")}`,
    all: false,
    testDirs,
    test: testDirs.length > 0,
    shards: testDirs.includes("packages/kernel") ? FULL_SHARDS : 1,
    web,
    visual: web,
    e2e: manifestChanged || hits(["apps/web", "apps/capybara", PACK_PLUGIN_DIR, ...e2ePlugins]),
    docker: manifestChanged || hits(DOCKER_ROOTS),
    bootstrapNetwork: files.some(isBootstrapNetworkInput),
  };
}

/** Reads the workspace packages (pnpm-workspace.yaml `dir/*` globs) and test-plugins.json. */
export function loadWorkspace(root: string): Workspace {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const block = /^packages:\n((?:[ \t]+-.*\n?)+)/m.exec(yaml);
  if (block?.[1] === undefined) throw new Error("pnpm-workspace.yaml: no packages list");
  const packages: WorkspacePackage[] = [];
  for (const line of block[1].split("\n").filter((l) => l.trim() !== "")) {
    const glob = /^\s+-\s+["']?([^"'\s]+)["']?\s*$/.exec(line)?.[1];
    const base = glob === undefined ? undefined : /^([\w.-]+)\/\*$/.exec(glob)?.[1];
    if (base === undefined)
      throw new Error(`pnpm-workspace.yaml: unsupported entry ${line.trim()}`);
    if (!existsSync(join(root, base))) continue;
    for (const e of readdirSync(join(root, base), { withFileTypes: true })) {
      const dir = `${base}/${e.name}`;
      const manifest = join(root, dir, "package.json");
      if (!e.isDirectory() || !existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
      const deps = new Set<string>();
      for (const kind of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const n of Object.keys((pkg[kind] as Record<string, string> | undefined) ?? {})) {
          deps.add(n);
        }
      }
      packages.push({
        dir,
        name: String(pkg.name),
        deps: [...deps].sort(),
        hasTests: existsSync(join(root, dir, "test")),
      });
    }
  }
  packages.sort((a, b) => a.dir.localeCompare(b.dir));
  const raw = JSON.parse(readFileSync(join(root, "tools/ci/test-plugins.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const testPlugins: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("$")) continue;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      throw new Error(`test-plugins.json: "${k}" must be an array of plugin names`);
    }
    testPlugins[k] = v;
  }
  return { packages, testPlugins };
}

/** GitHub Actions step outputs for a plan. */
export function toOutputs(plan: Plan): Record<string, string> {
  return {
    reason: plan.reason,
    test: String(plan.test),
    // Trailing slash: vitest filters are substring matches, and `plugins/foo` would also match
    // `plugins/foo-bar`. Empty = no filter = the whole suite.
    "test-dirs": plan.testDirs.map((d) => `${d}/`).join(" "),
    "test-shards": JSON.stringify(Array.from({ length: plan.shards }, (_, i) => i + 1)),
    "test-shard-total": String(plan.shards),
    web: String(plan.web),
    visual: String(plan.visual),
    e2e: String(plan.e2e),
    docker: String(plan.docker),
    "bootstrap-network": String(plan.bootstrapNetwork),
  };
}
