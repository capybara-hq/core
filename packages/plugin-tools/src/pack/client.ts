import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, posix } from "node:path";
import {
  CLIENT_API_VERSION,
  CLIENT_ASSET_TYPES,
  CLIENT_LIMITS,
  type PluginClientSection,
} from "@capybara-hq/plugin-sdk";
import { init as lexerInit, parse as lexerParse } from "es-module-lexer";
import { type BuildFailure, build } from "esbuild";

/** What the browser bundle may import: the host provides these four (spec §4.2). */
export const CLIENT_EXTERNALS = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "@capybara-hq/plugin-client",
] as const;

/**
 * A pack or check failure that belongs to a named rule (`client-size`, `client-undeclared`, …):
 * `capybara-plugin check` reports it under that rule instead of the generic `plugin-pack`.
 */
export class PackRuleError extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message);
    this.name = "PackRuleError";
  }
}

/** Client sources of a plugin dir: `src/client.tsx` or `src/client.ts`, `client/styles/*.css`, `client/assets/**`. */
export function clientEntrySource(dir: string): string | undefined {
  for (const f of ["src/client.tsx", "src/client.ts"]) {
    if (existsSync(join(dir, f))) return join(dir, f);
  }
  return undefined;
}

async function filesUnder(root: string, base = root): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p, base)));
    else if (e.isFile())
      out.push(
        p
          .slice(base.length + 1)
          .split("\\")
          .join("/"),
      );
    else throw new Error(`${p}: only regular files can be packed`);
  }
  return out.sort();
}

