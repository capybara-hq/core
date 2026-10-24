import type { ZodTypeAny } from "zod";
import type { FormAnswer, ToolContent, ToolResult, ToolSpec } from "./tool.js";

/** 注入到出站请求的鉴权信息。 */
export interface AuthInjection {
  headers: Record<string, string>;
  query?: Record<string, string>;
}

/** 连接器与远端服务的一次会话。 */
export interface ConnectorSession {
  listTools(): Promise<ToolSpec[]>;
  /**
   * `ctx.spec`：内核快照里该工具已复核的定义（`connector_tools.spec`，绝不是待复核的新定义），含 listTools 时给出的
   * `connectorData`。连接器应按它路由调用，而不是重新读取远端描述（远端变化须先经漂移复核）。旧内核不传，须判空。
   */
  callTool(
    name: string,
    input: unknown,
    signal: AbortSignal,
    ctx?: { spec: ToolSpec },
  ): Promise<ToolResult>;
  listResources?(): Promise<
    { uri: string; name: string; description?: string; mimeType?: string }[]
  >;
  readResource?(uri: string): Promise<ToolResult>;
  /** 可选：远端提供的提示模板（如 MCP prompts）。不支持时不实现，内核须判空。 */
  listPrompts?(): Promise<PromptInfo[]>;
  /** 可选：按参数渲染一个提示模板，返回消息（如 MCP `prompts/get`）。失败抛 ToolError（英文、不含凭据）。 */
  getPrompt?(name: string, args: Record<string, string>): Promise<RenderedPrompt>;
  close(): Promise<void>;
}

/** 远端提示模板（`/连接器:提示名` 斜杠命令）。 */
export interface PromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments: { name: string; description?: string; required?: boolean }[];
}

/** 渲染后的提示：按顺序的消息，内容块同工具结果（非文本给类型说明）。 */
export interface RenderedPrompt {
  description?: string;
  messages: { role: "user" | "assistant"; content: ToolContent[] }[];
}

/**
 * 远端在一次调用中途向用户要输入（MCP `elicitation/create`）：
 * - `form`：`requestedSchema` 是远端给的扁平 JSON Schema（object + 原始类型属性），由内核映射成交互表单；
 * - `url`：请用户在浏览器里打开 `url` 完成某步（授权、付款、填敏感信息），完成与否由用户确认。
 */
export type ElicitationRequest =
  | { mode: "form"; message: string; requestedSchema: Record<string, unknown> }
  | { mode: "url"; message: string; url: string; elicitationId: string };

/** 对 elicitation 的答复（与 MCP `ElicitResult` 对应）：接受（带表单内容）/ 拒绝 / 取消。 */
export type ElicitationResponse =
  | { action: "accept"; content?: FormAnswer }
  | { action: "decline" }
  | { action: "cancel" };

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
  /**
   * Called when the remote asks the user for input mid-call (MCP `elicitation/create`, the URL-mode
   * `-32042` error); the connector passes the returned answer back to the remote as is. Optional:
   * when the kernel does not provide it, the connector does not declare the MCP elicitation
   * capability (so the remote never starts one).
   *
   * 内核不能在等用户回答期间保持远端调用（运行会暂停、worker 释放、会话关闭）：需要问用户时，内核**中止本次调用**
   * （经 `callTool` 的 signal）并让运行进入等待；用户回答后内核重新发起同一调用，远端再次发起同样的 elicitation 时
   * 由本回调立即用用户的答案答复。所以连接器只需「收到就调用、拿到就回」，不要自己缓存或重试；需要问用户时本回调
   * 以错误拒绝（调用已被中止），连接器让该错误原样结束本次调用即可。
   */
  onElicit?: (request: ElicitationRequest) => Promise<ElicitationResponse>;
}

/**
 * 远端描述里声明的一种认证方式，映射到内核连接器认证（ConnectorAuth）的形状，供安装向导预填。
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
