import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import {
  ensureMigrated,
  MIGRATE_LOCK_PREFIX,
  unrunMigrations,
} from "../../src/extensions/migrate-lock.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";

/**
 * 插件迁移的持锁协调（C16，F-P）：独立连接上的 `pg_try_advisory_lock`，拿不到返回 busy；拿到后复核
 * `migrated_sha`、执行迁移、写 `migrated_sha`、发布 `plugins.migrated`；会话结束即释放锁（不泄漏到连接池）。
 */

let pgc: TestContainer;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let dir: string;
const published: { topic: string; payload: unknown }[] = [];
const bus = {
  async publish(topic: string, payload: unknown) {
    published.push({ topic, payload });
  },
};
const SHA1 = "a".repeat(64);
const SHA2 = "b".repeat(64);

async function seed(name: string, sha: string, migratedSha: string | null): Promise<void> {
  for (const s of [SHA1, SHA2]) {
    await db
      .insertInto("extension_packages")
      .values({
        sha256: s,
        name,
        package_name: `@t/${name}`,
        version: s === SHA1 ? "1.0.0" : "2.0.0",
        size: 1,
        section: JSON.stringify({}),
        blob_store: "pg",
        source: "file",
        source_ref: "upload",
      })
      .onConflict((oc) => oc.column("sha256").doNothing())
      .execute();
  }
  await db
    .insertInto("extension_installs")
    .values({
      name,
      sha256: sha,
      version: "x",
      source: "file",
      desired_state: "enabled",
      migrated_sha: migratedSha,
    })
    .execute();
}

const migratedSha = async (name: string) =>
  (
    await db
      .selectFrom("extension_installs")
      .select("migrated_sha")
      .where("name", "=", name)
      .executeTakeFirstOrThrow()
  ).migrated_sha;

const deps = () => ({ db, dbUrl: pgc.url, bus });

beforeAll(async () => {
  pgc = await startTestPostgres();
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  dir = await mkdtemp(join(tmpdir(), "migrate-lock-"));
  await writeFile(
    join(dir, "0001_init.sql"),
    "CREATE TABLE IF NOT EXISTS hits (id serial PRIMARY KEY);\nINSERT INTO hits DEFAULT VALUES;\n",
  );
}, 120_000);
afterAll(async () => {
  await destroyDb?.();
  await rm(dir, { recursive: true, force: true });
  await pgc?.stop();
});
beforeEach(async () => {
  published.length = 0;
  await truncateTables(db, "capybara.extension_installs, capybara.extension_packages");
  for (const s of ["plugin_ml_a", "plugin_ml_b", "plugin_ml_c", "plugin_ml_d"]) {
    await sql.raw(`DROP SCHEMA IF EXISTS ${s} CASCADE`).execute(db);
  }
});

describe("ensureMigrated", () => {
  it("拿到锁：执行迁移、写 migrated_sha、发布 plugins.migrated；再调一次不重复执行", async () => {
    await seed("ml-a", SHA1, null);
    expect(await ensureMigrated(deps(), "ml-a", SHA1, dir)).toBe("migrated");
    expect(await migratedSha("ml-a")).toBe(SHA1);
    const hits = await sql<{ n: number }>`SELECT count(*)::int AS n FROM plugin_ml_a.hits`.execute(
      db,
    );
    expect(hits.rows[0]?.n).toBe(1);
    expect(published).toEqual([
      { topic: "plugins.migrated", payload: { plugin: "ml-a", sha256: SHA1 } },
    ]);
    expect(await ensureMigrated(deps(), "ml-a", SHA1, dir)).toBe("migrated");
    expect(published).toHaveLength(1);
  });

  it("锁被别的会话持有 → busy，不执行；持有方释放后能拿到（锁不泄漏）", async () => {
    await seed("ml-b", SHA1, null);
    const holder = new pg.Client({ connectionString: pgc.url });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext($1))", [`${MIGRATE_LOCK_PREFIX}ml-b`]);
      expect(await ensureMigrated(deps(), "ml-b", SHA1, dir)).toBe("busy");
      expect(await migratedSha("ml-b")).toBeNull();
      expect(published).toEqual([]);
    } finally {
      await holder.end();
    }
    expect(await ensureMigrated(deps(), "ml-b", SHA1, dir)).toBe("migrated");
    // 多次 busy / migrated 之后，池里没有任何会话还拿着这把锁
    const held = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`.execute(
      db,
    );
    expect(held.rows[0]?.n).toBe(0);
  });

  it("两个调用并发：迁移只执行一次，另一个 busy 或看到已迁移", async () => {
    await seed("ml-c", SHA1, null);
    const r = await Promise.all([
      ensureMigrated(deps(), "ml-c", SHA1, dir),
      ensureMigrated(deps(), "ml-c", SHA1, dir),
      ensureMigrated(deps(), "ml-c", SHA1, dir),
    ]);
    expect(r).toContain("migrated");
    const hits = await sql<{ n: number }>`SELECT count(*)::int AS n FROM plugin_ml_c.hits`.execute(
      db,
    );
    expect(hits.rows[0]?.n).toBe(1);
    expect(published.filter((p) => p.topic === "plugins.migrated")).toHaveLength(1);
  });

  it("没有迁移目录：直接记下 migrated_sha；安装记录已换包时不迁移旧目标（busy）", async () => {
    await seed("ml-d", SHA2, SHA1);
    expect(await ensureMigrated(deps(), "ml-d", SHA2, undefined)).toBe("migrated");
    expect(await migratedSha("ml-d")).toBe(SHA2);
    // 请求的是 SHA1，但记录已指向 SHA2
    expect(await ensureMigrated(deps(), "ml-d", SHA1, dir)).toBe("busy");
    expect(await migratedSha("ml-d")).toBe(SHA2);
  });

  it("迁移失败：抛错、不写 migrated_sha，锁随会话释放", async () => {
    await seed("ml-a", SHA1, null);
    const bad = await mkdtemp(join(tmpdir(), "migrate-lock-bad-"));
    try {
      await writeFile(join(bad, "0001_bad.sql"), "THIS IS NOT SQL;");
      await expect(ensureMigrated(deps(), "ml-a", SHA1, bad)).rejects.toThrow(/0001_bad/);
      expect(await migratedSha("ml-a")).toBeNull();
      expect(await ensureMigrated(deps(), "ml-a", SHA1, dir)).toBe("migrated");
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });
});

describe("unrunMigrations（降级判断）", () => {
  it("目标版本的迁移文件都已执行（含 checksum 一致）→ 空；缺的或改过的列出来", async () => {
    await seed("ml-b", SHA1, null);
    await ensureMigrated(deps(), "ml-b", SHA1, dir);
    const init = {
      file: "0001_init.sql",
      sql: "CREATE TABLE IF NOT EXISTS hits (id serial PRIMARY KEY);\nINSERT INTO hits DEFAULT VALUES;\n",
    };
    expect(await unrunMigrations(db, "ml-b", [init])).toEqual([]);
    expect(await unrunMigrations(db, "ml-b", [])).toEqual([]);
    expect(
      await unrunMigrations(db, "ml-b", [init, { file: "0002_more.sql", sql: "SELECT 1;" }]),
    ).toEqual(["0002_more.sql"]);
    expect(await unrunMigrations(db, "ml-b", [{ ...init, sql: "SELECT 2;" }])).toEqual([
      "0001_init.sql",
    ]);
    // 插件从没迁移过（schema 不存在）
    expect(await unrunMigrations(db, "ml-c", [init])).toEqual(["0001_init.sql"]);
  });
});
