import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

/**
 * 创建基于 pg 连接池的 Kysely 实例。
 * 池上必须挂 error 监听：空闲连接出错（PG 重启、网络抖动）否则会成为未捕获异常使进程退出。
 */
export function createDb(
  url: string,
  poolMax: number,
  onError: (err: Error) => void = (err) => console.error("[db] idle client error:", err),
  // biome-ignore lint/suspicious/noExplicitAny: 内核不持有表结构类型，由调用方自行收窄
): Kysely<any> {
  const pool = new pg.Pool({ connectionString: url, max: poolMax });
  pool.on("error", onError);
  return new Kysely({ dialect: new PostgresDialect({ pool }) });
}
