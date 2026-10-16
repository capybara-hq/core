import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

/** 创建基于 pg 连接池的 Kysely 实例。 */
// biome-ignore lint/suspicious/noExplicitAny: 内核不持有表结构类型，由调用方自行收窄
export function createDb(url: string, poolMax: number): Kysely<any> {
  return new Kysely({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: poolMax }) }),
  });
}
