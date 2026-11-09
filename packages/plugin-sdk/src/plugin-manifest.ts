import semver from "semver";
import { z } from "zod";
import { AGENT_TEMPLATE_LIMITS } from "./agent-template.js";
import { type PluginClientSection, validateClientSection } from "./client-section.js";
import { CONFIG_UI_LIMITS, type JsonSchema } from "./config-ui.js";
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
import {
  type PluginSetupGuide,
  SETUP_GUIDE_FILE_RE,
  SETUP_GUIDE_LANGUAGES,
  SETUP_GUIDE_LIMITS,
  SETUP_GUIDE_MODES,
  SETUP_GUIDE_PLACES,
} from "./setup-guide.js";
import { type PluginThemeRef, THEME_LIMITS, themeIdOf } from "./theme.js";
import { parseSlotRef, uiSlot } from "./ui-slots.js";

/**
 * The plugin manifest `.capybara-plugin/plugin.json` (package ecosystem spec §4.1). A plugin is a
 * bundle of at most one extension, skills, connector templates, agent templates and themes, packed as
 * an npm-pack tgz:
 *
 * ```
 * package/package.json                  npm metadata; version equals plugin.json version
 * package/.capybara-plugin/plugin.json  this manifest (the packer writes it into every tgz)
 * package/skills/<name>/SKILL.md        skills
 * package/connectors/<id>.json          connector templates ({@link ConnectorTemplateFile})
 * package/agents/<name>.md              agent templates (parsed by `parseAgentTemplate`)
 * package/themes/<id>.json              themes (parsed by `parseThemeFile`)
 * package/dist/index.mjs                extension entry (only with an extension)
 * package/migrations/*.sql, package/ui/**
 * ```
 *
 * Paths start with `./` and stay inside the plugin root. Omitting `skills` / `connectorTemplates`
 * / `agents` / `themes` means "scan `skills/*\/SKILL.md` / `connectors/*.json` / `agents/*.md` /
 * `themes/*.json`" (done by the kernel when it reads the package). `extension` is written by the packer, never by hand.
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
  /** Agent templates ({@link AGENT_TEMPLATE_LIMITS}`.perPlugin`). */
  agents: AGENT_TEMPLATE_LIMITS.perPlugin,
  /** Themes ({@link THEME_LIMITS}`.perPlugin`). */
  themes: THEME_LIMITS.perPlugin,
  descriptionChars: 1024,
  publisherChars: 100,
  displayNameChars: 100,
  pathChars: 512,
  /** Entries of `suggestedAppearance.replacements`. */
  appearanceReplacements: 8,
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
  /** Suggested as pinned when an agent selects the skill (spec §9.1). */
  pinned?: boolean;
}

/** A connector template of the plugin: a `./…/<id>.json` file ({@link ConnectorTemplateFile}). */
export interface PluginConnectorTemplateRef {
  path: string;
}

/** An agent template of the plugin: a `./…/<name>.md` file (see `parseAgentTemplate`). */
export interface PluginAgentRef {
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
  /**
   * The config JSON Schemas (`configJsonSchema`, with `x-ui` hints), written by the packer so an
   * extension not loaded on a replica still gets its form; each ≤
   * {@link CONFIG_UI_LIMITS}`.configSchemaBytes`. Not part of the `manifest_mismatch` comparison.
   */
  configSchemas?: { deployment?: JsonSchema; org?: JsonSchema };
  /** Browser code, styles and assets (needs `permissions.client: true`); see {@link PluginClientSection}. */
  client?: PluginClientSection;
}

/**
 * How the plugin suggests it should look when chosen (client extensions spec §6.5). Nothing applies
 * on install; an admin applies it in one confirmed step.
 */
export interface SuggestedAppearance {
  /** A theme id (file base name) of this plugin. */
  theme?: string;
  /** Replaceable slot id → a `component` contribution id of this plugin's extension in that slot. */
  replacements?: Record<string, string>;
}

/**
 * A plugin's description: a string (English) or `{ en, zh? }`, each ≤ 1024 characters. Read it
 * through {@link pluginDescription}.
 */
