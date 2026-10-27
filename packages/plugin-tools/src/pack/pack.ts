import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import {
  checkEntryImports,
  defineExtension,
  type ExtensionManifest,
  HOST_PROVIDED_PACKAGES,
  PLUGIN_MANIFEST_FILE,
  type PluginExtensionSection,
  type PluginManifest,
  parseAgentTemplate,
  parseConnectorTemplateFile,
  parsePluginManifest,
  SDK_VERSION,
  staticManifestOf,
  validatePluginPackageJsonFor,
} from "@capybara-hq/plugin-sdk";
import { init as lexerInit, parse as lexerParse } from "es-module-lexer";
import { build, type Plugin } from "esbuild";
import { pack as tarPack } from "tar-stream";

/** The extension entry the packer writes (relative to the package root). */
const EXTENSION_ENTRY = "dist/index.mjs";

/**
 * The result of packing: the tgz path, its hex sha256 and the `.capybara-plugin/plugin.json`
 * written into it (the extension's static manifest is `manifest.extension?.manifest`).
 */
export interface PackResult {
  file: string;
  sha256: string;
  manifest: PluginManifest;
  /**
   * Entries of the plugin's package.json `files` that are not in the package (directories other than
   * `dist` / `migrations` / `ui` / `skills` / `connectors` / `.capybara-plugin`, globs, missing paths). Callers print them; `check:plugin-pack` fails.
   */
  dropped: string[];
}

/**
 * 临时目录前缀。临时目录建在系统临时目录下（不在插件源码树里，免得源码扫描读到半成品）；bundle 里对宿主包的
 * import 经临时目录里指向插件解析结果的 `node_modules` 软链解析。
 */
export const STAGING_PREFIX = ".capybara-pack-";

/**
 * 在临时目录下建 `node_modules/<宿主包>` 软链，指向从插件目录按 Node 规则向上找到的那份（找不到的跳过，
 * 导入产物时照常报错）。软链在 `package/` 之外，不进包。
 */
async function linkHostPackages(dir: string, stage: string): Promise<void> {
  for (const name of HOST_PROVIDED_PACKAGES) {
    let found: string | undefined;
    for (let d = dir; ; d = dirname(d)) {
      const candidate = join(d, "node_modules", name);
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
      if (dirname(d) === d) break;
    }
    if (found === undefined) continue;
    const link = join(stage, "node_modules", name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(await realpath(found), link, "dir");
  }
}

/** npm pack 使用的固定 mtime（让同样的输入产出字节相同的包）。 */
const FIXED_MTIME = new Date("1985-10-26T08:15:00Z");

/** 动态加载 bundle 的入口（单独成函数，便于测试与内核的加载方式保持一致）。 */
const importBundle = async (file: string) =>
  (await import(pathToFileURL(file).href)) as { default?: unknown };

const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("_")));

/**
 * esbuild 插件：Node 内置模块（带不带 `node:` 都算）一律外置并改写成 `node:` 前缀，
 * 这样产物的 import / require 只会出现 `node:*`，满足 C11 的白名单。
 */
const nodeBuiltins: Plugin = {
  name: "capybara-node-builtins",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      const bare = args.path.startsWith("node:") ? args.path.slice(5) : args.path;
      const top = bare.split("/")[0] as string;
      if (args.path.startsWith("node:") || BUILTINS.has(bare) || BUILTINS.has(top)) {
        return { path: `node:${bare}`, external: true };
      }
      return undefined;
    });
  },
};

/**
 * 打进来的 CJS 依赖要用 `require` / `__dirname` / `__filename`，ESM 里都没有：`require` 用 `node:module` 的
 * createRequire 补上（esbuild 的 `__require` 垫片按 `typeof require` 取它）；后两者在横幅里以不会撞名的名字定义，
 * 再经 `define` 把对全局 `__dirname` / `__filename` 的引用替换过去（指向包内的 `dist/`）。
 */
