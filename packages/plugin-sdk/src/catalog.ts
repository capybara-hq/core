import semver from "semver";
import { z } from "zod";
import { CATALOG_ITEM_NAME_RE, NPM_PACKAGE_NAME_RE, type PackageKind } from "./plugin-package.js";

/**
 * 目录清单（D16 / C25 / C26）：官方与企业的静态 `index.json`。内核按它浏览条目、按条目各版本的 sha512 校验下载的包
 * （不认 npm 元数据）。仓库里提交的 JSON Schema（`schemas/catalog-index.v1.schema.json`）由 `pnpm gen:package-schemas`
 * 从 {@link CatalogIndexSchema} 生成，`check:package-schemas` 保证二者不漂移。JSON Schema 表达不了的跨字段规则
 * （同一清单内 (kind, name) 唯一、同一条目内版本唯一、`sensitive` ⊆ `keys`、URL 能被解析）只由 {@link parseCatalogIndex} 判定。
 * 未知字段一律忽略（向前兼容：新版清单加字段不让旧内核拒绝整份清单）。
 */

/** 清单格式版本。 */
export const CATALOG_SCHEMA_VERSION = 1;

/** 清单的大小类上限。 */
export const CATALOG_LIMITS = {
  nameChars: 100,
  publisherChars: 100,
  summaryChars: 280,
  entries: 5000,
  versionsPerEntry: 500,
  permissionKeys: 500,
  urlChars: 2000,
} as const;

/** 清单里的一个版本。 */
export interface CatalogVersion {
  /** semver。 */
  version: string;
  /** 包 tgz 的 sha512 SRI：`sha512-<86 位 base64>==`。 */
  integrity: string;
  /** 最低内核版本（semver）。 */
  minKernel: string;
  /** 最低 SDK 版本（semver）；plugin 必填。 */
  minSdk?: string;
  /** 直接下载地址（https）；不给就走配置的 npm registry。 */
  tarball?: string;
  publishedAt?: string;
  /** 弃用说明。 */
  deprecated?: string;
}

/** 清单里的一个条目。 */
export interface CatalogEntry {
  kind: PackageKind;
  /** 条目名（与目录条目名同一规则）；同一清单内 (kind, name) 唯一。 */
  name: string;
  /** npm 包名（可带 scope）。 */
  npm: string;
  publisher: string;
  summary: { en: string; zh?: string };
  /** https URL。 */
  homepage?: string;
  /**
   * 权限摘要（只用于展示；与下载后算出的不一致时警告，不拒绝）：plugin 与 app 才有，键为内核 permissionKeys 的格式
   * （app 为其全部插件的并集），`sensitive` ⊆ `keys`。
   */
  permissions?: { keys: string[]; sensitive: string[] };
  /** ≥ 1，version 唯一。 */
  versions: CatalogVersion[];
}

/** 清单。 */
export interface CatalogIndex {
  schemaVersion: 1;
  name: string;
  publisher?: string;
  /** ISO 8601。 */
  updatedAt: string;
  entries: CatalogEntry[];
}