export type PluginDescription = string | { en: string; zh?: string };

/** A plugin description as `{ en, zh? }` (a plain string is the English text). */
export function pluginDescription(d: PluginDescription): { en: string; zh?: string } {
  return typeof d === "string" ? { en: d } : { en: d.en, ...(d.zh !== undefined && { zh: d.zh }) };
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
  /** A string (English) or `{ en, zh? }`, each ≤ 1024 characters; see {@link pluginDescription}. */
  description: PluginDescription;
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
  /** Agent templates; omitted = scan `agents/*.md`. */
  agents?: PluginAgentRef[];
  /** Themes; omitted = scan `themes/*.json`. */
  themes?: PluginThemeRef[];
  /**
   * Setup guides (spec `2026-11-08-plugin-setup-guides-design.md`): steps and template files the
   * kernel renders for a place (`channel-connection`); see {@link PluginSetupGuide}.
   */
  setupGuides?: PluginSetupGuide[];
  /** See {@link SuggestedAppearance}. */
  suggestedAppearance?: SuggestedAppearance;
  extension?: PluginExtensionSection;
}

/** A connector template file `connectors/<id>.json`; the template id is the file's base name. */
export interface ConnectorTemplateFile {
  displayName: LocalizedName;
  description?: string;
  /** Safe path relative to the plugin root (an optional leading `./`), .svg / .png. */
  icon?: string;
  /**
   * `false`: the template starts switched off in every org, even where its plugin is on, until an
   * org admin switches it on (it then needs no org input while off). Default `true`: on wherever
   * its plugin is. Ignored for a builtin plugin.
   */
  defaultEnabled?: boolean;
  /** Validated by {@link validateConnectorTemplate}. */
  template: ConnectorTemplateSpec;
}

const L = PLUGIN_MANIFEST_LIMITS;
const MAX_ERRORS = 50;
const ICON_RE = /\.(?:svg|png)$/i;
const COMPONENT_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
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

const configSchemaJson = z
  .record(z.string(), z.unknown())
  .refine(
    (v) => new TextEncoder().encode(JSON.stringify(v)).length <= CONFIG_UI_LIMITS.configSchemaBytes,
    {
      message: `must be at most ${CONFIG_UI_LIMITS.configSchemaBytes} bytes of JSON (${CONFIG_UI_LIMITS.configSchemaBytes / 1024} KiB)`,
    },
  );

const guideText = (max: number, what: string) =>
  z.strictObject({ en: text(max, `${what}.en`), zh: text(max, `${what}.zh`).optional() });

const setupGuide = z.strictObject({
  id: z.string().regex(CATALOG_ITEM_NAME_RE, {
    message: "id must match ^[a-z0-9][a-z0-9-]{0,63}$",
  }),
  place: z.enum(SETUP_GUIDE_PLACES),
  title: guideText(SETUP_GUIDE_LIMITS.titleChars, "title"),
  steps: z
    .array(
      z.strictObject({
        en: text(SETUP_GUIDE_LIMITS.stepChars, "en"),
        zh: text(SETUP_GUIDE_LIMITS.stepChars, "zh").optional(),
        mode: z.string().max(64).optional(),
      }),
    )
    .max(SETUP_GUIDE_LIMITS.steps)
    .optional(),
  files: z
    .array(
      z.strictObject({
        path: dotPath("path").regex(SETUP_GUIDE_FILE_RE, {
          message: "path must be a .tmpl, .yaml, .yml, .json or .txt file",
        }),
        title: guideText(SETUP_GUIDE_LIMITS.titleChars, "title"),
        language: z.enum(SETUP_GUIDE_LANGUAGES),
        mode: z.string().max(64).optional(),
      }),
    )
    .max(SETUP_GUIDE_LIMITS.files)
    .optional(),
});

