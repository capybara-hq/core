import { apiFetch } from "./api";
import type { LocalizedName, PluginScope, SwitchPreview } from "./catalog";
import type { ConfigIssue, JsonSchema } from "./json-schema";

/**
 * Sensitive reason codes (kernel `SensitiveReason`): the UI translates them by code
 * (`extensions.review.reason.<code>`); only the kernel decides what is sensitive.
 */
export type SensitiveReason =
  | "secrets"
  | "public_routes"
  | "tools"
  | "hooks"
  | "ui_embed"
  | "channel"
  | "directory"
  | "identity_source"
  | "sandbox"
  | "object_store";

/** 权限清单的一项（内核 `PermissionItem`）：逐项的敏感标记与原因码。 */
export interface PermissionItem {
  value: string;
  sensitive: boolean;
  reason?: SensitiveReason;
}

/** 权限清单的一组（内核 `PermissionGroup`）：`sensitive` 为需要特别留意的类别，`entries` 与 `items` 一一对应。 */
export interface PermissionGroup {
  category: string;
  sensitive: boolean;
  items: string[];
  entries: PermissionItem[];
}

/** Why an extension cannot run on the platform (kernel `ExtensionUnavailableReason`). */
export type ExtensionUnavailableReason =
  | "not_deployed"
  | "needs_deployment_config"
  | "pending_approval"
  | "pending_migration"
  | "loading"
  | "dependency"
  | "conflict"
  | "failed"
  | "deployment_disabled";

/** One extension from the org's view (kernel `OrgExtensionView`). */
export interface OrgExtension {
  plugin: string;
  /** The extension's display name; null when it has none (show the id). */
  displayName?: LocalizedName | null;
  /**
   * The URL of its plugin's icon (a kernel catalog icon route for this viewer's scope); null when
   * the plugin has none or the viewer may not see it: draw the initial.
   */
  icon?: string | null;
  version: string;
  enabled: boolean;
  configurable: boolean;
  config: Record<string, unknown> | null;
  secrets: { path: string; set: boolean }[];
  permissions: PermissionGroup[];
  orgConfigSchema: JsonSchema | null;
  /** false：此插件在部署上当前不可用（如被停用；组织页显示「不可用」，启用设置保留、不能修改）。 */
  available?: boolean;
  /**
   * Only when unavailable: why it cannot run on the platform (kernel `OrgExtensionView.reason`),
   * e.g. `needs_deployment_config`. Older kernels leave it out.
   */
  reason?: ExtensionUnavailableReason;
  /**
   * A required bootstrap plugin (kernel `OrgExtensionView.required`): enabled in every org and
   * cannot be disabled (the kernel answers 409 `extension.required`); its org config can still be set.
   */
  required?: boolean;
  /** The catalog plugin the extension ships in and its scope (builtin counts as `all`); null without one. */
  catalogItem?: { itemId: string; scope: PluginScope } | null;
  /** The org admin can switch it (the plugin's switch): never for an `all` / builtin plugin. */
  switchable?: boolean;
  /**
   * The extension points it provides (`web-search@1`, names only), for every role: members get no
   * permissions but this (older kernels leave it out; then the `provides` permission group).
   */
  provides?: string[];
  /**
   * The two-level deployment config in this org (spec A §5.3): the org `following` the platform, a
   * `copy` of the overridable fields, or `none` (no overridable field). Admins only; older kernels
   * leave it out.
   */
  overrideState?: "following" | "copy" | "none";
  /**
   * The org must configure the extension before it works here (the effective config is not valid,
   * or a required org-only field is missing), as the kernel decides.
   */
  needsConfig?: boolean;
}

/** One field of an org's two-level config (kernel `OrgOverrideField`). */
export interface OrgOverrideField {
  path: string;
  level: "readonly" | "override";
  secret: boolean;
  /** The platform's value (non-secret) or only whether it is set (secret). */
  platform: { value?: unknown; set?: boolean };
  /** With a copy, on an overridable field: the copy's value, or whether its secret is set. */
  org?: { value?: unknown; set?: boolean };
  /** With a copy, on an overridable non-secret field: the copy's value differs from the platform's. */
  differs?: boolean;
}

