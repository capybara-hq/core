import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const FILE_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

/** 迁移器所有者：目标 schema 与迁移文件目录。 */
export interface MigrationOwner {
  schema: string;
  dir: string;
}

const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;
const num = (name: string) => Number.parseInt(name.slice(0, 4), 10);

/**
 * 执行目录下尚未应用的 SQL 迁移。
 * 使用独立的 pg.Client（不走连接池），在该会话上持有 advisory lock（按 schema 名哈希）；
 * 结束时无论成败都 end() 会话，会话结束即释放锁，不会把持锁连接还给连接池。
 * 执行前先校验已应用文件的 checksum 与编号顺序；每个文件在独立事务中执行。
 * `opts.connectTimeoutMs` 为建立连接的超时（不设则 pg 无限等待）。
 */
export async function migrate(
  connectionString: string,
  owner: MigrationOwner,
  opts: { connectTimeoutMs?: number } = {},
): Promise<{ applied: string[] }> {
  const { schema, dir } = owner;
  const names = (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
  const files = await Promise.all(
    names.map(async (name) => {
      const content = await readFile(join(dir, name), "utf8");
      return { name, content, checksum: createHash("sha256").update(content).digest("hex") };
    }),
  );
  const table = `${ident(schema)}._migrations`;

  const client = new pg.Client({
    connectionString,
    ...(opts.connectTimeoutMs !== undefined && { connectionTimeoutMillis: opts.connectTimeoutMs }),
  });
  client.on("error", () => {});
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [`capybara-migrate:${schema}`]);
    await client.query(`create schema if not exists ${ident(schema)}`);
    await client.query(`create table if not exists ${table} (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
    const rows = (
      await client.query<{ name: string; checksum: string }>(`select name, checksum from ${table}`)
    ).rows;
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const f of files) {
      const prev = done.get(f.name);
      if (prev !== undefined && prev !== f.checksum) {
        throw new Error(
          `Migration ${schema}/${f.name} was modified after being applied (checksum mismatch)`,
        );
      }
    }
    const highest = Math.max(-1, ...rows.map((r) => num(r.name)));
    for (const f of files) {
      if (!done.has(f.name) && num(f.name) < highest) {
        throw new Error(
          `Migration ${schema}/${f.name} is out of order: a higher-numbered migration (${String(highest).padStart(4, "0")}) is already applied`,
        );
      }
    }

    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f.name)) continue;
      try {
        await client.query("begin");
        await client.query(`set local search_path to ${ident(schema)}, public`);
        await client.query(f.content);
        await client.query(`insert into ${table} (name, checksum) values ($1, $2)`, [
          f.name,
          f.checksum,
        ]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => {});
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Migration ${schema}/${f.name} failed: ${msg}`, { cause: e });
      }
      applied.push(f.name);
    }
    return { applied };
  } finally {
    await client.end().catch(() => {});
  }
}
