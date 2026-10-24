import semver from "semver";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SEMVER_VERSION_RE, SHA512_INTEGRITY_RE } from "./catalog.js";
import { EXTENSION_NAME_RE } from "./define-extension.js";
import {
  CONNECTOR_TEMPLATE_LIMITS,
  type ConnectorTemplateSpec,
  DIRECTORY_ITEM_NAME_RE,
  isSafePackagePath,
  type LocalizedName,
  NPM_PACKAGE_NAME_RE,
  validateConnectorTemplate,
} from "./plugin-package.js";

export { APP_MANIFEST_FILE } from "./plugin-package.js";

/**
 * 应用包清单 `app.yaml`（D17 / C31）：应用 = 插件 + 连接器模板 + 技能的组合包，打成 npm-pack tgz，package.json 为
 * `{ capybara: { kind: "app", manifest: "app.yaml" } }`。
 *
 * - 插件按清单名、npm 包名、semver 范围与 lock（精确版本 + tgz 的 sha512）引用；**插件包不打进应用包**，
 *   内核导入时按 lock 从配置的 npm registry 拉取并按 `lock.integrity` 校验（与清单引入同一套下载与校验）。
 * - 连接器模板内联声明（与连接器模板包的 `template` 同形，{@link validateConnectorTemplate}），`template.plugin`
 *   必须列在 `plugins` 里，或是部署里已知的连接器插件（{@link AppManifestParseOptions.isKnownConnectorPlugin}）。
 * - 技能打在包里：每个 `skills[].path` 是包内目录，含 SKILL.md（内容由内核按技能包规则校验）。
 * - 应用里的 agent 模板推迟（C32）。
 *
 * 仓库里提交的 JSON Schema（`schemas/app.v1.schema.json`）由 `pnpm gen:package-schemas` 从 {@link AppManifestSchema}
 * 生成，`check:package-schemas` 保证二者不漂移。JSON Schema 表达不了的规则（lock 版本满足范围、范围本身合法、
 * 名字 / id / 路径唯一、模板引用的插件已列出、模板的静态规则、路径安全）只由 {@link parseAppManifest} 判定。
 * 未知字段一律拒绝（清单是包作者写的，拼错字段应当报错而不是被忽略）。
 */

/** 清单格式版本。 */
export const APP_MANIFEST_SCHEMA_VERSION = 1;

/** 应用包清单的上限。 */
export const APP_MANIFEST_LIMITS = {
  /** `app.yaml` 的字符数上限（超过不做 YAML 解析）。 */
  manifestChars: 256 * 1024,
  plugins: 20,
  connectorTemplates: 20,
  skills: 50,
  descriptionChars: 1024,
  publisherChars: CONNECTOR_TEMPLATE_LIMITS.publisherChars,
  displayNameChars: CONNECTOR_TEMPLATE_LIMITS.displayNameChars,
  pathChars: 512,
} as const;

/** 应用引用的一个插件。 */
export interface AppPluginRef {
  /** 插件清单名。 */
  name: string;
  /** npm 包名（可带 scope）。 */
  npm: string;
  /** semver 范围：部署里已装且满足范围的插件不动。 */
  version: string;
  /** 锁定的版本与 tgz 的 sha512（`lock.version` 必须满足 `version`）。 */
  lock: { version: string; integrity: string };
  /** 组织安装时可以不启用。 */
  optional?: boolean;
}

/** 应用里内联的连接器模板。 */
export interface AppConnectorTemplate {
  /** 包内唯一，`^[a-z0-9][a-z0-9-]{0,63}$`。 */
  id: string;
  displayName: LocalizedName;
  description?: string;
  template: ConnectorTemplateSpec;
}

/** `app.yaml`。 */
export interface AppManifest {
  schemaVersion: 1;
  /** 目录条目名，`^[a-z0-9][a-z0-9-]{0,63}$`。 */
  name: string;
  /** semver，必须与 package.json 的 version 一致（内核检查）。 */
  version: string;
  publisher: string;
  /** ≤ 1024 字符。 */
  description: string;
  displayName?: LocalizedName;
  /** 包内 .svg / .png。 */
  icon?: string;
  /** ≤ 20。 */
  plugins: AppPluginRef[];
  /** ≤ 20。 */
  connectorTemplates: AppConnectorTemplate[];
  /** ≤ 50；`path` 为包内目录（含 SKILL.md）。 */
  skills: { path: string }[];
}