/**
 * `GET / PUT / DELETE …/extensions/:name/overrides` (kernel `OrgOverrideView`): hidden fields never
 * appear, secrets give only whether they are set. `schema` is the form's JSON Schema when the
 * kernel sends one; without it the form is drawn from the fields.
 */
export interface OrgOverrideView {
  state: "following" | "copy";
  createdAt?: string;
  fields: OrgOverrideField[];
  valid: boolean;
  issues: ConfigIssue[];
  schema?: JsonSchema | null;
}

/**
 * The permission groups the 扩展 page sorts by capability: `provides` from its own field (members
 * have it too), the rest (agent tools, UI views) from the permission list when the viewer has it.
 */
export function capabilityGroups(e: OrgExtension): PermissionGroup[] {
  const rest = e.permissions.filter((g) => g.category !== "provides");
  const points = e.provides ?? e.permissions.find((g) => g.category === "provides")?.items ?? [];
  if (points.length === 0) return rest;
  return [
    {
      category: "provides",
      sensitive: false,
      items: points,
      entries: points.map((value) => ({ value, sensitive: false })),
    },
    ...rest,
  ];
}

export interface PutOrgExtensionInput {
  enabled?: boolean;
  config?: Record<string, unknown>;
  force?: boolean;
  /** The hash of the switch-off preview, to confirm switching the extension's plugin off. */
  confirm?: string;
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/extensions`;

export const listOrgExtensions = (orgId: string) =>
  apiFetch<{ extensions: OrgExtension[] }>(base(orgId)).then((r) => ({
    // A member's list omits config, secrets, schema and permissions: fill the admin shape's empties
    extensions: r.extensions.map((e) => ({
      ...e,
      config: e.config ?? null,
      secrets: e.secrets ?? [],
      orgConfigSchema: e.orgConfigSchema ?? null,
      permissions: e.permissions ?? [],
    })),
  }));

export const putOrgExtension = (orgId: string, plugin: string, input: PutOrgExtensionInput) =>
  apiFetch<{ extension: OrgExtension } | SwitchPreview>(
    `${base(orgId)}/${encodeURIComponent(plugin)}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );

const overridesPath = (orgId: string, plugin: string) =>
  `${base(orgId)}/${encodeURIComponent(plugin)}/overrides`;

/** The org's two-level config of an extension (org admins). */
export const getOrgOverrides = (orgId: string, plugin: string) =>
  apiFetch<OrgOverrideView>(overridesPath(orgId, plugin));

/** Saves overridable fields (`null` clears; secrets are plain values); the first save makes the copy. */
export const putOrgOverrides = (orgId: string, plugin: string, values: Record<string, unknown>) =>
  apiFetch<OrgOverrideView>(overridesPath(orgId, plugin), {
    method: "PUT",
    body: JSON.stringify({ values }),
  });

/** Drops the copy (its secrets too): the org follows the platform again. */
export const resetOrgOverrides = (orgId: string, plugin: string) =>
  apiFetch<OrgOverrideView>(overridesPath(orgId, plugin), { method: "DELETE" });

/** Takes the platform's current values of these non-secret fields into the copy. */
export const takeOrgOverrides = (orgId: string, plugin: string, paths: string[]) =>
  apiFetch<OrgOverrideView>(`${overridesPath(orgId, plugin)}/take`, {
    method: "POST",
    body: JSON.stringify({ paths }),
  });

/** 立即同步通讯录（202，后台任务）。 */
export const syncDirectory = (orgId: string, plugin: string) =>
  apiFetch<{ jobId: string }>(`${base(orgId)}/${encodeURIComponent(plugin)}/directory/sync`, {
    method: "POST",
  });

