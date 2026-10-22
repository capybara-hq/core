import semver from "semver";
import type { z } from "zod";
import { definePlugin, type PluginManifest } from "./define-plugin.js";
import type { PluginPermissions } from "./permissions.js";

/**
 * 插件包（npm-pack tgz）格式与校验规则（C11）。只含纯函数：读 tgz、扫描 import 由内核做，打包由 `tools/pack-plugin` 做。
 *
 * 包内容都在 `package/` 下；`package.json` 的 `capybara` 段是**静态**清单，审阅只看它与迁移 SQL，不执行插件代码；
 * 加载时再用真实模块的 {@link staticManifestOf} 核对（不一致 → `manifest_mismatch`）。
 * `dist` 是单文件 ESM，三方依赖已打进去；只有 {@link HOST_PROVIDED_PACKAGES} 由宿主提供。
 */

/** 宿主提供的包（peerDependencies，安装时链接到宿主副本）；其余三方依赖必须打进 entry。 */
export const HOST_PROVIDED_PACKAGES = ["@capybara-hq/plugin-sdk", "zod"] as const;

/** 打包工具产出的 entry 路径（相对包根）。 */
export const PLUGIN_PACKAGE_ENTRY = "dist/index.mjs";

/** npm 安装时会自动执行的脚本：插件包一律不许有（安装不跑脚本，有也是误导）。 */
export const FORBIDDEN_INSTALL_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
] as const;

/** 不许出现的依赖字段：三方依赖必须打进 entry。 */
const FORBIDDEN_DEP_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "bundleDependencies",
  "bundledDependencies",
] as const;

/** 静态清单里的一个配置字段（点路径，根即叶子时为空串）。 */
export interface StaticConfigField {
  path: string;
  secret: boolean;
  hot: boolean;
}

/** 插件清单的静态部分（可 JSON 序列化；不含 setup、zod schema、migrations 路径）。 */
export interface StaticPluginManifest {
  name: string;
  version: string;
  sdk: string;
  provides: string[];
  requires: string[];
  optional: string[];
  permissions: PluginPermissions;
  ui?: PluginManifest["ui"];
  config: { deployment: StaticConfigField[]; org: StaticConfigField[] };
}

/** `package.json` 的 `capybara` 段（kind = plugin）。路径都相对包根。 */
export interface CapybaraPackageSection {
  kind: "plugin";
  entry: string;
  sdk: string;
  manifest: StaticPluginManifest;
  migrations?: string;
  ui?: string;
}

