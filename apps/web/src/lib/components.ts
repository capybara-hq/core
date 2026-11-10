import { ApiClientError, apiFetch, CSRF_HEADER, ensureSession, toError } from "./api";
import type { LocalizedName, PluginScope, ScopeConflict, ThemePreview } from "./catalog";
import { type ThemeScheme, type ThemeSwatch, themeName } from "./themes";

/**
 * Platform components (kernel `catalog/component-scope.controller.ts`, super admins): the
 * deployment's skills, connector templates, agent templates and themes, each with the plugin it came from,
 * its scope (its plugin's, or its own), disable and visibility, its versions, and a new version of a
 * skill or agent template uploaded on its own (spec §5, §7.2).
 */

export const PLATFORM_COMPONENT_KINDS = [
  "skill",
  "connector_template",
  "agent_template",
  "theme",
] as const;
export type PlatformComponentKind = (typeof PLATFORM_COMPONENT_KINDS)[number];

/** Where each kind's admin pages live. */
export const COMPONENT_ROUTES: Record<PlatformComponentKind, string> = {
  skill: "/admin/skills",
  connector_template: "/admin/connector-templates",
  agent_template: "/admin/agent-templates",
  theme: "/admin/themes",
};

/** The path segment each kind's pages show (`/admin/skills` -> `skills`). */
export const COMPONENT_SEGMENTS: Record<PlatformComponentKind, string> = {
  skill: "skills",
  connector_template: "connector-templates",
  agent_template: "agent-templates",
  theme: "themes",
};

/** Who owns an item or component (kernel `catalog/ownership.ts`): the platform, or one org. */
export type Owner = { kind: "platform" } | { kind: "org"; orgId: string; name: string };

/**
 * A component in the admin list (kernel `ComponentView`): a platform component, or an org's own
 * skill or agent template (ruling P2-11; scope, disable and uploads are platform-only).
 */
export interface PlatformComponent {
  kind: PlatformComponentKind;
  id: string;
  /** Skill or template name; a connector template's id. */
  name: string;
  /** A connector template's localized display name (null or absent: show `name`). */
  displayName?: LocalizedName | null;
  /** Its plugin's icon (the admin icon route; null without one). */
  icon?: string | null;
  description: string | null;
  /** The description's Chinese text (a theme's `description.zh`; null: one text for both). */
  descriptionZh?: string | null;
  /** The plugin it came from (null: none). */
  plugin: string | null;
  itemId: string | null;
  /** The platform, or the org that owns it (an org's own item: read-only here; ruling P3-1). */
  owner: Owner;
  /** Its owner shares it with other orgs (the share gate; false for the platform's). */
  shareable: boolean;
  /** A platform row made from an org's own skill or agent template when first shared (P3-3). */
  promoted: boolean;
  /** Of a builtin plugin: its scope cannot be changed nor disabled. */
  builtin: boolean;
  /** `follow`: its plugin's scope; `own`: its own. */
  scopeMode: "follow" | "own";
  /** The effective scope. */
  scope: PluginScope;
  /** The effective `named` list, sorted. */
  orgs: string[];
  /** Orgs that switched an `all` component off (0 for other scopes). */
  offCount?: number;
  disabled: boolean;
  /** Its plugin is disabled or deleted: off everywhere. */
  pluginStopped: boolean;
  shownToOthers: boolean;
  /** Its own version counter (a connector template: its catalog version). */
  version: string;
  /** The orgs it is on in now. */
  onIn: string[];
  /** A theme: its name and swatches from its current version. */
  theme?: {
    name: { en: string; zh?: string };
    swatches: Partial<Record<ThemeScheme, ThemeSwatch>>;
  };
}

/**
 * A component's name as the UI shows it: a theme's own name in the locale, else its localized
 * display name (a connector template), else `name`.
 */
export const componentName = (c: PlatformComponent, locale: string): string =>
  c.theme !== undefined ? themeName(c.theme, locale) : componentLabel(c, locale);

