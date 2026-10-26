import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { collectImports, type Finding, isParseError, parseFile } from "./source.js";

/**
 * Tests that load an official plugin (`plugins/<name>`) by path or by package name must say so, or a
 * diff-based CI run would skip them when only that plugin changed: either the owning package declares
 * the plugin as a dependency, or tools/ci/test-plugins.json lists it under the test root
 * (`<package dir>/test`, or `<package dir>/e2e`).
 *
 * The mapping file is used instead of devDependencies on purpose: pnpm propagates dependents
 * transitively (a kernel devDependency on a plugin would make every plugin change rerun every
 * package that depends on the kernel), apps/web may depend only on @capybara-hq/design, and
 * kernel -> plugin -> testing -> kernel would add dependency cycles.
 *
 * What counts as a reference (a text scan, conservative: mentions in comments count too):
 * - a string or template whose text is `../…/plugins/<name>` and resolves to the repo's plugins dir;
 * - a string or template that starts with `plugins/<name>` (joined onto the repo root), or
 *   `${…}plugins/<name>`; URL paths such as `/api/…/plugins/<name>` start with `/` and don't count;
 * - an import / require / resolve of `@capybara-hq/plugin-<name>`.
 * A path whose plugin name is interpolated (`plugins/${name}`) is reported: write each path literally.
 *
 * A file whose plugin paths are only data (e.g. synthetic diffs in tools/ci's tests) opts out with a
 * comment containing `test-plugins-check: ignore-file`, followed by the reason.
 *
 * Two boundary rules for the move of the official plugins out of core (package ecosystem spec §6.3):
 * - `test-plugins-official`: a test root of a package outside `plugins/` loads no official plugin
 *   except those that stay in core ({@link CORE_PLUGINS}) and the {@link OFFICIAL_EXCEPTIONS}, each
 *   with its reason. A real plugin's behaviour is tested in `plugins/<name>/test`; the kernel side
 *   of a contract is tested on a core fake (`@capybara-hq/testing` fixtures).
 * - `plugin-test-imports`: a file under `plugins/<name>/test` reaches nothing in core, so the tests
 *   keep working once the plugin lives in its own repository: no import of an `@capybara-hq/*`
 *   package other than {@link PLUGIN_TEST_PACKAGES} and the plugin itself, no relative import or
 *   path string that leaves the plugin directory, and no repo-root path into `packages/` or
 *   `apps/`. A kernel facility a plugin test needs is exported by `@capybara-hq/testing`.
 */

export const TEST_PLUGINS_FILE = "tools/ci/test-plugins.json";

/** Official plugins that stay in core and that core tests may load (spec §6.1). */
export const CORE_PLUGINS = ["model-fake"];

/** A core test file allowed to load official plugins while they still live in core. */
export interface OfficialException {
  /** Repo-relative path of the test file. */
  file: string;
  plugins: string[];
  reason: string;
}

export const OFFICIAL_EXCEPTIONS: OfficialException[] = [
  {
    file: "tools/checks/test/bootstrap.test.ts",
    plugins: ["object-store-s3", "openai-compatible"],
    reason:
      "packages/kernel/bootstrap.json pins these plugins as workspace entries until they are " +
      "published; the test packs the real manifest's plugin directories",
  },
  {
    file: "apps/web/e2e/global-setup.ts",
    plugins: ["connector-openapi", "example-board"],
    reason:
      "loaded for connector-openapi-wizard.spec.ts and embed-board.spec.ts, which stay in core " +
      "until phase A3b decides their home (Ruling 4 of the phase A3a ledger)",
  },
];

/**
 * `@capybara-hq/*` packages a plugin test may import besides the plugin itself: the SDK, the test
 * helpers, and model-fake (the scripted model provider that stays in core and is published), which
 * a test loads by package name to drive agent runs.
 */
export const PLUGIN_TEST_PACKAGES = [
  "@capybara-hq/plugin-sdk",
  "@capybara-hq/testing",
  "@capybara-hq/plugin-model-fake",
];