/** 入口模块里的一个 import：`name` 是 specifier（非字面量的动态 import 时为空串）。 */
export interface EntryImport {
  name: string;
  dynamic: boolean;
  literal: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// npm 包名规则（简化）：可带 scope，小写，≤ 214 字符。
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/**
 * 包内相对路径是否安全：非空、不以 `/` 开头、不含 `\`、控制字符与盘符，没有空段、`.` 与 `..` 段，≤ 1024 字符。
 */
export function isSafePackagePath(p: string): boolean {
  if (typeof p !== "string" || p === "" || p.length > 1024) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拒绝控制字符
  if (p.startsWith("/") || p.includes("\\") || /[\u0000-\u001f\u007f]/.test(p)) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * 范围是否有上界：展开后的每个比较集（`||` 的每一支）都至少有一个 `<` / `<=` 或精确版本。
 * `*`、`x`、`>=1.0.0` 这类没有上界的范围会把将来的大版本 SDK 也当成兼容。
 */
function hasUpperBound(range: string): boolean {
  const r = new semver.Range(range);
  return r.set.every((comparators) =>
    comparators.some(
      (c) =>
        c.operator === "<" ||
        c.operator === "<=" ||
        ((c.operator === "" || c.operator === "=") && c.value !== ""),
    ),
  );
}

const isHostPackage = (name: string) =>
  HOST_PROVIDED_PACKAGES.some((h) => name === h || name.startsWith(`${h}/`));

/**
 * 核对入口模块的 import（C11）：静态与字面量动态 import 只许 `node:*`、{@link HOST_PROVIDED_PACKAGES}（含子路径）
 * 与包内相对路径（`./`、`../`；是否越出包外由调用方按文件位置判断）；非字面量的动态 import 一律拒绝。
 * 返回问题列表（空表示合法）。
 */
export function checkEntryImports(specifiers: EntryImport[]): string[] {
  const out: string[] = [];
  for (const s of specifiers) {
    if (s.dynamic && !s.literal) {
      out.push("dynamic import() with a non-literal specifier is not allowed");
      continue;
    }
    const n = s.name;
    if (n.startsWith("node:") && n.length > 5) continue;
    if (isHostPackage(n)) continue;
    if (n.startsWith("./") || n.startsWith("../")) continue;
    out.push(
      `import of "${n}" is not allowed: bundle third-party dependencies into the entry ` +
        `(only node:*, ${HOST_PROVIDED_PACKAGES.join(", ")} and relative paths are resolved at load)`,
    );
  }
  return out;
}

const WRAPPERS = new Set(["default", "prefault", "optional", "nullable", "readonly", "catch"]);

interface FieldMeta {
  secret?: unknown;
  hot?: unknown;
}

type AnySchema = z.ZodTypeAny;
const defOf = (s: AnySchema) =>
  s._zod.def as unknown as {
    type: string;
    innerType?: AnySchema;
    shape?: Record<string, AnySchema>;
  };
const metaOf = (s: AnySchema) => s.meta() as FieldMeta | undefined;

/** 与内核 `configFields` 相同的遍历：对象递归展开，default / optional 等包装剥掉，对象上的 secret 向下继承。 */
function configFieldsOf(
  schema: AnySchema | undefined,
  prefix = "",
  inheritedSecret = false,
): StaticConfigField[] {
  if (!schema) return [];
  let node = schema;
  let meta = metaOf(node);
  while (WRAPPERS.has(defOf(node).type) && defOf(node).innerType) {
    node = defOf(node).innerType as AnySchema;
    meta ??= metaOf(node);
  }
  const secret = inheritedSecret || meta?.secret === true;
  const def = defOf(node);
  if (def.type === "object" && def.shape) {
    return Object.entries(def.shape).flatMap(([k, v]) =>
      configFieldsOf(v, prefix ? `${prefix}.${k}` : k, secret),
    );
  }
  return [{ path: prefix, secret, hot: meta?.hot === true }];
}

const byPath = (a: StaticConfigField, b: StaticConfigField) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const jsonClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * 真实清单的静态部分：打包时写进 `capybara.manifest`，加载时与包内的比对（`manifest_mismatch`）。
 * 结果可 JSON 往返（undefined 字段去掉）；配置字段按路径排序。
 */
export function staticManifestOf(m: PluginManifest): StaticPluginManifest {
  const out: StaticPluginManifest = {
    name: m.name,
    version: m.version,
    sdk: m.sdk,
    provides: [...m.provides],
    requires: [...(m.requires ?? [])],
    optional: [...(m.optional ?? [])],
    permissions: jsonClone(m.permissions ?? {}),
    config: {
      deployment: configFieldsOf(m.config?.deployment).sort(byPath),
      org: configFieldsOf(m.config?.org).sort(byPath),
    },
  };
  if (m.ui !== undefined) out.ui = jsonClone(m.ui);
  return out;
}

const SECTION_KEYS = new Set(["kind", "entry", "sdk", "manifest", "migrations", "ui"]);
const MANIFEST_KEYS = new Set([
  "name",
  "version",
  "sdk",
  "provides",
  "requires",
  "optional",
  "permissions",
  "ui",
  "config",
]);

function checkConfigFields(label: string, v: unknown, errs: string[]): void {
  if (!Array.isArray(v)) {
    errs.push(`${label} must be an array`);
    return;
  }
  const seen = new Set<string>();
  for (const f of v) {
    if (
      !isObj(f) ||
      typeof f.path !== "string" ||
      typeof f.secret !== "boolean" ||
      typeof f.hot !== "boolean"
    ) {
      errs.push(`${label} entries need path (string), secret and hot (booleans)`);
      continue;
    }
    if (seen.has(f.path)) errs.push(`${label} has duplicate path "${f.path}"`);
    seen.add(f.path);
  }
}

function checkManifest(m: unknown, pkgVersion: unknown, sectionSdk: unknown, errs: string[]) {
  const at = "capybara.manifest";
  if (!isObj(m)) {
    errs.push(`${at} must be an object`);
    return;
  }
  for (const k of Object.keys(m)) {
    if (!MANIFEST_KEYS.has(k)) errs.push(`${at} has unknown field "${k}"`);
  }
  for (const k of ["provides", "requires", "optional"]) {
    if (!Array.isArray(m[k])) errs.push(`${at}.${k} must be an array`);
  }
  if (!isObj(m.permissions)) errs.push(`${at}.permissions must be an object`);
  if (!isObj(m.config)) errs.push(`${at}.config must be an object`);
  else {
    checkConfigFields(`${at}.config.deployment`, m.config.deployment, errs);
    checkConfigFields(`${at}.config.org`, m.config.org, errs);
  }
  if (typeof pkgVersion === "string" && m.version !== pkgVersion) {
    errs.push(
      `${at}.version "${String(m.version)}" does not match package.json version "${pkgVersion}"`,
    );
  }
  if (typeof sectionSdk === "string" && m.sdk !== sectionSdk) {
    errs.push(`${at}.sdk "${String(m.sdk)}" does not match capybara.sdk "${sectionSdk}"`);
  }
  // 名字、版本、sdk 范围、能力引用、权限、界面贡献：与 definePlugin 同一套规则（setup 用占位函数）。
  try {
    definePlugin({
      ...(m as unknown as PluginManifest),
      config: undefined,
      migrations: undefined,
      setup() {},
    } as unknown as PluginManifest);
  } catch (e) {
    errs.push(`${at}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 校验插件包的 `package.json`（C11 里与它有关的规则），返回问题列表（空表示合法）：
 * 没有安装脚本（{@link FORBIDDEN_INSTALL_SCRIPTS}）与 `gypfile`；没有 dependencies / optionalDependencies /
 * bundle(d)Dependencies；peerDependencies 只含宿主提供的包；`capybara` 段字段齐全且路径不越界，entry 是 `.mjs`；
 * `capybara.sdk` 有上界（`*`、`>=x` 这类会把将来的大版本也当成兼容，拒绝）且满足宿主 SDK 版本（includePrerelease），
 * `peerDependencies` 的 SDK 范围必须存在且等于它；`peerDependencies.zod`（若有）是合法范围，给了
 * `opts.hostZodVersion` 时须被宿主 zod 满足；manifest 的 version 与 package.json 一致、sdk 与 `capybara.sdk` 一致，
 * 其余按 definePlugin 的规则校验。
 */
export function validatePluginPackageJson(
  pkg: unknown,
  hostSdkVersion: string,
  opts: { hostZodVersion?: string } = {},
): string[] {
  if (!isObj(pkg)) return ["package.json must be a JSON object"];
  const errs: string[] = [];
  if (typeof pkg.name !== "string" || pkg.name.length > 214 || !NPM_NAME_RE.test(pkg.name)) {
    errs.push("package.json name must be a valid npm package name");
  }
  if (typeof pkg.version !== "string" || semver.valid(pkg.version) === null) {
    errs.push("package.json version must be a valid semver version");
  }
  if (pkg.scripts !== undefined) {
    if (!isObj(pkg.scripts)) errs.push("package.json scripts must be an object");
    else {
      for (const s of FORBIDDEN_INSTALL_SCRIPTS) {
        if (Object.hasOwn(pkg.scripts, s)) {
          errs.push(`package.json scripts.${s} is not allowed: plugin packages never run scripts`);
        }
      }
    }
  }
  if (pkg.gypfile !== undefined && pkg.gypfile !== false) {
    errs.push("package.json gypfile is not allowed: native addons are not supported");
  }
  for (const f of FORBIDDEN_DEP_FIELDS) {
    const v = pkg[f];
    if (v === undefined) continue;
    const empty = Array.isArray(v) ? v.length === 0 : isObj(v) && Object.keys(v).length === 0;
    if (!empty) {
      errs.push(`package.json ${f} is not allowed: bundle third-party dependencies into the entry`);
    }
  }
  let peers: Record<string, unknown> = {};
  if (pkg.peerDependencies !== undefined) {
    if (!isObj(pkg.peerDependencies)) errs.push("package.json peerDependencies must be an object");
    else {
      peers = pkg.peerDependencies;
      for (const k of Object.keys(peers)) {
        if (!(HOST_PROVIDED_PACKAGES as readonly string[]).includes(k)) {
          errs.push(
            `package.json peerDependencies "${k}" is not provided by the host (only ${HOST_PROVIDED_PACKAGES.join(", ")})`,
          );
        }
      }
    }
  }
  const zodRange = peers.zod;
  if (zodRange !== undefined) {
    if (typeof zodRange !== "string" || semver.validRange(zodRange) === null) {
      errs.push("package.json peerDependencies zod must be a valid semver range");
    } else if (
      opts.hostZodVersion !== undefined &&
      !semver.satisfies(opts.hostZodVersion, zodRange, { includePrerelease: true })
    ) {
      errs.push(
        `package.json peerDependencies zod "${zodRange}" is not satisfied by the host zod ${opts.hostZodVersion}`,
      );
    }
  }

  const s = pkg.capybara;
  if (!isObj(s)) {
    errs.push('package.json needs a "capybara" section object');
    return errs;
  }
  for (const k of Object.keys(s)) {
    if (!SECTION_KEYS.has(k)) errs.push(`capybara has unknown field "${k}"`);
  }
  if (s.kind !== "plugin") errs.push('capybara.kind must be "plugin"');
  if (typeof s.entry !== "string" || !isSafePackagePath(s.entry) || !s.entry.endsWith(".mjs")) {
    errs.push("capybara.entry must be a relative .mjs path inside the package");
  }
  for (const k of ["migrations", "ui"] as const) {
    if (s[k] !== undefined && (typeof s[k] !== "string" || !isSafePackagePath(s[k]))) {
      errs.push(`capybara.${k} must be a relative directory path inside the package`);
    }
  }
  if (typeof s.sdk !== "string" || semver.validRange(s.sdk) === null) {
    errs.push("capybara.sdk must be a valid semver range");
  } else {
    if (!hasUpperBound(s.sdk)) {
      errs.push(
        `capybara.sdk "${s.sdk}" has no upper bound: use a range such as ^0.1.0 so a future major SDK is not assumed compatible`,
      );
    }
    if (!semver.satisfies(hostSdkVersion, s.sdk, { includePrerelease: true })) {
      errs.push(
        `capybara.sdk "${s.sdk}" is not satisfied by the host SDK version ${hostSdkVersion}`,
      );
    }
    const peerSdk = peers["@capybara-hq/plugin-sdk"];
    if (peerSdk === undefined) {
      errs.push(
        `package.json peerDependencies "@capybara-hq/plugin-sdk" is required and must equal capybara.sdk "${s.sdk}"`,
      );
    } else if (peerSdk !== s.sdk) {
      errs.push(
        `package.json peerDependencies "@capybara-hq/plugin-sdk" "${String(peerSdk)}" must equal capybara.sdk "${s.sdk}"`,
      );
    }
  }
  checkManifest(s.manifest, pkg.version, s.sdk, errs);
  return errs;
}