/**
 * An org's own skill or agent template not promoted yet (the org row's id, ruling P3-23): not a
 * platform row, so it has no deployment disable; showing or associating it promotes it first.
 */
export const isOrgRow = (c: PlatformComponent): boolean =>
  c.owner.kind === "org" && !c.promoted && c.itemId === null;

/** Why the super admin cannot show an org-owned component to or associate it with other orgs. */
export type ShareBlock = "notShareable" | "notOwned";

/**
 * The share gate of an org-owned component (rulings P3-1, P3-16, P4-13), null when the super
 * admin may show and associate it (and always for the platform's): an org row must be one its org
 * created itself (no plugin), an org's agent template too (a plugin's template is shared with its
 * plugin, ruling T4-R9; P3-46 is lifted for org-created templates only), and its owner must share it.
 */
export function shareBlockOf(c: PlatformComponent): ShareBlock | null {
  if (c.owner.kind === "platform") return null;
  if ((isOrgRow(c) || c.kind === "agent_template") && c.plugin !== null) return "notOwned";
  return c.shareable ? null : "notShareable";
}

/**
 * After a change that promoted an org row (ruling P3-23: the answer carries the platform id), the
 * detail moves to the new id; the list was read again by the mutation's invalidation.
 */
export function moveTo(
  router: { replace(href: string): void },
  before: PlatformComponent,
  after: PlatformComponent,
): void {
  if (after.id !== before.id) {
    router.replace(`${COMPONENT_ROUTES[before.kind]}/${encodeURIComponent(after.id)}`);
  }
}

/** One version of a platform component (kernel `ComponentVersionView`). */
export interface ComponentVersion {
  version: string;
  /** The plugin version it came from (null: uploaded on its own). */
  catalogVersion: string | null;
  updatedOnOwn: boolean;
  createdAt: string;
}

/** What a component scope change, disable or return to its plugin's scope would do. */
export interface ComponentScopePreview {
  affected: {
    orgId: string;
    orgName: string;
    agents: { id: string; name: string }[];
    /** A connector template: the org's connectors made from it, which stay as the org's own. */
    connectorsKept: number;
  }[];
  conflicts: ScopeConflict[];
  /** A theme the change takes away: whose default it is and who picked it (themes spec §6). */
  themes?: ThemePreview[];
  scopeHash: string;
}

/** `{ scope, orgs? }`, `{ disabled: true }` or `{ follow: true }`. */
export type ComponentTarget =
  | { scope: PluginScope; orgs?: string[] }
  | { disabled: true }
  | { follow: true };

/** A new version uploaded on its own (kernel `UploadedComponentVersion`). */
export interface UploadedComponentVersion {
  kind: "skill" | "agent_template";
  id: string;
  name: string;
  version: number;
}

/** A component's name in the reader's language: a connector template's display name, else its name. */
export const componentLabel = (
  c: { name: string; displayName?: LocalizedName | null },
  locale: string,
): string => (c.displayName ? (locale === "zh" ? c.displayName.zh : c.displayName.en) : c.name);

/**
 * A component's description in the reader's language (browser review F08): its Chinese text in the
 * zh UI when it has one, else the one it has; null when it has none.
 */
export const componentDescription = (
  c: { description: string | null; descriptionZh?: string | null },
  locale: string,
): string | null => {
  const text = locale === "zh" ? (c.descriptionZh ?? c.description) : c.description;
  return text === null || text === "" ? null : text;
};

