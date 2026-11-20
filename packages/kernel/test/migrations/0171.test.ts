import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * 0171_account_avatar.sql (account profile spec §5.1): `accounts.avatar`, the
 * `account_avatar_uploads` table and `identities.updated_at`. Migrates to the migration before it,
 * seeds an account, runs 0171, then again by hand.
 */
const FILE = "0171_account_avatar.sql";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;
const dirs: string[] = [];

const copyMigrations = (pred: (f: string) => boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "cap-mig-"));
  dirs.push(dir);
  for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && pred(f)) copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
};

const runFile = async () => {
  const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
  await sql.raw(`set search_path to capybara; ${text}`).execute(db);
};

type Column = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  default: string | null;
};
const columnsOf = async (table: string) =>
  (
    await sql<Column>`
      select column_name, data_type, is_nullable, column_default as default
      from information_schema.columns
      where table_schema = 'capybara' and table_name = ${table}
      order by ordinal_position`.execute(db)
  ).rows;

const indexesOf = async (table: string) =>
  (
    await sql<{ indexdef: string }>`
      select indexdef from pg_indexes where schemaname = 'capybara' and tablename = ${table}`.execute(
      db,
    )
  ).rows.map((r) => r.indexdef);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A'), ('a2', 'B')`.execute(
    db,
  );
  await sql`insert into capybara.identities (source, external_id, account_id, profile)
    values ('lark:t1', 'ou_1', 'a1', '{}')`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0171 account avatar", () => {
  it("adds a nullable jsonb accounts.avatar, null on existing rows", async () => {
    const col = (await columnsOf("accounts")).find((c) => c.column_name === "avatar");
    expect(col).toMatchObject({ data_type: "jsonb", is_nullable: "YES", default: null });
    const rows = (await sql<{ avatar: unknown }>`select avatar from capybara.accounts`.execute(db))
      .rows;
    expect(rows.map((r) => r.avatar)).toEqual([null, null]);
  });

  it("creates account_avatar_uploads with exactly the spec's columns", async () => {
    const cols = await columnsOf("account_avatar_uploads");
    expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ["id", "text", "NO"],
      ["account_id", "text", "NO"],
      ["storage_key", "text", "NO"],
      ["content_type", "text", "NO"],
      ["size", "bigint", "YES"],
      ["status", "text", "NO"],
      ["expires_at", "timestamp with time zone", "YES"],
      ["created_at", "timestamp with time zone", "NO"],
    ]);
    expect(cols.find((c) => c.column_name === "status")?.default).toBe("'pending'::text");
    expect(cols.find((c) => c.column_name === "created_at")?.default).toBe("now()");
    const pk = (
      await sql<{ def: string }>`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'capybara.account_avatar_uploads'::regclass and contype = 'p'`.execute(db)
    ).rows;
    expect(pk.map((r) => r.def)).toEqual(["PRIMARY KEY (id)"]);
  });

  it("indexes account_id, and expires_at only where it is set", async () => {
    const defs = await indexesOf("account_avatar_uploads");
    expect(defs).toContainEqual(expect.stringMatching(/USING btree \(account_id\)$/));
    expect(defs).toContainEqual(
      expect.stringMatching(/USING btree \(expires_at\) WHERE \(expires_at IS NOT NULL\)$/),
    );
  });

  it("refuses a status other than pending or ready, and defaults to pending", async () => {
    await sql`insert into capybara.account_avatar_uploads (id, account_id, storage_key, content_type)
      values ('u0', 'a2', 'k0', 'image/png')`.execute(db);
    const row = (
      await sql<{
        status: string;
      }>`select status from capybara.account_avatar_uploads where id = 'u0'`.execute(db)
    ).rows[0];
    expect(row?.status).toBe("pending");
    await expect(
      sql`update capybara.account_avatar_uploads set status = 'deleting' where id = 'u0'`.execute(
        db,
      ),
    ).rejects.toThrow();
  });

  it("adds a nullable identities.updated_at, null on existing rows", async () => {
    const col = (await columnsOf("identities")).find((c) => c.column_name === "updated_at");
    expect(col).toMatchObject({
      data_type: "timestamp with time zone",
      is_nullable: "YES",
      default: null,
    });
    const rows = (
      await sql<{ updated_at: unknown }>`select updated_at from capybara.identities`.execute(db)
    ).rows;
    expect(rows).toEqual([{ updated_at: null }]);
  });

  it("deleting an account deletes its upload rows", async () => {
    await sql`insert into capybara.account_avatar_uploads (id, account_id, storage_key, content_type)
      values ('u1', 'a1', 'k1', 'image/png'), ('u2', 'a1', 'k2', 'image/webp')`.execute(db);
    await sql`delete from capybara.identities where account_id = 'a1'`.execute(db);
    await sql`delete from capybara.accounts where id = 'a1'`.execute(db);
    const left = (
      await sql<{
        id: string;
      }>`select id from capybara.account_avatar_uploads where account_id = 'a1'`.execute(db)
    ).rows;
    expect(left).toEqual([]);
  });

  it("is idempotent and keeps the data", async () => {
    await sql`update capybara.accounts set avatar = '{"kind":"upload","uploadId":"u0"}' where id = 'a2'`.execute(
      db,
    );
    await runFile();
    await runFile();
    const row = (
      await sql<{ avatar: unknown }>`select avatar from capybara.accounts where id = 'a2'`.execute(
        db,
      )
    ).rows[0];
    expect(row?.avatar).toEqual({ kind: "upload", uploadId: "u0" });
    const uploads = (
      await sql<{ n: string }>`select count(*) as n from capybara.account_avatar_uploads`.execute(
        db,
      )
    ).rows[0];
    expect(Number(uploads?.n)).toBe(1);
  });
});
