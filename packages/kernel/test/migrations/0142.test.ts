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
 * 0142_backfill_event_fields.sql (no compatibility before 0.1.0): rows logged before a now-required
 * field existed get it: `compaction_summary.savedTokens` 0, a compaction event's `step` from the
 * run's compaction usage logged after it (else 0), `approval_requested`'s approver fields from the
 * approval row (else null); in the log and in eval case snapshots. Current rows are untouched.
 * Migrates to the migration before it, seeds old rows, runs 0142, then runs it again (idempotent).
 */
const FILE = "0142_backfill_event_fields.sql";

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

const ask = (approvalId: string) => ({
  step: 0,
  callId: "k",
  approvalId,
  toolKey: "Bash",
  expiresAt: "2026-11-09T00:00:00Z",
});
const at = "2026-11-09T00:00:00Z";
const snapshot = {
  version: 1,
  events: [
    {
      seq: 1,
      type: "compaction_summary",
      payload: { coversUpToSeq: 0, text: "s" },
      runId: "r1",
      createdAt: at,
    },
    { seq: 2, type: "approval_requested", payload: ask("ap1"), runId: "r1", createdAt: at },
  ],
};

const payloadOf = async (seq: number) =>
  (
    await sql<{ payload: Record<string, unknown> }>`select payload from capybara.conversation_events
      where conversation_id = 'c1' and seq = ${seq}`.execute(db)
  ).rows[0]?.payload;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
    values ('c1', 'o1', 'ag1', 'a1')`.execute(db);
  await sql`insert into capybara.runs (id, conversation_id, status, agent_version, trigger_account_id)
    values ('r1', 'c1', 'completed', 1, 'a1')`.execute(db);
  await sql`insert into capybara.approvals
    (id, org_id, conversation_id, run_id, call_id, tool_key, spec_hash, requested_for, expires_at)
    values ('ap1', 'o1', 'c1', 'r1', 'k', 'Bash', 'h', 'a1', now())`.execute(db);
  const usage = { step: 3, provider: "p", model: "m", purpose: "compaction" };
  await sql`insert into capybara.conversation_events (conversation_id, seq, type, run_id, payload)
    values
    ('c1', 1, 'compaction_summary', 'r1', '{"coversUpToSeq":0,"text":"s"}'::jsonb),
    ('c1', 2, 'usage', 'r1', ${JSON.stringify(usage)}::jsonb),
    ('c1', 3, 'compaction_failed', 'r1', '{"attempt":1,"reason":"x"}'::jsonb),
    ('c1', 4, 'compaction_summary', 'r1',
      '{"coversUpToSeq":0,"text":"t","savedTokens":5,"step":7}'::jsonb),
    ('c1', 5, 'approval_requested', 'r1', ${JSON.stringify(ask("ap1"))}::jsonb),
    ('c1', 6, 'approval_requested', 'r1', ${JSON.stringify(ask("gone"))}::jsonb),
    ('c1', 7, 'approval_requested', 'r1',
      ${JSON.stringify({ ...ask("ap1"), requestedFor: null, approverRole: "admin" })}::jsonb)`.execute(
    db,
  );
  await sql`insert into capybara.eval_sets (id, org_id, agent_id, name, created_by)
    values ('00000000-0000-0000-0000-000000000001', 'o1', 'ag1', 's', 'a1')`.execute(db);
  await sql`insert into capybara.eval_cases
    (set_id, org_id, source_conversation_id, source_run_id, agent_version, title, snapshot,
     snapshot_bytes, plan_step, plan_run, added_by)
    values ('00000000-0000-0000-0000-000000000001', 'o1', 'c1', 'r1', 1, 't',
      ${JSON.stringify(snapshot)}::jsonb, 1, '{}'::jsonb, '{}'::jsonb, 'a1')`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const expectMigrated = async () => {
  expect(await payloadOf(1)).toEqual({ coversUpToSeq: 0, text: "s", savedTokens: 0, step: 3 });
  expect(await payloadOf(3)).toEqual({ attempt: 1, reason: "x", step: 0 });
  expect(await payloadOf(4)).toEqual({ coversUpToSeq: 0, text: "t", savedTokens: 5, step: 7 });
  expect(await payloadOf(5)).toEqual({ ...ask("ap1"), requestedFor: "a1", approverRole: null });
  expect(await payloadOf(6)).toEqual({ ...ask("gone"), requestedFor: null, approverRole: null });
  expect(await payloadOf(7)).toEqual({ ...ask("ap1"), requestedFor: null, approverRole: "admin" });
  const snap = (
    await sql<{ snapshot: typeof snapshot }>`select snapshot from capybara.eval_cases`.execute(db)
  ).rows[0]?.snapshot;
  expect(snap?.events.map((e) => e.payload)).toEqual([
    { coversUpToSeq: 0, text: "s", savedTokens: 0, step: 0 },
    { ...ask("ap1"), requestedFor: "a1", approverRole: null },
  ]);
};

describe("0142_backfill_event_fields", () => {
  it("fills the now-required fields of older rows and leaves current ones alone", async () => {
    await expectMigrated();
  });

  it("is idempotent", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await db.transaction().execute(async (tx) => {
      await sql`set local search_path to capybara, public`.execute(tx);
      await sql.raw(text).execute(tx);
    });
    await expectMigrated();
  });
});