const enc = encodeURIComponent;
const base = "/api/v1/admin/components";
const one = (kind: PlatformComponentKind, id: string) => `${base}/${kind}/${enc(id)}`;
const send = (method: "POST" | "PUT", body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export const listPlatformComponents = (kind: PlatformComponentKind) =>
  apiFetch<{ components: PlatformComponent[] }>(`${base}?kind=${kind}`);

export const listComponentVersions = (kind: PlatformComponentKind, id: string) =>
  apiFetch<{ versions: ComponentVersion[] }>(`${one(kind, id)}/versions`);

export const previewComponentScope = (
  kind: PlatformComponentKind,
  id: string,
  target: ComponentTarget,
) => apiFetch<ComponentScopePreview>(`${one(kind, id)}/scope/preview`, send("POST", target));

/** Gives the component its own scope or makes it follow its plugin, with the preview's hash. */
export const setComponentScope = (
  kind: PlatformComponentKind,
  id: string,
  body: ({ scope: PluginScope; orgs?: string[] } | { follow: true }) & { scopeHash: string },
) => apiFetch<PlatformComponent>(`${one(kind, id)}/scope`, send("PUT", body));

/** Disables (with the `{ disabled: true }` preview's hash) or enables the component. */
export const setComponentDisabled = (
  kind: PlatformComponentKind,
  id: string,
  body: { disabled: boolean; scopeHash?: string },
) => apiFetch<PlatformComponent>(`${one(kind, id)}/disabled`, send("PUT", body));

/** Whether orgs outside a `named` component's list see it. */
export const setComponentShown = (
  kind: PlatformComponentKind,
  id: string,
  shownToOthers: boolean,
) => apiFetch<PlatformComponent>(`${one(kind, id)}/shown`, send("PUT", { shownToOthers }));

/**
 * Uploads a new version of a platform skill (its .zip as the raw body, streamed by the kernel).
 * Checks the session first: the proxy streams the body through, and a stream cannot be replayed.
 */
export async function uploadSkillVersion(
  id: string,
  file: Blob,
): Promise<UploadedComponentVersion> {
  await ensureSession();
  const res = await fetch(`${one("skill", id)}/versions`, {
    method: "POST",
    credentials: "same-origin",
    headers: { [CSRF_HEADER]: "1", "content-type": "application/octet-stream" },
    body: file,
  }).catch((e: unknown) => {
    throw new ApiClientError(0, "network", e instanceof Error ? e.message : String(e));
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as UploadedComponentVersion;
}

/** Uploads a new version of a platform agent template (its markdown file's text). */
export const uploadAgentTemplateVersion = (id: string, content: string) =>
  apiFetch<UploadedComponentVersion>(
    `${one("agent_template", id)}/versions`,
    send("POST", { content }),
  );

/**
 * A platform component offered to the org (kernel `OrgOfferedComponentView`, `GET
 * /orgs/:orgId/components`): on there, or one an org admin could switch on. Members read it.
 */
export interface OrgComponent {
  kind: PlatformComponentKind;
  id: string;
  /** Skill or template name; a connector template's id. */
  name: string;
  /** A connector template's localized display name (null or absent: show `name`). */
  displayName?: LocalizedName | null;
  /** Its plugin's icon on the org's icon route (null without one or when the org cannot see it). */
  icon?: string | null;
  description: string | null;
  /** The description's Chinese text (a theme's `description.zh`; null: one text for both). */
  descriptionZh?: string | null;
  plugin: string | null;
  itemId: string | null;
  version: string;
  scopeMode: "follow" | "own";
  /** The org's own switch (null: never switched). */
  switch: boolean | null;
  on: boolean;
  /** Of a builtin plugin: on for every org, never switched off here (已启用 · 平台统一). */
  locked: boolean;
  /** A component following its plugin: the plugin is on in the org (true for its own scope). */
  pluginOn: boolean;
  /** An org admin may switch it now (not locked; its plugin on when it follows it). */
  switchable: boolean;
  /** On by platform default: effective scope `all`, not builtin (平台默认启用; the org may turn it off). */
  platformDefault?: boolean;
  /** The org's copies linked to it (older agents select them; absent from older kernels). */
  linkedIds?: string[];
  /** The platform, or the org that owns it (an org's upload; absent from older kernels). */
  owner?: Owner;
  /**
   * Connector templates only: the template's setup guide in its plugin's latest version, null
   * without one (setup guides v2 spec §9.3; other kinds and older kernels: absent).
   */
  guide?: { itemId: string; guideId: string } | null;
}

/**
 * The platform component an id stands for (its own id or a linked copy's) while it is offered to
 * the org but off there: an agent that selects it lists it as unavailable (spec §5 rule 8), never
 * as deleted; turning it on again brings it back.
 */
export const unavailableComponent = (
  offered: readonly OrgComponent[] | null | undefined,
  kind: PlatformComponentKind,
  id: string,
): OrgComponent | undefined =>
  offered?.find(
    (c) => c.kind === kind && !c.on && (c.id === id || (c.linkedIds ?? []).includes(id)),
  );

/** What switching a component off in the org takes away: the agents using it, connectors kept. */
export interface ComponentSwitchPreview {
  preview: {
    agents: { id: string; name: string; refs: string[] }[];
    connectorsKept: number;
    /** A theme: whether it is the org's default and how many members picked it. */
    themes?: ThemePreview[];
  };
  confirm: string;
}

const orgBase = (orgId: string) => `/api/v1/orgs/${enc(orgId)}/components`;

/** The components offered to the org, of one kind and / or of one plugin. */
export const listOrgComponents = (
  orgId: string,
  filter: { kind?: PlatformComponentKind; itemId?: string },
) => {
  const q = new URLSearchParams();
  if (filter.kind !== undefined) q.set("kind", filter.kind);
  if (filter.itemId !== undefined) q.set("itemId", filter.itemId);
  const qs = q.toString();
  return apiFetch<{ components: OrgComponent[] }>(`${orgBase(orgId)}${qs === "" ? "" : `?${qs}`}`);
};

/**
 * Switches one component on or off in the org (org admins). Off on a component in use answers its
 * preview first; confirm with its hash. `all` -> 409 `plugin.scope_locked`; a name taken in the
 * org -> 409 `plugin.skill_conflict`.
 */
export const setOrgComponentSwitch = (
  orgId: string,
  kind: PlatformComponentKind,
  id: string,
  body: { enabled: boolean; confirm?: string },
) =>
  apiFetch<{ component: OrgComponent } | ComponentSwitchPreview>(
    `${orgBase(orgId)}/${kind}/${enc(id)}/switch`,
    send("PUT", body),
  );

/** One row of a workspace component page: the org's own item, or a platform one with its state. */
export type UsableRow<T> =
  | { kind: "own"; item: T }
  | { kind: "platform"; item: T | undefined; component: OrgComponent | undefined };

/**
 * The rows of a workspace 技能 / 智能体模板 page by name: the org's own items, then each platform
 * component once (the usable set has the ones on in the org, the component list every one offered;
 * either may be missing while it loads).
 */
export function usableRows<T extends { id: string; name: string; origin?: "org" | "platform" }>(
  usable: readonly T[],
  offered: readonly OrgComponent[] | undefined,
): UsableRow<T>[] {
  const rows: UsableRow<T>[] = usable
    .filter((x) => x.origin !== "platform")
    .map((item) => ({ kind: "own", item }));
  const platform = usable.filter((x) => x.origin === "platform");
  const ids = new Set([...platform.map((x) => x.id), ...(offered ?? []).map((c) => c.id)]);
  for (const id of ids) {
    rows.push({
      kind: "platform",
      item: platform.find((x) => x.id === id),
      component: offered?.find((c) => c.id === id),
    });
  }
  const nameOf = (r: UsableRow<T>) =>
    r.item?.name ?? (r.kind === "platform" ? (r.component?.name ?? "") : "");
  return rows.sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));
}

/**
 * Whether a workspace template row may be the org's own agent template (rulings P4-12, P4-13): no
 * plugin, and the org's own row without a catalog item, or a platform row this org owns (one it
 * shared, promoted). Only a candidate: the template's detail (`owned`) decides.
 */
export function maybeOwnTemplate(
  r: UsableRow<{ id: string; plugin: string | null; catalogItemId?: string | null }>,
  orgId: string,
): boolean {
  if (r.kind === "own") return r.item.plugin === null && (r.item.catalogItemId ?? null) === null;
  const plugin = r.item?.plugin ?? r.component?.plugin ?? null;
  const owner = r.component?.owner;
  return plugin === null && owner?.kind === "org" && owner.orgId === orgId;
}