/** The CSS files (sorted) of `client/styles/`, as base names. */
export async function clientStyleNames(dir: string): Promise<string[]> {
  const root = join(dir, "client/styles");
  if (!existsSync(root)) return [];
  return (await readdir(root, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith(".css"))
    .map((e) => e.name)
    .sort();
}

/** Whether the plugin dir has any client code (entry, styles or assets). */
export async function hasClientSources(dir: string): Promise<boolean> {
  return (
    clientEntrySource(dir) !== undefined ||
    (await clientStyleNames(dir)).length > 0 ||
    (await filesUnder(join(dir, "client/assets"))).length > 0
  );
}

/** How a stylesheet names one of the plugin's assets (styles are served next to `assets/`). */
const ASSETS_URL = "../assets/";

/**
 * The problem of one URL of a stylesheet (escapes decoded, trimmed), or undefined when it is a
 * `#fragment`, a `data:` URL or `../assets/<path>` naming one of `assets` (paths relative to
 * `client/assets/`) exactly. Every other URL is refused, relative ones too: the stylesheet is served
 * from the kernel's `/api/v1/client/<plugin>/<build>/styles/`, where `../../../../…` reaches the
 * kernel's own routes with the viewer's cookies. The kernel checks the same at import.
 */
export function cssUrlProblem(u: string, assets: ReadonlySet<string>): string | undefined {
  if (u.startsWith("#") || /^data:/i.test(u)) return undefined;
  if (u.startsWith(ASSETS_URL) && assets.has(u.slice(ASSETS_URL.length))) return undefined;
  return `url(${u}) is not allowed; use ../assets/<a file of client/assets>, a data: URL or a #fragment`;
}

/**
 * CSS rule of the packer (spec §4.1): no `@import`, and every `url()` and string of `image-set()`
 * (but a `type()` argument) passes {@link cssUrlProblem} for the plugin's `assets` (paths relative
 * to `client/assets/`). Returns the problem text, or undefined.
 */
export function cssRemoteProblem(css: string, assets: ReadonlySet<string>): string | undefined {
  // escapes (`\68 ttps:`, `u\72l(`) are decoded first, so a spelled-out URL is read as it would be
  const bare = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-f]{1,6})[ \t\n]?|\\([^\n])/gi, (_m, hex?: string, ch?: string) => {
      if (hex === undefined) return ch ?? "";
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "\ufffd";
    });
  if (/@import\b/i.test(bare)) {
    return "@import is not allowed (a remote stylesheet is not integrity-pinned); inline the rules";
  }
  for (const m of bare.matchAll(/url\(\s*(["']?)([^)"']*)\1\s*\)/gi)) {
    const problem = cssUrlProblem((m[2] ?? "").trim(), assets);
    if (problem !== undefined) return problem;
  }
  // image-set() takes plain strings as URLs
  for (const m of bare.matchAll(/(?:-webkit-)?image-set\(([^;{}]*)\)/gi)) {
    for (const q of (m[1] ?? "").matchAll(/(type\(\s*)?(["'])((?:\\.|(?!\2)[^\\])*)\2/gi)) {
      if (q[1] !== undefined) continue; // type("image/png") names a type, not a URL
      const problem = cssUrlProblem((q[3] ?? "").trim(), assets);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}

const sha384 = (data: Uint8Array) => `sha384-${createHash("sha384").update(data).digest("base64")}`;

/**
 * An asset path the kernel can look up by exact key: segments of `[A-Za-z0-9._-]` only (no `%`,
 * space, `?`, `#`, backslash or non-ASCII character), no `.` / `..` / empty segment, a file stem.
 */
export function assetPathProblem(rel: string): string | undefined {
  const segs = rel.split("/");
  if (rel.includes("%")) return "contains %; use plain characters";
  if (rel.includes("\\")) return "contains a backslash";
  if (segs.some((s) => s === "" || s === "." || s === "..")) {
    return "has an empty, . or .. segment";
  }
  if (!segs.every((s) => /^[A-Za-z0-9._-]+$/.test(s))) {
    return "may use only letters, digits, . _ - and / (no spaces, ?, # or non-ASCII characters)";
  }
  const name = segs[segs.length - 1] as string;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "has an empty file stem or no extension";
  const ext = name.slice(dot).toLowerCase();
  if (!Object.hasOwn(CLIENT_ASSET_TYPES, ext)) {
    return `has an unsupported type; allowed: ${Object.keys(CLIENT_ASSET_TYPES).join(" ")}`;
  }
  return undefined;
}

async function importIssues(code: string): Promise<string[]> {
  await lexerInit;
  const [imports] = lexerParse(code);
  const issues: string[] = [];
  for (const i of imports) {
    if (i.d === -2) continue; // import.meta
    if (i.n === undefined) {
      issues.push("a dynamic import with a non-literal specifier");
    } else if (!(CLIENT_EXTERNALS as readonly string[]).includes(i.n)) {
      issues.push(`imports "${i.n}", which the host does not provide`);
    }
  }
  return [...new Set(issues)];
}

const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("_")));

const SKIP = Symbol("capybara-skip");

/**
 * Specifiers the client bundle must never contain even when they resolve (a second React or the
 * SDK inside the bundle): `node:*`, `react-dom` subpaths (`react-dom/server`, `/client`), `react`
 * subpaths other than `react/jsx-runtime`, and every `@capybara-hq/*` but `@capybara-hq/plugin-client`.
 */
function forbiddenSpecifier(spec: string): string | undefined {
  const refuse = (why: string) => `import "${spec}" is not allowed: ${why}`;
  if (spec.startsWith("node:")) return `Node builtin "${spec}" is not available in the browser`;
  if (spec.startsWith("react-dom/")) return refuse("only react-dom itself is provided by the host");
  if (spec.startsWith("react/") && spec !== "react/jsx-runtime") {
    return refuse("only react and react/jsx-runtime are provided by the host");
  }
  if (spec.startsWith("@capybara-hq/") && spec !== "@capybara-hq/plugin-client") {
    return refuse("a client bundle may import only @capybara-hq/plugin-client");
  }
  return undefined;
}

const forbidden = (message: string) => new PackRuleError("client-import-forbidden", message);

/**
 * Builds a plugin's client code into `<stage>/package/dist/client/` and returns the client section
 * (null when the plugin has no client code):
 * - `src/client.tsx` / `src/client.ts` → `client.mjs` (esbuild, browser, ESM, es2022, minified; only
 *   {@link CLIENT_EXTERNALS} stay bare imports; Node builtins, unresolved packages and any other
 *   import are `client-import-forbidden`);
 * - `client/styles/*.css` (sorted) → `styles/<name>.css`, each wrapped in `@layer extensions { … }`
 *   (`client-css-remote` for `@import` and absolute `url()`);
 * - `client/assets/**` → `assets/**` (allowed types, plain paths);
 * - the sizes against `CLIENT_LIMITS` (`client-size`) and a sha384 of every written file.
 */
export async function buildClient(dir: string, stage: string): Promise<PluginClientSection | null> {
  const entrySrc = clientEntrySource(dir);
  const styleNames = await clientStyleNames(dir);
  const assetRels = await filesUnder(join(dir, "client/assets"));
  if (entrySrc === undefined && styleNames.length === 0 && assetRels.length === 0) return null;
  if (entrySrc === undefined && styleNames.length === 0) {
    throw new Error("client/assets has files but there is no entry or style file to use them");
  }

  const outRoot = join(stage, "package", "dist", "client");
  const written = new Map<string, Buffer>(); // "./dist/client/…" → bytes
  const put = async (rel: string, data: Buffer) => {
    const file = join(outRoot, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
    written.set(`./dist/client/${rel}`, data);
  };
  const tooBig = (what: string, bytes: number, limit: number) =>
    new PackRuleError("client-size", `${what} is ${bytes} bytes; the limit is ${limit}`);

  let entry: string | undefined;
  if (entrySrc !== undefined) {
    let result: Awaited<ReturnType<typeof build>>;
    try {
      result = await build({
        absWorkingDir: dir,
        entryPoints: [entrySrc],
        outfile: join(outRoot, "client.mjs"),
        bundle: true,
        platform: "browser",
        format: "esm",
        target: "es2022",
        minify: true,
        jsx: "automatic",
        external: [...CLIENT_EXTERNALS],
        plugins: [
          {
            name: "capybara-client-no-builtins",
            setup(b) {
              b.onResolve({ filter: /^[^./]/ }, async (args) => {
                if (args.pluginData === SKIP) return undefined;
                const bad = forbiddenSpecifier(args.path);
                if (bad !== undefined) return { errors: [{ text: bad }] };
                // a bare builtin name (`events`, `buffer`) is allowed when an npm package of that
                // name resolves; `node:*` never is
                const top = args.path.split("/")[0] as string;
                if (!args.path.startsWith("node:") && BUILTINS.has(top)) {
                  const r = await b.resolve(args.path, {
                    resolveDir: args.resolveDir,
                    importer: args.importer,
                    kind: args.kind,
                    pluginData: SKIP,
                  });
                  if (r.errors.length > 0) {
                    return {
                      errors: [
                        { text: `Node builtin "${args.path}" is not available in the browser` },
                      ],
                    };
                  }
                }
                return undefined;
              });
            },
          },
        ],
        charset: "utf8",
        logLevel: "silent",
        legalComments: "none",
        metafile: true,
        write: false,
      });
    } catch (e) {
      const errors = (e as BuildFailure).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const texts = errors.map((x) => x.text);
        if (texts.every((t) => /Could not resolve|Node builtin|is not allowed/.test(t))) {
          throw forbidden(`client entry: ${texts.join("; ")}`);
        }
        throw new Error(`client entry: esbuild failed: ${texts.join("; ")}`);
      }
      throw e;
    }
    const out = result.outputFiles?.find((f) => f.path.endsWith("client.mjs"));
    if (out === undefined) throw new Error("client entry: esbuild produced no output");
    const code = Buffer.from(out.contents);
    const issues = await importIssues(code.toString("utf8"));
    if (issues.length > 0) throw forbidden(`client entry: ${issues.join("; ")}`);
    if (code.length > CLIENT_LIMITS.entryBytes) {
      throw tooBig("client entry", code.length, CLIENT_LIMITS.entryBytes);
    }
    await put("client.mjs", code);
    entry = "./dist/client/client.mjs";
  }

  const styles: string[] = [];
  // the URLs a stylesheet may use: ../assets/<path> of a file of client/assets
  const assetSet = new Set(assetRels);
  if (styleNames.length > CLIENT_LIMITS.styleFiles) {
    throw tooBig("client/styles file count", styleNames.length, CLIENT_LIMITS.styleFiles);
  }
  for (const name of styleNames) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.css$/.test(name)) {
      throw new Error(`client/styles/${name}: use letters, digits, . _ - in the file name`);
    }
    const css = await readFile(join(dir, "client/styles", name), "utf8");
    const problem = cssRemoteProblem(css, assetSet);
    if (problem !== undefined) {
      throw new PackRuleError("client-css-remote", `client/styles/${name}: ${problem}`);
    }
    const wrapped = Buffer.from(`@layer extensions {\n${css.trimEnd()}\n}\n`);
    if (wrapped.length > CLIENT_LIMITS.styleBytes) {
      throw tooBig(`client/styles/${name}`, wrapped.length, CLIENT_LIMITS.styleBytes);
    }
    await put(`styles/${name}`, wrapped);
    styles.push(`./dist/client/styles/${name}`);
  }

  const assets: string[] = [];
  if (assetRels.length > CLIENT_LIMITS.assetFiles) {
    throw tooBig("client/assets file count", assetRels.length, CLIENT_LIMITS.assetFiles);
  }
  for (const rel of assetRels) {
    const problem = assetPathProblem(rel);
    if (problem !== undefined) throw new Error(`client/assets/${rel}: ${problem}`);
    const abs = join(dir, "client/assets", rel);
    const size = (await stat(abs)).size;
    if (size > CLIENT_LIMITS.assetBytes) {
      throw tooBig(`client/assets/${rel}`, size, CLIENT_LIMITS.assetBytes);
    }
    await put(posix.join("assets", rel), await readFile(abs));
    assets.push(`./dist/client/assets/${rel}`);
  }

  let total = 0;
  for (const data of written.values()) total += data.length;
  if (total > CLIENT_LIMITS.totalBytes) {
    throw tooBig("the client section", total, CLIENT_LIMITS.totalBytes);
  }

  const integrity: Record<string, string> = {};
  for (const [path, data] of written) integrity[path] = sha384(data);
  return {
    ...(entry !== undefined && { entry }),
    ...(styles.length > 0 && { styles }),
    ...(assets.length > 0 && { assets }),
    integrity,
    apiVersion: CLIENT_API_VERSION,
  };
}
