import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * 0053_subagents.sql (phase C, spec §18): `conversations.kind` gains 'subagent' with a parent link,
 * `runs.subagent_tokens_used`, the `subagent_dispatches`, `agent_templates` and
 * `agent_template_versions` tables, and the 'agent_template' install component kind.
 */
const FILE = "0053_subagents.sql";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;

/** Runs the file a second time the way the migrator does (one transaction, schema search path). */
async function rerun(): Promise<void> {
  const content = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
  await db.transaction().execute(async (t) => {
    await sql`set local search_path to capybara, public`.execute(t);
    await sql.raw(content).execute(t);
  });
}

const count = async (q: string) =>
  Number((await sql<{ n: string }>`${sql.raw(q)}`.execute(db)).rows[0]?.n);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
}, 120_000);

describe("0053_subagents", () => {
  it("0053 applies twice without error and widens conversations.kind", async () => {
    await rerun();
    await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
      values ('p1', 'o1', 'ag1', 'a1')`.execute(db);
    await sql`insert into capybara.conversations
      (id, org_id, agent_id, account_id, kind, parent_conversation_id, subagent_type)
      values ('s1', 'o1', 'ag1', 'a1', 'subagent', 'p1', 'general-purpose')`.execute(db);
    await expect(
      sql`insert into capybara.conversations (id, org_id, agent_id, account_id, kind)
        values ('x1', 'o1', 'ag1', 'a1', 'other')`.execute(db),
    ).rejects.toThrow(/conversations_kind_check/);
    // re-added NOT VALID: the widened CHECK is implied by the old one, so existing rows need no
    // scan under the ACCESS EXCLUSIVE lock (new writes are still checked, as above)
    const validated = await sql<{ v: boolean }>`
      select convalidated as v from pg_constraint
      where conname in ('conversations_kind_check', 'plugin_install_components_kind_check')`.execute(
      db,
    );
    expect(validated.rows.map((r) => r.v)).toEqual([false, false]);

    await sql`insert into capybara.runs (id, conversation_id, status, agent_version, trigger_account_id)
      values ('rp', 'p1', 'waiting', 1, 'a1'), ('rs', 's1', 'queued', 1, 'a1')`.execute(db);
    const tokens = await sql<{ n: string }>`
      select subagent_tokens_used::text as n from capybara.runs where id = 'rp'`.execute(db);
    expect(tokens.rows[0]?.n).toBe("0");
    await sql`insert into capybara.subagent_dispatches
      (parent_run_id, parent_call_id, parent_conversation_id, step, child_conversation_id, child_run_id)
      values ('rp', 'call-1', 'p1', 0, 's1', 'rs')`.execute(db);
    const resumed = await sql<{ resumed: boolean }>`
      select resumed from capybara.subagent_dispatches where parent_call_id = 'call-1'`.execute(db);
    expect(resumed.rows[0]?.resumed).toBe(false);

    await sql`delete from capybara.conversations where id = 'p1'`.execute(db);
    expect(await count("select count(*)::text as n from capybara.conversations")).toBe(0);
    expect(await count("select count(*)::text as n from capybara.subagent_dispatches")).toBe(0);
  });

  it("agent_template_versions.source_format rejects 'x'", async () => {
    await sql`insert into capybara.agent_templates (id, org_id, name, plugin_name, current_version)
      values ('t1', 'o1', 'code-reviewer', 'superpowers', 1)`.execute(db);
    await sql`insert into capybara.agent_template_versions (template_id, version, definition)
      values ('t1', 1, '{}'::jsonb)`.execute(db);
    const fmt = await sql<{ f: string }>`
      select source_format as f from capybara.agent_template_versions where template_id = 't1'`.execute(
      db,
    );
    expect(fmt.rows[0]?.f).toBe("capybara");
    await expect(
      sql`insert into capybara.agent_template_versions (template_id, version, definition, source_format)
        values ('t1', 2, '{}'::jsonb, 'x')`.execute(db),
    ).rejects.toThrow(/source_format/);
    // every template comes from a plugin
    await expect(
      sql`insert into capybara.agent_templates (id, org_id, name, current_version)
        values ('t0', 'o1', 'no-plugin', 1)`.execute(db),
    ).rejects.toThrow(/plugin_name/);
    // one live template per (org, plugin, name)
    await expect(
      sql`insert into capybara.agent_templates (id, org_id, name, plugin_name, current_version)
        values ('t2', 'o1', 'code-reviewer', 'superpowers', 1)`.execute(db),
    ).rejects.toThrow(/duplicate key/);
    await sql`update capybara.agent_templates set deleted_at = now() where id = 't1'`.execute(db);
    await sql`insert into capybara.agent_templates (id, org_id, name, plugin_name, current_version)
      values ('t2', 'o1', 'code-reviewer', 'superpowers', 1)`.execute(db);
  });

  it("plugin_install_components.kind accepts 'agent_template'", async () => {
    await sql`insert into capybara.catalog_items
      (id, name, package_name, publisher, description, latest_version, created_by)
      values ('00000000-0000-4000-8000-000000000001', 'superpowers', '@x/sp', 'x', 'S',
        '1.0.0', 'a1')`.execute(db);
    await sql`insert into capybara.plugin_installs (id, org_id, item_id, version, status)
      values ('00000000-0000-4000-8000-000000000002', 'o1', '00000000-0000-4000-8000-000000000001',
        '1.0.0', 'installed')`.execute(db);
    await sql`insert into capybara.plugin_install_components (install_id, kind, ref, created)
      values ('00000000-0000-4000-8000-000000000002', 'agent_template', 't2', true)`.execute(db);
    await expect(
      sql`insert into capybara.plugin_install_components (install_id, kind, ref, created)
        values ('00000000-0000-4000-8000-000000000002', 'nope', 'x', true)`.execute(db),
    ).rejects.toThrow(/plugin_install_components_kind_check/);
  });
});