export interface TestPluginsOptions {
  /** Defaults to {@link CORE_PLUGINS}. */
  allowedInCore?: string[];
  /** Defaults to {@link OFFICIAL_EXCEPTIONS}. */
  exceptions?: OfficialException[];
}
const IGNORE_FILE = "test-plugins-check: ignore-file";
const TEST_ROOTS = ["test", "e2e"];
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const PATH_REF = /(["'`}])((?:\.\.\/)*)plugins\/(\$\{|[a-z0-9][a-z0-9._-]*(?=[/"'`]))/g;
/** A relative path in a string or template literal (`./x`, `../x`). */
const RELATIVE_STRING = /(["'`])(\.{1,2}\/[^"'`$]*)/g;
/** A repo-root path into core: `"packages/…"`, `"apps/…"`, or after an interpolation `${root}/apps/…`. */
const ROOTED_STRING = /(?:["'`]|\}\/?)((?:packages|apps)\/[a-z0-9][^"'`$]*)/g;
const SCOPED_IMPORT = /^@capybara-hq\/[^/]+/;
const PKG_REF =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bresolve\s*\(\s*)["']@capybara-hq\/plugin-([a-z0-9][a-z0-9._-]*)(?=["'/])/g;

interface Pkg {
  dir: string;
  name: string;
  deps: Set<string>;
}

/** Workspace packages from pnpm-workspace.yaml (`dir/*` entries only). */
function workspacePackages(root: string): Pkg[] {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const bases = [...yaml.matchAll(/^\s+-\s+["']?([\w.-]+)\/\*["']?\s*$/gm)].map((m) => m[1] ?? "");
  const out: Pkg[] = [];
  for (const base of bases) {
    if (!existsSync(join(root, base))) continue;
    for (const e of readdirSync(join(root, base), { withFileTypes: true })) {
      const manifest = join(root, base, e.name, "package.json");
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
      out.push({ dir: `${base}/${e.name}`, name: String(pkg.name), deps });
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile() && SOURCE_EXT.test(e.name)) out.push(p);
  }
  return out;
}

const lineAt = (source: string, offset: number) => source.slice(0, offset).split("\n").length;

export interface PluginRef {
  plugin: string;
  line: number;
  /** The plugin name is interpolated, so it can't be resolved. */
  dynamic: boolean;
}

/** Workspace plugin references in one file (`plugin` is the directory name under plugins/). */
export function findPluginRefs(
  file: string,
  source: string,
  root: string,
  pluginByPackage: Map<string, string>,
): PluginRef[] {
  const refs: PluginRef[] = [];
  const pluginsDir = join(root, "plugins");
  for (const m of source.matchAll(PATH_REF)) {
    const ups = m[2] ?? "";
    if (ups !== "" && resolve(dirname(file), `${ups}plugins`) !== pluginsDir) continue;
    const name = m[3] ?? "";
    const line = lineAt(source, m.index ?? 0);
    refs.push(
      name === "${" ? { plugin: "", line, dynamic: true } : { plugin: name, line, dynamic: false },
    );
  }
  for (const m of source.matchAll(PKG_REF)) {
    const plugin = pluginByPackage.get(`@capybara-hq/plugin-${m[1] ?? ""}`);
    if (plugin !== undefined)
      refs.push({ plugin, line: lineAt(source, m.index ?? 0), dynamic: false });
  }
  return refs;
}

/** `plugin-test-imports` findings for one file under `plugins/<name>/test`. */
function pluginTestFindings(file: string, source: string, plugin: Pkg, root: string): Finding[] {
  const out: Finding[] = [];
  const pluginDir = join(root, plugin.dir);
  const inside = (p: string) => !relative(pluginDir, p).startsWith("..");
  const seen = new Set<number>();
  const add = (offset: number, what: string) => {
    const line = lineAt(source, offset);
    if (seen.has(line)) return;
    seen.add(line);
    out.push({
      file,
      line,
      rule: "plugin-test-imports",
      message:
        `${what}: a plugin test may use only ${PLUGIN_TEST_PACKAGES.join(", ")}, ${plugin.name} ` +
        "and files inside its plugin directory (it must keep working in its own repository); " +
        "export a missing kernel facility from @capybara-hq/testing",
    });
  };
  const parsed = parseFile(file);
  if (!isParseError(parsed)) {
    for (const { spec, start } of collectImports(parsed.program)) {
      const scoped = SCOPED_IMPORT.exec(spec)?.[0];
      if (
        scoped !== undefined &&
        scoped !== plugin.name &&
        !PLUGIN_TEST_PACKAGES.includes(scoped)
      ) {
        add(start, `imports ${spec}`);
      }
    }
  }
  for (const m of source.matchAll(RELATIVE_STRING)) {
    const p = m[2] ?? "";
    if (!inside(resolve(dirname(file), p))) add(m.index ?? 0, `${p} leaves ${plugin.dir}`);
  }
  for (const m of source.matchAll(ROOTED_STRING)) {
    add(m.index ?? 0, `${m[1] ?? ""} is a path into core`);
  }
  return out;
}

export function checkTestPlugins(root: string, opts: TestPluginsOptions = {}): Finding[] {
  const allowedInCore = new Set(opts.allowedInCore ?? CORE_PLUGINS);
  const exceptions = opts.exceptions ?? OFFICIAL_EXCEPTIONS;
  const findings: Finding[] = [];
  const mappingFile = join(root, TEST_PLUGINS_FILE);
  const mapping = existsSync(mappingFile)
    ? (JSON.parse(readFileSync(mappingFile, "utf8")) as Record<string, unknown>)
    : {};
  const packages = workspacePackages(root);
  const plugins = new Map(
    packages.filter((p) => p.dir.startsWith("plugins/")).map((p) => [p.dir.slice(8), p]),
  );
  const pluginByPackage = new Map([...plugins].map(([dir, p]) => [p.name, dir]));
  const mappingLine = (key: string) => {
    const text = existsSync(mappingFile) ? readFileSync(mappingFile, "utf8") : "";
    const i = text.indexOf(`"${key}"`);
    return i < 0 ? 1 : lineAt(text, i);
  };

  const used = new Map<string, Set<string>>();
  for (const pkg of packages) {
    for (const sub of TEST_ROOTS) {
      const key = `${pkg.dir}/${sub}`;
      const listed = mapping[key];
      const allowed = new Set(Array.isArray(listed) ? listed.map(String) : []);
      for (const file of listFiles(join(root, pkg.dir, sub))) {
        const source = readFileSync(file, "utf8");
        if (pkg.dir.startsWith("plugins/")) {
          findings.push(...pluginTestFindings(file, source, pkg, root));
        }
        if (source.includes(IGNORE_FILE)) continue;
        const rel = relative(root, file);
        const excepted = new Set(
          exceptions.filter((e) => e.file === rel).flatMap((e) => e.plugins),
        );
        const refs = findPluginRefs(file, source, root, pluginByPackage);
        for (const r of refs) {
          if (r.dynamic) {
            findings.push({
              file,
              line: r.line,
              rule: "test-plugin-dynamic",
              message:
                "plugin path with an interpolated name: write each plugin path literally so " +
                `${TEST_PLUGINS_FILE} can be checked against it`,
            });
            continue;
          }
          const target = plugins.get(r.plugin);
          if (target === undefined || target.dir === pkg.dir) continue;
          if (!used.has(key)) used.set(key, new Set());
          used.get(key)?.add(r.plugin);
          if (
            !pkg.dir.startsWith("plugins/") &&
            !allowedInCore.has(r.plugin) &&
            !excepted.has(r.plugin)
          ) {
            findings.push({
              file,
              line: r.line,
              rule: "test-plugins-official",
              message:
                `core tests may load no official plugin except ${[...allowedInCore].join(", ")} ` +
                `(loads plugins/${r.plugin}): test the plugin's behaviour in plugins/${r.plugin}/test ` +
                "and the kernel contract on a core fake (@capybara-hq/testing fixtures)",
            });
          }
          if (pkg.deps.has(target.name) || allowed.has(r.plugin)) continue;
          findings.push({
            file,
            line: r.line,
            rule: "test-plugin-undeclared",
            message:
              `loads plugins/${r.plugin}, which ${pkg.dir}/package.json doesn't depend on: add ` +
              `"${r.plugin}" to "${key}" in ${TEST_PLUGINS_FILE} so diff-based CI reruns these ` +
              "tests when the plugin changes",
          });
        }
      }
    }
  }

  for (const [key, listed] of Object.entries(mapping)) {
    if (key.startsWith("$")) continue;
    const line = mappingLine(key);
    const pkgDir = key.split("/").slice(0, -1).join("/");
    const pkg = packages.find((p) => p.dir === pkgDir);
    const validKey =
      pkg !== undefined &&
      TEST_ROOTS.includes(key.split("/").at(-1) ?? "") &&
      existsSync(join(root, key));
    if (!validKey || !Array.isArray(listed)) {
      findings.push({
        file: mappingFile,
        line,
        rule: "test-plugin-mapping",
        message: `"${key}" must be an existing <package>/test or <package>/e2e directory mapped to an array of plugin names`,
      });
      continue;
    }
    for (const name of listed.map(String)) {
      const problem = !plugins.has(name)
        ? `"${name}" is not a directory under plugins/`
        : !used.get(key)?.has(name)
          ? `no file under ${key} references plugins/${name} any more: remove it`
          : pkg.deps.has(plugins.get(name)?.name ?? "")
            ? `${pkgDir}/package.json already depends on plugins/${name}: remove it`
            : undefined;
      if (problem !== undefined) {
        findings.push({
          file: mappingFile,
          line,
          rule: "test-plugin-mapping",
          message: `"${key}": ${problem}`,
        });
      }
    }
  }
  return findings;
}
