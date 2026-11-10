import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * 0109_agent_skill_sharing.sql (skill authoring via the Platform tool): skills gain
 * `origin_agent_id` and `maintainer_account_id` (an agent skill shared with the org),
 * skill_change_requests gain `kind`, and the pending R4 owner-approved changes are cancelled.
 * Migrates to the migration before it, seeds a pending and an approved request, then runs 0109.
 */
const FILE = "0109_agent_skill_sharing.sql";

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

const insertRequest = (id: string, name: string, status: string, kind?: string) =>
  kind === undefined
    ? sql`insert into capybara.skill_change_requests
        (id, org_id, agent_id, proposed_version, object_prefix, requested_by_account,
         requested_in_conversation, status)
        values (${id}, 'o1', 'ag1', ${JSON.stringify({ manifest: { name } })}::jsonb, 'p/', 'a1',
          'c1', ${status})`.execute(db)
    : sql`insert into capybara.skill_change_requests
        (id, org_id, agent_id, proposed_version, object_prefix, requested_by_account,
         requested_in_conversation, status, kind)
        values (${id}, 'o1', 'ag1', ${JSON.stringify({ manifest: { name } })}::jsonb, 'p/', 'a1',
          'c1', ${status}, ${kind})`.execute(db);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1), ('ag2', 'o1', 'a1', 'private', 1)`.execute(db);
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
    values ('c1', 'o1', 'ag1', 'a1')`.execute(db);
  await insertRequest("r-pending", "s1", "pending");
  await insertRequest("r-approved", "s2", "approved");
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 120_000);

describe("0109_agent_skill_sharing", () => {
  it("adds skills.origin_agent_id, skills.maintainer_account_id and skill_change_requests.kind", async () => {
    const cols = await sql<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>`select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'capybara'
        and ((table_name = 'skills' and column_name in ('origin_agent_id', 'maintainer_account_id'))
          or (table_name = 'skill_change_requests' and column_name = 'kind'))
      order by table_name, column_name`.execute(db);
    expect(cols.rows).toEqual([
      {
        table_name: "skill_change_requests",
        column_name: "kind",
        data_type: "text",
        is_nullable: "NO",
        column_default: "'version'::text",
      },
      {
        table_name: "skills",
        column_name: "maintainer_account_id",
        data_type: "text",
        is_nullable: "YES",
        column_default: null,
      },
      {
        table_name: "skills",
        column_name: "origin_agent_id",
        data_type: "text",
        is_nullable: "YES",
        column_default: null,
      },
    ]);
  });

  it("cancels pending requests and stamps decided_at; decided ones keep their status", async () => {
    const rows = await sql<{ id: string; status: string; decided_at: Date | null; kind: string }>`
      select id, status, decided_at, kind from capybara.skill_change_requests
      where id in ('r-pending', 'r-approved') order by id`.execute(db);
    expect(rows.rows.map((r) => [r.id, r.status, r.decided_at !== null, r.kind])).toEqual([
      ["r-approved", "approved", false, "version"],
      ["r-pending", "cancelled", true, "version"],
    ]);
  });

  it("refuses a request kind other than share or version", async () => {
    await expect(insertRequest("r-other", "s3", "pending", "other")).rejects.toMatchObject({
      code: "23514",
    });
    await insertRequest("r-share", "s4", "pending", "share");
  });

  it("deleting the origin agent clears origin_agent_id and keeps the shared skill", async () => {
    await sql`insert into capybara.skills
      (id, org_id, scope, agent_id, name, description, current_version, created_by,
       origin_agent_id, maintainer_account_id)
      values ('sk1', 'o1', 'org', null, 'shared', 'd', 1, 'a1', 'ag2', 'a1')`.execute(db);
    await sql`delete from capybara.agents where id = 'ag2'`.execute(db);
    const rows = await sql<{
      id: string;
      origin_agent_id: string | null;
      maintainer_account_id: string | null;
      deleted_at: Date | null;
    }>`select id, origin_agent_id, maintainer_account_id, deleted_at
      from capybara.skills where id = 'sk1'`.execute(db);
    expect(rows.rows).toEqual([
      { id: "sk1", origin_agent_id: null, maintainer_account_id: "a1", deleted_at: null },
    ]);
  });
});
