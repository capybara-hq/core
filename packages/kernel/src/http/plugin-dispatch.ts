import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Logger } from "@capybara-hq/plugin-sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import FindMyWay from "find-my-way";
import type { Route } from "../ctx/create-ctx.js";
import { errorBody } from "../errors.js";

/** 插件路由都在此前缀下（ctx.http.route 已加 `/plugins/<name>` 前缀）。 */
export const PLUGIN_PREFIX = "/plugins/";

/** 插件路由表：按方法与路径（不含查询串）找到插件 handler。 */
export interface PluginRouter {
  find(method: string, path: string): Route["handler"] | undefined;
}

/** 用 find-my-way 建立插件路由表，路径语法与 Fastify 相同；路径不在 `/plugins/` 下时抛错。 */
export function createPluginRouter(routes: Route[]): PluginRouter {
  const router = FindMyWay();
  for (const r of routes) {
    if (!r.path.startsWith(PLUGIN_PREFIX)) {
      throw new Error(`plugin route ${r.method} ${r.path} is outside ${PLUGIN_PREFIX}`);
    }
    router.on(r.method, r.path, () => {}, { handler: r.handler });
  }
  return {
    find(method, path) {
      const found = router.find(method as FindMyWay.HTTPMethod, path);
      return (found?.store as { handler: Route["handler"] } | undefined)?.handler;
    },
  };
}

/**
 * 在独立的封装作用域里注册 `/plugins/*`，转成 Web `Request` 交给插件 handler：
 * 作用域内移除默认解析器、所有 content-type 一律按原始 Buffer 收下，插件拿到的 body 与客户端发出的字节一致。
 * 未挂载或无匹配 → 404 `not_found`；handler 抛错记日志并返回 500 `internal`（不回显错误信息）。
 * 必须在 Nest `app.init()` 之前调用。
 */
export async function registerPluginDispatch(
  fastify: FastifyInstance,
  getRouter: () => PluginRouter | undefined,
  log: Logger,
): Promise<void> {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0] as string;
    const pluginHandler = getRouter()?.find(req.method, path);
    if (!pluginHandler) {
      return reply.code(404).send(errorBody("not_found", `Route ${req.method} ${path} not found`));
    }
    let res: Response;
    try {
      res = await pluginHandler(toWebRequest(req));
    } catch (err) {
      log.error("plugin handler failed", { path, err });
      return reply.code(500).send(errorBody("internal", "Internal error"));
    }
    reply.code(res.status);
    for (const [name, value] of res.headers) {
      if (name !== "set-cookie") reply.header(name, value);
    }
    for (const cookie of res.headers.getSetCookie()) reply.header("set-cookie", cookie);
    if (res.body === null) return reply.send();
    return reply.send(Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>));
  };

  await fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.all(`${PLUGIN_PREFIX}*`, handler);
  });
}

/** Fastify 请求 → Web `Request`：数组头用 `, ` 合并（`set-cookie` 逐条保留）；GET / HEAD 不带 body。 */
function toWebRequest(req: FastifyRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (name === "set-cookie") for (const v of value) headers.append(name, v);
      else headers.set(name, value.join(", "));
    } else {
      headers.set(name, value);
    }
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && Buffer.isBuffer(req.body);
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
    method: req.method,
    headers,
    ...(hasBody && { body: req.body as Buffer }),
  });
}
