import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, posix, relative, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import {
  checkEntryImports,
  type EntryImport,
  isSafePackagePath,
  PLUGIN_MANIFEST_FILE,
  type PluginExtensionSection,
} from "@capybara-hq/plugin-sdk";
import { init as lexerInit, parse as lexerParse } from "es-module-lexer";
import { extract as tarExtract } from "tar-stream";
import { PluginPackageError, packagePath, readPluginPackage } from "../catalog/plugin-package.js";
import { pluginSchemaName } from "../ctx/create-ctx.js";
import { MIGRATION_FILE_RE } from "../db/migrator.js";
import { ApiError } from "../errors.js";
import { buildPermissionSet, type PermissionSet, parseCreatedTables } from "./permission-set.js";
import { migrationWarnings, warningsDigest } from "./permission-view.js";

/**
 * 插件包（npm-pack tgz，C11）的读取与校验。tgz 一律当作恶意输入：
 *
 * - 压缩后 ≤ `maxBytes`（调用方给，即 `packages.maxBytes`）；用 `zlib.gunzip` 的 `maxOutputLength`
 *   按**实际**解压字节数封顶（{@link EXTENSION_PACKAGE_LIMITS.maxUnpackedBytes}），超过即中止，挡压缩炸弹。
 *   整个包与解出的内容都在内存里处理。
 * - tar 解析用 tar-stream（3.2.2，固定版本）：纯内存、从不碰文件系统（不像 node-tar 的 extract 会直接落盘，
 *   历史上多次出现路径穿越 / 符号链接类 CVE），校验头部 checksum，自己处理 pax / GNU 长路径头并把真实路径与
 *   大小交给我们；只给出原始头，取舍全由这里决定。它已在锁文件中（testcontainers 间接依赖），不引入新的传递依赖。
 * - 只接受普通文件与目录：符号链接、硬链接、设备、fifo 等一律拒绝；条目数 ≤
 *   {@link EXTENSION_PACKAGE_LIMITS.maxEntries}；路径必须在 `package/` 下且是安全的相对路径
 *   （见 plugin-sdk `isSafePackagePath`：无 `..`、`.`、空段、反斜杠、控制字符、盘符），按小写去重
 *   （大小写不敏感的文件系统上解出来会互相覆盖）；不许有 `node_modules/`、`*.node`、`binding.gyp`。
 * - `package.json` ≤ {@link EXTENSION_PACKAGE_LIMITS.maxPackageJsonBytes}, strict UTF-8 + `JSON.parse`. The
 *   package is a plugin tgz read by `readPluginPackage` (`catalog/plugin-package.ts`: plugin.json,
 *   the package.json rules of plugin-sdk `validatePluginPackageJsonFor`, the pre-0.1.0 format
 *   rejected); an extension package is a plugin with an `extension` section.
 * - import 白名单：用 es-module-lexer（2.3.2，固定版本）静态分析 entry 及其包内相对 import 到的模块：
 *   静态 import / `export ... from` / 字面量动态 `import()` 只许 `node:*`、宿主两包（含子路径）与包内相对路径；
 *   **非字面量的动态 `import()` 拒绝**。相对路径解析后必须仍在包内、指向包里存在的 `.mjs` / `.js`，并同样被扫描。
 * - `require`：ESM 里没有 `require` 绑定，bundle 只能经 `node:module` 的 `createRequire` 得到它（打包工具的横幅
 *   就是这样给打进来的 CJS 依赖用的）。这里**不**静态分析 `require(...)`：一是 bundle 里大量 `require("x")`
 *   字样出现在字符串 / 代码生成模板里（实测 connector-mcp 里 ajv 的模板、object-store-s3 的报错文案），正则必然误报，
 *   为此在安装路径上引入完整 JS 解析器不值得；二是插件本来就以批准过的代码在进程内运行（权限是治理而非沙箱），
 *   拦 `require` 拦不住 `process.getBuiltinModule`。打包工具在构建时已保证 require 只指向 `node:*` 与宿主包
 *   （其余全部打进 bundle）；插件目录不在宿主 `node_modules` 的上游路径里，漏打的 `require("x")` 加载时找不到，
 *   安装记录转为 failed。
 */