const BANNER = [
  'import { createRequire as __capybaraCreateRequire } from "node:module";',
  'import { fileURLToPath as __capybaraFileURLToPath } from "node:url";',
  'import { dirname as __capybaraPathDirname } from "node:path";',
  "const require = __capybaraCreateRequire(import.meta.url);",
  "const __capybara_filename = __capybaraFileURLToPath(import.meta.url);",
  "const __capybara_dirname = __capybaraPathDirname(__capybara_filename);",
].join("\n");
const DEFINE = { __dirname: "__capybara_dirname", __filename: "__capybara_filename" };

/** 用 es-module-lexer 列出模块的 import（与内核安装时的扫描一致），交给 SDK 的白名单核对。 */
async function importIssues(code: string): Promise<string[]> {
  await lexerInit;
  const [imports] = lexerParse(code);
  return checkEntryImports(
    imports
      .filter((i) => i.d !== -2)
      .map((i) => ({ name: i.n ?? "", dynamic: i.d > -1, literal: i.n !== undefined })),
  );
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p, base)));
    else if (e.isFile()) out.push(relative(base, p).split("\\").join("/"));
    else throw new Error(`${p}: only regular files can be packed`);
  }
  return out;
}

/**
 * The gzip header's OS byte (RFC 1952 offset 9). zlib fills it from the host it was built for (0x13
 * on macOS, 0x03 on Unix, 0x0a on Windows), the only byte of the pack that depended on the host: it
 * is pinned to Unix so the same source and lockfile give the same tgz on every platform. Readers
 * ignore it.
 */
const GZIP_OS_BYTE = 9;
const GZIP_OS_UNIX = 0x03;

/**
 * Gzips the tar: entries sorted by path, `package/` prefix, 0644, fixed mtime, no owner; the gzip
 * header has mtime 0 and the Unix OS byte ({@link GZIP_OS_UNIX}).
 */
async function makeTgz(files: Map<string, Buffer>): Promise<Buffer> {
  const p = tarPack();
  const chunks: Buffer[] = [];
  const collected = (async () => {
    for await (const c of p) chunks.push(c as Buffer);
  })();
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path) as Buffer;
    await new Promise<void>((res, rej) => {
      p.entry(
        {
          name: `package/${path}`,
          size: data.length,
          mode: 0o644,
          mtime: FIXED_MTIME,
          uid: 0,
          gid: 0,
          uname: "",
          gname: "",
          type: "file",
        },
        data,
        (err) => (err ? rej(err) : res()),
      );
    });
  }
  p.finalize();
  await collected;
  const gz = await promisify(gzip)(Buffer.concat(chunks), { level: 9 });
  gz[GZIP_OS_BYTE] = GZIP_OS_UNIX;
  return gz;
}

/**
 * npm metadata copied verbatim from the plugin's package.json when present (F4). They only describe
 * the package on npm; `repository` (with `directory`) is required for npm provenance.
 */
export const METADATA_FIELDS = ["description", "repository", "homepage", "keywords"] as const;

const pick = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** Third-party license notices of the bundled dependencies (written only when there are any). */
export const NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";

const LICENSE_FILE_RE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i;

/** Nearest `LICENSE` from the plugin dir up to the workspace root (the dir with pnpm-workspace.yaml). */
function findLicense(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    const f = join(d, "LICENSE");
    if (existsSync(f)) return f;
    if (existsSync(join(d, "pnpm-workspace.yaml")) || dirname(d) === d) return undefined;
  }
}

/** `files` entries shipped (or deliberately not shipped) by other means than {@link extraFiles}. */
const SHIPPED_ELSEWHERE = [
  "dist",
  "migrations",
  "ui",
  "skills",
  "connectors",
  "agents",
  ".capybara-plugin",
  "README.md",
  "LICENSE",
  "NOTICE",
];

