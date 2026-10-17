import type { Logger } from "@capybara-hq/plugin-sdk";
import { type ErrorHandler, Hono } from "hono";
import type { Route } from "../ctx/create-ctx.js";

const PLUGIN_PREFIX = "/plugins/";

/** 内核 HTTP 应用：健康检查由调用方挂载；插件路由在插件加载后通过 `mountPlugins` 一次性挂上。 */
export interface KernelApp {
  app: Hono;
  /** 挂载插件路由；路径必须以 `/plugins/` 开头（ctx.http.route 已加 `/plugins/<name>` 前缀）。只能调用一次。 */
  mountPlugins(routes: Route[]): void;
}

/**
 * 创建 Hono 应用。插件路由放在独立的子应用里，由 `/plugins/*` 统一转发：
 * 子应用之外不存在任何插件路径，所以插件无法注册前缀以外的路径；
 * 插件加载前 `/plugins/*` 一律 404。handler 抛错记日志并返回 500（不回显错误信息）。
 */
export function createApp(log: Logger): KernelApp {
  const app = new Hono();
  let plugins: Hono | undefined;
  const onError: ErrorHandler = (err, c) => {
    log.error("http handler failed", { path: c.req.path, err });
    return c.json({ error: "internal error" }, 500);
  };
  app.onError(onError);
  app.all(`${PLUGIN_PREFIX}*`, (c) => (plugins ? plugins.fetch(c.req.raw) : c.notFound()));

  return {
    app,
    mountPlugins(routes) {
      if (plugins) throw new Error("plugin routes already mounted");
      const sub = new Hono();
      sub.onError(onError);
      for (const r of routes) {
        if (!r.path.startsWith(PLUGIN_PREFIX)) {
          throw new Error(`plugin route ${r.method} ${r.path} is outside ${PLUGIN_PREFIX}`);
        }
        sub.on(r.method, r.path, (c) => r.handler(c.req.raw));
      }
      plugins = sub;
    },
  };
}