/** 解压、条目与 package.json 的上限。 */
export const EXTENSION_PACKAGE_LIMITS = {
  /** 解压后的 tar 总字节数上限。 */
  maxUnpackedBytes: 256 * 1024 * 1024,
  /** tar 条目数上限（含目录项）。 */
  maxEntries: 5000,
  /** `package.json` 的字节数上限。 */
  maxPackageJsonBytes: 1024 * 1024,
} as const;

/**
 * 宿主 zod 的版本（插件包的 `peerDependencies.zod` 必须被它满足：加载时插件用的就是这一份 zod）。
 * 从内核自己的依赖解析，与 `syncPackage` 链接给插件的是同一个包。
 */
export const HOST_ZOD_VERSION: string = (
  createRequire(import.meta.url)("zod/package.json") as { version: string }
).version;

/** tgz 内容的统一前缀（npm pack 的约定）。 */
const PREFIX = "package/";

/**
 * Codes of {@link ExtensionPackageError}: an invalid package, a tgz in the pre-0.1.0 format, or a
 * plugin without an extension (nothing to install on the deployment).
 */
export type ExtensionPackageErrorCode =
  | "extension.package_invalid"
  | "extension.legacy_format"
  | "extension.no_extension";

/** The extension package is invalid; `issues` lists the problems (English, shown to the admin). */
export class ExtensionPackageError extends Error {
  readonly code: ExtensionPackageErrorCode;
  readonly issues: string[];
  constructor(issues: string[], code: ExtensionPackageErrorCode = "extension.package_invalid") {
    super(
      code === "extension.package_invalid"
        ? `Invalid plugin package: ${issues[0] ?? "unknown problem"}`
        : (issues[0] ?? code),
    );
    this.name = "ExtensionPackageError";
    this.code = code;
    this.issues = issues;
  }
}

/** The API error for an {@link ExtensionPackageError} (its code, message and issues as details). */
export function extensionPackageApiError(e: ExtensionPackageError): ApiError {
  return new ApiError(e.code, e.message, e.issues);
}

/**
 * The extension of a read package: the plugin's {@link PluginExtensionSection} (paths start with
 * `./`; resolve them with {@link packagePath}) plus the plugin's name and version.
 */
export type ExtensionPackageSection = PluginExtensionSection & { name: string; version: string };

/** A read and validated extension package. Paths are relative to the package root (no `package/`). */
export interface ExtensionPackage {
  /** Hex sha256 of the whole tgz. */
  sha256: string;
  /** tgz bytes. */
  size: number;
  packageJson: Record<string, unknown>;
  section: ExtensionPackageSection;
  files: { path: string; size: number }[];
  /** Migration-named SQL directly in the `extension.migrations` directory, sorted by file name. */
  migrationSql: { file: string; sql: string }[];
}

/** 解包上限：`maxBytes` 即 `packages.maxBytes`；其余默认取 {@link EXTENSION_PACKAGE_LIMITS}。 */
export interface ExtensionPackageLimits {
  maxBytes: number;
  maxUnpackedBytes?: number;
  maxEntries?: number;
}

/** Options of {@link readExtensionPackage}; `hostZodVersion` defaults to {@link HOST_ZOD_VERSION}. */
export interface ReadExtensionPackageOptions extends ExtensionPackageLimits {
  hostSdkVersion: string;
  hostZodVersion?: string;
}

const unpackLimits = (l: ExtensionPackageLimits) => ({
  maxBytes: l.maxBytes,
  maxUnpackedBytes: l.maxUnpackedBytes ?? EXTENSION_PACKAGE_LIMITS.maxUnpackedBytes,
  maxEntries: l.maxEntries ?? EXTENSION_PACKAGE_LIMITS.maxEntries,
});

/** tgz 里的一个文件（路径相对包根，已去掉 `package/`）。 */
export interface PackageFile {
  path: string;
  data: Buffer;
}
type RawFile = PackageFile;

