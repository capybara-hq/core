import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Finding } from "./source.js";

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
 */

export const TEST_PLUGINS_FILE = "tools/ci/test-plugins.json";
const IGNORE_FILE = "test-plugins-check: ignore-file";
const TEST_ROOTS = ["test", "e2e"];
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const PATH_REF = /(["'`}])((?:\.\.\/)*)plugins\/(\$\{|[a-z0-9][a-z0-9._-]*(?=[/"'`]))/g;
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

export function checkTestPlugins(root: string): Finding[] {
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
        if (source.includes(IGNORE_FILE)) continue;
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
