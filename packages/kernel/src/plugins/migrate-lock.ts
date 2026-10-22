import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import pg from "pg";
import { pluginSchemaName } from "../ctx/create-ctx.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { migrate } from "../db/migrator.js";
import { pgConnectOptions } from "../db/pool.js";

/** 插件迁移完成（kernel bus 主题，频道 `cap:kernel:plugins.migrated`，payload `{ plugin, sha256 }`）。 */
export const PLUGINS_MIGRATED_TOPIC = "plugins.migrated";

/** 插件迁移咨询锁的键前缀（`hashtext(<前缀><插件名>)`）。 */
export const MIGRATE_LOCK_PREFIX = "capybara.plugin-migrate:";

/** {@link ensureMigrated} 的依赖。 */
export interface MigrateLockDeps {
  db: KernelDb;
  /** 迁移用独立连接（不走连接池）。 */
  dbUrl: string;
  connectTimeoutMs?: number | undefined;
  /** 发布 `plugins.migrated`（kernel bus）。 */
  bus: { publish(topic: string, payload: unknown): Promise<void> };
  log?: { warn(msg: string, fields?: Record<string, unknown>): void };
  /** 中止进行中的迁移（宿主关闭）。 */
  signal?: AbortSignal | undefined;
}

/**
 * 某插件某个包的迁移由一个副本持锁执行（C16，F-P）：
 * 1. 独立 `pg.Client`（不走连接池）上 `pg_try_advisory_lock(hashtext('capybara.plugin-migrate:' || name))`，
 *    拿不到 → `busy`（别的副本正在迁移；调用方记 `pending_migration`，等 `plugins.migrated` 或下一个周期）；
 * 2. 拿到后复核安装记录：已换成别的包 → `busy`（不迁移过期目标，下一轮按新目标处理）；`migrated_sha` 已是它 → `migrated`；
 * 3. 执行迁移（迁移器另开会话，持按 schema 的锁；只做扩展，见 skills/writing-migrations），写 `migrated_sha`；
 * 4. 结束会话（锁随之释放，进程崩溃时同样释放），发布 `plugins.migrated {plugin, sha256}`（失败只告警）。
 * `dir` 为迁移目录的绝对路径（只取审阅过的 `capybara.migrations`）；没有迁移时直接记下 `migrated_sha`。
 * 迁移出错时抛出（不写 `migrated_sha`）。
 */
export async function ensureMigrated(
  d: MigrateLockDeps,
  name: string,
  sha256: string,
  dir: string | undefined,
): Promise<"migrated" | "busy"> {
  const client = new pg.Client({
    connectionString: d.dbUrl,
    ...pgConnectOptions({ connectTimeoutMs: d.connectTimeoutMs }),
  });
  client.on("error", () => {});
  let ran = false;
  try {
    await client.connect();
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
      [`${MIGRATE_LOCK_PREFIX}${name}`],
    );
    if (lock.rows[0]?.ok !== true) return "busy";
    const row = (
      await client.query<{ sha256: string; migrated_sha: string | null }>(
        "SELECT sha256, migrated_sha FROM capybara.plugin_installs WHERE name = $1",
        [name],
      )
    ).rows[0];
    if (row?.sha256 !== sha256) return "busy";
    if (row.migrated_sha === sha256) return "migrated";
    if (dir !== undefined) {
      await migrate(
        d.dbUrl,
        { schema: pluginSchemaName(name), dir },
        { connectTimeoutMs: d.connectTimeoutMs, signal: d.signal },
      );
    }
    await client.query(
      "UPDATE capybara.plugin_installs SET migrated_sha = $2 WHERE name = $1 AND sha256 = $2",
      [name, sha256],
    );
    ran = true;
  } finally {
    // 会话结束即释放咨询锁（不把持锁连接还给任何池）
    await client.end().catch(() => {});
  }
  if (ran) {
    try {
      await d.bus.publish(PLUGINS_MIGRATED_TOPIC, { plugin: name, sha256 });
    } catch (err) {
      d.log?.warn(
        "cannot publish plugins.migrated; other replicas pick it up on the next reconcile",
        {
          plugin: name,
          err,
        },
      );
    }
  }
  return "migrated";
}

/**
 * 目标包里尚未执行过的迁移文件（降级判断，C16：降级仅当目标版本的迁移文件都已执行过）：
 * 按插件 schema 的 `_migrations` 表比对文件名与 checksum（与迁移器相同的 sha256）；改过内容的也算未执行。
 * 插件从没迁移过时返回全部文件。
 */
export async function unrunMigrations(
  db: KernelDb | Transaction<KernelDatabase>,
  name: string,
  files: { file: string; sql: string }[],
): Promise<string[]> {
  if (files.length === 0) return [];
  const schema = pluginSchemaName(name);
  const exists = await sql<{
    t: string | null;
  }>`SELECT to_regclass(${`"${schema}"._migrations`})::text AS t`.execute(db);
  const done = new Map<string, string>();
  if (exists.rows[0]?.t) {
    const rows = await sql<{
      name: string;
      checksum: string;
    }>`SELECT name, checksum FROM ${sql.table(`${schema}._migrations`)}`.execute(db);
    for (const r of rows.rows) done.set(r.name, r.checksum);
  }
  return files
    .filter((f) => done.get(f.file) !== createHash("sha256").update(f.sql).digest("hex"))
    .map((f) => f.file);
}
