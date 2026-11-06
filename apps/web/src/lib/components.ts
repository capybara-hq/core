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
  /** `platform`, or the id of the org that owns it (an org's own item: read-only here). */
  owner: string;
  /** The owning org's name (null for `platform`). */
  ownerName: string | null;
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
