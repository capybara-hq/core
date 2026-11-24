import type { ReactNode } from "react";
import {
  agentTemplateNameOf,
  descriptionOf,
  displayNameOf,
  type OrgCatalogDetail,
  type OrgCatalogTemplate,
  skillNameOf,
  templateNeed,
} from "../../lib/catalog";
import type { OrgComponent } from "../../lib/components";
import type { OrgExtension } from "../../lib/extensions";
import type { ContentsExtension, PluginContentsModel, TemplateRow } from "./model";
import { nameIn } from "./model";

/** What enabling the plugin does with a connector template, as the org enable page states it. */
export type EnableState = "ready" | "needs_client" | "needs_credential" | "kept" | "off";

/**
 * The state of a template once the plugin is enabled in the org: the org's existing connector is
 * kept; a default-off template the org has not switched on creates none; one that needs an OAuth
 * client or an org credential becomes a needs-configuration connector; any other is ready.
 */
export function enableState(t: OrgCatalogTemplate): EnableState {
  if (t.connected === true) return "kept";
  if (t.defaultOff && t.on !== true) return "off";
  const need = templateNeed(t);
  if (need === "client") return "needs_client";
  if (need === "credential") return "needs_credential";
  return "ready";
}

/** What a surface hands the adapter to fill the rows' trailing slots. */
export interface FromOrgOptions {
  /** A connector template row's trailing slot (the enable page: its {@link EnableState}). */
  template?: (t: OrgCatalogTemplate) => ReactNode;
}

/** The extension block of an org's catalog detail: what it provides, and whether it needs config. */
function extensionOf(
  detail: OrgCatalogDetail,
  extension: OrgExtension | undefined,
  locale: string,
): ContentsExtension | undefined {
  if (detail.extension === null) return undefined;
  return {
    name: extension?.displayName != null ? nameIn(extension.displayName, locale) : detail.extension,
    provides: (extension?.provides ?? []).map((value) => ({ value, sensitive: false })),
    config: [],
    needsConfig: extension?.needsConfig === true,
  };
}

/**
 * The contents of a plugin as an org sees it (the enable page and the org's plugin page): the org
 * catalog detail, the descriptions of its skills and agent templates from the org's components
 * (the detail lists names only) and the org's extension, if it has one. Every connector template is
 * a row, those switched off by default included; `opts.template` fills their trailing slot.
 */
export function fromOrgDetail(
  detail: OrgCatalogDetail,
  components: OrgComponent[],
  extension: OrgExtension | undefined,
  locale: string,
  opts: FromOrgOptions = {},
): PluginContentsModel {
  const item = detail.item;
  const describe = (kind: OrgComponent["kind"], name: string): string => {
    const c = components.find((x) => x.kind === kind && x.name === name);
    return c === undefined ? "" : descriptionOf({ ...c, description: c.description ?? "" }, locale);
  };
  const ext = extensionOf(detail, extension, locale);
  const templates: TemplateRow[] = detail.templates.map((c) => ({
    kind: "connectorTemplate",
    key: c.id,
    id: c.id,
    name: c.displayName
      ? displayNameOf({ name: c.id, displayName: c.displayName }, locale)
      : c.connector,
    icon: c.icon ?? null,
    description: descriptionOf(c, locale),
    endpoint: c.endpoint,
    editableEndpoint: c.editableEndpoint,
    auth: c.auth,
    ...(opts.template !== undefined && { trailing: opts.template(c) }),
  }));
  return {
    head: {
      name: displayNameOf(item, locale),
      version: item.latestVersion,
      sensitive: 0,
    },
    description: descriptionOf(item, locale),
    facts: item.publisher !== "" ? { publisher: item.publisher } : {},
    ...(ext !== undefined && { extension: ext }),
    skills: detail.skills.map((dir) => {
      const name = skillNameOf(dir);
      return { kind: "skill", key: dir, name, description: describe("skill", name) };
    }),
    templates,
    agents: detail.agents.map((path) => {
      const name = agentTemplateNameOf(path);
      return {
        kind: "agentTemplate",
        key: path,
        name,
        description: describe("agent_template", name),
        needs: [],
        toolsUnknown: true,
      };
    }),
    themes: [],
    dependencies: detail.dependencies.map((d) => ({
      name: d.name,
      range: d.range,
      resolved: null,
    })),
  };
}
