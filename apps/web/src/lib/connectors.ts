import { apiFetch } from "./api";

/**
 * 内核连接器 API 的类型（`packages/kernel/src/tools/connectors.controller.ts` / `connectors.service.ts`；
 * 只声明界面用到的字段，时间为 JSON 字符串）。Web 层不 import 内核代码。
 */

export type Ownership = "org" | "personal";

/** 令牌端点的客户端认证方式（有客户端密钥时）。 */
export type TokenAuthMethod = "client_secret_basic" | "client_secret_post";

/** 授权码流（个人凭据，经「连接」授权）：端点经 MCP 发现或手填，客户端自动注册（DCR）或手填。 */
export interface OAuthCodeAuth {
  type: "oauth_code";
  ownership: "personal";
  discovery: "mcp" | "manual";
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  client: "dcr" | "manual";
  tokenAuthMethod?: TokenAuthMethod;
}

/** 客户端凭据流（组织凭据，安装时用客户端换取 token）。 */
export interface OAuthClientAuth {
  type: "oauth_client";
  ownership: "org";
  tokenUrl: string;
  scopes?: string[];
  tokenAuthMethod?: TokenAuthMethod;
}

/** 认证方式：只有类型与非密钥字段，凭据值走 `credential` / 凭据接口。 */
export type ConnectorAuth =
  | { type: "none" }
  | { type: "bearer"; ownership: Ownership }
  | { type: "api_key"; ownership: Ownership; in: "header" | "query"; name: string }
  | { type: "basic"; ownership: Ownership }
  | { type: "headers"; ownership: Ownership; names: string[] }
  | OAuthCodeAuth
  | OAuthClientAuth;

/** 能在界面里手填凭据值的认证方式（不含 none 与 OAuth）。 */
export type AuthType = Exclude<ConnectorAuth["type"], "oauth_code" | "oauth_client">;

/** OAuth 客户端（安装时手填 / 轮换组织客户端）。 */
export interface OAuthClientValue {
  clientId: string;
  clientSecret?: string;
}

/** 凭据值（形状按认证方式）。 */
export type CredentialValue =
  | { token: string }
  | { username: string; password: string }
  | { headers: Record<string, string> }
  | OAuthClientValue;

export type ToolPolicy = "allow" | "ask" | "deny";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  requiresUserInteraction?: boolean;
}

/** 一份工具定义（复核对比的一侧）。 */
export interface ToolDefinition {
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations | null;
  /** 连接器的路由数据（如 OpenAPI 的方法 / 路径 / 服务器）；读者视图里为 null。 */
  connectorData: Record<string, unknown> | null;
}

export interface ConnectorTool extends ToolDefinition {
  name: string;
  key: string;
  status: "enabled" | "disabled" | "pending_review";
  defaultPolicy: ToolPolicy;
  /** 定义不合规时的英文原因（此时工具只能停用）。 */
  issue: string | null;
  /** 远端已不再提供该工具（随之停用）。 */
  missing?: boolean;
  reviewedAt?: string | null;
  /**
   * 定义变化后待复核的新定义（顶层字段是上次复核通过的定义，供对比）。从未复核过的工具（新增待复核、被拒的新工具，
   * `reviewedAt` 为 null）没有旧定义：此处为 null，待复核的定义就在顶层字段里。
   */
  pending?: (ToolDefinition & { specHash: string }) | null;
}

