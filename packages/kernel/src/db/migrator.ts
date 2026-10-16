import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Kysely, sql } from "kysely";

const FILE_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

/** 迁移器所有者：目标 schema 与迁移文件目录。 */
export interface MigrationOwner {
  schema: string;
  dir: string;
}

/**
 * 执行目录下尚未应用的 SQL 迁移。
 * 全程在单一专用连接上持有 advisory lock（按 schema 名哈希），保证并发调用只有一个执行；
 * 每个文件在独立事务中执行，已执行文件的 checksum 变化会抛错并点名该文件。
 */
export async function migrate(
  // biome-ignore lint/suspicious/noExplicitAny: 内核不持有表结构类型
  db: Kysely<any>,
  owner: MigrationOwner,
): Promise<{ applied: string[] }> {
  const { schema, dir } = owner;
  const names = (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
  const files = await Promise.all(
    names.map(async (name) => {
      const content = await readFile(join(dir, name), "utf8");
      return { name, content, checksum: createHash("sha256").update(content).digest("hex") };
    }),
  );
  const table = sql.table(`${schema}._migrations`);

  return db.connection().execute(async (conn) => {
    const lockKey = sql`hashtext(${`capybara-migrate:${schema}`})`;
    await sql`select pg_advisory_lock(${lockKey})`.execute(conn);
    try {
      await sql`create schema if not exists ${sql.id(schema)}`.execute(conn);
      await sql`create table if not exists ${table} (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`.execute(conn);
      const done = new Map(
        (
          await sql<{
            name: string;
            checksum: string;
          }>`select name, checksum from ${table}`.execute(conn)
        ).rows.map((r) => [r.name, r.checksum]),
      );
      const applied: string[] = [];
      for (const f of files) {
        const prev = done.get(f.name);
        if (prev !== undefined) {
          if (prev !== f.checksum) {
            throw new Error(
              `Migration ${f.name} was modified after being applied (checksum mismatch)`,
            );
          }
          continue;
        }
        await conn.transaction().execute(async (tx) => {
          await sql.raw(f.content).execute(tx);
          await sql`insert into ${table} (name, checksum) values (${f.name}, ${f.checksum})`.execute(
            tx,
          );
        });
        applied.push(f.name);
      }
      return { applied };
    } finally {
      await sql`select pg_advisory_unlock(${lockKey})`.execute(conn);
    }
  });
}
