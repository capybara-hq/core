import semver from "semver";
import { z } from "zod";
import { defineExtension, EXTENSION_NAME_RE, type ExtensionManifest } from "./define-extension.js";
import {
  CATALOG_ITEM_NAME_RE,
  CONNECTOR_TEMPLATE_LIMITS,
  type ConnectorTemplateSpec,
  isSafePackagePath,
  type LocalizedName,
  SEMVER_VERSION_RE,
  type StaticExtensionManifest,
  validateConnectorTemplate,
} from "./plugin-package.js";
import { hasUpperBound } from "./semver-range.js";

/**
 * The plugin manifest `.capybara-plugin/plugin.json` (package ecosystem spec §4.1). A plugin is a
 * bundle of at most one extension, skills and connector templates, packed as an npm-pack tgz:
 *
 * ```
 * package/package.json                  npm metadata; version equals plugin.json version
 * package/.capybara-plugin/plugin.json  this manifest (the packer writes it into every tgz)
 * package/skills/<name>/SKILL.md        skills
 * package/connectors/<id>.json          connector templates ({@link ConnectorTemplateFile})
 * package/dist/index.mjs                extension entry (only with an extension)
 * package/migrations/*.sql, package/ui/**
 * ```
 *
 * Paths start with `./` and stay inside the plugin root. Omitting `skills` / `connectorTemplates`
 * means "scan `skills/*\/SKILL.md` / `connectors/*.json`" (done by the kernel when it reads the
 * package). `extension` is written by the packer, never by hand.
 *
 * The committed JSON Schema (`schemas/plugin.v1.schema.json`) is generated from
 * {@link PluginManifestSchema} by `pnpm gen:package-schemas` and drift-checked by
 * `check:package-schemas`. Rules JSON Schema cannot express (path safety and nesting, uniqueness,
 * no self-dependency, extension name and version equal to the plugin's, the extension manifest
 * rules of defineExtension) are decided only by {@link parsePluginManifest}. Unknown keys are
 * rejected (the manifest is written by the author; a typo should fail, not be ignored).
 */

/** Path of the manifest inside the plugin root (and under `package/` in a tgz). */
export const PLUGIN_MANIFEST_FILE = ".capybara-plugin/plugin.json";

/** Manifest format version. */
export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1;

/** Limits of the plugin manifest. */
export const PLUGIN_MANIFEST_LIMITS = {
  /** Characters of the `plugin.json` text (larger text is not parsed). */
  manifestChars: 256 * 1024,
  dependencies: 20,
  skills: 50,
  connectorTemplates: 20,
  descriptionChars: 1024,
  publisherChars: 100,
  displayNameChars: 100,
  pathChars: 512,
} as const;

/** A plugin this one depends on: a plugin name and a semver range. */
export interface PluginDependency {
  /** Catalog item name (`^[a-z0-9][a-z0-9-]{0,63}$`). */
  name: string;
  /** semver range. */
  version: string;
}

/** A skill of the plugin: a `./…` directory holding SKILL.md. */
export interface PluginSkillRef {
  path: string;
  /** Suggested as pinned (spec §9.1; stored, no runtime effect yet). */
  pinned?: boolean;
}

/** A connector template of the plugin: a `./…/<id>.json` file ({@link ConnectorTemplateFile}). */
export interface PluginConnectorTemplateRef {
  path: string;
}

/** The plugin's extension, written by the packer. */
export interface PluginExtensionSection {
  /** `./dist/index.mjs`. */
  entry: string;
  /** The static extension manifest (checked against the module's at load: `manifest_mismatch`). */
  manifest: StaticExtensionManifest;
  /** `./migrations`. */
  migrations?: string;
  /** `./ui`. */
  ui?: string;
}

