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

/** `connector@1`：插件实现、内核调用。 */
export interface Connector {
  kind: string;
  endpointSchema: ZodTypeAny;
  open(args: ConnectorOpenArgs): Promise<ConnectorSession>;
}
