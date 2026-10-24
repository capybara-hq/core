import semver from "semver";
import type { z } from "zod";
import { ConnectorAuthSchema } from "./connector-auth.js";
import { defineExtension, EXTENSION_NAME_RE, type ExtensionManifest } from "./define-extension.js";
import type { ExtensionPermissions } from "./permissions.js";

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
export interface StaticExtensionManifest {
  name: string;
  version: string;
  sdk: string;
  provides: string[];
  requires: string[];
  optional: string[];
  permissions: ExtensionPermissions;
  ui?: ExtensionManifest["ui"];
  config: { deployment: StaticConfigField[]; org: StaticConfigField[] };
}

/** `package.json` 的 `capybara` 段（kind = plugin）。路径都相对包根。 */
export interface CapybaraPackageSection {
  kind: "plugin";
  entry: string;
  sdk: string;
  manifest: StaticExtensionManifest;
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

/** npm 包名规则（简化）：可带 scope，小写，≤ 214 字符（长度另行检查）。 */
export const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const NPM_NAME_RE = NPM_PACKAGE_NAME_RE;

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
export function staticManifestOf(m: ExtensionManifest): StaticExtensionManifest {
  const out: StaticExtensionManifest = {
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
  // Name, version, sdk range, extension point refs, permissions, UI contributions: the same rules
  // as defineExtension (with a placeholder setup).
  try {
    defineExtension({
      ...(m as unknown as ExtensionManifest),
      config: undefined,
      migrations: undefined,
      setup() {},
    } as unknown as ExtensionManifest);
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
 * 其余按 defineExtension 的规则校验。
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

// ---------------------------------------------------------------------------------------------
// 企业目录的包种类（C21）：plugin（上面）、connector-template（C30）、skill、app（C31，app.yaml 见 app-manifest.ts）。
// 格式统一为 package.json 的 `capybara` 段；连接器模板与技能另接受 zip（根目录放 package.json）。
// ---------------------------------------------------------------------------------------------

/** 目录包的种类。 */
export type PackageKind = "plugin" | "connector-template" | "skill" | "app";

/** 全部目录包种类（顺序即界面上的默认顺序）。 */
export const PACKAGE_KINDS: readonly PackageKind[] = [
  "plugin",
  "connector-template",
  "skill",
  "app",
] as const;

/** 插件类的 `capybara` 段（与 {@link CapybaraPackageSection} 同一类型，按 kind 命名的别名）。 */
export type PluginPackageSection = CapybaraPackageSection;

/**
 * 连接器模板（C30）：连接器插件引用 + `Connector.kind` + 端点预设 + 组织可改的端点路径 + 认证预设（不含凭据）+
 * 默认 ownership + 各工具默认策略 + 图标。组织安装时只能填凭据、客户端 id / secret 与 `editableEndpoint` 里的字段。
 */
export interface ConnectorTemplateSpec {
  /** 连接器插件名（如 `connector-mcp`）。 */
  plugin: string;
  /** 连接器插件的 semver 范围，可选。 */
  pluginVersion?: string;
  /** `Connector.kind`（如 `"mcp"`）。 */
  connector: string;
  /** 端点预设；导入时内核按该连接器的 `endpointSchema` 校验。 */
  endpoint: Record<string, unknown>;
  /** 组织安装时允许改的点路径（如 `"url"`）；其余以模板为准。路径必须存在于连接器的端点 schema 中。 */
  editableEndpoint?: string[];
  /** 与连接器安装接口的认证方式同形（{@link ConnectorAuthSchema}），不含任何凭据。 */
  auth: Record<string, unknown>;
  /** 缺省取 `auth.ownership`；给了就必须与之一致。 */
  ownership?: "org" | "personal";
  /** 工具名 → 默认策略（安装后记 `policy_source 'template'`）。 */
  defaultToolPolicies?: Record<string, "allow" | "ask" | "deny">;
  /** 包内路径，svg / png，≤ {@link CONNECTOR_TEMPLATE_LIMITS}`.iconBytes`。 */
  icon?: string;
}

/** 双语显示名。 */
export interface LocalizedName {
  zh: string;
  en: string;
}

/** `capybara` 段（kind = connector-template）。 */
export interface ConnectorTemplateSection {
  kind: "connector-template";
  publisher: string;
  description: string;
  displayName?: LocalizedName;
  template: ConnectorTemplateSpec;
}

/** `capybara` 段（kind = skill）；技能内容（SKILL.md 等）在包根。 */
export interface SkillPackageSection {
  kind: "skill";
  publisher: string;
  description: string;
  displayName?: LocalizedName;
}

/** 应用包清单文件名（C31）。 */
export const APP_MANIFEST_FILE = "app.yaml";

/** `capybara` 段（kind = app）；`app.yaml` 的格式与解析见 app-manifest.ts（`AppManifest` / `parseAppManifest`）。 */
export interface AppPackageSection {
  kind: "app";
  manifest: "app.yaml";
}

/** 任一种类的 `capybara` 段。 */
export type PackageSection =
  | PluginPackageSection
  | ConnectorTemplateSection
  | SkillPackageSection
  | AppPackageSection;

/** 连接器模板与目录段的上限。 */
export const CONNECTOR_TEMPLATE_LIMITS = {
  /** 图标字节数上限。 */
  iconBytes: 64 * 1024,
  /** 端点预设 JSON 序列化后的字符数上限。 */
  endpointChars: 16 * 1024,
  /** `editableEndpoint` 条数上限。 */
  editablePaths: 50,
  /** `defaultToolPolicies` 条数上限。 */
  toolPolicies: 1000,
  /** publisher 字符数上限。 */
  publisherChars: 100,
  /** description 字符数上限。 */
  descriptionChars: 1024,
  /** displayName 每种语言的字符数上限。 */
  displayNameChars: 100,
} as const;

/** 目录条目名（与清单条目名同一规则）：小写字母或数字开头，之后小写字母、数字、连字符，≤ 64。 */
export const CATALOG_ITEM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** npm 包名去掉 scope（`@acme/foo` → `foo`）。 */
export const unscopedPackageName = (name: string): string =>
  name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;

const PATH_SEG_RE = /^[A-Za-z0-9_-]{1,100}$/;
const PROTO_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * 凭据样式的字段名（比较时转小写、去掉 `-` 与 `_`）：模板会被所有组织看到，端点预设里出现这些键一律拒绝。
 * `authorization` / `cookie` 等头名同样在列（端点头里的凭据）。
 */
const CREDENTIAL_KEYS = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearertoken",
  "authtoken",
  "apikey",
  "apitoken",
  "xapikey",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "privatekey",
  "authorization",
  "proxyauthorization",
  "cookie",
  "sessiontoken",
]);

const normKey = (k: string) => k.toLowerCase().replace(/[-_]/g, "");

/** 递归找出凭据样式的键（只报路径，不回显值）。 */
function credentialKeyPaths(v: unknown, at: string, out: string[], depth = 0): void {
  if (depth > 20) return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      credentialKeyPaths(x, `${at}.${i}`, out, depth + 1);
    });
    return;
  }
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    const p = `${at}.${k}`;
    if (CREDENTIAL_KEYS.has(normKey(k))) out.push(p);
    credentialKeyPaths(x, p, out, depth + 1);
  }
}