/** Whether the extension provides an extension point (by the manifest's `provides` name, ignoring the major version). */
export function provides(p: OrgExtension, extensionPoint: string): boolean {
  const group = p.permissions.find((g) => g.category === "provides");
  return group?.items.some((i) => i.split("@")[0] === extensionPoint) ?? false;
}

/**
 * One extension point whose provider the org chooses (kernel `OrgPointDefaultView`, web tools
 * spec §6): the extensions that could serve the org now, the stored default (also when it is not
 * a candidate now) and the provider a call would use now (null: none, or several and no default).
 */
export interface ExtensionPointDefault {
  point: string;
  candidates: string[];
  default: string | null;
  effective: string | null;
}

const pointsBase = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/extension-points`;

/** The org's `org-default` extension points (`org.extensions.manage`). */
export const listExtensionPointDefaults = (orgId: string) =>
  apiFetch<{ points: ExtensionPointDefault[] }>(pointsBase(orgId));

/** Stores the org's default provider of a point (204). */
export const putExtensionPointDefault = (orgId: string, point: string, extension: string) =>
  apiFetch<void>(`${pointsBase(orgId)}/${encodeURIComponent(point)}/default`, {
    method: "PUT",
    body: JSON.stringify({ extension }),
  });

/** One tool of an extension enabled in the org (kernel `ExtensionToolOffer`). Display only. */
export interface ExtensionToolOffer {
  /** The registered name: the `name` of a `{kind:"plugin"}` reference. */
  name: string;
  /** The model-visible key `plugin__<plugin>__<name>`, also the `toolPolicies` key. */
  key: string;
  title: string | null;
  /** The first line of the tool's (English) description. */
  description: string;
  annotations: Record<string, boolean>;
  defaultPolicy: "allow" | "ask";
  /** The org turned this tool off (older kernels leave it out): still listed, shown as off. */
  switchedOff?: boolean;
}

/** An extension enabled in the org with the tools it registered (kernel `ExtensionToolsOffer`). */
export interface ExtensionToolsOffer {
  plugin: string;
  displayName: LocalizedName;
  tools: ExtensionToolOffer[];
}

/** The tools of the extensions enabled in the org (`agents.use`), grouped by extension. */
export const listExtensionTools = (orgId: string) =>
  apiFetch<{ extensions: ExtensionToolsOffer[] }>(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/tools/extensions`,
  );

/** Whether each `org-default` point has a provider for the org now (`agents.use`; no names). */
export const listAvailableExtensionPoints = (orgId: string) =>
  apiFetch<{ points: { point: string; available: boolean }[] }>(`${pointsBase(orgId)}/available`);

/** One tool of an extension with the org's switch (kernel `OrgToolSwitch`). */
export interface OrgToolSwitch {
  tool: string;
  enabled: boolean;
}

/** An org agent whose current version selects the tool being switched off. */
export interface AffectedToolAgent {
  id: string;
  name: string;
}

/** `PUT …/tools/:tool`: the switch-off preview with its confirm hash, or the switch applied. */
export type ToolSwitchResult =
  | { applied: false; affectedAgents: AffectedToolAgent[]; confirm: string }
  | { applied: true };

const toolsPath = (orgId: string, plugin: string) =>
  `${base(orgId)}/${encodeURIComponent(plugin)}/tools`;

/** The extension's tools with the org's switches (members read). */
export const listOrgToolSwitches = (orgId: string, plugin: string) =>
  apiFetch<{ tools: OrgToolSwitch[] }>(toolsPath(orgId, plugin));

/** Switches one tool; off answers the preview until `confirm` carries its hash (org admins). */
export const putOrgToolSwitch = (
  orgId: string,
  plugin: string,
  tool: string,
  input: { enabled: boolean; confirm?: string },
) =>
  apiFetch<ToolSwitchResult>(`${toolsPath(orgId, plugin)}/${encodeURIComponent(tool)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