const fail = (issue: string): never => {
  throw new ExtensionPackageError([issue]);
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const isForbiddenFile = (path: string): string | undefined => {
  const segs = path.split("/");
  if (segs.includes("node_modules")) return `${path}: node_modules/ is not allowed`;
  const base = segs[segs.length - 1] as string;
  if (base === "binding.gyp") return `${path}: binding.gyp is not allowed (native addons)`;
  if (base.endsWith(".node")) return `${path}: native addon (.node) files are not allowed`;
  return undefined;
};

/** Decompresses and parses the tar and returns the files in it (with `package/` removed from paths). Anything non-conforming -> ExtensionPackageError. */
async function unpack(
  bytes: Uint8Array,
  opts: { maxBytes: number; maxUnpackedBytes: number; maxEntries: number },
): Promise<RawFile[]> {
  if (bytes.byteLength > opts.maxBytes) {
    fail(`the package is larger than ${opts.maxBytes} bytes`);
  }
  let tarBuf: Buffer;
  try {
    tarBuf = await promisify(gunzip)(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      {
        maxOutputLength: opts.maxUnpackedBytes,
      },
    );
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError) {
      throw new ExtensionPackageError([
        `the package is larger than ${opts.maxUnpackedBytes} bytes unpacked`,
      ]);
    }
    throw new ExtensionPackageError(["the file is not a gzip-compressed tar archive"]);
  }

  const files: RawFile[] = [];
  const seen = new Set<string>();
  const dirs = new Set<string>();
  let entries = 0;
  const ex = tarExtract();
  ex.end(tarBuf);
  try {
    for await (const entry of ex) {
      const h = entry.header;
      entries++;
      if (entries > opts.maxEntries) fail(`the package has more than ${opts.maxEntries} entries`);
      const raw = String(h.name);
      const type = h.type as string | null;
      if (type !== "file" && type !== "directory") {
        entry.resume();
        fail(`${raw}: ${type ?? "unknown"} entries are not allowed (only regular files)`);
      }
      const name = type === "directory" && raw.endsWith("/") ? raw.slice(0, -1) : raw;
      if (!name.startsWith(PREFIX) && name !== PREFIX.slice(0, -1)) {
        entry.resume();
        fail(`${raw}: every entry must be under package/`);
      }
      const rel = name.slice(PREFIX.length);
      if (type === "directory") {
        entry.resume();
        if (rel !== "" && !isSafePackagePath(rel)) fail(`${raw}: unsafe path`);
        continue;
      }
      if (!isSafePackagePath(rel)) {
        entry.resume();
        fail(`${raw}: unsafe path`);
      }
      const forbidden = isForbiddenFile(rel);
      if (forbidden) {
        entry.resume();
        fail(forbidden);
      }
      const key = rel.toLowerCase();
      if (seen.has(key) || dirs.has(key)) {
        entry.resume();
        fail(`${raw}: duplicate path (paths are compared case-insensitively)`);
      }
      seen.add(key);
      const segs = key.split("/");
      for (let i = 1; i < segs.length; i++) {
        const d = segs.slice(0, i).join("/");
        if (seen.has(d)) fail(`${raw}: path conflicts with file "${d}"`);
        dirs.add(d);
      }
      const chunks: Buffer[] = [];
      for await (const c of entry) chunks.push(c as Buffer);
      // 单块时直接用它（不复制）；多块才拼接
      files.push({
        path: rel,
        data: chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks),
      });
    }
  } catch (e) {
    ex.destroy();
    if (e instanceof ExtensionPackageError) throw e;
    fail(`the tar archive is malformed: ${errMsg(e)}`);
  }
  return files;
}

const utf8 = (path: string, data: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return fail(`${path} is not valid UTF-8 text`);
  }
};

/** 扫描一个模块的 import（es-module-lexer）；`import.meta` 不算 import。 */
function scanImports(path: string, code: string): EntryImport[] {
  let imports: ReturnType<typeof lexerParse>[0];
  try {
    [imports] = lexerParse(code, path);
  } catch (e) {
    return fail(`${path} is not valid ES module syntax: ${errMsg(e)}`);
  }
  const out: EntryImport[] = [];
  for (const i of imports) {
    if (i.d === -2) continue; // import.meta
    const dynamic = i.d > -1;
    out.push({ name: i.n ?? "", dynamic, literal: i.n !== undefined });
  }
  return out;
}