const TEMPLATE_KEYS = new Set([
  "plugin",
  "pluginVersion",
  "connector",
  "endpoint",
  "editableEndpoint",
  "auth",
  "ownership",
  "defaultToolPolicies",
  "icon",
]);

/**
 * 校验连接器模板（{@link ConnectorTemplateSpec}）的静态部分，返回问题列表（空表示合法；路径相对模板根，不回显值）：
 * 字段齐全、无未知字段；`auth` 符合 {@link ConnectorAuthSchema}（strict：夹带 `token` 等多余字段即拒绝）；
 * 端点预设里任何层级都不许有凭据样式的键；`editableEndpoint` 是不重复的点路径；`ownership` 与 `auth.ownership`
 * 一致；默认策略只许 allow / ask / deny；icon 是包内 .svg / .png 路径。
 * 端点是否符合连接器的 `endpointSchema`、`editableEndpoint` 是否存在于其中，由内核在导入时按已加载的连接器校验。
 */
export function validateConnectorTemplate(t: unknown): string[] {
  if (!isObj(t)) return ["template must be an object"];
  const errs: string[] = [];
  for (const k of Object.keys(t)) {
    if (!TEMPLATE_KEYS.has(k)) errs.push(`template has unknown field "${k}"`);
  }
  if (typeof t.plugin !== "string" || !EXTENSION_NAME_RE.test(t.plugin)) {
    errs.push(`template.plugin must be a plugin name matching ${EXTENSION_NAME_RE}`);
  }
  if (
    t.pluginVersion !== undefined &&
    (typeof t.pluginVersion !== "string" || semver.validRange(t.pluginVersion) === null)
  ) {
    errs.push("template.pluginVersion must be a valid semver range");
  }
  if (typeof t.connector !== "string" || t.connector.length < 1 || t.connector.length > 100) {
    errs.push("template.connector must be a connector kind (1-100 characters)");
  }
  if (!isObj(t.endpoint)) errs.push("template.endpoint must be an object");
  else {
    if (JSON.stringify(t.endpoint).length > CONNECTOR_TEMPLATE_LIMITS.endpointChars) {
      errs.push(
        `template.endpoint is larger than ${CONNECTOR_TEMPLATE_LIMITS.endpointChars} characters`,
      );
    }
    const leaks: string[] = [];
    credentialKeyPaths(t.endpoint, "template.endpoint", leaks);
    for (const p of leaks) {
      errs.push(
        `${p} looks like a credential: templates must not contain credentials; organizations provide them when installing`,
      );
    }
  }
  if (t.editableEndpoint !== undefined) {
    if (
      !Array.isArray(t.editableEndpoint) ||
      t.editableEndpoint.length > CONNECTOR_TEMPLATE_LIMITS.editablePaths
    ) {
      errs.push(
        `template.editableEndpoint must be an array of at most ${CONNECTOR_TEMPLATE_LIMITS.editablePaths} paths`,
      );
    } else {
      const seen = new Set<string>();
      for (const p of t.editableEndpoint) {
        const ok =
          typeof p === "string" &&
          p.split(".").every((s) => PATH_SEG_RE.test(s) && !PROTO_KEYS.has(s));
        if (!ok) {
          errs.push(
            `template.editableEndpoint entries must be dot paths of letters, digits, "_" and "-" (got ${JSON.stringify(typeof p === "string" ? p.slice(0, 100) : typeof p)})`,
          );
          continue;
        }
        if (p.split(".").some((seg) => CREDENTIAL_KEYS.has(normKey(seg)))) {
          errs.push(
            `template.editableEndpoint "${p}" looks like a credential field: organizations provide credentials through the connector's auth, not the endpoint`,
          );
          continue;
        }
        if (seen.has(p)) errs.push(`template.editableEndpoint has duplicate path "${p}"`);
        seen.add(p);
      }
    }
  }
  const auth = ConnectorAuthSchema.safeParse(t.auth);
  if (!auth.success) {
    for (const i of auth.error.issues) {
      const path = ["template.auth", ...i.path.map(String)].join(".");
      const keys = (i as { keys?: string[] }).keys;
      errs.push(
        keys && keys.length > 0
          ? `${path} has unknown field(s) ${keys.map((k) => `"${k}"`).join(", ")}: auth presets must not contain credentials`
          : `${path}: ${i.message}`,
      );
    }
  }
  if (t.ownership !== undefined) {
    if (t.ownership !== "org" && t.ownership !== "personal") {
      errs.push('template.ownership must be "org" or "personal"');
    } else if (auth.success) {
      const a = auth.data as { type: string; ownership?: string };
      if (a.type === "none") {
        errs.push("template.ownership is not allowed with auth type none (no credential)");
      } else if (a.ownership !== t.ownership) {
        errs.push(
          `template.ownership "${t.ownership}" does not match template.auth.ownership "${a.ownership}"`,
        );
      }
    }
  }
  if (t.defaultToolPolicies !== undefined) {
    const p = t.defaultToolPolicies;
    if (!isObj(p) || Object.keys(p).length > CONNECTOR_TEMPLATE_LIMITS.toolPolicies) {
      errs.push(
        `template.defaultToolPolicies must be an object with at most ${CONNECTOR_TEMPLATE_LIMITS.toolPolicies} entries`,
      );
    } else {
      for (const [name, v] of Object.entries(p)) {
        if (name.length < 1 || name.length > 200) {
          errs.push("template.defaultToolPolicies keys must be tool names (1-200 characters)");
        } else if (PROTO_KEYS.has(name)) {
          errs.push(`template.defaultToolPolicies key "${name}" is not allowed`);
        } else if (v !== "allow" && v !== "ask" && v !== "deny") {
          errs.push(`template.defaultToolPolicies.${name} must be "allow", "ask" or "deny"`);
        }
      }
    }
  }
  if (t.icon !== undefined) {
    if (typeof t.icon !== "string" || !isSafePackagePath(t.icon) || !/\.(svg|png)$/i.test(t.icon)) {
      errs.push("template.icon must be a relative .svg or .png path inside the package");
    }
  }
  return errs;
}

