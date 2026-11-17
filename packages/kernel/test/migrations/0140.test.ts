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
 * 0140_retire_history_forms.sql (no compatibility before 0.1.0): the history-only forms of agent
 * definitions (an enabled `tools` list, `skills.orgSkills` / `skills.pinned`) go from agent
 * versions, `subagent_started` events and eval snapshots; a follow-up narrowing gets both lists
 * (a missing one from the frozen definition); template versions lose `selectedSkills`. Migrates to
 * the migration before it, seeds old rows, runs 0140, then runs it again (idempotent).
 */
const FILE = "0140_retire_history_forms.sql";

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

const base = { name: "A", model: { provider: "p", model: "m" } };
const offTool = { kind: "builtin", name: "Bash" };
const offSkill = { kind: "skill", skillId: "s9" };
/** A frozen definition from before tools and skills were on by default. */
const oldFrozen = {
  ...base,
  tools: [{ kind: "builtin", name: "Read" }],
  disabledTools: [offTool],
  skills: { orgSkills: ["s1"], pinned: ["s1"], writePolicy: "ask" },
};
const currentFrozen = {
  ...base,
  disabledTools: [offTool],
  skills: { writePolicy: "ask" },
};
// an old narrowing: the enabled `tools` list and `skills` of the time, no lists of its own
const oldNarrowing = { tools: ["Read"], skills: { orgSkills: ["s1"] } };
const doneNarrowing = { disabledTools: [offTool], disabledSkills: [] };
const fullNarrowing = { disabledTools: [], disabledSkills: [offSkill] };
const task = (narrowed: unknown) => ({
  content: [{ type: "text", text: "go" }],
  authorAccountId: "a1",
  dispatch: { parentConversationId: "p", parentRunId: "r", callId: "k", narrowed },
});
const at = "2026-11-09T00:00:00Z";
const snapshot = {
  version: 1,
  definitions: { "1": { ...base, tools: [], skills: { pinned: ["s2"] } } },
  subagent: { definition: oldFrozen, preamble: "p" },
  events: [
    {
      seq: 1,
      type: "subagent_started",
      payload: { definition: oldFrozen },
      runId: null,
      createdAt: at,
    },
    { seq: 2, type: "user_message", payload: task(oldNarrowing), runId: null, createdAt: at },
    { seq: 3, type: "run_completed", payload: {}, runId: "r2", createdAt: at },
  ],
};

