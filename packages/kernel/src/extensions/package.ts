import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve as resolvePath } from "node:path";
import {
  checkEntryImports,
  type EntryImport,
  isSafePackagePath,
  PLUGIN_MANIFEST_FILE,
  type PluginExtensionSection,
} from "@capybara-hq/plugin-sdk";
import { init as lexerInit, parse as lexerParse } from "es-module-lexer";
import { PluginPackageError, readPluginPackage } from "../catalog/plugin-package.js";
import { pluginSchemaName } from "../ctx/create-ctx.js";
import { MIGRATION_FILE_RE } from "../db/migrator.js";
import { ApiError } from "../errors.js";
import {
  HOST_ZOD_VERSION,
  PACKAGE_TGZ_LIMITS,
  PackageTgzError,
  type PackageTgzLimits,
  packagePath,
  unpackPackageTgz,
} from "../packages/tgz.js";
import { buildPermissionSet, type PermissionSet, parseCreatedTables } from "./permission-set.js";
import { migrationWarnings, warningsDigest } from "./permission-view.js";

/**
 * Reading and validating an extension package: a plugin tgz (`readPluginPackage`,
 * `catalog/plugin-package.ts`: unpacking by the rules of `packages/tgz.ts`, plugin.json, the
 * package.json rules of plugin-sdk `validatePluginPackageJsonFor`, the pre-0.1.0 format rejected)
 * with an `extension` section. On top of the plugin rules:
 *
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

/** Limits on unpacking an extension package (the shared tgz limits). */
export const EXTENSION_PACKAGE_LIMITS = PACKAGE_TGZ_LIMITS;
export { HOST_ZOD_VERSION };

/** Unpack limits: `maxBytes` is `packages.maxBytes`; the rest default to {@link EXTENSION_PACKAGE_LIMITS}. */
export type ExtensionPackageLimits = PackageTgzLimits;

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

/** Options of {@link readExtensionPackage}; `hostZodVersion` defaults to {@link HOST_ZOD_VERSION}. */
export interface ReadExtensionPackageOptions extends ExtensionPackageLimits {
  hostSdkVersion: string;
  hostZodVersion?: string;
}

const fail = (issue: string): never => {
  throw new ExtensionPackageError([issue]);
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  let files: Awaited<ReturnType<typeof unpackPackageTgz>>;
  try {
    files = await unpackPackageTgz(bytes, limits);
  } catch (e) {
    if (e instanceof PackageTgzError) throw new ExtensionPackageError(e.issues);
    throw e;
  }
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
