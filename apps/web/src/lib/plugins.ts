import { apiFetch } from "./api";
import type { JsonSchema } from "./json-schema";

/** 权限清单的一组（内核 `PermissionGroup`）：`sensitive` 为需要特别留意的类别。 */
export interface PermissionGroup {
  category: string;
  sensitive: boolean;
  items: string[];
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
}

export interface PutOrgPluginInput {
  enabled?: boolean;
  config?: Record<string, unknown>;
  force?: boolean;
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/plugins`;

export const listOrgPlugins = (orgId: string) => apiFetch<{ plugins: OrgPlugin[] }>(base(orgId));

export const putOrgPlugin = (orgId: string, plugin: string, input: PutOrgPluginInput) =>
  apiFetch<{ plugin: OrgPlugin }>(`${base(orgId)}/${encodeURIComponent(plugin)}`, {
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
