import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** 工具处理函数抛出它 → 服务以 JSON-RPC 错误（该 code 与消息）响应，而不是 `isError` 结果。 */
export class FakeMcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "FakeMcpRpcError";
  }
}

/** 工具处理函数收到的请求信息（头名一律小写）。 */
export interface FakeMcpCallInfo {
  name: string;
  args: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface FakeMcpTool {
  name: string;
  title?: string;
  /** 不给时清单里不带 description（测试「缺描述」的映射）。 */
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  /**
   * 返回工具结果。可模拟慢（await 一段时间）、报错（返回 `isError: true`，或抛 `McpError` 得到 JSON-RPC 错误）、
   * 回显请求头（`info.headers`）、超大输出。缺省返回 `ok`。
   * `ctx.notifyToolsChanged()` 在本次调用的响应流里发 `notifications/tools/list_changed`（需 `sseResponses`）。
   */
  handler?: (
    info: FakeMcpCallInfo,
    ctx: FakeMcpHandlerContext,
  ) => CallToolResult | Promise<CallToolResult>;
}

/** 工具处理函数的第二个参数。 */
export interface FakeMcpHandlerContext {
  /** 发一条 `notifications/tools/list_changed`（与本次调用关联，经响应的 SSE 流送达）。 */
  notifyToolsChanged(): Promise<void>;
}

export interface FakeMcpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  text?: string;
  /** base64。 */
  blob?: string;
}

/** 收到的一个 HTTP 请求（JSON-RPC 方法名与请求头）。 */
export interface FakeMcpRequest {
  httpMethod: string;
  /** JSON-RPC 方法名；批量 / 无法解析时为 undefined。 */
  method: string | undefined;
  headers: Record<string, string>;
}

export interface FakeMcpServerOptions {
  tools: FakeMcpTool[];
  /** 给出时声明 resources 能力（空数组也算支持）。 */
  resources?: FakeMcpResource[];
  /** 要求 `Authorization: Bearer <token>`，不符 → HTTP 401。 */
  requireBearer?: string;
  /** 自定义 bearer 校验（如交给假授权服务器的 `verify`）：返回 false → HTTP 401。与 `requireBearer` 二选一。 */
  verifyBearer?: (token: string) => boolean;
  /**
   * OAuth 受保护资源（RFC 9728）：401 响应带 `WWW-Authenticate: Bearer`。`advertise: "header"` 时元数据放在非标准
   * 路径、只经 `resource_metadata` 参数告知；`"well-known"` 时元数据只在
   * `/.well-known/oauth-protected-resource/mcp`，401 不带该参数。
   */
  protectedResource?: {
    authorizationServers: string[];
    scopesSupported?: string[];
    advertise: "header" | "well-known";
  };
  /** 前 n 个 HTTP 请求无条件返回 401（模拟凭据过期后刷新）。 */
  unauthorizedTimes?: number;
  /** 每次工具调用（在处理函数之前）调用。 */
  onCall?: (info: FakeMcpCallInfo) => void;
  /**
   * 在 MCP 处理之前拦截 HTTP 请求：返回 `{ status, body, location? }` 时直接以该状态与正文响应（模拟网关报错、
   * 正文回显请求头、重定向等），返回 undefined 时正常处理。
   */
  intercept?: (
    req: FakeMcpRequest & { body: unknown },
  ) => { status: number; body: string; location?: string } | undefined;
  /**
   * 以 SSE 流响应 POST（缺省为 JSON 响应）。只有 SSE 响应能在调用途中带上服务端通知（如 list_changed）。
   */
  sseResponses?: boolean;
}

export interface FakeMcpServer {
  /** MCP 端点（`http://127.0.0.1:<port>/mcp`）。 */
  url: string;
  /** 工具调用记录（按到达顺序）。 */
  calls: FakeMcpCallInfo[];
  /** 全部 HTTP 请求（含被 401 拒绝的）。 */
  requests: FakeMcpRequest[];
  stop(): Promise<void>;
}

const headersOf = (req: IncomingMessage): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const send = (
  res: ServerResponse,
  status: number,
  body: string,
  location?: string,
  extra: Record<string, string> = {},
) => {
  res.writeHead(status, {
    "content-type": "text/plain",
    ...(location !== undefined && { location }),
    ...extra,
  });
  res.end(body);
};

/** 受保护资源元数据的两个位置（见 `FakeMcpServerOptions.protectedResource`）。 */
const PRM_HEADER_PATH = "/meta/resource.json";
const PRM_WELL_KNOWN_PATH = "/.well-known/oauth-protected-resource/mcp";

/**
 * 本地假 MCP 服务（Streamable HTTP，无状态模式，缺省 JSON 响应，`sseResponses` 时 SSE）：每个 HTTP 请求新建一个 SDK `Server` 处理，
 * 监听 127.0.0.1 随机端口。GET（独立 SSE 流）与 DELETE（结束会话）返回 405，客户端按规范忽略。
 */