/** 非插件包的 package.json 通用规则：名字、版本、不许安装脚本与依赖字段（不执行、不安装，有也是误导）。 */
function checkCommonPackageJson(pkg: Record<string, unknown>, kind: string, errs: string[]): void {
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
          errs.push(`package.json scripts.${s} is not allowed: catalog packages never run scripts`);
        }
      }
    }
  }
  for (const f of [...FORBIDDEN_DEP_FIELDS, "peerDependencies"] as const) {
    const v = pkg[f];
    if (v === undefined) continue;
    const empty = Array.isArray(v) ? v.length === 0 : isObj(v) && Object.keys(v).length === 0;
    if (!empty) errs.push(`package.json ${f} is not allowed in a ${kind} package`);
  }
}

const isText = (v: unknown, max: number) =>
  typeof v === "string" && v.trim().length > 0 && [...v].length <= max;

/** publisher / description / displayName（技能与连接器模板共有）。 */
function checkListingFields(s: Record<string, unknown>, errs: string[]): void {
  const L = CONNECTOR_TEMPLATE_LIMITS;
  if (!isText(s.publisher, L.publisherChars)) {
    errs.push(
      `capybara.publisher must be a non-empty string of at most ${L.publisherChars} characters`,
    );
  }
  if (!isText(s.description, L.descriptionChars)) {
    errs.push(
      `capybara.description must be a non-empty string of at most ${L.descriptionChars} characters`,
    );
  }
  if (s.displayName !== undefined) {
    const d = s.displayName;
    const ok =
      isObj(d) &&
      Object.keys(d).every((k) => k === "zh" || k === "en") &&
      isText(d.zh, L.displayNameChars) &&
      isText(d.en, L.displayNameChars);
    if (!ok) {
      errs.push(
        `capybara.displayName must be { zh, en } with non-empty strings of at most ${L.displayNameChars} characters`,
      );
    }
  }
}

