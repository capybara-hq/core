import type { ConnectorTemplateSpec, PluginManifest } from "@capybara-hq/plugin-sdk";
import { type ExtensionTgzOpts, pluginTgz } from "../helpers/plugin-packages.js";
import { SKILL_MD } from "../skills/zip.js";

/** Plugin tgz for the catalog tests: a skill, a connector template, or a bundle of both. */

export const SVG_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';

export const mcpTemplate = (over: Partial<ConnectorTemplateSpec> = {}): ConnectorTemplateSpec => ({
  plugin: "connector-mcp",
  connector: "mcp",
  endpoint: { url: "https://mcp.example.com/mcp" },
  editableEndpoint: ["url"],
  auth: { type: "bearer", ownership: "org" },
  defaultToolPolicies: { search: "allow" },
  ...over,
});

/** Options shared by the plugin builders below. */
export interface PluginOpts {
  version?: string;
  /** npm name (default `@acme/plugin-<name>`). */
  packageName?: string;
  /** Overrides of plugin.json. */
  manifest?: Partial<PluginManifest>;
  /** More files (paths relative to the package root). */
  files?: Record<string, string | Uint8Array>;
  /** Gives the plugin an extension (see `pluginTgz`). */
  extension?: ExtensionTgzOpts;
}

/** Files of one skill directory `skills/<skill>/` (SKILL.md and `scripts/run.py`). */
export const skillFiles = (
  skill: string,
  md: string = SKILL_MD(skill),
): Record<string, string> => ({
  [`skills/${skill}/SKILL.md`]: md,
  [`skills/${skill}/scripts/run.py`]: "print(1)\n",
});

/** The connector template file `connectors/<id>.json` (with an icon at `icons/<id>.svg` unless `icon: null`). */
export const templateFiles = (
  id: string,
  template: ConnectorTemplateSpec = mcpTemplate(),
  o: { icon?: string | null; displayName?: { zh: string; en: string } } = {},
): Record<string, string> => {
  const icon = o.icon === undefined ? SVG_ICON : o.icon;
  return {
    [`connectors/${id}.json`]: JSON.stringify({
      displayName: o.displayName ?? { zh: "GitHub", en: "GitHub" },
      description: "GitHub over MCP",
      ...(icon !== null && { icon: `./icons/${id}.svg` }),
      template,
    }),
    ...(icon !== null && { [`icons/${id}.svg`]: icon }),
  };
};

const build = (name: string, o: PluginOpts, files: Record<string, string | Uint8Array>) =>
  pluginTgz({
    manifest: {
      name,
      publisher: "Acme",
      description: `${name} plugin`,
      ...(o.version !== undefined && { version: o.version }),
      ...o.manifest,
    },
    packageName: o.packageName ?? `@acme/plugin-${name}`,
    files: { ...files, ...o.files },
    ...(o.extension !== undefined && { extension: o.extension }),
  });

/** A plugin with one skill (`skills/<skill>/`, skill name `skill`, default the plugin name). */
export function skillPlugin(
  name: string,
  o: PluginOpts & { skill?: string; skillMd?: string } = {},
): Promise<Uint8Array> {
  const skill = o.skill ?? name;
  return build(name, o, skillFiles(skill, o.skillMd));
}

/** A plugin with one connector template `connectors/<id>.json` (plugin name default `id`). */
export function templatePlugin(
  id: string,
  template: ConnectorTemplateSpec = mcpTemplate(),
  o: PluginOpts & { name?: string; icon?: string | null } = {},
): Promise<Uint8Array> {
  return build(
    o.name ?? id,
    o,
    templateFiles(id, template, { ...(o.icon !== undefined && { icon: o.icon }) }),
  );
}

/**
 * A plugin bundling skills and connector templates (and dependencies; an extension through
 * `extension`): `skills` are skill names, `templates` maps template ids to templates.
 */
export function bundlePlugin(
  o: PluginOpts & {
    name: string;
    dependencies?: { name: string; version: string }[];
    skills?: string[];
    templates?: Record<string, ConnectorTemplateSpec>;
  },
): Promise<Uint8Array> {
  const files: Record<string, string> = {};
  for (const s of o.skills ?? []) Object.assign(files, skillFiles(s));
  for (const [id, t] of Object.entries(o.templates ?? {}))
    Object.assign(files, templateFiles(id, t));
  return build(
    o.name,
    {
      ...o,
      manifest: {
        ...(o.dependencies !== undefined && { dependencies: o.dependencies }),
        ...o.manifest,
      },
    },
    files,
  );
}
