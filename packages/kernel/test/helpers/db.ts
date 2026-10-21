import { type Kysely, sql } from "kysely";

/** PG 的死锁（40P01）与拿不到锁（55P03，lock_timeout）。 */
const LOCK_CONFLICTS = new Set(["40P01", "55P03"]);
const ATTEMPTS = 8;

const codeOf = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;

/**
 * 测试之间清表：`TRUNCATE <tables> CASCADE`，遇到死锁 / 锁超时就退避重试。
 *
 * 为什么需要：带 worker 角色的内核在后台不停地跑扫描与清理（渠道 supervisor 扫描、出站投递查
 * `channel_deliveries`、离职 sweep、维护队列……）。TRUNCATE 要按顺序给一串表（含 CASCADE 带出的表）加
 * ACCESS EXCLUSIVE 锁，而后台的一条 join 查询可能已拿到其中一张表的 ACCESS SHARE、正等另一张——两边互等，
 * PG 判死锁后随机杀掉一方。被杀的是 TRUNCATE 时 beforeEach 就挂了（被杀的是后台查询则只是一次扫描失败，内核自己会重试）。
 * TRUNCATE 本身是原子的，失败时什么都没清，所以重试是安全的；`lock_timeout` 让它不在长事务后面无限排队。
 *
 * `tables` 原样拼进 SQL，只传测试代码里写死的表名。
 */
export async function truncateTables<DB>(db: Kysely<DB>, tables: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.transaction().execute(async (t) => {
        await sql`SET LOCAL lock_timeout = '5s'`.execute(t);
        await sql.raw(`TRUNCATE ${tables} CASCADE`).execute(t);
      });
      return;
    } catch (e) {
      const code = codeOf(e) ?? "";
      if (!LOCK_CONFLICTS.has(code) || attempt >= ATTEMPTS) throw e;
      console.warn(`truncateTables: ${code} on attempt ${attempt}/${ATTEMPTS}, retrying`);
      await new Promise((r) => setTimeout(r, 50 * attempt + Math.floor(Math.random() * 50)));
    }
  }
}