const clientSection = z
  .strictObject({
    entry: z.string().max(L.pathChars).optional(),
    styles: z.array(z.string().max(L.pathChars)).max(64).optional(),
    assets: z.array(z.string().max(L.pathChars)).max(256).optional(),
    integrity: z.record(z.string().max(L.pathChars), z.string().max(128)),
    apiVersion: z.number().int().min(1),
  })
  .superRefine((c, ctx) => {
    for (const e of validateClientSection(c))
      ctx.addIssue({ code: "custom", path: [], message: e });
  });

const suggestedAppearance = z.strictObject({
  theme: z
    .string()
    .regex(CATALOG_ITEM_NAME_RE, { message: "theme must match ^[a-z0-9][a-z0-9-]{0,63}$" })
    .optional(),
  replacements: z.record(z.string().max(100), z.string().max(100)).optional(),
});

const extensionSection = z.strictObject({
  entry: dotPath("entry").refine((p) => p.endsWith(".mjs"), {
    message: "entry must be a .mjs file",
  }),
  manifest: staticExtensionManifest,
  migrations: dotPath("migrations").optional(),
  ui: dotPath("ui").optional(),
  configSchemas: z
    .strictObject({ deployment: configSchemaJson.optional(), org: configSchemaJson.optional() })
    .optional(),
  client: clientSection.optional(),
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
    description: z.union([
      text(L.descriptionChars, "description"),
      z.strictObject({
        en: text(L.descriptionChars, "description.en"),
        zh: text(L.descriptionChars, "description.zh").optional(),
      }),
    ]),
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
    agents: z
      .array(
        z.strictObject({
          path: dotPath("path").regex(/\.md$/, { message: "path must be a .md file" }),
        }),
      )
      .max(L.agents)
      .optional(),
    themes: z
      .array(
        z.strictObject({
          path: dotPath("path").refine(
            (p) => p.endsWith(".json") && CATALOG_ITEM_NAME_RE.test(themeIdOf(p)),
            { message: "path must be a <id>.json file with id matching ^[a-z0-9][a-z0-9-]{0,63}$" },
          ),
        }),
      )
      .max(L.themes)
      .optional(),
    setupGuides: z.array(setupGuide).max(SETUP_GUIDE_LIMITS.guides).optional(),
    suggestedAppearance: suggestedAppearance.optional(),
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
    const agentPaths = new Set<string>();
    m.agents?.forEach((a, i) => {
      if (agentPaths.has(a.path))
        issue(["agents", i, "path"], `duplicate agent template path ${a.path}`);
      agentPaths.add(a.path);
    });
    const themeIds = new Set<string>();
    m.themes?.forEach((t, i) => {
      const id = themeIdOf(t.path);
      if (themeIds.has(id)) issue(["themes", i, "path"], `duplicate theme id ${id}`);
      themeIds.add(id);
    });
    const guideIds = new Set<string>();
    m.setupGuides?.forEach((g, i) => {
      if (guideIds.has(g.id)) issue(["setupGuides", i, "id"], `duplicate setup guide id ${g.id}`);
      guideIds.add(g.id);
      if ((g.steps?.length ?? 0) === 0 && (g.files?.length ?? 0) === 0) {
        issue(["setupGuides", i], "a setup guide needs at least one step or file");
      }
      const modes = SETUP_GUIDE_MODES[g.place];
      const badMode = (mode: string | undefined, path: (string | number)[]) => {
        if (mode !== undefined && !modes.includes(mode)) {
          issue(path, `mode must be one of ${modes.join(", ")} for place ${g.place}`);
        }
      };
      g.steps?.forEach((s, j) => {
        badMode(s.mode, ["setupGuides", i, "steps", j, "mode"]);
      });
      const paths = new Set<string>();
      g.files?.forEach((f, j) => {
        badMode(f.mode, ["setupGuides", i, "files", j, "mode"]);
        if (paths.has(f.path)) {
          issue(["setupGuides", i, "files", j, "path"], `duplicate file ${f.path} in the guide`);
        }
        paths.add(f.path);
      });
      if (
        g.place === "channel-connection" &&
        m.extension !== undefined &&
        !m.extension.manifest.provides.some((p) => p.startsWith("channel@"))
      ) {
        issue(
          ["setupGuides", i, "place"],
          "a channel-connection guide needs the plugin's extension to provide channel@1",
        );
      }
    });
    const sa = m.suggestedAppearance;
    if (sa !== undefined) {
      const at = ["suggestedAppearance"];
      if (sa.theme === undefined && sa.replacements === undefined) {
        issue(at, "suggestedAppearance needs theme or replacements");
      }
      if (sa.theme !== undefined && m.themes !== undefined && !themeIds.has(sa.theme)) {
        issue(
          [...at, "theme"],
          `suggestedAppearance.theme names ${sa.theme}, which is not a theme of the plugin`,
        );
      }
      if (sa.replacements !== undefined) {
        const entries = Object.entries(sa.replacements);
        if (m.extension === undefined) {
          issue([...at, "replacements"], "suggestedAppearance.replacements needs an extension");
        }
        if (entries.length > L.appearanceReplacements) {
          issue(
            [...at, "replacements"],
            `suggestedAppearance.replacements has ${entries.length} entries; the limit is ${L.appearanceReplacements}`,
          );
        }
        const seen = new Set<string>();
        for (const [slot, id] of entries) {
          const ref = parseSlotRef(slot);
          if (ref === null) {
            issue(
              [...at, "replacements"],
              `suggestedAppearance.replacements: ${slot} is not a slot ref`,
            );
            continue;
          }
          if (seen.has(ref.id)) {
            issue(
              [...at, "replacements"],
              `suggestedAppearance.replacements: ${slot} names the slot ${ref.id} again; give each slot once`,
            );
            continue;
          }
          seen.add(ref.id);
          if (!COMPONENT_ID_RE.test(id)) {
            issue(
              [...at, "replacements"],
              `suggestedAppearance.replacements: ${slot} names ${id}, which is not a contribution id`,
            );
            continue;
          }
          const known = uiSlot(ref.id);
          if (known === undefined) continue;
          if (known.cardinality !== "single") {
            issue(
              [...at, "replacements"],
              `suggestedAppearance.replacements: ${slot} is not a replaceable slot`,
            );
            continue;
          }
          const ok = (m.extension?.manifest.ui ?? []).some((u) => {
            const us = typeof u.slot === "string" ? parseSlotRef(u.slot) : null;
            return u.id === id && u.kind === "component" && us?.id === ref.id;
          });
          if (!ok) {
            issue(
              [...at, "replacements"],
              `suggestedAppearance.replacements: ${slot} names ${id}, which is not a component contribution in that slot`,
            );
          }
        }
      }
    }
    if (
      m.extension === undefined &&
      m.skills?.length === 0 &&
      m.connectorTemplates?.length === 0 &&
      (m.agents === undefined || m.agents.length === 0) &&
      (m.themes === undefined || m.themes.length === 0)
    ) {
      issue(
        [],
        "a plugin must contain an extension, a skill, a connector template, an agent template or a theme",
      );
    }
    const ext = m.extension;
    if (ext === undefined) return;
    const em = ext.manifest;
    const hasClientPermission = em.permissions.client === true;
    if (ext.client !== undefined && !hasClientPermission) {
      issue(["extension", "client"], "extension.client needs permissions.client: true");
    }
    if (ext.client === undefined && hasClientPermission) {
      issue(
        ["extension", "manifest", "permissions", "client"],
        "extension.client needs permissions.client: true (permissions.client is set without a client section)",
      );
    }
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
    defaultEnabled: z.boolean().optional(),
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
      data = JSON.parse(json.startsWith("\uFEFF") ? json.slice(1) : json);
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

/**
 * The theme check of `suggestedAppearance` after the themes are known (the manifest may omit
 * `themes` and let the scan find them): shared by the packer and the kernel.
 */
export function appearanceIssues(manifest: PluginManifest, themeIds: readonly string[]): string[] {
  const theme = manifest.suggestedAppearance?.theme;
  if (theme === undefined || themeIds.includes(theme)) return [];
  return [`suggestedAppearance.theme names ${theme}, which is not a theme of the plugin`];
}