/** 从 entry 出发，沿包内相对 import 逐个扫描，汇总问题。 */
function checkModuleGraph(entry: string, byPath: Map<string, Uint8Array>): string[] {
  const issues: string[] = [];
  const queue = [entry];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (visited.has(path)) continue;
    visited.add(path);
    const specs = scanImports(path, utf8(path, byPath.get(path) as Uint8Array));
    for (const msg of checkEntryImports(specs)) issues.push(`${path}: ${msg}`);
    for (const s of specs) {
      if (!s.name.startsWith("./") && !s.name.startsWith("../")) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), s.name));
      if (target.startsWith("../") || target === ".." || !isSafePackagePath(target)) {
        issues.push(`${path}: import "${s.name}" points outside the package`);
        continue;
      }
      if (!byPath.has(target)) {
        issues.push(`${path}: import "${s.name}" not found in the package`);
        continue;
      }
      if (!target.endsWith(".mjs") && !target.endsWith(".js")) {
        issues.push(`${path}: import "${s.name}" must point to a .mjs or .js module`);
        continue;
      }
      queue.push(target);
    }
  }
  return issues;
}

/**
 * Unpacks a tgz by the extension package rules (size, decompression cap, entry count, regular files
 * only, paths safe and under `package/`, case-insensitive dedup, no `node_modules/` / `*.node` /
 * `binding.gyp`), without looking at the content. Enterprise catalog imports of other tgz kinds use
 * it too. Invalid -> {@link ExtensionPackageError}.
 */
export function unpackPackageTgz(
  bytes: Uint8Array,
  limits: ExtensionPackageLimits,
): Promise<PackageFile[]> {
  return unpack(bytes, unpackLimits(limits));
}

/**
 * Reads the package's `package.json`: it must exist, be ≤
 * {@link EXTENSION_PACKAGE_LIMITS.maxPackageJsonBytes} and strict UTF-8 JSON.
 * Invalid -> {@link ExtensionPackageError}. Returns the parse result (shape not validated).
 */
export function parsePackageJsonFile(file: { data: Buffer } | undefined): unknown {
  if (!file) return fail("package.json not found in the package");
  if (file.data.byteLength > EXTENSION_PACKAGE_LIMITS.maxPackageJsonBytes) {
    fail(`package.json is larger than ${EXTENSION_PACKAGE_LIMITS.maxPackageJsonBytes} bytes`);
  }
  const text = utf8("package.json", file.data);
  try {
    return JSON.parse(text);
  } catch {
    return fail("package.json is not valid JSON");
  }
}

/** Maps an error of `readPluginPackage` to the extension package error. */
const fromPluginPackageError = (e: PluginPackageError): ExtensionPackageError =>
  new ExtensionPackageError(
    e.issues,
    e.code === "catalog.legacy_format" ? "extension.legacy_format" : "extension.package_invalid",
  );

/**
 * Reads and validates an extension package without running any code from it: a plugin tgz
 * (`readPluginPackage`) with an `extension` section, whose entry's module graph passes the import
 * rules (file header) and whose `extension.migrations` SQL is collected. Invalid ->
 * {@link ExtensionPackageError} (listing every problem it can find; problems while unpacking stop
 * at the first): `extension.legacy_format` for the pre-0.1.0 format, `extension.no_extension` for a
 * plugin without an extension, otherwise `extension.package_invalid`.
 */
export async function readExtensionPackage(
  bytes: Uint8Array,
  opts: ReadExtensionPackageOptions,
): Promise<ExtensionPackage> {
  let plugin: Awaited<ReturnType<typeof readPluginPackage>>;
  try {
    plugin = await readPluginPackage(bytes, opts);
  } catch (e) {
    if (e instanceof PluginPackageError) throw fromPluginPackageError(e);
    throw e;
  }
  const { manifest, files } = plugin;
  const ext = manifest.extension;
  if (ext === undefined) {
    throw new ExtensionPackageError(
      [
        `plugin ${manifest.name} has no extension (no "extension" in ${PLUGIN_MANIFEST_FILE}); import it into the catalog instead`,
      ],
      "extension.no_extension",
    );
  }

  await lexerInit;
  const issues = checkModuleGraph(packagePath(ext.entry), files);
  const migrationSql: ExtensionPackage["migrationSql"] = [];
  if (ext.migrations !== undefined) {
    const dir = packagePath(ext.migrations);
    for (const [path, data] of files) {
      if (!path.startsWith(`${dir}/`)) continue;
      const file = path.slice(dir.length + 1);
      if (file.includes("/") || !MIGRATION_FILE_RE.test(file)) continue;
      migrationSql.push({ file, sql: utf8(path, data) });
    }
    migrationSql.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }
  if (issues.length > 0) throw new ExtensionPackageError(issues);

  return {
    sha256: plugin.sha256,
    size: plugin.size,
    packageJson: plugin.packageJson,
    section: { ...ext, name: manifest.name, version: manifest.version },
    files: [...files].map(([path, data]) => ({ path, size: data.byteLength })),
    migrationSql,
  };
}