/** 精确的 semver 版本（JSON Schema 可用的正则）。 */
export const SEMVER_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
/** npm 包 tgz 的 sha512 SRI：`sha512-<86 位 base64>==`。 */
export const SHA512_INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
const SEMVER_RE = SEMVER_VERSION_RE;
const INTEGRITY_RE = SHA512_INTEGRITY_RE;
/** 内核 permissionKeys 的格式：`<类别>[:<值>]`，类别为小写字母与点。 */
const PERMISSION_KEY_RE = /^[a-z][a-z.]{0,62}(?::[^\r\n]{1,256})?$/;
const HTTPS_URL_RE = /^https:\/\/\S+$/;
/** 只供测试：回环地址上的 http。 */
const HTTPS_OR_LOOPBACK_RE =
  /^(?:https:\/\/\S+|http:\/\/(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(?::\d{1,5})?(?:\/\S*)?)$/;

export interface CatalogParseOptions {
  /** 只供测试：允许 `tarball` 用回环地址上的 http。 */
  allowInsecureLoopback?: boolean;
}

const semverString = (what: string) =>
  z
    .string()
    .max(256)
    .regex(SEMVER_RE, { message: `${what} must be a semver version` });

const urlString = (re: RegExp) =>
  z
    .string()
    .max(CATALOG_LIMITS.urlChars)
    .regex(re, { message: "must be an https URL" })
    .refine(
      (s) => {
        try {
          new URL(s);
          return true;
        } catch {
          return false;
        }
      },
      { message: "must be a valid URL" },
    );

const isoDate = () => z.iso.datetime({ offset: true, message: "must be an ISO 8601 date-time" });

function buildSchema(opts: CatalogParseOptions) {
  const version = z.object({
    version: semverString("version"),
    integrity: z
      .string()
      .regex(INTEGRITY_RE, { message: "integrity must be sha512-<86 base64 chars>==" }),
    minKernel: semverString("minKernel"),
    minSdk: semverString("minSdk").optional(),
    tarball: urlString(opts.allowInsecureLoopback ? HTTPS_OR_LOOPBACK_RE : HTTPS_URL_RE).optional(),
    publishedAt: isoDate().optional(),
    deprecated: z.string().min(1).max(CATALOG_LIMITS.summaryChars).optional(),
  });
  const pluginVersion = version.extend({ minSdk: semverString("minSdk") });
  const permissionKey = z.string().max(300).regex(PERMISSION_KEY_RE, {
    message: "must be a permission key (<category>[:<value>])",
  });
  const permissions = z.object({
    keys: z.array(permissionKey).max(CATALOG_LIMITS.permissionKeys),
    sensitive: z.array(permissionKey).max(CATALOG_LIMITS.permissionKeys),
  });
  const common = {
    name: z
      .string()
      .regex(CATALOG_ITEM_NAME_RE, { message: "name must match ^[a-z0-9][a-z0-9-]{0,63}$" }),
    npm: z
      .string()
      .max(214)
      .regex(NPM_PACKAGE_NAME_RE, { message: "npm must be an npm package name" }),
    publisher: z.string().min(1).max(CATALOG_LIMITS.publisherChars),
    summary: z.object({
      en: z.string().min(1).max(CATALOG_LIMITS.summaryChars),
      zh: z.string().min(1).max(CATALOG_LIMITS.summaryChars).optional(),
    }),
    homepage: urlString(HTTPS_URL_RE).optional(),
  };
  const versions = <T extends z.ZodType>(v: T) =>
    z.array(v).min(1).max(CATALOG_LIMITS.versionsPerEntry);
  const entry = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("plugin"),
      ...common,
      permissions: permissions.optional(),
      versions: versions(pluginVersion),
    }),
    z.object({
      kind: z.literal("app"),
      ...common,
      permissions: permissions.optional(),
      versions: versions(version),
    }),
    z.object({
      kind: z.literal("connector-template"),
      ...common,
      permissions: z.never().optional(),
      versions: versions(version),
    }),
    z.object({
      kind: z.literal("skill"),
      ...common,
      permissions: z.never().optional(),
      versions: versions(version),
    }),
  ]);
  return z
    .object({
      schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
      name: z.string().min(1).max(CATALOG_LIMITS.nameChars),
      publisher: z.string().min(1).max(CATALOG_LIMITS.publisherChars).optional(),
      updatedAt: isoDate(),
      entries: z.array(entry).max(CATALOG_LIMITS.entries),
    })
    .superRefine((idx, ctx) => {
      const seen = new Set<string>();
      idx.entries.forEach((e, i) => {
        const key = `${e.kind} ${e.name}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["entries", i, "name"],
            message: `duplicate entry ${key}`,
          });
        }
        seen.add(key);
        const versions = new Set<string>();
        e.versions.forEach((v, j) => {
          if (versions.has(v.version)) {
            ctx.addIssue({
              code: "custom",
              path: ["entries", i, "versions", j, "version"],
              message: `duplicate version ${v.version}`,
            });
          }
          versions.add(v.version);
        });
        if (e.permissions) {
          const keys = new Set(e.permissions.keys);
          for (const s of e.permissions.sensitive) {
            if (!keys.has(s)) {
              ctx.addIssue({
                code: "custom",
                path: ["entries", i, "permissions", "sensitive"],
                message: `sensitive key "${s}" is not in keys`,
              });
            }
          }
        }
      });
    });
}

/** 清单的 zod schema（https only）。生成 JSON Schema 用 `z.toJSONSchema(CatalogIndexSchema, { io: "input" })`。 */
export const CatalogIndexSchema: z.ZodType<CatalogIndex> = buildSchema(
  {},
) as unknown as z.ZodType<CatalogIndex>;

const LOOPBACK_SCHEMA = buildSchema({
  allowInsecureLoopback: true,
}) as unknown as z.ZodType<CatalogIndex>;

const MAX_ERRORS = 50;

/** 校验并解析清单（多余字段被丢弃）。不合法返回 `{ errors }`（`<路径>: <原因>`，最多 50 条），从不抛错。 */
export function parseCatalogIndex(
  json: unknown,
  opts: CatalogParseOptions = {},
): CatalogIndex | { errors: string[] } {
  const r = (opts.allowInsecureLoopback ? LOOPBACK_SCHEMA : CatalogIndexSchema).safeParse(json);
  if (r.success) return r.data;
  return {
    errors: r.error.issues.slice(0, MAX_ERRORS).map((i) => {
      const path = i.path.map(String).join(".");
      return path ? `${path}: ${i.message}` : i.message;
    }),
  };
}

/** 条目里与宿主兼容的版本（`minKernel` / `minSdk` 不高于宿主），按 semver 从新到旧。 */
export function compatibleVersions(
  e: CatalogEntry,
  host: { kernel: string; sdk: string },
): CatalogVersion[] {
  return e.versions
    .filter(
      (v) =>
        semver.gte(host.kernel, v.minKernel) &&
        (v.minSdk === undefined || semver.gte(host.sdk, v.minSdk)),
    )
    .sort((a, b) => semver.rcompare(a.version, b.version));
}