export interface AppManifestParseOptions {
  /**
   * 不在 `plugins` 里、但部署里已有（内置 / 配置声明 / 已安装）的连接器插件：模板可以引用它。
   * 不给时模板只能引用 `plugins` 里列出的插件。
   */
  isKnownConnectorPlugin?: (name: string) => boolean;
}

const L = APP_MANIFEST_LIMITS;
const ICON_RE = /\.(?:svg|png|SVG|PNG)$/;

const text = (max: number, what: string) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/\S/, { message: `${what} must not be blank` });

const localized = z.strictObject({
  zh: text(L.displayNameChars, "displayName.zh"),
  en: text(L.displayNameChars, "displayName.en"),
});

const semverVersion = (what: string) =>
  z
    .string()
    .max(256)
    .regex(SEMVER_VERSION_RE, { message: `${what} must be a semver version` });

const packagePath = (what: string) =>
  z
    .string()
    .min(1)
    .max(L.pathChars)
    .refine(isSafePackagePath, {
      message: `${what} must be a relative path inside the package (no "..", no leading "/")`,
    });

function buildSchema(opts: AppManifestParseOptions) {
  const plugin = z.strictObject({
    name: z
      .string()
      .regex(EXTENSION_NAME_RE, { message: "name must be a plugin name (^[a-z][a-z0-9-]{1,40}$)" }),
    npm: z
      .string()
      .max(214)
      .regex(NPM_PACKAGE_NAME_RE, { message: "npm must be an npm package name" }),
    version: z
      .string()
      .min(1)
      .max(256)
      .refine((r) => semver.validRange(r) !== null, {
        message: "version must be a valid semver range",
      }),
    lock: z.strictObject({
      version: semverVersion("lock.version"),
      integrity: z.string().regex(SHA512_INTEGRITY_RE, {
        message: "lock.integrity must be sha512-<86 base64 chars>==",
      }),
    }),
    optional: z.boolean().optional(),
  });
  // 模板只校验结构；字段规则（无凭据、认证预设、editableEndpoint 等）在 superRefine 里交给 validateConnectorTemplate
  const template = z.strictObject({
    plugin: z.string().max(100),
    pluginVersion: z.string().max(256).optional(),
    connector: z.string().max(100),
    endpoint: z.record(z.string(), z.unknown()),
    editableEndpoint: z
      .array(z.string().max(1000))
      .max(CONNECTOR_TEMPLATE_LIMITS.editablePaths)
      .optional(),
    auth: z.record(z.string(), z.unknown()),
    ownership: z.enum(["org", "personal"]).optional(),
    defaultToolPolicies: z.record(z.string(), z.enum(["allow", "ask", "deny"])).optional(),
    icon: z.string().max(L.pathChars).optional(),
  });
  const connectorTemplate = z.strictObject({
    id: z.string().regex(DIRECTORY_ITEM_NAME_RE, {
      message: "id must match ^[a-z0-9][a-z0-9-]{0,63}$",
    }),
    displayName: localized,
    description: text(L.descriptionChars, "description").optional(),
    template,
  });
  return z
    .strictObject({
      schemaVersion: z.literal(APP_MANIFEST_SCHEMA_VERSION),
      name: z.string().regex(DIRECTORY_ITEM_NAME_RE, {
        message: "name must match ^[a-z0-9][a-z0-9-]{0,63}$",
      }),
      version: semverVersion("version"),
      publisher: text(L.publisherChars, "publisher"),
      description: text(L.descriptionChars, "description"),
      displayName: localized.optional(),
      icon: packagePath("icon")
        .regex(ICON_RE, { message: "icon must be a .svg or .png file" })
        .optional(),
      plugins: z.array(plugin).max(L.plugins),
      connectorTemplates: z.array(connectorTemplate).max(L.connectorTemplates),
      skills: z.array(z.strictObject({ path: packagePath("path") })).max(L.skills),
    })
    .superRefine((m, ctx) => {
      const issue = (path: (string | number)[], message: string) =>
        ctx.addIssue({ code: "custom", path, message });
      const byName = new Map<string, { lock: { version: string } }>();
      const npms = new Set<string>();
      m.plugins.forEach((p, i) => {
        if (byName.has(p.name)) issue(["plugins", i, "name"], `duplicate plugin ${p.name}`);
        byName.set(p.name, p);
        if (npms.has(p.npm)) issue(["plugins", i, "npm"], `duplicate npm package ${p.npm}`);
        npms.add(p.npm);
        if (
          semver.validRange(p.version) !== null &&
          !semver.satisfies(p.lock.version, p.version, { includePrerelease: true })
        ) {
          issue(
            ["plugins", i, "lock", "version"],
            `${p.lock.version} does not satisfy the version range ${p.version}`,
          );
        }
      });
      const ids = new Set<string>();
      m.connectorTemplates.forEach((c, i) => {
        if (ids.has(c.id))
          issue(["connectorTemplates", i, "id"], `duplicate connector template id ${c.id}`);
        ids.add(c.id);
        for (const e of validateConnectorTemplate(c.template)) issue(["connectorTemplates", i], e);
        const listed = byName.get(c.template.plugin);
        if (!listed && !opts.isKnownConnectorPlugin?.(c.template.plugin)) {
          issue(
            ["connectorTemplates", i, "template", "plugin"],
            `connector plugin ${c.template.plugin} is not listed in plugins (and is not a connector plugin known to this deployment)`,
          );
        }
        const range = c.template.pluginVersion;
        if (
          listed &&
          range !== undefined &&
          semver.validRange(range) !== null &&
          !semver.satisfies(listed.lock.version, range, { includePrerelease: true })
        ) {
          issue(
            ["connectorTemplates", i, "template", "pluginVersion"],
            `the locked ${c.template.plugin} ${listed.lock.version} does not satisfy ${range}`,
          );
        }
      });
      const paths: string[] = [];
      m.skills.forEach((s, i) => {
        if (paths.includes(s.path)) {
          issue(["skills", i, "path"], `duplicate skill path ${s.path}`);
          return;
        }
        const nested = paths.find((p) => s.path.startsWith(`${p}/`) || p.startsWith(`${s.path}/`));
        if (nested !== undefined) {
          issue(
            ["skills", i, "path"],
            `skill path ${s.path} is inside another skill (${nested}) or contains it`,
          );
        }
        paths.push(s.path);
      });
    });
}

