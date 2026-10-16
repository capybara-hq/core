import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
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
    const d = db();
    expect((await migrate(pg.url, { schema, dir })).applied).toEqual(["0001_a.sql"]);
  });

  it("rejects on checksum mismatch", async () => {
    const schema = schemaName();
    const dir = await fixture({ "0001_a.sql": `create table ${schema}.a (id int);` });
    const d = db();
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
});
