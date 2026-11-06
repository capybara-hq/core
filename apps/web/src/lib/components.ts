import { ApiClientError, apiFetch, CSRF_HEADER, ensureSession, toError } from "./api";
import type { PluginScope, ScopeConflict } from "./catalog";

/**
 * Platform components (kernel `catalog/component-scope.controller.ts`, super admins): the
 * deployment's skills, connector templates and agent templates, each with the plugin it came from,
 * its scope (its plugin's, or its own), disable and visibility, its versions, and a new version of a
 * skill or agent template uploaded on its own (spec §5, §7.2).
 */

export const PLATFORM_COMPONENT_KINDS = ["skill", "connector_template", "agent_template"] as const;
export type PlatformComponentKind = (typeof PLATFORM_COMPONENT_KINDS)[number];

/** Where each kind's admin pages live. */
export const COMPONENT_ROUTES: Record<PlatformComponentKind, string> = {
  skill: "/admin/skills",
  connector_template: "/admin/connector-templates",
  agent_template: "/admin/agent-templates",
};

/** The path segment each kind's pages show (`/admin/skills` -> `skills`). */
export const COMPONENT_SEGMENTS: Record<PlatformComponentKind, string> = {
  skill: "skills",
  connector_template: "connector-templates",
  agent_template: "agent-templates",
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
  name: string;
  description: string | null;
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
  disabled: boolean;
  /** Its plugin is disabled or deleted: off everywhere. */
  pluginStopped: boolean;
  shownToOthers: boolean;
  /** Its own version counter (a connector template: its catalog version). */
  version: string;
  /** The orgs it is on in now. */
  onIn: string[];
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
  name: string;
  description: string | null;
  plugin: string | null;
  itemId: string | null;
  version: string;
  scopeMode: "follow" | "own";
  /** The org's own switch (null: never switched). */
  switch: boolean | null;
  on: boolean;
  /** Its effective scope is `all`: on for every org, never switched off here (已启用 · 平台统一). */
  locked: boolean;
  /** A component following its plugin: the plugin is on in the org (true for its own scope). */
  pluginOn: boolean;
  /** An org admin may switch it now (not locked; its plugin on when it follows it). */
  switchable: boolean;
  /** The org's copies linked to it (older agents select them; absent from older kernels). */
  linkedIds?: string[];
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
  preview: { agents: { id: string; name: string; refs: string[] }[]; connectorsKept: number };
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