/**
 * Files shipped besides the bundle: `README.md` and `LICENSE` (the plugin's own, else the workspace's),
 * the `NOTICE` next to that `LICENSE` if there is one (Apache-2.0 4(d) asks redistributions to carry it),
 * plus every plain file named in the package.json `files` list at the plugin root (e.g. slack's
 * `app-manifest.yaml`). `dist` is replaced by the bundle, `migrations` / `ui` are handled by the
 * extension, `skills` / `connectors` / `agents` by {@link contentFiles} and `.capybara-plugin` is written by the
 * packer; any other entry (a directory, a glob, a missing path) is reported in `dropped`.
 */
async function extraFiles(
  dir: string,
  listed: unknown,
): Promise<{ files: Map<string, Buffer>; dropped: string[] }> {
  const files = new Map<string, Buffer>();
  const dropped: string[] = [];
  if (existsSync(join(dir, "README.md"))) {
    files.set("README.md", await readFile(join(dir, "README.md")));
  }
  const license = findLicense(dir);
  if (license !== undefined) files.set("LICENSE", await readFile(license));
  const notice = license === undefined ? undefined : join(dirname(license), "NOTICE");
  if (notice !== undefined && existsSync(notice)) files.set("NOTICE", await readFile(notice));
  for (const raw of Array.isArray(listed) ? listed : []) {
    const entry = String(raw).replace(/^\.\//, "").replace(/\/+$/, "");
    if (SHIPPED_ELSEWHERE.includes(entry)) continue;
    const p = join(dir, entry);
    const plain = /^[\w.-]+$/.test(entry) && existsSync(p) && (await stat(p)).isFile();
    if (plain) files.set(entry, await readFile(p));
    else dropped.push(entry);
  }
  return { files, dropped };
}

/** Package root of a bundled input under node_modules (`.../node_modules/@scope/name` or `/name`). */
function packageRootOf(abs: string): string | undefined {
  const m = /^(.*[/\\]node_modules[/\\](?:@[^/\\]+[/\\])?[^/\\]+)/.exec(abs);
  return m?.[1];
}

/**
 * THIRD-PARTY-NOTICES.txt for the npm packages esbuild bundled (from the metafile inputs): name,
 * version, license and the package's license / notice files, sorted, so MIT / BSD notices that require
 * reproduction survive bundling. Undefined when nothing third-party was bundled.
 */
async function thirdPartyNotices(dir: string, inputs: string[]): Promise<string | undefined> {
  const roots = new Set<string>();
  for (const i of inputs) {
    const r = packageRootOf(resolve(dir, i));
    if (r !== undefined) roots.add(r);
  }
  const entries: { id: string; text: string }[] = [];
  for (const root of roots) {
    const pj = join(root, "package.json");
    if (!existsSync(pj)) continue;
    const pkg = JSON.parse(await readFile(pj, "utf8")) as Record<string, unknown>;
    const id = `${String(pkg.name)}@${String(pkg.version)}`;
    const license = typeof pkg.license === "string" ? pkg.license : "UNKNOWN";
    const texts: string[] = [];
    for (const f of (await readdir(root)).filter((n) => LICENSE_FILE_RE.test(n)).sort()) {
      if ((await stat(join(root, f))).isFile())
        texts.push((await readFile(join(root, f), "utf8")).trim());
    }
    const body =
      texts.length > 0
        ? texts.join("\n\n")
        : `(no license file in the package; license: ${license})`;
    entries.push({ id, text: `${id} (${license})\n\n${body}` });
  }
  if (entries.length === 0) return undefined;
  const unique = [...new Map(entries.map((e) => [e.id, e])).values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const rule = "-".repeat(72);
  return `This package bundles the third-party software listed below. Their license notices follow.\n\n${unique
    .map((e) => `${rule}\n${e.text}\n`)
    .join("\n")}`;
}

/** npm pack 的文件名：`@scope/name` → `scope-name-<version>.tgz`。 */
const tgzName = (name: string, version: string) =>
  `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const stripDot = (p: string) => p.replace(/^\.\//, "");

/**
 * Reads and validates the source `.capybara-plugin/plugin.json` (without `extension`, which the
 * packer writes).
 */
async function readSourceManifest(dir: string, label: string): Promise<PluginManifest> {
  const file = join(dir, PLUGIN_MANIFEST_FILE);
  if (!existsSync(file)) {
    throw new Error(`${label}: missing ${PLUGIN_MANIFEST_FILE} (the plugin manifest)`);
  }
  const raw = await readFile(file, "utf8");
  let data: unknown = raw;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    // parsePluginManifest reports the JSON error.
  }
  if (isObj(data) && "extension" in data) {
    throw new Error(
      `${label}: ${PLUGIN_MANIFEST_FILE}: extension is written by the packer; remove it from the source`,
    );
  }
  const m = parsePluginManifest(data);
  if ("errors" in m) throw new Error(`${label}: ${PLUGIN_MANIFEST_FILE}: ${m.errors.join("; ")}`);
  return m;
}

/**
 * The skills, connector templates, agent templates and icons of a plugin: every file under
 * `skills/`, every `connectors/*.json` and every `agents/*.md` when present, plus the paths
 * `plugin.json` lists (`skills`, `connectorTemplates`, `agents`, `icon`) and the template icons.
 * Listed paths must exist, connector template files must parse ({@link parseConnectorTemplateFile})
 * and agent templates too ({@link parseAgentTemplate}), so a package that lies about its content
 * fails here instead of at import. `skills` / `templates` / `agents` count what the kernel will see
 * (the listed ones, else the scanned ones).
 */
async function contentFiles(
  dir: string,
  label: string,
  m: PluginManifest,
): Promise<{ files: Map<string, Buffer>; skills: number; templates: number; agents: number }> {
  const files = new Map<string, Buffer>();
  const addTree = async (rel: string) => {
    for (const f of await listFiles(join(dir, rel))) {
      files.set(posix.join(rel, f), await readFile(join(dir, rel, f)));
    }
  };
  const addFile = async (rel: string, what: string) => {
    const p = join(dir, rel);
    if (!existsSync(p) || !(await stat(p)).isFile()) {
      throw new Error(`${label}: ${what} ./${rel} does not exist`);
    }
    files.set(rel, await readFile(p));
  };

  let scannedSkills = 0;
  if (existsSync(join(dir, "skills"))) {
    await addTree("skills");
    scannedSkills = [...files.keys()].filter((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p)).length;
  }
  for (const s of m.skills ?? []) {
    const rel = stripDot(s.path);
    if (!existsSync(join(dir, rel, "SKILL.md"))) {
      throw new Error(`${label}: skill ${s.path} has no SKILL.md`);
    }
    await addTree(rel);
  }

  const templates: string[] = [];
  if (existsSync(join(dir, "connectors"))) {
    for (const e of (await readdir(join(dir, "connectors"), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (e.isFile() && e.name.endsWith(".json")) templates.push(`connectors/${e.name}`);
    }
  }
  const listedTemplates = (m.connectorTemplates ?? []).map((c) => stripDot(c.path));
  for (const rel of new Set([...templates, ...listedTemplates])) {
    await addFile(rel, "connector template");
    const t = parseConnectorTemplateFile((files.get(rel) as Buffer).toString("utf8"));
    if ("errors" in t) throw new Error(`${label}: ${rel}: ${t.errors.join("; ")}`);
    if (t.icon !== undefined) await addFile(stripDot(t.icon), `${rel} icon`);
  }
  if (m.icon !== undefined) await addFile(stripDot(m.icon), "icon");

  // Agent templates: listed, else scanned from agents/*.md (sub-agents spec §16.2)
  const agents: string[] = [];
  if (m.agents === undefined && existsSync(join(dir, "agents"))) {
    for (const e of (await readdir(join(dir, "agents"), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (e.isFile() && e.name.endsWith(".md")) agents.push(`agents/${e.name}`);
    }
  }
  for (const a of m.agents ?? []) agents.push(stripDot(a.path));
  for (const rel of agents) {
    await addFile(rel, "agent template");
    const t = parseAgentTemplate((files.get(rel) as Buffer).toString("utf8"));
    if ("errors" in t) throw new Error(`${label}: ${rel}: ${t.errors.join("; ")}`);
  }

  return {
    files,
    skills: m.skills?.length ?? scannedSkills,
    templates: m.connectorTemplates?.length ?? templates.length,
    agents: agents.length,
  };
}

/**
 * Bundles the extension `src/index.ts`:
 * 1. esbuild bundles it into the single-file ESM `dist/index.mjs` (platform node, target node24),
 *    with only {@link HOST_PROVIDED_PACKAGES} and Node builtins (rewritten to `node:*`) external;
 *    CJS dependencies work through the createRequire banner;
 * 2. the bundle's imports are checked (allowlist, no non-literal dynamic import), the bundle is
 *    imported and its default export goes through defineExtension; `staticManifestOf` gives the
 *    static manifest, whose version must equal the package.json version;
 * 3. `migrations/` (when the manifest declares migrations, which must resolve to the plugin's
 *    `migrations/`), `ui/` (when present) and THIRD-PARTY-NOTICES.txt join the files.
 *
 * Temporary files live in `.capybara-pack-*` under the system temp dir and are removed afterwards.
 */
async function bundleExtension(
  dir: string,
  label: string,
  pkgVersion: unknown,
): Promise<{ files: Map<string, Buffer>; extension: PluginExtensionSection }> {
  const stage = await realpath(await mkdtemp(join(tmpdir(), STAGING_PREFIX)));
  try {
    await linkHostPackages(dir, stage);
    const entryOut = join(stage, "package", EXTENSION_ENTRY);
    const result = await build({
      absWorkingDir: dir,
      entryPoints: [join(dir, "src/index.ts")],
      outfile: entryOut,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      external: [...HOST_PROVIDED_PACKAGES],
      plugins: [nodeBuiltins],
      banner: { js: BANNER },
      define: DEFINE,
      charset: "utf8",
      logLevel: "silent",
      metafile: true,
      // Notices of bundled dependencies go to THIRD-PARTY-NOTICES.txt (built from the metafile).
      legalComments: "none",
    });
    if (result.errors.length > 0) {
      throw new Error(`${label}: esbuild failed: ${result.errors.map((e) => e.text).join("; ")}`);
    }
    const code = await readFile(entryOut);
    const issues = await importIssues(code.toString("utf8"));
    if (issues.length > 0) throw new Error(`${label}: ${issues.join("; ")}`);

    const mod = await importBundle(entryOut);
    if (typeof mod.default !== "object" || mod.default === null) {
      throw new Error(`${label}: the bundle has no default export object`);
    }
    const m = defineExtension(mod.default as ExtensionManifest);
    if (m.version !== pkgVersion) {
      throw new Error(
        `${label}: manifest version ${m.version} does not match package.json version ${String(pkgVersion)}`,
      );
    }

    const files = new Map<string, Buffer>([[EXTENSION_ENTRY, code]]);
    const extension: PluginExtensionSection = {
      entry: `./${EXTENSION_ENTRY}`,
      manifest: staticManifestOf(m),
    };
    if (m.migrations !== undefined) {
      const from = resolve(dir, "src", m.migrations);
      if (from !== join(dir, "migrations")) {
        throw new Error(
          `${label}: manifest migrations "${m.migrations}" must resolve to <plugin>/migrations`,
        );
      }
      for (const f of await listFiles(from)) {
        files.set(posix.join("migrations", f), await readFile(join(from, f)));
      }
      extension.migrations = "./migrations";
    }
    if (existsSync(join(dir, "ui"))) {
      for (const f of await listFiles(join(dir, "ui"))) {
        files.set(posix.join("ui", f), await readFile(join(dir, "ui", f)));
      }
      extension.ui = "./ui";
    }
    const notices = await thirdPartyNotices(dir, Object.keys(result.metafile?.inputs ?? {}));
    if (notices !== undefined) files.set(NOTICES_FILE, Buffer.from(notices));
    return { files, extension };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * Packs a plugin directory into a plugin package (spec §4.1):
 * 1. reads and validates the source `.capybara-plugin/plugin.json` (it must not carry
 *    `extension`);
 * 2. when `src/index.ts` exists, bundles the extension ({@link bundleExtension}) and sets
 *    `extension = { entry: "./dist/index.mjs", manifest, migrations?: "./migrations", ui?: "./ui" }`;
 *    a declarative plugin (no `src/index.ts`) runs no esbuild and creates no staging dir;
 * 3. ships `skills/**`, `connectors/*.json`, `agents/*.md` and the listed paths ({@link contentFiles}), README,
 *    LICENSE, NOTICE and the plain files of package.json `files` ({@link extraFiles});
 * 4. writes a package.json with only name / version / type / license / {@link METADATA_FIELDS}
 *    and, with an extension, peerDependencies (no `capybara` section), and the final
 *    `plugin.json`, both validated with the SDK (`parsePluginManifest`,
 *    `validatePluginPackageJsonFor`);
 * 5. writes a reproducible tgz with the `package/` prefix to `outDir/<npm-style file name>`.
 */
export async function packPlugin(pluginDir: string, outDir: string): Promise<PackResult> {
  const dir = resolve(pluginDir);
  const srcPkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const label = typeof srcPkg.name === "string" ? srcPkg.name : dir;
  const source = await readSourceManifest(dir, label);
  const content = await contentFiles(dir, label, source);
  const hasExtension = existsSync(join(dir, "src/index.ts"));
  if (!hasExtension && content.skills === 0 && content.templates === 0 && content.agents === 0) {
    throw new Error(
      `${label}: a plugin must contain an extension, a skill, a connector template or an agent template (src/index.ts, skills/<name>/SKILL.md, connectors/<id>.json or agents/<name>.md)`,
    );
  }
  const ext = hasExtension ? await bundleExtension(dir, label, srcPkg.version) : undefined;

  const files = new Map<string, Buffer>([...(ext?.files ?? []), ...content.files]);
  const extra = await extraFiles(dir, srcPkg.files);
  for (const [path, data] of extra.files) files.set(path, data);

  const manifest: PluginManifest =
    ext === undefined ? source : { ...source, extension: ext.extension };
  const parsed = parsePluginManifest(manifest);
  if ("errors" in parsed) {
    throw new Error(`${label}: packed ${PLUGIN_MANIFEST_FILE}: ${parsed.errors.join("; ")}`);
  }

  const deps = (srcPkg.dependencies ?? {}) as Record<string, string>;
  const pkg: Record<string, unknown> = {
    name: srcPkg.name,
    version: srcPkg.version,
    type: "module",
    ...(srcPkg.license === undefined ? {} : { license: srcPkg.license }),
    ...pick(srcPkg, METADATA_FIELDS),
    ...(ext === undefined
      ? {}
      : {
          peerDependencies: {
            "@capybara-hq/plugin-sdk": ext.extension.manifest.sdk,
            zod: deps.zod ?? "^4.0.0",
          },
        }),
  };
  const pkgIssues = validatePluginPackageJsonFor(pkg, parsed, SDK_VERSION);
  if (pkgIssues.length > 0) throw new Error(`${label}: ${pkgIssues.join("; ")}`);
  files.set("package.json", Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`));
  files.set(PLUGIN_MANIFEST_FILE, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

  const tgz = await makeTgz(files);
  await mkdir(outDir, { recursive: true });
  const file = resolve(outDir, tgzName(String(srcPkg.name), String(srcPkg.version)));
  await writeFile(file, tgz);
  return {
    file,
    sha256: createHash("sha256").update(tgz).digest("hex"),
    manifest: parsed,
    dropped: extra.dropped,
  };
}
