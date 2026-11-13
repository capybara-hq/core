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
 * 0124_conversation_source.sql (memory plugin spec §6.2): conversations gain `source`, backfilled
 * from the rows that existed: `kind = 'subagent'` → subagent, a conversation with a channel thread
 * row of any archive state → channel_dm (only `dm:` keys) or channel_group, a group conversation whose
 * thread is still to bind → channel_group (its delivery's target), the rest → web. Migrates to the
 * migration before it, seeds, then runs 0124 (twice: idempotent).
 */
const FILE = "0124_conversation_source.sql";

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

const conversation = (id: string, kind = "chat", parent: string | null = null) =>
  sql`insert into capybara.conversations (id, org_id, agent_id, account_id, kind,
      parent_conversation_id)
    values (${id}, 'o1', 'ag1', 'a1', ${kind}, ${parent})`.execute(db);

const thread = (id: string, conv: string, key: string, archived: boolean) =>
  sql`insert into capybara.channel_threads (id, connection_id, chat_id, thread_key, account_id,
      conversation_id, archived_at)
    values (${id}, 'cc1', 'chat-1', ${key}, 'a1', ${conv},
      ${archived ? sql`now()` : sql`null`})`.execute(db);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
  await sql`insert into capybara.channel_connections (id, org_id, plugin, name, agent_id,
      created_by)
    values ('cc1', 'o1', 'chan', 'chan', 'ag1', 'a1')`.execute(db);
  await conversation("c-web");
  await conversation("c-dm-archived");
  await thread("t1", "c-dm-archived", "dm:u1", true);
  await conversation("c-dm");
  await thread("t2", "c-dm", "dm:u1", false);
  await conversation("c-group");
  await thread("t3", "c-group", "om_123", false);
  await conversation("c-group-archived");
  await thread("t4", "c-group-archived", "om_456", true);
  // a DM row and a group row on one conversation: a group's (the safer source)
  await conversation("c-mixed");
  await thread("t5", "c-mixed", "dm:u2", true);
  await thread("t6", "c-mixed", "om_789", false);
  // a scheduled group run whose thread binds at its first post, which has not happened yet
  await conversation("c-group-pending");
  await sql`insert into capybara.channel_deliveries (conversation_id, connection_id, target,
      pending_thread_account_id)
    values ('c-group-pending', 'cc1', '{"chatId":"chat-1","chatType":"group"}', 'a1')`.execute(db);
  await conversation("c-sub", "subagent", "c-web");
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sources = async () =>
  Object.fromEntries(
    (
      await sql<{ id: string; source: string }>`select id, source
        from capybara.conversations order by id`.execute(db)
    ).rows.map((r) => [r.id, r.source]),
  );

const EXPECTED = {
  "c-dm": "channel_dm",
  "c-dm-archived": "channel_dm",
  "c-group": "channel_group",
  "c-group-archived": "channel_group",
  "c-group-pending": "channel_group",
  "c-mixed": "channel_group",
  "c-sub": "subagent",
  "c-web": "web",
};

describe("0124_conversation_source", () => {
  it("backfills each existing conversation's source, archived thread rows included", async () => {
    expect(await sources()).toEqual(EXPECTED);
  });

  it("is idempotent: running the file again changes nothing", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql.raw(`set search_path to capybara; ${text}`).execute(db);
    expect(await sources()).toEqual(EXPECTED);
  });

  it("new rows default to web and an unknown source is refused", async () => {
    await conversation("c-new");
    expect((await sources())["c-new"]).toBe("web");
    await expect(
      sql`update capybara.conversations set source = 'email' where id = 'c-new'`.execute(db),
    ).rejects.toThrow(/conversations_source_check/);
  });
});