export interface ConnectorSummary {
  id: string;
  slug: string;
  name: string;
  connector: string;
  endpoint: { url?: string } & Record<string, unknown>;
  auth: ConnectorAuth;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorDetail extends ConnectorSummary {
  tools: ConnectorTool[];
  /** 当前用户视角的凭据状态；`ownership` 为 null 表示无需凭据。 */
  credential: { ownership: Ownership | null; status: "connected" | "missing" };
}

export interface ToolIssue {
  name: string;
  reason: string;
}

/** 连接器：MCP（Streamable HTTP）或 OpenAPI 文档。 */
export type ConnectorKind = "mcp" | "openapi";

/** MCP：端点 URL；OpenAPI：文档 URL 或文档正文（二选一）、可选 baseUrl 与勾选的操作。 */
export type ConnectorEndpoint =
  | { url: string; headers?: Record<string, string> }
  | { specUrl?: string; specText?: string; baseUrl?: string; operations?: string[] };

export interface CreateConnectorInput {
  name: string;
  slug?: string;
  connector: string;
  endpoint: ConnectorEndpoint;
  auth: ConnectorAuth;
  credential?: CredentialValue;
}

/** 远端描述里声明的认证方式（向导据此预填）。 */
export type AuthHint = { scheme: string; description?: string } & (
  | { type: "bearer" }
  | { type: "basic" }
  | { type: "api_key"; in: "header" | "query"; name: string }
  | { type: "oauth_client"; tokenUrl: string; scopes: string[] }
  | { type: "oauth_code"; authorizationUrl: string; tokenUrl: string; scopes: string[] }
);

/** 远端描述里的一个操作（OpenAPI operation）。 */
export interface ConnectorOperation {
  id: string;
  method: string;
  path: string;
  summary?: string;
}

/** 预览里的一个工具（与安装后的工具同形的子集）。 */
export interface ToolPreview {
  name: string;
  key: string;
  description: string;
  annotations: ToolAnnotations | null;
  defaultPolicy: ToolPolicy;
  issue: string | null;
}

/** 预览（不落库）：`tools` 为 null 表示没有列工具（未给认证、缺凭据、OAuth 授权码流）。 */
export interface ConnectorPreview {
  tools: ToolPreview[] | null;
  issues: ToolIssue[];
  authHints: AuthHint[];
  operations?: ConnectorOperation[];
}

export interface PreviewConnectorInput {
  name?: string;
  slug?: string;
  connector: string;
  endpoint: ConnectorEndpoint;
  auth?: ConnectorAuth;
  credential?: CredentialValue;
}

export interface UpdateConnectorInput {
  name?: string;
  status?: "active" | "disabled";
  tools?: Record<string, { status?: "enabled" | "disabled"; defaultPolicy?: ToolPolicy }>;
}

/** 需要凭据的认证方式的归属；`none` 为 null。 */
export const ownershipOf = (auth: ConnectorAuth): Ownership | null =>
  auth.type === "none" ? null : auth.ownership;

/** 当前组织中能否管理连接器（`connectors.manage`：管理员起；只用于决定是否显示管理入口，最终由内核判定）。 */
export function canManageConnectors(me: {
  currentOrgId: string | null;
  memberships: { orgId: string; role: string }[];
}): boolean {
  const role = me.memberships.find((m) => m.orgId === me.currentOrgId)?.role;
  return role === "admin" || role === "owner";
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/connectors`;
const one = (orgId: string, connectorId: string) =>
  `${base(orgId)}/${encodeURIComponent(connectorId)}`;

export const listConnectors = (orgId: string) =>
  apiFetch<{ connectors: ConnectorSummary[] }>(base(orgId));

export const previewConnector = (orgId: string, input: PreviewConnectorInput) =>
  apiFetch<ConnectorPreview>(`${base(orgId)}/preview`, {
    method: "POST",
    body: JSON.stringify(input),
  });

/** 复核待复核的工具：approve 采用新定义并启用，reject 停用并保留旧定义。 */
export const reviewTool = (
  orgId: string,
  connectorId: string,
  name: string,
  action: "approve" | "reject",
) =>
  apiFetch<{ connector: ConnectorDetail }>(
    `${one(orgId, connectorId)}/tools/${encodeURIComponent(name)}/review`,
    {
      method: "POST",
      body: JSON.stringify({ action }),
    },
  );

export const getConnector = (orgId: string, connectorId: string) =>
  apiFetch<{ connector: ConnectorDetail }>(one(orgId, connectorId));

export const createConnector = (orgId: string, input: CreateConnectorInput) =>
  apiFetch<{ connector: ConnectorDetail; issues: ToolIssue[] }>(base(orgId), {
    method: "POST",
    body: JSON.stringify(input),
  });

export const updateConnector = (orgId: string, connectorId: string, input: UpdateConnectorInput) =>
  apiFetch<{ connector: ConnectorDetail }>(one(orgId, connectorId), {
    method: "PATCH",
    body: JSON.stringify(input),
  });

export const deleteConnector = (orgId: string, connectorId: string) =>
  apiFetch<void>(one(orgId, connectorId), { method: "DELETE" });

export const refreshConnector = (orgId: string, connectorId: string) =>
  apiFetch<{ connector: ConnectorDetail; issues: ToolIssue[] }>(
    `${one(orgId, connectorId)}/refresh`,
    {
      method: "POST",
    },
  );

export const setOrgCredential = (orgId: string, connectorId: string, value: CredentialValue) =>
  apiFetch<void>(`${one(orgId, connectorId)}/credentials/org`, {
    method: "PUT",
    body: JSON.stringify(value),
  });

export const setMyCredential = (orgId: string, connectorId: string, value: CredentialValue) =>
  apiFetch<void>(`${one(orgId, connectorId)}/credentials/me`, {
    method: "PUT",
    body: JSON.stringify(value),
  });

/** 发起 OAuth 连接：返回授权服务器的授权地址（随后整页跳转过去）；`returnTo` 为授权结束后回到的站内路径。 */
export const connectConnector = (orgId: string, connectorId: string, returnTo: string) =>
  apiFetch<{ authorizationUrl: string }>(`${one(orgId, connectorId)}/connect`, {
    method: "POST",
    body: JSON.stringify({ returnTo }),
  });

export const clearMyCredential = (orgId: string, connectorId: string) =>
  apiFetch<void>(`${one(orgId, connectorId)}/credentials/me`, { method: "DELETE" });

/** 连接器提供的提示模板（`/连接器:提示名` 斜杠命令）。 */
export interface ConnectorPrompt {
  connectorId: string;
  connectorSlug: string;
  connectorName: string;
  name: string;
  title?: string;
  description?: string;
  arguments: { name: string; description?: string; required?: boolean }[];
}

/** 连接器提供的资源（`@` 引用）。 */
export interface ConnectorResource {
  connectorId: string;
  connectorSlug: string;
  connectorName: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** 列表时不可用的连接器：当前用户未连接个人凭据，或连接失败。 */
export interface ConnectorUnavailable {
  connectorId: string;
  connectorName: string;
  reason: "not_connected" | "failed";
}

export const listConnectorPrompts = (orgId: string) =>
  apiFetch<{ prompts: ConnectorPrompt[]; unavailable: ConnectorUnavailable[] }>(
    `${base(orgId)}/prompts`,
  );

/** 按参数渲染提示模板为文本（放进输入框，由用户发送）。 */
export const renderConnectorPrompt = (
  orgId: string,
  connectorId: string,
  name: string,
  args: Record<string, string>,
) =>
  apiFetch<{ text: string }>(`${one(orgId, connectorId)}/prompts/${encodeURIComponent(name)}`, {
    method: "POST",
    body: JSON.stringify({ arguments: args }),
  });

export const listConnectorResources = (orgId: string) =>
  apiFetch<{ resources: ConnectorResource[]; unavailable: ConnectorUnavailable[] }>(
    `${base(orgId)}/resources`,
  );
