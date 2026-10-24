import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import pgLib from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
const dbs: ReturnType<typeof createDb>[] = [];
const dirs: string[] = [];
let n = 0;

function db() {
  const d = createDb(pg.url, 5);
  dbs.push(d);
  return d;
}

async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "mig-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

const schemaName = () => `t_${process.pid}_${++n}`;

async function tableExists(d: ReturnType<typeof createDb>, schema: string, table: string) {
  const r = await sql<{
    x: string | null;
  }>`select to_regclass(${`${schema}.${table}`})::text as x`.execute(d);
  return r.rows[0]?.x != null;
}

beforeAll(async () => {
  pg = await startTestPostgres();
}, 120_000);

afterAll(async () => {
  await Promise.all(dbs.map((d) => d.destroy()));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  await pg?.stop();
}, 120_000);

describe("migrate", () => {
  it("unqualified table lands in the owner schema, not public", async () => {
    const schema = schemaName();
    const dir = await fixture({ "0001_a.sql": "create table if not exists unq_t (id int);" });
    const d = db();
    await migrate(pg.url, { schema, dir });
    expect(await tableExists(d, schema, "unq_t")).toBe(true);
    expect(await tableExists(d, "public", "unq_t")).toBe(false);
  });

  it("applies in order", async () => {
    const schema = schemaName();
    const dir = await fixture({
      "0002_b.sql": `create table ${schema}.b (id int);`,
      "0001_a.sql": `create table ${schema}.a (id int);`,
      "notes.txt": "ignored",
    });
    const d = db();
    await sql.raw(`create schema ${schema}`).execute(d);
    const r = await migrate(pg.url, { schema, dir });
    expect(r.applied).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(await tableExists(d, schema, "a")).toBe(true);
    expect(await tableExists(d, schema, "b")).toBe(true);
  });

  it("creates the schema and is idempotent on rerun", async () => {
    const schema = schemaName();
    const dir = await fixture({ "0001_a.sql": `create table ${schema}.a (id int);` });
    const d = db();
    await sql.raw(`create schema ${schema}`).execute(d);
    await migrate(pg.url, { schema, dir });
    expect((await migrate(pg.url, { schema, dir })).applied).toEqual([]);
  });

  it("creates a missing schema before _migrations", async () => {
    const schema = schemaName();
    const dir = await fixture({ "0001_a.sql": `create table if not exists ${schema}.a (id int);` });
    expect((await migrate(pg.url, { schema, dir })).applied).toEqual(["0001_a.sql"]);
  });

  it("rejects on checksum mismatch", async () => {
    const schema = schemaName();
    const dir = await fixture({ "0001_a.sql": `create table ${schema}.a (id int);` });
    await migrate(pg.url, { schema, dir });
    await writeFile(join(dir, "0001_a.sql"), `create table ${schema}.a (id int, x int);`);
    await expect(migrate(pg.url, { schema, dir })).rejects.toThrow(/0001_a\.sql/);
  });

  it("serializes concurrent migrate calls", async () => {
    const schema = schemaName();
    const dir = await fixture({
      "0001_a.sql": `create table ${schema}.a (id int);`,
      "0002_b.sql": `create table ${schema}.b (id int);`,
    });
    const [r1, r2] = await Promise.all([
      migrate(pg.url, { schema, dir }),
      migrate(pg.url, { schema, dir }),
    ]);
    expect([...r1.applied, ...r2.applied].sort()).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("rolls back a failed file", async () => {
    const schema = schemaName();
    const dir = await fixture({
      "0001_a.sql": `create table ${schema}.a (id int);`,
      "0003_bad.sql": `create table ${schema}.c (id int);\nselec nonsense;`,
    });
    const d = db();
    await expect(migrate(pg.url, { schema, dir })).rejects.toThrow(/0003_bad\.sql/);
    const rows = await sql<{
      name: string;
    }>`select name from ${sql.id(schema, "_migrations")}`.execute(d);
    expect(rows.rows.map((r) => r.name)).toEqual(["0001_a.sql"]);
    expect(await tableExists(d, schema, "c")).toBe(false);
  });

  it("rejects when an applied file is modified, before applying anything new", async () => {
    const schema = schemaName();
    const dir = await fixture({ "0001_a.sql": `create table ${schema}.a (id int);` });
    const d = db();
    await migrate(pg.url, { schema, dir });
    await writeFile(join(dir, "0001_a.sql"), `create table ${schema}.a (id int, x int);`);
    await writeFile(join(dir, "0002_b.sql"), `create table ${schema}.b (id int);`);
    await expect(migrate(pg.url, { schema, dir })).rejects.toThrow(/0001_a\.sql/);
    expect(await tableExists(d, schema, "b")).toBe(false);
  });

  it("rejects an unapplied file numbered below the highest applied", async () => {
    const schema = schemaName();
    const dir = await fixture({ "0002_b.sql": `create table ${schema}.b (id int);` });
    const d = db();
    await migrate(pg.url, { schema, dir });
    await writeFile(join(dir, "0001_a.sql"), `create table ${schema}.a (id int);`);
    await expect(migrate(pg.url, { schema, dir })).rejects.toThrow(/0001_a\.sql.*out of order/);
    expect(await tableExists(d, schema, "a")).toBe(false);
  });

  it("does not leave the advisory lock held after a failure", async () => {
    const schema = schemaName();
    const bad = await fixture({ "0001_bad.sql": "selec nonsense;" });
    await expect(migrate(pg.url, { schema, dir: bad })).rejects.toThrow(/0001_bad\.sql/);
    const ok = await fixture({ "0002_ok.sql": `create table if not exists ${schema}.a (id int);` });
    expect((await migrate(pg.url, { schema, dir: ok })).applied).toEqual(["0002_ok.sql"]);
  });
});

describe("createDb", () => {
  it("survives a terminated idle backend and reports it via onError", async () => {
    const errors: Error[] = [];
    const d = createDb(pg.url, 2, (e) => errors.push(e));
    dbs.push(d);
    const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(d)).rows[0]
      ?.pid;
    const admin = db();
    await sql`select pg_terminate_backend(${pid})`.execute(admin);
    await new Promise((r) => setTimeout(r, 500));
    expect(errors.length).toBeGreaterThan(0);
    expect((await sql<{ x: number }>`select 1 as x`.execute(d)).rows[0]?.x).toBe(1);
  });

  it("abort during the file-reading phase rejects promptly and leaves no backend", async () => {
    const schema = schemaName();
    const dir = await fixture({ "0001_a.sql": "create table if not exists ab_t (id int);" });
    // 另一条连接持有该 schema 的迁移锁：漏掉中止的迁移会连上并永远阻塞在取锁上
    const holder = new pgLib.Client({ connectionString: pg.url });
    await holder.connect();
    try {
      await holder.query("select pg_advisory_lock(hashtext($1))", [`capybara-migrate:${schema}`]);
      const ac = new AbortController();
      const p = migrate(pg.url, { schema, dir }, { signal: ac.signal });
      ac.abort(); // 同步中止：此时 migrate 还在读目录、尚未连接
      const outcome = await Promise.race([
        p.then(
          () => "resolved",
          (e: Error) => e.message,
        ),
        new Promise<string>((r) => setTimeout(() => r("timeout"), 2_000)),
      ]);
      expect(outcome).toMatch(/aborted/);
      const waiting = await holder.query<{ n: number }>(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())",
      );
      expect(waiting.rows[0]?.n).toBe(0);
    } finally {
      await holder.end();
    }
  });

  it("abort while client.connect() is waiting on a black-hole server rejects promptly (does not wait for connectTimeoutMs)", async () => {
    const dir = await fixture({ "0001_a.sql": "select 1;" });
    // 接受 TCP 连接但从不回应启动包：pg 的 connect() 会一直等到 connectTimeoutMs
    const sockets: Socket[] = [];
    let closed = 0;
    const server = createServer((s) => {
      sockets.push(s);
      s.on("error", () => {});
      s.on("close", () => closed++);
      s.resume();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const ac = new AbortController();
      const t0 = Date.now();
      const p = migrate(
        `postgres://u:p@127.0.0.1:${port}/db`,
        { schema: schemaName(), dir },
        { signal: ac.signal, connectTimeoutMs: 30_000 },
      );
      await new Promise<void>((r) => {
        const check = () => (sockets.length > 0 ? r() : setTimeout(check, 10));
        check();
      });
      ac.abort();
      const outcome = await Promise.race([
        p.then(
          () => "resolved",
          (e: Error) => e.message,
        ),
        new Promise<string>((r) => setTimeout(() => r("timeout"), 4_000)),
      ]);
      expect(outcome).toMatch(/aborted/);
      // connectTimeoutMs is 30 s; 4 s still proves the abort cut it short and tolerates CI load.
      expect(Date.now() - t0).toBeLessThan(4_000);
      // 客户端已主动断开正在建立的连接
      const until = Date.now() + 1_000;
      while (closed < sockets.length && Date.now() < until)
        await new Promise((r) => setTimeout(r, 10));
      expect(closed).toBe(sockets.length);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
