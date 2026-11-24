import type { ReactNode } from "react";
import {
  agentTemplateNameOf,
  type CatalogItem,
  type CatalogItemDetail,
  type CatalogItemVersion,
  clientFilesOf,
  displayNameOf,
  type PluginManifest,
  skillNameOf,
  templateIdOf,
} from "../../lib/catalog";
import {
  COMPONENT_ROUTES,
  componentDescription,
  componentName,
  type PlatformComponent,
  type PlatformComponentKind,
} from "../../lib/components";
import type {
  AgentRow,
  ConfigField,
  ContentsDependency,
  ContentsExtension,
  ContentsLicense,
  PluginContentsModel,
  SkillRow,
  TemplateRow,
  ThemeRow,
} from "./model";

/** The page of a platform component (its name links to it). */
const hrefOf = (c: PlatformComponent | undefined): { href?: string } =>
  c === undefined ? {} : { href: `${COMPONENT_ROUTES[c.kind]}/${encodeURIComponent(c.id)}` };

/** What the surface draws in the contents' trailing slots (it owns the links and the copy). */
export interface ManifestSlots {
  /** A row's scope (follow or its own, linking to the component page); `c` is absent when unlisted. */
  scope: (kind: PlatformComponentKind, c: PlatformComponent | undefined) => ReactNode;
  /** The lines under the extension: its client code (a file count) and client components. */
  extensionLines: (client: { files: number } | null, uiComponents: string[]) => ReactNode;
  /** A dependency: found in the catalog (its versions) or not. */
  dependency: (found: CatalogItem | undefined, catalogRead: boolean) => ReactNode;
}

/** The version the platform runs (its manifest is what the contents list). */
export function platformVersionOf(detail: CatalogItemDetail): CatalogItemVersion | undefined {
  const { item } = detail;
  return (
    detail.versions.find((v) => v.version === (item.platformVersion ?? item.latestVersion)) ??
    detail.versions.find((v) => v.version === item.latestVersion)
  );
}

/** How many components a manifest holds: the extension, skills, templates, agents and themes. */
export const manifestCount = (m: PluginManifest): number =>
  (m.extension ? 1 : 0) +
  (m.skills?.length ?? 0) +
  (m.connectorTemplates?.length ?? 0) +
  (m.agents?.length ?? 0) +
  (m.themes?.length ?? 0);

/** The license fact of a version: its SPDX name, else "LICENSE", with the text when it was kept. */
export function licenseOf(v: CatalogItemVersion | undefined): ContentsLicense | undefined {
  if (v === undefined) return undefined;
  const name =
    v.manifest.license !== undefined && v.manifest.license !== "" ? v.manifest.license : "LICENSE";
  const text =
    typeof v.licenseText === "string" && v.licenseText !== "" ? v.licenseText : undefined;
  if (text !== undefined) return { name, text };
  if (v.licenseTruncated === true) return { name, truncated: true };
  return v.manifest.license !== undefined && v.manifest.license !== "" ? { name } : undefined;
}

/** The top-level config fields of an extension's manifest, a secret one marked. */
function configOf(m: NonNullable<PluginManifest["extension"]>["manifest"]): ConfigField[] {
  const fields = new Map<string, boolean>();
  for (const f of m.config?.deployment ?? []) {
    const top = f.path.split(".")[0] ?? f.path;
    fields.set(top, (fields.get(top) ?? false) || f.secret);
  }
  return [...fields].map(([name, secret]) => ({ name, secret }));
}

/**
 * The contents of the version the platform runs (the platform plugin page's components tab): the
 * extension with its client code and client components as lines under it, the skills, connector
 * templates, agent templates and themes with their scope in the trailing slot, the dependencies
 * and the translation report. Names and descriptions come from the platform's components when it
 * lists them. The license is the page's fact (see {@link licenseOf}), not part of this model.
 */
export function fromManifest(
  detail: CatalogItemDetail,
  components: PlatformComponent[],
  locale: string,
  opts: { slots: ManifestSlots; catalog: CatalogItem[] | null },
): PluginContentsModel {
  const { item } = detail;
  const version = platformVersionOf(detail);
  const m = version?.manifest;
  const { slots, catalog } = opts;
  const own = (kind: PlatformComponentKind, name: string) =>
    components.find((c) => c.kind === kind && c.itemId === item.id && c.name === name);
  const ext = m?.extension?.manifest;
  const client = m?.extension?.client;
  const uiComponents = ext?.permissions.ui?.components ?? [];
  const clientFiles = client !== undefined ? clientFilesOf(client).length : 0;
  const hasLines = client !== undefined || uiComponents.length > 0;
  const extension: ContentsExtension | undefined =
    ext === undefined
      ? undefined
      : {
          name: ext.name,
          provides: ext.provides.map((value) => ({ value, sensitive: false })),
          config: configOf(ext),
          needsConfig: (ext.config?.deployment ?? []).length > 0,
          ...(hasLines && {
            trailing: slots.extensionLines(
              client === undefined ? null : { files: clientFiles },
              uiComponents,
            ),
          }),
        };
  const skills: SkillRow[] = (m?.skills ?? []).map((s) => {
    const name = skillNameOf(s.path);
    const c = own("skill", name);
    return {
      kind: "skill",
      key: s.path,
      name,
      description: c === undefined ? "" : (componentDescription(c, locale) ?? ""),
      trailing: slots.scope("skill", c),
      ...hrefOf(c),
    };
  });
  const templates: TemplateRow[] = (m?.connectorTemplates ?? []).map((t) => {
    const id = templateIdOf(t.path);
    const c = own("connector_template", id);
    return {
      kind: "connectorTemplate",
      key: t.path,
      id,
      name: c === undefined ? id : componentName(c, locale),
      icon: c?.icon ?? null,
      description: c === undefined ? "" : (componentDescription(c, locale) ?? ""),
      trailing: slots.scope("connector_template", c),
      ...hrefOf(c),
    };
  });
  const agents: AgentRow[] = (m?.agents ?? []).map((a) => {
    const name = agentTemplateNameOf(a.path);
    const c = own("agent_template", name);
    return {
      kind: "agentTemplate",
      key: a.path,
      name,
      description: c === undefined ? "" : (componentDescription(c, locale) ?? ""),
      needs: [],
      trailing: slots.scope("agent_template", c),
      ...hrefOf(c),
    };
  });
  // Themes are listed without a scope: this page reads no theme list
  const themes: ThemeRow[] = (m?.themes ?? []).map((th) => ({
    kind: "theme",
    key: th.path,
    name: templateIdOf(th.path),
  }));
  const dependencies: ContentsDependency[] = (m?.dependencies ?? []).map((d) => {
    const found = catalog?.find((i) => i.name === d.name);
    return {
      name: d.name,
      range: d.version,
      resolved: null,
      ...(found !== undefined && { href: `/admin/plugins/${found.id}` }),
      trailing: slots.dependency(found, catalog !== null),
    };
  });
  return {
    head: {
      name: displayNameOf(item, locale),
      version: version?.version ?? item.platformVersion ?? item.latestVersion,
      sensitive: 0,
    },
    // the page's own facts carry the description
    description: "",
    facts: {},
    ...(extension !== undefined && { extension }),
    skills,
    templates,
    agents,
    themes,
    dependencies,
    ...(version?.translation != null && { translation: version.translation }),
  };
}
