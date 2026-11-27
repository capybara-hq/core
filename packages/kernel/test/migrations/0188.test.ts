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
 * 0188_automations_rename.sql (collaboration spec §4.1): scheduled tasks become automations. Seeds
 * a database migrated to the file before it with a task, its run and grant, the rows that link to
 * them and every stored value that names the feature, then runs 0188: tables, columns, indexes and
 * constraints carry the new names, stored values read the new names, and the event log is untouched.
 */
const FILE = "0188_automations_rename.sql";

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

const tableExists = async (name: string) =>
  (
    await sql<{ n: number }>`select count(*)::int as n from information_schema.tables
      where table_schema = 'capybara' and table_name = ${name}`.execute(db)
  ).rows[0]?.n === 1;

const col = async (table: string, name: string) =>
  (
    await sql<{ n: number }>`select count(*)::int as n from information_schema.columns
      where table_schema = 'capybara' and table_name = ${table} and column_name = ${name}`.execute(
      db,
    )
  ).rows[0]?.n === 1;

const indexExists = async (name: string) =>
  (
    await sql<{ n: number }>`select count(*)::int as n from pg_indexes
      where schemaname = 'capybara' and indexname = ${name}`.execute(db)
  ).rows[0]?.n === 1;

const constraintsOf = async (table: string) =>
  (
    await sql<{ conname: string }>`select c.conname from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'capybara' and t.relname = ${table} order by c.conname`.execute(db)
  ).rows.map((r) => r.conname);

const policyExists = async (table: string, policy: string) =>
  (
    await sql<{ n: number }>`select count(*)::int as n from pg_policies
      where schemaname = 'capybara' and tablename = ${table} and policyname = ${policy}`.execute(db)
  ).rows[0]?.n === 1;

const one = async <T>(q: ReturnType<typeof sql<T>>) => (await q.execute(db)).rows[0];