/**
 * The package's permission set from the static manifest and the migration SQL only (review runs no
 * extension code), in the same shape as `computePermissionSet` on the real module (config fields
 * keep only path / secret).
 */
export function permissionSetOfPackage(p: ExtensionPackage): PermissionSet {
  return permissionSetOfSection(p.section, p.migrationSql);
}

/**
 * Same as {@link permissionSetOfPackage}, from the extension section and the migration SQL (the host
 * uses it on the locally synced package for the permission gate without importing the module: no
 * extension code, top-level code included, runs before approval).
 */
export function permissionSetOfSection(
  section: Pick<PluginExtensionSection, "manifest">,
  migrationSql: { file: string; sql: string }[],
): PermissionSet {
  const m = section.manifest;
  const schema = pluginSchemaName(m.name);
  const tables = migrationSql.flatMap((f) => parseCreatedTables(f.sql, schema));
  const strip = (fs: { path: string; secret: boolean }[]) =>
    fs.map((f) => ({ path: f.path, secret: f.secret }));
  return buildPermissionSet({
    provides: m.provides,
    requires: m.requires,
    optional: m.optional,
    config: { deployment: strip(m.config.deployment), org: strip(m.config.org) },
    tables,
    permissions: m.permissions,
    warningsDigest: warningsDigest(migrationWarnings(migrationSql, m.name)),
  });
}

/**
 * Reads the migration SQL in `extension.migrations` under the locally unpacked directory `root` (not
 * recursive, only files with migration names, sorted by name), in the same shape as the
 * `migrationSql` of {@link readExtensionPackage}; empty when no migrations are declared.
 */
export async function readMigrationSql(
  root: string,
  section: Pick<PluginExtensionSection, "migrations">,
): Promise<{ file: string; sql: string }[]> {
  if (section.migrations === undefined) return [];
  const dir = resolvePath(root, packagePath(section.migrations));
  const names = (await readdir(dir)).filter((f) => MIGRATION_FILE_RE.test(f)).sort();
  const out: { file: string; sql: string }[] = [];
  for (const file of names) out.push({ file, sql: await readFile(resolvePath(dir, file), "utf8") });
  return out;
}

/**
 * Unpacks the package into `dir` (dropping the `package/` prefix). `dir` must not exist or be empty;
 * the unpack rules and limits are the same as {@link readExtensionPackage} (paths, file types, entry
 * count and unpacked size; pass the same `limits`, i.e. `packages.maxBytes`), and the package should
 * have been validated with it first. Files 0644, directories 0755, written with `wx` (no overwrite,
 * no following existing links).
 */
export async function extractExtensionPackage(
  bytes: Uint8Array,
  dir: string,
  limits: ExtensionPackageLimits,
): Promise<void> {
  const files = await unpack(bytes, unpackLimits(limits));
  const root = resolvePath(dir);
  let existing: string[] = [];
  try {
    existing = await readdir(root);
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
  }
  if (existing.length > 0) throw new Error(`extract target ${root} is not empty`);
  await mkdir(root, { recursive: true, mode: 0o755 });
  for (const f of files) {
    const target = resolvePath(root, f.path);
    const rel = relative(root, target);
    if (rel.startsWith("..") || rel === "") fail(`${f.path}: unsafe path`);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, f.data, { flag: "wx", mode: 0o644 });
  }
}
