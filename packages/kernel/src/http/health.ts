import type { Logger } from "@capybara-hq/plugin-sdk";
import type { Hono } from "hono";

/** 一项就绪检查：成功 resolve，失败 reject。 */
export type ReadinessCheck = () => Promise<void>;

/** 单项检查的超时：依赖挂起（如 Redis 正在重连、命令进了离线队列）时也要尽快给出 503。 */
const CHECK_TIMEOUT_MS = 2_000;

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 挂载 `GET /healthz`（进程存活，恒 200）与 `GET /readyz`（依赖就绪）。
 * readyz 的 body 只给出每项检查的 `"ok"` / `"error"`，失败原因只进日志（已打码），不进响应——
 * 驱动的错误信息可能带连接串。停机开始后 readyz 立即 503，不再执行检查。
 */
export function mountHealth(
  app: Hono,
  opts: {
    checks: Record<string, ReadinessCheck>;
    isStopping: () => boolean;
    log: Logger;
    timeoutMs?: number;
  },
): void {
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    if (opts.isStopping()) return c.json({ ok: false, stopping: true }, 503);
    const names = Object.keys(opts.checks);
    const results = await Promise.allSettled(
      names.map((n) => withTimeout((opts.checks[n] as ReadinessCheck)(), timeoutMs)),
    );
    const body: Record<string, unknown> = {};
    let ok = true;
    results.forEach((r, i) => {
      const name = names[i] as string;
      if (r.status === "fulfilled") {
        body[name] = "ok";
      } else {
        ok = false;
        body[name] = "error";
        opts.log.warn("readiness check failed", { check: name, err: r.reason });
      }
    });
    if (opts.isStopping()) return c.json({ ok: false, stopping: true }, 503);
    return c.json({ ok, ...body }, ok ? 200 : 503);
  });
}
