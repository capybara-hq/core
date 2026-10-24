import { apiFetch } from "./api";
import type { JsonSchema } from "./json-schema";

/**
 * 敏感原因码（内核 `SensitiveReason`）：界面按码翻译（`plugins.review.reason.<码>`），敏感判定只在内核。
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

/** 组织视角下的一个插件（内核 `OrgPluginView`）。 */
export interface OrgPlugin {
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

export interface PutOrgPluginInput {
  enabled?: boolean;
  config?: Record<string, unknown>;
  force?: boolean;
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/extensions`;

export const listOrgPlugins = (orgId: string) => apiFetch<{ extensions: OrgPlugin[] }>(base(orgId));

export const putOrgPlugin = (orgId: string, plugin: string, input: PutOrgPluginInput) =>
  apiFetch<{ extension: OrgPlugin }>(`${base(orgId)}/${encodeURIComponent(plugin)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });

/** 立即同步通讯录（202，后台任务）。 */
export const syncDirectory = (orgId: string, plugin: string) =>
  apiFetch<{ jobId: string }>(`${base(orgId)}/${encodeURIComponent(plugin)}/directory/sync`, {
    method: "POST",
  });

/** 插件是否提供某能力（按清单 `provides` 的能力名，不看主版本）。 */
export function provides(p: OrgPlugin, capability: string): boolean {
  const group = p.permissions.find((g) => g.category === "provides");
  return group?.items.some((i) => i.split("@")[0] === capability) ?? false;
}
