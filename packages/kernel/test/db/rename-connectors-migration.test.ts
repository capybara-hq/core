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
 * 0033_rename_apps_to_connectors.sql（D17）：表与 app_id 列改名，数据保留；索引 / 约束名不变；重复执行无副作用。
 * 先迁到 0032 写入旧表数据，再跑完整目录。
 */
const RENAME = "0033_rename_apps_to_connectors.sql";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;
let before: string;

const columns = async (table: string) =>
  (
    await sql<{ column_name: string }>`select column_name from information_schema.columns
      where table_schema = 'capybara' and table_name = ${table} order by column_name`.execute(db)
  ).rows.map((r) => r.column_name);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  before = mkdtempSync(join(tmpdir(), "cap-mig-"));
  for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && f < RENAME) {
      copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(before, f));
    }
  }
  await migrate(pg.url, { schema: "capybara", dir: before });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
    values ('c1', 'o1', 'ag1', 'a1')`.execute(db);
  await sql`insert into capybara.apps (id, org_id, slug, name, connector, created_by)
    values ('x1', 'o1', 'docs', 'Docs', 'mcp', 'a1')`.execute(db);
  await sql`insert into capybara.app_tools (app_id, name, spec, spec_hash, status, default_policy)
    values ('x1', 'search', '{}', 'h', 'enabled', 'allow')`.execute(db);
  await sql`insert into capybara.tool_grants (org_id, account_id, agent_id, tool_key, spec_hash, app_id)
    values ('o1', 'a1', 'ag1', 'docs__search', 'h', 'x1')`.execute(db);
  await sql`insert into capybara.conversation_tool_grants (conversation_id, tool_key, spec_hash, app_id)
    values ('c1', 'docs__search', 'h', 'x1')`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  if (before) rmSync(before, { recursive: true, force: true });
}, 120_000);

describe("0033 应用 → 连接器", () => {
  it("表改名：旧表不在，新表带着原有数据", async () => {
    const reg = async (t: string) =>
      (await sql<{ x: string | null }>`select to_regclass(${t})::text as x`.execute(db)).rows[0]
        ?.x ?? null;
    expect(await reg("capybara.apps")).toBeNull();
    expect(await reg("capybara.app_tools")).toBeNull();
    const rows = await sql<{
      id: string;
      connector: string;
    }>`select id, connector from capybara.connectors`.execute(db);
    expect(rows.rows).toEqual([{ id: "x1", connector: "mcp" }]);
  });

  it("app_id 列一律改为 connector_id，值保留", async () => {
    for (const t of ["connector_tools", "tool_grants", "conversation_tool_grants", "approvals"]) {
      const cols = await columns(t);
      expect(cols, t).toContain("connector_id");
      expect(cols, t).not.toContain("app_id");
    }
    const tools = await sql<{
      connector_id: string;
    }>`select connector_id from capybara.connector_tools`.execute(db);
    expect(tools.rows).toEqual([{ connector_id: "x1" }]);
    const grants = await sql<{
      connector_id: string;
    }>`select connector_id from capybara.tool_grants`.execute(db);
    expect(grants.rows).toEqual([{ connector_id: "x1" }]);
  });

  it("索引与约束名不变：slug 唯一索引与工具状态 CHECK 照常生效", async () => {
    await expect(
      sql`insert into capybara.connectors (id, org_id, slug, name, connector, created_by)
        values ('x2', 'o1', 'docs', 'Again', 'mcp', 'a1')`.execute(db),
    ).rejects.toThrow(/apps_org_slug_uniq/);
    await expect(
      sql`insert into capybara.connector_tools (connector_id, name, spec, spec_hash, status, default_policy)
        values ('x1', 'bad', '{}', 'h', 'weird', 'allow')`.execute(db),
    ).rejects.toThrow(/check/);
  });

  it("重复执行无副作用（表与列已改名时什么都不做）", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, RENAME), "utf8");
    await sql.raw(`set search_path to capybara, public; ${text}`).execute(db);
    expect(await columns("connector_tools")).toContain("connector_id");
  });
});