/** 应用包清单的 zod schema。生成 JSON Schema 用 `z.toJSONSchema(AppManifestSchema, { io: "input" })`。 */
export const AppManifestSchema: z.ZodType<AppManifest> = buildSchema(
  {},
) as unknown as z.ZodType<AppManifest>;

const MAX_ERRORS = 50;

/**
 * 解析并校验 `app.yaml`（YAML：重复键报错、别名数有上限；超过 {@link APP_MANIFEST_LIMITS}`.manifestChars` 不解析）。
 * 不合法返回 `{ errors }`（`<路径>: <原因>`，英文，最多 50 条，不回显模板里的值），从不抛错。
 */
export function parseAppManifest(
  yamlText: string,
  opts: AppManifestParseOptions = {},
): AppManifest | { errors: string[] } {
  if (typeof yamlText !== "string") return { errors: ["app.yaml must be text"] };
  if (yamlText.length > L.manifestChars) {
    return { errors: [`app.yaml is larger than ${L.manifestChars} characters`] };
  }
  const src = yamlText.startsWith("﻿") ? yamlText.slice(1) : yamlText;
  let data: unknown;
  try {
    data = parseYaml(src, { uniqueKeys: true, maxAliasCount: 50 });
  } catch (e) {
    const first = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    return { errors: [`app.yaml is not valid YAML: ${first}`] };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { errors: ["app.yaml must be a YAML mapping"] };
  }
  const schema = opts.isKnownConnectorPlugin ? buildSchema(opts) : AppManifestSchema;
  const r = schema.safeParse(data);
  if (r.success) return r.data as AppManifest;
  return {
    errors: r.error.issues.slice(0, MAX_ERRORS).map((i) => {
      const path = i.path.map(String).join(".");
      return path ? `${path}: ${i.message}` : i.message;
    }),
  };
}
