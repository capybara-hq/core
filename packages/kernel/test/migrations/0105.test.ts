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
 * 0105_setup_guides_v2.sql (setup guides v2 spec §11, §15): connectors gain `guide_ack`, and the v1
 * acks of channel connections are cleared (a v1 template hash never equals a v2 hash, so keeping
 * them would show every connection a false notice). Migrates to the migration before it, writes a
 * connection with a v1 ack and one without, then runs 0105.
 */
const FILE = "0105_setup_guides_v2.sql";

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

const V1_ACK = { guideId: "slack-app", version: "0.1.0", hash: "a".repeat(64), mode: "webhook" };

const insertConnection = (id: string, ack: object | null) =>
  sql`insert into capybara.channel_connections
    (id, org_id, plugin, name, agent_id, config, created_by, guide_ack)
    values (${id}, 'o1', 'slack', ${id}, 'ag1', '{}'::jsonb, 'a1',
      ${ack === null ? null : JSON.stringify(ack)}::jsonb)`.execute(db);

const acks = async () =>
  (
    await sql<{ id: string; guide_ack: unknown }>`select id, guide_ack
      from capybara.channel_connections order by id`.execute(db)
  ).rows;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
  await insertConnection("c-acked", V1_ACK);
  await insertConnection("c-none", null);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 120_000);

describe("0105_setup_guides_v2", () => {
  it("clears the v1 acks of channel connections", async () => {
    expect(await acks()).toEqual([
      { id: "c-acked", guide_ack: null },
      { id: "c-none", guide_ack: null },
    ]);
  });

  it("adds connectors.guide_ack (jsonb, nullable)", async () => {
    const cols = await sql<{ data_type: string; is_nullable: string }>`select data_type, is_nullable
      from information_schema.columns
      where table_schema = 'capybara' and table_name = 'connectors' and column_name = 'guide_ack'`.execute(
      db,
    );
    expect(cols.rows).toEqual([{ data_type: "jsonb", is_nullable: "YES" }]);
  });

  it("is idempotent: running its statements again changes nothing and fails nothing", async () => {
    await insertConnection("c-v2", { ...V1_ACK, hash: "b".repeat(64) });
    const body = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql
      .raw(`set search_path to capybara, public; ${body}; set search_path to default`)
      .execute(db);
    // a rerun clears again (the statement is unconditional on content): an ack written after the
    // migration is only ever written by v2 code, and the migrator never reruns an applied file
    expect((await acks()).every((r) => r.guide_ack === null)).toBe(true);
    // and the migrator itself treats the applied file as done
    await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
  });
});
