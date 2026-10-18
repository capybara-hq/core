import { apiFetch } from "./api";

/**
 * 内核应用 API 的类型（`packages/kernel/src/tools/apps.controller.ts` / `apps.service.ts`；
 * 只声明界面用到的字段，时间为 JSON 字符串）。Web 层不 import 内核代码。
 */

export type Ownership = "org" | "personal";

/** 静态认证方式：只有类型与非密钥字段，凭据值走 `credential` / 凭据接口。 */
export type AppAuth =
  | { type: "none" }
  | { type: "bearer"; ownership: Ownership }
  | { type: "api_key"; ownership: Ownership; in: "header" | "query"; name: string }
  | { type: "basic"; ownership: Ownership }
  | { type: "headers"; ownership: Ownership; names: string[] }
  // OAuth：授权码流为个人凭据（经「连接」授权，不填 token），客户端凭据流为组织凭据
  | { type: "oauth_code"; ownership: "personal" }
  | { type: "oauth_client"; ownership: "org" };

/** 能在界面里手填凭据值的认证方式（不含 none 与 OAuth）。 */
export type AuthType = Exclude<AppAuth["type"], "oauth_code" | "oauth_client">;

/** 凭据值（形状按认证方式）。 */
export type CredentialValue =
  | { token: string }
  | { username: string; password: string }
  | { headers: Record<string, string> };

export type ToolPolicy = "allow" | "ask" | "deny";

export interface AppTool {
  name: string;
  key: string;
  description: string;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } | null;
  status: "enabled" | "disabled";
  defaultPolicy: ToolPolicy;
  /** 定义不合规时的英文原因（此时工具只能停用）。 */
  issue: string | null;
}

export interface AppSummary {
  id: string;
  slug: string;
  name: string;
  connector: string;
  endpoint: { url?: string } & Record<string, unknown>;
  auth: AppAuth;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface AppDetail extends AppSummary {
  tools: AppTool[];
  /** 当前用户视角的凭据状态；`ownership` 为 null 表示无需凭据。 */
  credential: { ownership: Ownership | null; status: "connected" | "missing" };
}

export interface ToolIssue {
  name: string;
  reason: string;
}

export interface CreateAppInput {
  name: string;
  slug?: string;
  connector: string;
  endpoint: { url: string; headers?: Record<string, string> };
  auth: AppAuth;
  credential?: CredentialValue;
}

export interface UpdateAppInput {
  name?: string;
  status?: "active" | "disabled";
  tools?: Record<string, { status?: "enabled" | "disabled"; defaultPolicy?: ToolPolicy }>;
}

/** 需要凭据的认证方式的归属；`none` 为 null。 */
export const ownershipOf = (auth: AppAuth): Ownership | null =>
  auth.type === "none" ? null : auth.ownership;

/** 当前组织中能否管理应用（`apps.manage`：管理员起；只用于决定是否显示管理入口，最终由内核判定）。 */
export function canManageApps(me: {
  currentOrgId: string | null;
  memberships: { orgId: string; role: string }[];
}): boolean {
  const role = me.memberships.find((m) => m.orgId === me.currentOrgId)?.role;
  return role === "admin" || role === "owner";
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/apps`;
const one = (orgId: string, appId: string) => `${base(orgId)}/${encodeURIComponent(appId)}`;

export const listApps = (orgId: string) => apiFetch<{ apps: AppSummary[] }>(base(orgId));

export const getApp = (orgId: string, appId: string) =>
  apiFetch<{ app: AppDetail }>(one(orgId, appId));

export const createApp = (orgId: string, input: CreateAppInput) =>
  apiFetch<{ app: AppDetail; issues: ToolIssue[] }>(base(orgId), {
    method: "POST",
    body: JSON.stringify(input),
  });

export const updateApp = (orgId: string, appId: string, input: UpdateAppInput) =>
  apiFetch<{ app: AppDetail }>(one(orgId, appId), {
    method: "PATCH",
    body: JSON.stringify(input),
  });

export const deleteApp = (orgId: string, appId: string) =>
  apiFetch<void>(one(orgId, appId), { method: "DELETE" });

export const refreshApp = (orgId: string, appId: string) =>
  apiFetch<{ app: AppDetail; issues: ToolIssue[] }>(`${one(orgId, appId)}/refresh`, {
    method: "POST",
  });

export const setOrgCredential = (orgId: string, appId: string, value: CredentialValue) =>
  apiFetch<void>(`${one(orgId, appId)}/credentials/org`, {
    method: "PUT",
    body: JSON.stringify(value),
  });

export const setMyCredential = (orgId: string, appId: string, value: CredentialValue) =>
  apiFetch<void>(`${one(orgId, appId)}/credentials/me`, {
    method: "PUT",
    body: JSON.stringify(value),
  });

/** 发起 OAuth 连接：返回授权服务器的授权地址（随后整页跳转过去）；`returnTo` 为授权结束后回到的站内路径。 */
export const connectApp = (orgId: string, appId: string, returnTo: string) =>
  apiFetch<{ authorizationUrl: string }>(`${one(orgId, appId)}/connect`, {
    method: "POST",
    body: JSON.stringify({ returnTo }),
  });

export const clearMyCredential = (orgId: string, appId: string) =>
  apiFetch<void>(`${one(orgId, appId)}/credentials/me`, { method: "DELETE" });