export async function startFakeMcpServer(opts: FakeMcpServerOptions): Promise<FakeMcpServer> {
  const calls: FakeMcpCallInfo[] = [];
  const requests: FakeMcpRequest[] = [];
  let rejected = 0;

  const mcpServer = (headers: Record<string, string>): Server => {
    const server = new Server(
      { name: "fake-mcp", version: "1.0.0" },
      {
        capabilities: {
          tools: { listChanged: true },
          ...(opts.resources !== undefined && { resources: {} }),
        },
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: opts.tools.map((t) => ({
        name: t.name,
        ...(t.title !== undefined && { title: t.title }),
        ...(t.description !== undefined && { description: t.description }),
        inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as {
          type: "object";
        },
        ...(t.annotations !== undefined && { annotations: t.annotations }),
        ...(t._meta !== undefined && { _meta: t._meta }),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const tool = opts.tools.find((t) => t.name === req.params.name);
      if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${req.params.name}`);
      const info: FakeMcpCallInfo = {
        name: req.params.name,
        args: (req.params.arguments ?? {}) as Record<string, unknown>,
        headers,
      };
      calls.push(info);
      opts.onCall?.(info);
      if (!tool.handler) return { content: [{ type: "text", text: "ok" }] };
      try {
        return await tool.handler(info, {
          notifyToolsChanged: () =>
            extra.sendNotification({ method: "notifications/tools/list_changed" }),
        });
      } catch (e) {
        if (e instanceof FakeMcpRpcError) throw new McpError(e.code, e.message);
        throw e;
      }
    });
    if (opts.resources !== undefined) {
      const resources = opts.resources;
      server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          ...(r.description !== undefined && { description: r.description }),
          ...(r.mimeType !== undefined && { mimeType: r.mimeType }),
        })),
      }));
      server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
        const r = resources.find((x) => x.uri === req.params.uri);
        if (!r)
          throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${req.params.uri}`);
        return {
          contents: [
            r.blob !== undefined
              ? {
                  uri: r.uri,
                  blob: r.blob,
                  ...(r.mimeType !== undefined && { mimeType: r.mimeType }),
                }
              : {
                  uri: r.uri,
                  text: r.text ?? "",
                  ...(r.mimeType !== undefined && { mimeType: r.mimeType }),
                },
          ],
        };
      });
    }
    return server;
  };

  let base = "";
  const prm = opts.protectedResource;
  const unauthorized = (res: ServerResponse) => {
    const challenge =
      prm?.advertise === "header"
        ? `Bearer resource_metadata="${base}${PRM_HEADER_PATH}"`
        : prm
          ? `Bearer realm="fake-mcp"`
          : undefined;
    send(
      res,
      401,
      "Unauthorized",
      undefined,
      challenge === undefined ? {} : { "www-authenticate": challenge },
    );
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", base).pathname;
    if (prm && req.method === "GET") {
      const at = prm.advertise === "header" ? PRM_HEADER_PATH : PRM_WELL_KNOWN_PATH;
      if (path === at) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            resource: `${base}/mcp`,
            authorization_servers: prm.authorizationServers,
            bearer_methods_supported: ["header"],
            ...(prm.scopesSupported !== undefined && { scopes_supported: prm.scopesSupported }),
          }),
        );
        return;
      }
      if (path.startsWith("/.well-known/") || path === PRM_HEADER_PATH) {
        return send(res, 404, "Not Found");
      }
    }
    const headers = headersOf(req);
    const raw = req.method === "POST" ? await readBody(req) : "";
    let body: unknown;
    try {
      body = raw === "" ? undefined : JSON.parse(raw);
    } catch {
      body = raw;
    }
    const method =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? ((body as { method?: unknown }).method as string | undefined)
        : undefined;
    const entry: FakeMcpRequest = { httpMethod: req.method ?? "GET", method, headers };
    requests.push(entry);

    if (rejected < (opts.unauthorizedTimes ?? 0)) {
      rejected++;
      return unauthorized(res);
    }
    if (
      opts.requireBearer !== undefined &&
      headers.authorization !== `Bearer ${opts.requireBearer}`
    ) {
      return unauthorized(res);
    }
    if (opts.verifyBearer) {
      const m = /^Bearer (.+)$/.exec(headers.authorization ?? "");
      if (!m || !opts.verifyBearer(m[1] as string)) return unauthorized(res);
    }
    const over = opts.intercept?.({ ...entry, body });
    if (over) return send(res, over.status, over.body, over.location);
    if (req.method !== "POST") return send(res, 405, "Method Not Allowed");

    const server = mcpServer(headers);
    // 不给 sessionIdGenerator = 无状态模式
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: opts.sseResponses !== true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    // exactOptionalPropertyTypes 下 SDK 自身的 Transport 类型不兼容（onclose 可为 undefined），按 SDK 文档用法转型
    await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
    await transport.handleRequest(req, res, body);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, String(e));
      else res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  return {
    url: `${base}/mcp`,
    calls,
    requests,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        http.closeAllConnections();
        http.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
