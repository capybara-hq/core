import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

/** 内核连接池的 PG `application_name`（便于在 pg_stat_activity 中识别）。 */
export const KERNEL_APPLICATION_NAME = "capybara-kernel";

/**
 * 创建基于 pg 连接池的 Kysely 实例。
 * 池上必须挂 error 监听：空闲连接出错（PG 重启、网络抖动）否则会成为未捕获异常使进程退出。
 * `opts.connectTimeoutMs` 为建立连接的超时（不设则 pg 无限等待）。
 */
export function createDb(
  url: string,
  poolMax: number,
  onError: (err: Error) => void = (err) => console.error("[db] idle client error:", err),
  opts: { connectTimeoutMs?: number } = {},
  // biome-ignore lint/suspicious/noExplicitAny: 内核不持有表结构类型，由调用方自行收窄
): Kysely<any> {
  const pool = new pg.Pool({
    connectionString: url,
    max: poolMax,
    application_name: KERNEL_APPLICATION_NAME,
    ...(opts.connectTimeoutMs !== undefined && { connectionTimeoutMillis: opts.connectTimeoutMs }),
  });
  pool.on("error", onError);
  return new Kysely({ dialect: new PostgresDialect({ pool }) });
}
