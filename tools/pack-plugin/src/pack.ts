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
  type CapybaraPackageSection,
  checkEntryImports,
  definePlugin,
  HOST_PROVIDED_PACKAGES,
  PLUGIN_PACKAGE_ENTRY,
  type PluginManifest,
  SDK_VERSION,
  type StaticPluginManifest,
  staticManifestOf,
  validatePluginPackageJson,
} from "@capybara-hq/plugin-sdk";
import { init as lexerInit, parse as lexerParse } from "es-module-lexer";
import { build, type Plugin } from "esbuild";
import { pack as tarPack } from "tar-stream";

/** 打包结果：tgz 路径、十六进制 sha256 与写进 `capybara.manifest` 的静态清单。 */
export interface PackResult {
  file: string;
  sha256: string;
  manifest: StaticPluginManifest;
  /**
   * Entries of the plugin's package.json `files` that are not in the package (directories other than
   * `dist` / `migrations` / `ui`, globs, missing paths). Callers print them; `check:plugin-pack` fails.
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

/** 生成 gzip 后的 tar：条目按路径排序，统一 `package/` 前缀、0644、固定 mtime、无属主。 */
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
  return promisify(gzip)(Buffer.concat(chunks), { level: 9 });
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

/**
 * Files shipped besides the bundle: `README.md` and `LICENSE` (the plugin's own, else the workspace's),
 * plus every plain file named in the package.json `files` list at the plugin root (e.g. slack's
 * `app-manifest.yaml`). `dist` is replaced by the bundle and `migrations` / `ui` are handled by the
 * manifest; any other entry (a directory, a glob, a missing path) is reported in `dropped`.
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
  for (const raw of Array.isArray(listed) ? listed : []) {
    const entry = String(raw).replace(/^\.\//, "").replace(/\/+$/, "");
    if (["dist", "migrations", "ui", "README.md", "LICENSE"].includes(entry)) continue;
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

/**
 * 把一个插件目录打成插件包（C11）：
 * 1. esbuild 把 `src/index.ts` 打成单文件 ESM `dist/index.mjs`（platform node、target node24），只外置
 *    {@link HOST_PROVIDED_PACKAGES} 与 Node 内置模块（改写为 `node:*`），CJS 依赖经 createRequire 横幅兼容；
 * 2. 扫描产物的 import（白名单、非字面量动态 import），导入产物取默认导出，经 definePlugin 校验后用
 *    `staticManifestOf` 生成静态清单；清单 version 必须与插件 package.json 一致；
 * 3. 生成只含 name / version / type / license / {@link METADATA_FIELDS} / peerDependencies / capybara 的
 *    package.json，复制
 *    `migrations/`（清单声明了 migrations 时，必须解析到插件根的 `migrations/`）与 `ui/`（存在时）；
 * 4. 打成带 `package/` 前缀、可复现的 tgz，写到 `outDir/<npm 风格文件名>`。
 *
 * 临时文件放在系统临时目录下的 `.capybara-pack-*`，结束后删除。
 */
export async function packPlugin(pluginDir: string, outDir: string): Promise<PackResult> {
  const dir = resolve(pluginDir);
  const srcPkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const label = typeof srcPkg.name === "string" ? srcPkg.name : dir;
  const stage = await realpath(await mkdtemp(join(tmpdir(), STAGING_PREFIX)));
  try {
    await linkHostPackages(dir, stage);
    const entryOut = join(stage, "package", PLUGIN_PACKAGE_ENTRY);
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
    const m = definePlugin(mod.default as PluginManifest);
    if (m.version !== srcPkg.version) {
      throw new Error(
        `${label}: manifest version ${m.version} does not match package.json version ${String(srcPkg.version)}`,
      );
    }
    const manifest = staticManifestOf(m);

    const files = new Map<string, Buffer>([[PLUGIN_PACKAGE_ENTRY, code]]);
    const section: CapybaraPackageSection = {
      kind: "plugin",
      entry: PLUGIN_PACKAGE_ENTRY,
      sdk: m.sdk,
      manifest,
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
      section.migrations = "migrations";
    }
    const notices = await thirdPartyNotices(dir, Object.keys(result.metafile?.inputs ?? {}));
    if (notices !== undefined) files.set(NOTICES_FILE, Buffer.from(notices));
    const extra = await extraFiles(dir, srcPkg.files);
    for (const [path, data] of extra.files) files.set(path, data);
    if (existsSync(join(dir, "ui"))) {
      for (const f of await listFiles(join(dir, "ui"))) {
        files.set(posix.join("ui", f), await readFile(join(dir, "ui", f)));
      }
      section.ui = "ui";
    }

    const deps = (srcPkg.dependencies ?? {}) as Record<string, string>;
    const pkg: Record<string, unknown> = {
      name: srcPkg.name,
      version: srcPkg.version,
      type: "module",
      ...(srcPkg.license === undefined ? {} : { license: srcPkg.license }),
      ...pick(srcPkg, METADATA_FIELDS),
      peerDependencies: { "@capybara-hq/plugin-sdk": m.sdk, zod: deps.zod ?? "^4.0.0" },
      capybara: section,
    };
    const pkgIssues = validatePluginPackageJson(pkg, SDK_VERSION);
    if (pkgIssues.length > 0) throw new Error(`${label}: ${pkgIssues.join("; ")}`);
    files.set("package.json", Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`));

    const tgz = await makeTgz(files);
    await mkdir(outDir, { recursive: true });
    const file = resolve(outDir, tgzName(String(srcPkg.name), String(srcPkg.version)));
    await writeFile(file, tgz);
    return {
      file,
      sha256: createHash("sha256").update(tgz).digest("hex"),
      manifest,
      dropped: extra.dropped,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
