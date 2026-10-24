import { apiFetch } from "./api";
import type { JsonSchema } from "./json-schema";

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

/** One extension from the org's view (kernel `OrgExtensionView`). */
export interface OrgExtension {
  plugin: string;
  version: string;
  enabled: boolean;
  configurable: boolean;
  config: Record<string, unknown> | null;
  secrets: { path: string; set: boolean }[];
  permissions: PermissionGroup[];
  orgConfigSchema: JsonSchema | null;
  /** false：此插件在部署上当前不可用（如被停用；组织页显示「不可用」，启用设置保留、不能修改）。 */
  available?: boolean;
}

export interface PutOrgExtensionInput {
  enabled?: boolean;
  config?: Record<string, unknown>;
  force?: boolean;
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/extensions`;

export const listOrgExtensions = (orgId: string) =>
  apiFetch<{ extensions: OrgExtension[] }>(base(orgId));

export const putOrgExtension = (orgId: string, plugin: string, input: PutOrgExtensionInput) =>
  apiFetch<{ extension: OrgExtension }>(`${base(orgId)}/${encodeURIComponent(plugin)}`, {
    method: "PUT",
    body: JSON.stringify(input),
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