const DEFINITION = {
  instructions: "Use ScheduleCreate wisely.",
  disabledTools: [
    { kind: "builtin", name: "ScheduleDelete" },
    { kind: "builtin", name: "Bash" },
    { kind: "plugin", plugin: "p", tools: ["ScheduleCreate"] },
  ],
  toolPolicies: { ScheduleCreate: "deny", Bash: "ask" },
  subagents: {
    inline: [
      {
        name: "helper",
        description: "d",
        instructions: "i",
        tools: ["ScheduleList", "Read"],
        disallowedTools: ["ScheduleUpdate"],
        toolPolicies: { ScheduleTargets: "ask" },
      },
    ],
  },
};

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name, settings) values ('o1', 'o1', 'O',
    ${JSON.stringify({
      theme: { id: null },
      scheduledTasks: { enabled: true, forbiddenTools: ["ScheduleCreate", "Bash", "ScheduleList"] },
    })}::jsonb)`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o2', 'o2', 'O2')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
  await sql`insert into capybara.agent_versions (agent_id, version, definition, created_by)
    values ('ag1', 1, ${JSON.stringify(DEFINITION)}::jsonb, 'a1')`.execute(db);
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id, scheduled_task_id)
    values ('c1', 'o1', 'ag1', 'a1', 't1')`.execute(db);
  await sql`insert into capybara.runs (id, conversation_id, status, agent_version, trigger_account_id,
      trigger_seq, scheduled_task_run_id)
    values ('r1', 'c1', 'completed', 1, 'a1', 1, 'tr1')`.execute(db);
  await sql`insert into capybara.scheduled_tasks (id, org_id, account_id, agent_id, name, prompt,
      trigger, mode, next_run_at)
    values ('t1', 'o1', 'a1', 'ag1', 'T', 'P',
      '{"kind":"cron","expr":"0 9 * * *","timeZone":"UTC"}'::jsonb, 'new', now())`.execute(db);
  await sql`insert into capybara.scheduled_task_runs (id, task_id, org_id, scheduled_for)
    values ('tr1', 't1', 'o1', '2026-11-11T09:00:00Z')`.execute(db);
  await sql`insert into capybara.scheduled_task_grants (task_id, tool_key, spec_hash)
    values ('t1', 'ScheduleUpdate', 'h1'), ('t1', 'Bash', 'h2')`.execute(db);
  await sql`insert into capybara.tool_grants (org_id, account_id, agent_id, tool_key, spec_hash)
    values ('o1', 'a1', 'ag1', 'ScheduleCreate', 'h')`.execute(db);
  await sql`insert into capybara.conversation_tool_grants (conversation_id, tool_key, spec_hash)
    values ('c1', 'ScheduleDelete', 'h')`.execute(db);
  await sql`insert into capybara.push_preferences (account_id, category, enabled)
    values ('a1', 'schedules', false), ('a1', 'tasks', true)`.execute(db);
  await sql`insert into capybara.audit_events (actor_account_id, org_id, action, target, detail)
    values ('a1', 'o1', 'schedule.created', 't1', '{}'::jsonb),
      ('a1', 'o1', 'schedule.grants_changed', 't1', '{}'::jsonb),
      ('a1', 'o1', 'agent.created', 'ag1', '{}'::jsonb)`.execute(db);
  await sql`insert into capybara.outbox (queue, job_name, job_id, data, org_id)
    values
      ('cap-kernel-maintenance', 'sched-fire', 'sched-fire-tr1', '{"taskRunId":"tr1"}'::jsonb, 'o1'),
      ('cap-kernel-maintenance', 'sched-settle', 'sched-settle-tr1-unfired',
        '{"taskRunId":"tr1","unfired":true}'::jsonb, 'o1'),
      ('cap-push-deliver', 'push-fanout', 'push-fanout-sched-tr1',
        '{"eventId":"sched-tr1","source":{"kind":"schedule","taskRunId":"tr1"}}'::jsonb, 'o1'),
      ('cap-push-deliver', 'push-deliver', 'push-sched-tr1-reg1',
        '{"eventId":"sched-tr1","registrationId":"reg1","accountId":"a1","message":{}}'::jsonb, 'o1'),
      ('cap-push-deliver', 'push-fanout', 'push-fanout-conv-c1-3',
        '{"eventId":"conv-c1-3","source":{"kind":"conversation","conversationId":"c1","seq":3}}'::jsonb,
        'o1')`.execute(db);
  // the event log keeps the frozen marker names
  await sql`insert into capybara.conversation_events (conversation_id, seq, type, payload)
    values ('c1', 1, 'user_message',
      '{"text":"P","schedule":{"taskId":"t1","taskRunId":"tr1"},"tool":"ScheduleCreate"}'::jsonb)`.execute(
    db,
  );
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0188_automations_rename", () => {
  it("renames the tables, their link columns and the columns that point at them", async () => {
    expect(await tableExists("automations")).toBe(true);
    expect(await tableExists("automation_runs")).toBe(true);
    expect(await tableExists("automation_grants")).toBe(true);
    expect(await tableExists("scheduled_tasks")).toBe(false);
    expect(await tableExists("scheduled_task_runs")).toBe(false);
    expect(await tableExists("scheduled_task_grants")).toBe(false);
    expect(await col("automation_runs", "automation_id")).toBe(true);
    expect(await col("automation_runs", "task_id")).toBe(false);
    expect(await col("automation_grants", "automation_id")).toBe(true);
    expect(await col("runs", "automation_run_id")).toBe(true);
    expect(await col("runs", "scheduled_task_run_id")).toBe(false);
    expect(await col("conversations", "automation_id")).toBe(true);
    expect(await col("conversations", "scheduled_task_id")).toBe(false);
    // the queue marker column carries the frozen marker and keeps its name
    expect(await col("conversation_queue", "schedule")).toBe(true);
    // rows survive with their links
    expect(
      await one(sql<{ automation_id: string }>`select automation_id from capybara.automation_runs`),
    ).toEqual({ automation_id: "t1" });
    expect(
      await one(sql<{ automation_id: string }>`select automation_id from capybara.conversations`),
    ).toEqual({ automation_id: "t1" });
    expect(
      await one(sql<{ automation_run_id: string }>`select automation_run_id from capybara.runs`),
    ).toEqual({ automation_run_id: "tr1" });
  });

  it("renames the indexes and constraints", async () => {
    for (const name of [
      "automations_pkey",
      "automations_due_idx",
      "automations_account_idx",
      "automation_runs_pkey",
      "automation_runs_tick_uq",
      "automation_runs_pending_idx",
      "automation_runs_automation_idx",
      "automation_runs_fired_idx",
      "automation_grants_pkey",
      "conversations_automation_idx",
    ]) {
      expect(await indexExists(name), name).toBe(true);
    }
    expect(await indexExists("scheduled_task_runs_tick_uq")).toBe(false);
    expect(await indexExists("conversations_scheduled_task_idx")).toBe(false);
    expect(await constraintsOf("automations")).toEqual([
      "automations_mode_check",
      "automations_org_id_fkey",
      "automations_pause_reason_check",
      "automations_pkey",
      "automations_status_check",
    ]);
    expect(await constraintsOf("automation_runs")).toEqual([
      "automation_runs_automation_id_fkey",
      "automation_runs_org_id_fkey",
      "automation_runs_pkey",
      "automation_runs_skip_reason_check",
      "automation_runs_status_check",
    ]);
    expect(await constraintsOf("automation_grants")).toEqual([
      "automation_grants_automation_id_fkey",
      "automation_grants_pkey",
    ]);
  });

  it("keeps the RLS policies on the renamed tables that have org_id", async () => {
    expect(await policyExists("automations", "org_scope")).toBe(true);
    expect(await policyExists("automation_runs", "org_scope")).toBe(true);
    // a child table without org_id gets no policy (RLS spec §6), like before the rename
    expect(await col("automation_grants", "org_id")).toBe(false);
  });

  it("rewrites the push category, its CHECK and the stored rows", async () => {
    const rows = (
      await sql<{
        category: string;
        enabled: boolean;
      }>`select category, enabled from capybara.push_preferences order by category`.execute(db)
    ).rows;
    expect(rows).toEqual([
      { category: "automations", enabled: false },
      { category: "tasks", enabled: true },
    ]);
    await expect(
      sql`insert into capybara.push_preferences (account_id, category, enabled)
        values ('a1', 'schedules', true)`.execute(db),
    ).rejects.toThrow(/check/);
  });

  it("moves the org settings group to `automations` with the tool keys renamed", async () => {
    const o1 = await one(sql<{ settings: Record<string, unknown> }>`select settings
      from capybara.orgs where id = 'o1'`);
    expect(o1?.settings).toEqual({
      theme: { id: null },
      automations: {
        enabled: true,
        forbiddenTools: ["AutomationCreate", "Bash", "AutomationList"],
      },
    });
    const o2 = await one(sql<{ settings: Record<string, unknown> }>`select settings
      from capybara.orgs where id = 'o2'`);
    expect(o2?.settings).toEqual({});
  });

  it("renames the audit actions", async () => {
    const rows = (
      await sql<{
        action: string;
      }>`select action from capybara.audit_events order by action`.execute(db)
    ).rows.map((r) => r.action);
    expect(rows).toEqual(["agent.created", "automation.created", "automation.grants_changed"]);
  });

  it("renames the tool keys in grants and agent definitions", async () => {
    const grants = (
      await sql<{ tool_key: string }>`select tool_key from capybara.automation_grants
        order by tool_key`.execute(db)
    ).rows.map((r) => r.tool_key);
    expect(grants).toEqual(["AutomationUpdate", "Bash"]);
    expect(await one(sql`select tool_key from capybara.tool_grants`)).toEqual({
      tool_key: "AutomationCreate",
    });
    expect(await one(sql`select tool_key from capybara.conversation_tool_grants`)).toEqual({
      tool_key: "AutomationDelete",
    });
    const def = await one(sql<{ definition: unknown }>`select definition
      from capybara.agent_versions`);
    expect(def?.definition).toEqual({
      // prose is never rewritten
      instructions: "Use ScheduleCreate wisely.",
      disabledTools: [
        { kind: "builtin", name: "AutomationDelete" },
        { kind: "builtin", name: "Bash" },
        // an extension's tool of the same name is not a builtin
        { kind: "plugin", plugin: "p", tools: ["ScheduleCreate"] },
      ],
      toolPolicies: { AutomationCreate: "deny", Bash: "ask" },
      subagents: {
        inline: [
          {
            name: "helper",
            description: "d",
            instructions: "i",
            tools: ["AutomationList", "Read"],
            disallowedTools: ["AutomationUpdate"],
            toolPolicies: { AutomationTargets: "ask" },
          },
        ],
      },
    });
  });

  it("renames pending outbox jobs, their ids and the push source", async () => {
    const rows = (
      await sql<{
        job_name: string;
        job_id: string;
        data: unknown;
      }>`select job_name, job_id, data from capybara.outbox order by id`.execute(db)
    ).rows;
    expect(rows).toEqual([
      { job_name: "automation-fire", job_id: "automation-fire-tr1", data: { taskRunId: "tr1" } },
      {
        job_name: "automation-settle",
        job_id: "automation-settle-tr1-unfired",
        data: { taskRunId: "tr1", unfired: true },
      },
      {
        job_name: "push-fanout",
        job_id: "push-fanout-automation-tr1",
        data: { eventId: "automation-tr1", source: { kind: "automation", taskRunId: "tr1" } },
      },
      {
        job_name: "push-deliver",
        job_id: "push-automation-tr1-reg1",
        data: { eventId: "automation-tr1", registrationId: "reg1", accountId: "a1", message: {} },
      },
      {
        job_name: "push-fanout",
        job_id: "push-fanout-conv-c1-3",
        data: {
          eventId: "conv-c1-3",
          source: { kind: "conversation", conversationId: "c1", seq: 3 },
        },
      },
    ]);
  });

  it("never rewrites the event log", async () => {
    expect(await one(sql`select payload from capybara.conversation_events`)).toEqual({
      payload: { text: "P", schedule: { taskId: "t1", taskRunId: "tr1" }, tool: "ScheduleCreate" },
    });
  });

  it("0188 is idempotent", async () => {
    const snapshot = async () => ({
      settings: (await one(sql`select settings from capybara.orgs where id = 'o1'`)) as unknown,
      outbox: (
        await sql`select job_name, job_id, data from capybara.outbox order by id`.execute(db)
      ).rows,
      def: (await one(sql`select definition from capybara.agent_versions`)) as unknown,
      audit: (await sql`select action from capybara.audit_events order by action`.execute(db)).rows,
      constraints: await constraintsOf("automation_runs"),
    });
    const before = await snapshot();
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql.raw(`set search_path to capybara; ${text}`).execute(db);
    expect(await snapshot()).toEqual(before);
  });
});