/** `.capybara-plugin/plugin.json`. */
export interface PluginManifest {
  $schema?: string;
  schemaVersion: 1;
  /** Catalog item name; with an extension also an extension name, equal to `extension.manifest.name`. */
  name: string;
  /** Exact semver version. */
  version: string;
  publisher: string;
  /** ≤ 1024 characters. */
  description: string;
  displayName?: LocalizedName;
  /** `./…` .svg / .png inside the plugin. */
  icon?: string;
  license?: string;
  /** https URL. */
  homepage?: string;
  /** No self-dependency, no duplicates. */
  dependencies?: PluginDependency[];
  /** Omitted = scan `skills/*\/SKILL.md`. */
  skills?: PluginSkillRef[];
  /** Omitted = scan `connectors/*.json`. */
  connectorTemplates?: PluginConnectorTemplateRef[];
  /** Reserved: a non-empty list is rejected ("agents are not supported yet"). */
  agents?: [];
  extension?: PluginExtensionSection;
}

/** A connector template file `connectors/<id>.json`; the template id is the file's base name. */
export interface ConnectorTemplateFile {
  displayName: LocalizedName;
  description?: string;
  /** Safe path relative to the plugin root (an optional leading `./`), .svg / .png. */
  icon?: string;
  /** Validated by {@link validateConnectorTemplate}. */
  template: ConnectorTemplateSpec;
}

const L = PLUGIN_MANIFEST_LIMITS;
const MAX_ERRORS = 50;
const ICON_RE = /\.(?:svg|png)$/i;
const HTTPS_URL_RE = /^https:\/\/\S+$/;

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