const payloadOf = async (conv: string, seq: number) =>
  (
    await sql<{ payload: Record<string, unknown> }>`select payload from capybara.conversation_events
      where conversation_id = ${conv} and seq = ${seq}`.execute(db)
  ).rows[0]?.payload;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 2)`.execute(db);
  await sql`insert into capybara.agent_versions (agent_id, version, definition, created_by) values
    ('ag1', 1, ${JSON.stringify({ ...base, tools: [], skills: { orgSkills: ["s1"] } })}::jsonb, 'a1'),
    ('ag1', 2, ${JSON.stringify(currentFrozen)}::jsonb, 'a1')`.execute(db);
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
    values ('c1', 'o1', 'ag1', 'a1'), ('c2', 'o1', 'ag1', 'a1')`.execute(db);
  // c1: an old frozen definition with an old follow-up, a half-old one and a current one
  await sql`insert into capybara.conversation_events (conversation_id, seq, type, payload) values
    ('c1', 1, 'subagent_started', ${JSON.stringify({ definition: oldFrozen })}::jsonb),
    ('c1', 2, 'user_message', ${JSON.stringify(task(oldNarrowing))}::jsonb),
    ('c1', 3, 'user_message', ${JSON.stringify(task({ disabledTools: [] }))}::jsonb),
    ('c1', 4, 'user_message', ${JSON.stringify(task(fullNarrowing))}::jsonb),
    ('c2', 1, 'subagent_started', ${JSON.stringify({ definition: currentFrozen })}::jsonb),
    ('c2', 2, 'user_message', ${JSON.stringify(task(doneNarrowing))}::jsonb)`.execute(db);
  await sql`insert into capybara.eval_sets (id, org_id, agent_id, name, created_by)
    values ('00000000-0000-0000-0000-000000000001', 'o1', 'ag1', 's', 'a1')`.execute(db);
  await sql`insert into capybara.eval_cases
    (set_id, org_id, source_conversation_id, source_run_id, agent_version, title, snapshot,
     snapshot_bytes, plan_step, plan_run, added_by)
    values ('00000000-0000-0000-0000-000000000001', 'o1', 'c1', 'r2', 1, 't',
      ${JSON.stringify(snapshot)}::jsonb, 1, '{}'::jsonb, '{}'::jsonb, 'a1')`.execute(db);
  const template = { name: "t", description: "d", instructions: "i", selectedSkills: ["x"] };
  await sql`insert into capybara.agent_templates
    (id, org_id, name, plugin_name, current_version) values ('t1', 'o1', 't', 'pl', 1)`.execute(db);
  await sql`insert into capybara.agent_template_versions (template_id, version, definition)
    values ('t1', 1, ${JSON.stringify(template)}::jsonb)`.execute(db);
  await sql`insert into capybara.platform_agent_templates
    (id, plugin_name, name, current_version) values ('pt1', 'pl', 't', 1)`.execute(db);
  await sql`insert into capybara.platform_agent_template_versions
    (template_id, version, definition) values ('pt1', 1, ${JSON.stringify(template)}::jsonb)`.execute(
    db,
  );
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const expectMigrated = async () => {
  const versions = await sql<{ version: number; definition: unknown }>`select version, definition
    from capybara.agent_versions where agent_id = 'ag1' order by version`.execute(db);
  expect(versions.rows).toEqual([
    { version: 1, definition: base },
    { version: 2, definition: currentFrozen },
  ]);

  expect(await payloadOf("c1", 1)).toEqual({ definition: currentFrozen });
  // missing lists come from the frozen definition (no disabledSkills there: none)
  expect(await payloadOf("c1", 2)).toEqual(task({ disabledTools: [offTool], disabledSkills: [] }));
  expect(await payloadOf("c1", 3)).toEqual(task({ disabledTools: [], disabledSkills: [] }));
  expect(await payloadOf("c1", 4)).toEqual(task(fullNarrowing));
  expect(await payloadOf("c2", 1)).toEqual({ definition: currentFrozen });
  expect(await payloadOf("c2", 2)).toEqual(task(doneNarrowing));

  const snap = (
    await sql<{ snapshot: typeof snapshot }>`select snapshot from capybara.eval_cases`.execute(db)
  ).rows[0]?.snapshot;
  expect(snap).toEqual({
    ...snapshot,
    definitions: { "1": base },
    subagent: { definition: currentFrozen, preamble: "p" },
    events: [
      { ...snapshot.events[0], payload: { definition: currentFrozen } },
      {
        ...snapshot.events[1],
        payload: task({ disabledTools: [offTool], disabledSkills: [] }),
      },
      snapshot.events[2],
    ],
  });

  const templates = await sql<{ definition: unknown }>`
    select definition from capybara.agent_template_versions
    union all select definition from capybara.platform_agent_template_versions`.execute(db);
  expect(templates.rows.map((r) => r.definition)).toEqual([
    { name: "t", description: "d", instructions: "i" },
    { name: "t", description: "d", instructions: "i" },
  ]);
};

describe("0140_retire_history_forms", () => {
  it("rewrites the history-only forms in versions, the log, snapshots and templates", async () => {
    await expectMigrated();
  });

  it("is idempotent", async () => {
    const sqlText = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await db.transaction().execute(async (tx) => {
      await sql`set local search_path to capybara, public`.execute(tx);
      await sql.raw(sqlText).execute(tx);
    });
    await expectMigrated();
  });
});
