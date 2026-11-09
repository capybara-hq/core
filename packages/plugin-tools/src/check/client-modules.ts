import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { clientEntrySource } from "../pack/client.js";
import { packageImportsOf, resolveHashImport } from "./package-imports.js";
import { collectImports, isParseError, parseFile } from "./source.js";

/** The extension's server entry (what `capybara-plugin pack` bundles into `dist/index.mjs`). */
const SERVER_ENTRY = "src/index.ts";

/** TypeScript writes `./x.js` for `./x.ts`; the packers' esbuild resolves both. */
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

/** The file a relative specifier names (esbuild's lookup: as written, `.js` -> `.ts`, extensions, `index`). */
function resolveRelative(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  if (isFile(base)) return base;
  const ext = Object.keys(JS_TO_TS).find((e) => base.endsWith(e));
  if (ext !== undefined) {
    for (const ts of JS_TO_TS[ext] ?? []) {
      const p = base.slice(0, -ext.length) + ts;
      if (isFile(p)) return p;
    }
  }
  for (const e of EXTENSIONS) if (isFile(base + e)) return base + e;
  for (const e of EXTENSIONS) if (isFile(join(base, `index${e}`))) return join(base, `index${e}`);
  return undefined;
}

/**
 * The plugin's own source files an entry reaches through relative module references (static and
 * re-exports, literal dynamic `import()`, `require`) and `#…` subpath imports (every path target of
 * every condition in the package.json `imports` map), the entry included. Package imports and
 * files outside the plugin directory or under `node_modules` are not followed. A file that does
 * not parse is kept but not followed (the state check reports it as `parse-error`).
 */
function reachable(
  dir: string,
  entry: string | undefined,
  importMap: Record<string, unknown>,
): Set<string> {
  const seen = new Set<string>();
  if (entry === undefined || !isFile(entry)) return seen;
  const inside = (p: string) => {
    const rel = relative(dir, p);
    return !rel.startsWith("..") && !rel.split(/[\\/]/).includes("node_modules");
  };
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const parsed = parseFile(file);
    if (isParseError(parsed)) continue;
    for (const { spec } of collectImports(parsed.program)) {
      // a `#…` target path is relative to the package directory
      const paths = spec.startsWith("#")
        ? resolveHashImport(spec, importMap)
            .filter((t) => t.startsWith("./") || t.startsWith("../"))
            .map((t) => resolveRelative(join(dir, "package.json"), t))
        : spec.startsWith("./") || spec.startsWith("../")
          ? [resolveRelative(file, spec)]
          : [];
      for (const target of paths) {
        if (target !== undefined && inside(target) && !seen.has(target)) queue.push(target);
      }
    }
  }
  return seen;
}

/**
 * The plugin's **browser-only** modules: the client entry (`src/client.tsx` or `src/client.ts`)
 * and every source file it reaches through relative and `#…` imports, minus every file the server entry
 * (`src/index.ts`) reaches. A module both entries reach runs on the server too; a module neither
 * reaches is not known to be browser code. Both count as server code. Absolute paths.
 */
export function browserOnlyModules(pluginDir: string): Set<string> {
  const dir = resolve(pluginDir);
  const importMap = packageImportsOf(dir);
  const client = reachable(dir, clientEntrySource(dir), importMap);
  if (client.size === 0) return client;
  const server = reachable(dir, join(dir, SERVER_ENTRY), importMap);
  return new Set([...client].filter((f) => !server.has(f)));
}
