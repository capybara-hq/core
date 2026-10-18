import type { ZodTypeAny } from "zod";
import type { ToolResult, ToolSpec } from "./tool.js";

/** 注入到出站请求的鉴权信息。 */
export interface AuthInjection {
  headers: Record<string, string>;
  query?: Record<string, string>;
}

/** 连接器与远端服务的一次会话。 */
export interface ConnectorSession {
  listTools(): Promise<ToolSpec[]>;
  callTool(name: string, input: unknown, signal: AbortSignal): Promise<ToolResult>;
  listResources?(): Promise<
    { uri: string; name: string; description?: string; mimeType?: string }[]
  >;
  readResource?(uri: string): Promise<ToolResult>;
  close(): Promise<void>;
}

/** 内核打开会话时传给连接器的参数。 */
export interface ConnectorOpenArgs {
  /** 已按 endpointSchema 校验。 */
  endpoint: unknown;
  /** 每次请求前调用，凭据的刷新由内核负责。 */
  auth: () => Promise<AuthInjection>;
  /** 收到 401 时调用一次；内核刷新凭据后，插件重试一次。 */
  onUnauthorized: () => Promise<void>;
  signal: AbortSignal;
  /**
   * 会话期间远端报告工具清单变了（如 MCP `notifications/tools/list_changed`）时调用，可能多次；内核据此安排一次
   * 漂移检查（新的 / 变了的工具在管理员复核前不可用）。可选：旧内核不提供，连接器须判空。不要等待它、不要因它抛错。
   */
  onToolsChanged?: () => void;
}

/**
 * 远端描述里声明的一种认证方式，映射到内核应用认证（AppAuth）的形状，供安装向导预填。
 * `scheme` 是远端描述里的名字（如 OpenAPI `securitySchemes` 的键），`description` 原样给出（可能缺省）。
 * 只列内核支持的方式；其余（cookie 里的 API key、OpenID Connect、implicit / password 流等）不出现。
 */
export type AuthHint = { scheme: string; description?: string } & (
  | { type: "bearer" }
  | { type: "basic" }
  | { type: "api_key"; in: "header" | "query"; name: string }
  | { type: "oauth_client"; tokenUrl: string; scopes: string[] }
  | { type: "oauth_code"; authorizationUrl: string; tokenUrl: string; scopes: string[] }
);

/** 远端描述里的一个操作（如 OpenAPI operation），供安装向导勾选。 */
export interface ConnectorOperation {
  /** 端点配置里勾选用的 id（如 OpenAPI 的 operationId）。 */
  id: string;
  /** 大写 HTTP 方法。 */
  method: string;
  path: string;
  summary?: string;
}

/** `Connector.inspect` 的结果。 */
export interface ConnectorInspection {
  authHints: AuthHint[];
  operations?: ConnectorOperation[];
}

/** `connector@1`：插件实现、内核调用。 */
export interface Connector {
  kind: string;
  endpointSchema: ZodTypeAny;
  open(args: ConnectorOpenArgs): Promise<ConnectorSession>;
  /**
   * 可选：不带凭据读取端点的描述（安装向导的预览用），返回声明的认证方式与可选的操作清单。
   * `endpoint` 已按 endpointSchema 校验。失败抛 ToolError（消息英文、不含凭据）。旧连接器不实现，内核须判空。
   */
  inspect?(args: { endpoint: unknown; signal: AbortSignal }): Promise<ConnectorInspection>;
}