const SECTION_FIELDS: Record<Exclude<PackageKind, "plugin">, ReadonlySet<string>> = {
  "connector-template": new Set(["kind", "publisher", "description", "displayName", "template"]),
  skill: new Set(["kind", "publisher", "description", "displayName"]),
  app: new Set(["kind", "manifest"]),
};

/**
 * Parses and validates package.json by `capybara.kind`, returning the `capybara` section or a list
 * of problems:
 * - `plugin`: {@link validatePluginPackageJson} (rules on package content such as the entry file
 *   and imports are checked by the kernel when it reads the package);
 * - `connector-template`: the common rules + publisher / description / displayName +
 *   {@link validateConnectorTemplate} (problem paths prefixed `capybara.`); the npm package name
 *   without its scope is the catalog item name and must match {@link CATALOG_ITEM_NAME_RE};
 * - `skill`: the common rules + publisher / description / displayName (the skill name comes from
 *   the package's SKILL.md, checked by the kernel);
 * - `app`: `manifest` must be `app.yaml` (its content is parsed by `parseAppManifest`, checked by
 *   the kernel when it reads the package).
 * The common rules for non-plugin packages: a valid npm package name and semver version, no install
 * scripts, no dependency fields such as dependencies / peerDependencies.
 * The returned section is the input's object itself (not copied).
 */
export function parsePackageSection(
  pkg: unknown,
  hostSdkVersion: string,
): PackageSection | { errors: string[] } {
  if (!isObj(pkg)) return { errors: ["package.json must be a JSON object"] };
  const s = pkg.capybara;
  if (!isObj(s)) return { errors: ['package.json needs a "capybara" section object'] };
  const kind = s.kind;
  if (kind === "plugin") {
    const errs = validatePluginPackageJson(pkg, hostSdkVersion);
    return errs.length > 0 ? { errors: errs } : (s as unknown as PluginPackageSection);
  }
  if (kind !== "connector-template" && kind !== "skill" && kind !== "app") {
    return {
      errors: [`capybara.kind must be one of ${PACKAGE_KINDS.map((k) => `"${k}"`).join(", ")}`],
    };
  }
  const errs: string[] = [];
  checkCommonPackageJson(pkg, kind, errs);
  for (const k of Object.keys(s)) {
    if (!SECTION_FIELDS[kind].has(k)) errs.push(`capybara has unknown field "${k}"`);
  }
  if (kind === "app") {
    if (s.manifest !== APP_MANIFEST_FILE) {
      errs.push(`capybara.manifest must be "${APP_MANIFEST_FILE}"`);
    }
  } else {
    checkListingFields(s, errs);
  }
  if (kind === "connector-template") {
    if (typeof pkg.name === "string" && !CATALOG_ITEM_NAME_RE.test(unscopedPackageName(pkg.name))) {
      errs.push(
        `package.json name without its scope is the catalog item name and must match ${CATALOG_ITEM_NAME_RE}`,
      );
    }
    for (const e of validateConnectorTemplate(s.template)) errs.push(`capybara.${e}`);
  }
  return errs.length > 0 ? { errors: errs } : (s as unknown as PackageSection);
}
