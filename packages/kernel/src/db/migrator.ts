import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { pgConnectOptions } from "./pool.js";

/** 迁移文件名：`NNNN_<snake_desc>.sql`（其他文件忽略）。 */
export const MIGRATION_FILE_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

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
 * `opts.signal` 中止时结束会话：先从另一条连接 `pg_terminate_backend` 迁移会话的后端（后端阻塞在
 * advisory lock 或长语句上时不会读到客户端的断开，只 end() 会一直占着连接），再 end()；迁移以
 * `aborted` 失败；中止时若仍在建立连接，直接销毁正在建立的套接字（不等 `connectTimeoutMs`）。
 * 返回（或抛出）时会话与用于终止的连接都已结束。
 */
export async function migrate(
  connectionString: string,
  owner: MigrationOwner,
  opts: {
    connectTimeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    /** 迁移会话的 `statement_timeout`（毫秒）；不给不设。 */
    statementTimeoutMs?: number | undefined;
    /** 迁移会话的 `lock_timeout`（毫秒，含按 schema 的咨询锁）；不给不设。 */
    lockTimeoutMs?: number | undefined;
  } = {},
): Promise<{ applied: string[] }> {
  const { schema, dir } = owner;
  const { signal } = opts;
  if (signal?.aborted) throw new Error(`Migration ${schema} aborted`);
  const names = (await readdir(dir)).filter((f) => MIGRATION_FILE_RE.test(f)).sort();
  const files = await Promise.all(
    names.map(async (name) => {
      const content = await readFile(join(dir, name), "utf8");
      return { name, content, checksum: createHash("sha256").update(content).digest("hex") };
    }),
  );
  const table = `${ident(schema)}._migrations`;
  // 读文件期间可能已中止（AbortSignal 不会对之后才挂上的监听器补发 abort）：连接前再查一次。
  // 从这里到 client.connect() 之间没有 await，监听器挂上前不会错过中止。
  if (signal?.aborted) throw new Error(`Migration ${schema} aborted`);

  const newClient = () => {
    const c = new pg.Client({ connectionString, ...pgConnectOptions(opts) });
    c.on("error", () => {});
    return c;
  };
  const client = newClient();
  let ending: Promise<void> | undefined;
  const end = () => {
    ending ??= client.end().catch(() => {});
    return ending;
  };
  /** 从独立连接终止迁移会话的后端，再结束本地会话。 */
  const terminate = async (): Promise<void> => {
    // pg.Client 在握手时记录后端 pid（BackendKeyData），类型定义未暴露
    const internals = client as unknown as {
      processID: number | null;
      connection?: { stream?: { destroy(): void } };
    };
    const pid = internals.processID;
    if (!pid) {
      // 还在建立连接（TCP / 启动握手未完成，没有后端可终止）：直接销毁正在建立的套接字，
      // connect() 随即以连接中断失败，不必等到 connectTimeoutMs。这里不能先调 end()：
      // pg 在 end() 之后收到断开不会再回调 connect()，connect 会一直挂着。
      // connect 失败后由 finally 里的 end() 收尾（此时已是空操作）。
      internals.connection?.stream?.destroy();
      return;
    }
    const killer = newClient();
    try {
      await killer.connect();
      await killer.query("select pg_terminate_backend($1)", [pid]);
    } catch {
      // 尽力而为：终止失败时仍会 end() 本地会话
    } finally {
      await killer.end().catch(() => {});
    }
    await end();
  };
  let aborting: Promise<void> | undefined;
  const onAbort = () => {
    aborting ??= terminate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect();
    if (opts.statementTimeoutMs !== undefined) {
      await client.query(`set statement_timeout = ${Math.max(1, Math.floor(opts.statementTimeoutMs))}`);
    }
    if (opts.lockTimeoutMs !== undefined) {
      await client.query(`set lock_timeout = ${Math.max(1, Math.floor(opts.lockTimeoutMs))}`);
    }
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
  } catch (e) {
    if (signal?.aborted) throw new Error(`Migration ${schema} aborted`, { cause: e });
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await aborting;
    await end();
  }
}