/** `./<safe path>` (the part after `./` passes {@link isSafePackagePath}). */
const isDotPath = (p: string) => p.startsWith("./") && isSafePackagePath(p.slice(2));
const dotPath = (what: string) =>
  z
    .string()
    .min(3)
    .max(L.pathChars)
    .regex(/^\.\//, { message: `${what} must start with "./"` })
    .refine(isDotPath, {
      message: `${what} must be a relative path inside the plugin (no "..", no leading "/")`,
    });

const stripDot = (p: string) => p.replace(/^\.\//, "");
/** `connectors/crm.json` → `crm`. */
const baseId = (p: string) => (p.split("/").pop() ?? "").replace(/\.json$/, "");

const configFields = z
  .array(z.strictObject({ path: z.string().max(1000), secret: z.boolean(), hot: z.boolean() }))
  .max(1000);

const staticExtensionManifest = z.strictObject({
  name: z.string(),
  version: z.string(),
  sdk: z.string().max(256),
  provides: z.array(z.string()),
  requires: z.array(z.string()),
  optional: z.array(z.string()),
  permissions: z.record(z.string(), z.unknown()),
  ui: z.array(z.record(z.string(), z.unknown())).optional(),
  config: z.strictObject({ deployment: configFields, org: configFields }),
});

const extensionSection = z.strictObject({
  entry: dotPath("entry").refine((p) => p.endsWith(".mjs"), {
    message: "entry must be a .mjs file",
  }),
  manifest: staticExtensionManifest,
  migrations: dotPath("migrations").optional(),
  ui: dotPath("ui").optional(),
});

const schema = z
  .strictObject({
    $schema: z.string().max(L.pathChars).optional(),
    schemaVersion: z.literal(PLUGIN_MANIFEST_SCHEMA_VERSION),
    name: z.string().regex(CATALOG_ITEM_NAME_RE, {
      message: "name must match ^[a-z0-9][a-z0-9-]{0,63}$",
    }),
    version: z
      .string()
      .max(256)
      .regex(SEMVER_VERSION_RE, { message: "version must be an exact semver version" }),
    publisher: text(L.publisherChars, "publisher"),
    description: text(L.descriptionChars, "description"),
    displayName: localized.optional(),
    icon: dotPath("icon")
      .regex(ICON_RE, { message: "icon must be a .svg or .png file" })
      .optional(),
    license: text(100, "license").optional(),
    homepage: z
      .string()
      .max(2000)
      .regex(HTTPS_URL_RE, { message: "homepage must be an https URL" })
      .optional(),
    dependencies: z
      .array(
        z.strictObject({
          name: z.string().regex(CATALOG_ITEM_NAME_RE, {
            message: "name must match ^[a-z0-9][a-z0-9-]{0,63}$",
          }),
          version: z
            .string()
            .min(1)
            .max(256)
            .refine((r) => semver.validRange(r) !== null, {
              message: "version must be a valid semver range",
            }),
        }),
      )
      .max(L.dependencies)
      .optional(),
    skills: z
      .array(z.strictObject({ path: dotPath("path"), pinned: z.boolean().optional() }))
      .max(L.skills)
      .optional(),
    connectorTemplates: z
      .array(
        z.strictObject({
          path: dotPath("path").refine(
            (p) => p.endsWith(".json") && CATALOG_ITEM_NAME_RE.test(baseId(p)),
            { message: "path must be a <id>.json file with id matching ^[a-z0-9][a-z0-9-]{0,63}$" },
          ),
        }),
      )
      .max(L.connectorTemplates)
      .optional(),
    agents: z.array(z.unknown()).max(0, { message: "agents are not supported yet" }).optional(),
    extension: extensionSection.optional(),
  })
  .superRefine((m, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const names = new Set<string>();
    m.dependencies?.forEach((d, i) => {
      if (d.name === m.name) issue(["dependencies", i, "name"], "a plugin cannot depend on itself");
      if (names.has(d.name)) issue(["dependencies", i, "name"], `duplicate dependency ${d.name}`);
      names.add(d.name);
    });
    const dirs: string[] = [];
    m.skills?.forEach((s, i) => {
      const p = stripDot(s.path);
      if (dirs.includes(p)) {
        issue(["skills", i, "path"], `duplicate skill path ${s.path}`);
        return;
      }
      const other = dirs.find((d) => p.startsWith(`${d}/`) || d.startsWith(`${p}/`));
      if (other !== undefined) {
        issue(
          ["skills", i, "path"],
          `skill path ${s.path} is inside another skill (./${other}) or contains it`,
        );
      }
      dirs.push(p);
    });
    const ids = new Set<string>();
    m.connectorTemplates?.forEach((c, i) => {
      const id = baseId(c.path);
      if (ids.has(id))
        issue(["connectorTemplates", i, "path"], `duplicate connector template id ${id}`);
      ids.add(id);
    });
    if (m.extension === undefined && m.skills?.length === 0 && m.connectorTemplates?.length === 0) {
      issue([], "a plugin must contain an extension, a skill or a connector template");
    }
    const ext = m.extension;
    if (ext === undefined) return;
    const em = ext.manifest;
    if (!EXTENSION_NAME_RE.test(m.name)) {
      issue(["name"], `a plugin with an extension needs an extension name (${EXTENSION_NAME_RE})`);
    }
    if (em.name !== m.name) {
      issue(
        ["extension", "manifest", "name"],
        `extension name "${em.name}" must equal the plugin name "${m.name}"`,
      );
    }
    if (em.version !== m.version) {
      issue(
        ["extension", "manifest", "version"],
        `extension version "${em.version}" must equal the plugin version "${m.version}"`,
      );
    }
    if (semver.validRange(em.sdk) !== null && !hasUpperBound(em.sdk)) {
      issue(
        ["extension", "manifest", "sdk"],
        `"${em.sdk}" has no upper bound: use a range such as ^0.1.0 so a future major SDK is not assumed compatible`,
      );
    }
    for (const k of ["deployment", "org"] as const) {
      const seen = new Set<string>();
      for (const f of em.config[k]) {
        if (seen.has(f.path)) {
          issue(["extension", "manifest", "config", k], `duplicate config path "${f.path}"`);
        }
        seen.add(f.path);
      }
    }
    // Name, version, sdk range, extension point refs, permissions, UI contributions: the same
    // rules as defineExtension (with a placeholder setup).
    try {
      defineExtension({
        ...(em as unknown as ExtensionManifest),
        config: undefined,
        migrations: undefined,
        setup() {},
      } as unknown as ExtensionManifest);
    } catch (e) {
      issue(["extension", "manifest"], e instanceof Error ? e.message : String(e));
    }
  });

/**
 * The zod schema of `plugin.json` (strict objects: unknown keys rejected, `$schema` allowed).
 * The JSON Schema is generated with `z.toJSONSchema(PluginManifestSchema, { io: "input" })`.
 */
export const PluginManifestSchema: z.ZodType<PluginManifest> =
  schema as unknown as z.ZodType<PluginManifest>;

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

const templateFile = z
  .strictObject({
    displayName: localized,
    description: text(CONNECTOR_TEMPLATE_LIMITS.descriptionChars, "description").optional(),
    icon: z
      .string()
      .max(L.pathChars)
      .refine((p) => isSafePackagePath(stripDot(p)) && ICON_RE.test(p), {
        message: "icon must be a relative .svg or .png path inside the plugin",
      })
      .optional(),
    template,
  })
  // Field rules (no credentials, auth presets, editableEndpoint, ...) belong to validateConnectorTemplate.
  .superRefine((f, ctx) => {
    for (const e of validateConnectorTemplate(f.template)) {
      ctx.addIssue({ code: "custom", path: [], message: e });
    }
  });

/**
 * The zod schema of a connector template file (strict). The JSON Schema is generated with
 * `z.toJSONSchema(ConnectorTemplateFileSchema, { io: "input" })`.
 */
export const ConnectorTemplateFileSchema: z.ZodType<ConnectorTemplateFile> =
  templateFile as unknown as z.ZodType<ConnectorTemplateFile>;

function parseWith<T>(
  zodSchema: z.ZodType<T>,
  json: unknown,
  file: string,
): T | { errors: string[] } {
  let data = json;
  if (typeof json === "string") {
    if (json.length > L.manifestChars) {
      return { errors: [`${file} is larger than ${L.manifestChars} characters`] };
    }
    try {
      data = JSON.parse(json.startsWith("﻿") ? json.slice(1) : json);
    } catch (e) {
      const first = (e instanceof Error ? e.message : String(e)).split("\n")[0];
      return { errors: [`${file} is not valid JSON: ${first}`] };
    }
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { errors: [`${file} must be a JSON object`] };
  }
  const r = zodSchema.safeParse(data);
  if (r.success) return r.data;
  return {
    errors: r.error.issues.slice(0, MAX_ERRORS).map((i) => {
      const path = i.path.map(String).join(".");
      return path ? `${path}: ${i.message}` : i.message;
    }),
  };
}

/**
 * Parses and validates `plugin.json`: either the parsed JSON value or the file text (text larger
 * than {@link PLUGIN_MANIFEST_LIMITS}`.manifestChars` is not parsed). Invalid input returns
 * `{ errors }` (`<path>: <reason>`, English, at most 50); never throws. Whether the listed paths
 * exist, and the "contains something" rule after scanning, are checked by the kernel when it reads
 * the package.
 */
export function parsePluginManifest(json: unknown): PluginManifest | { errors: string[] } {
  return parseWith(PluginManifestSchema, json, "plugin.json");
}

/**
 * Parses and validates a connector template file (`connectors/<id>.json`): the parsed JSON value
 * or the file text. Template problems come from {@link validateConnectorTemplate} (paths relative
 * to the template root, values never echoed). Returns `{ errors }` (at most 50); never throws.
 */
export function parseConnectorTemplateFile(
  json: unknown,
): ConnectorTemplateFile | { errors: string[] } {
  return parseWith(ConnectorTemplateFileSchema, json, "connector template file");
}
