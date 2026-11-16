import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ConversationEvent, ConversationEventSchema } from "../../src/conversations/events.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { previousToolSet, toolSetChange } from "../../src/runtime/context/tool-changes.js";
import { AGENT, MODEL } from "../runtime/context/fixtures.js";

/**
 * 0143_backfill_model_call_fields.sql (no compatibility before 0.1.0): `model_call` rows logged
 * before `absorbedUpToSeq` / `tools` / `params` / `mediaBudgetBytes` existed get the values the old
 * readers assumed (the call's own seq, no tools marked as omitted, no params, the default media
 * budget), in the log and in eval case snapshots; current rows are untouched, and a conversation
 * holding such a row resumes without error. Migrates to the migration before it, seeds old rows,
 * runs 0143, then runs it again (idempotent).
 */
const FILE = "0143_backfill_model_call_fields.sql";

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

const base = { fromSeq: 1, toSeq: 1, summarySeq: null, systemHash: "h", reminderSeqs: [] };
const call = (request: Record<string, unknown>) => ({
  step: 1,
  attempt: 1,
  provider: "model-fake",
  model: "fake-1",
  fallback: false,
  request: { ...base, maxOutputTokens: 4096, ...request },
});
const media = [{ attachmentId: "00000000-0000-4000-8000-000000000001", outcome: "bytes" }];
const current = {
  absorbedUpToSeq: 4,
  tools: [{ key: "Bash", specHash: "h1" }],
  params: { effort: "low" },
};
const user = (text: string) => ({ content: [{ type: "text", text }], authorAccountId: "a1" });
const reply = (text: string) => ({
  step: 1,
  content: [{ type: "text", text }],
  stopReason: "end_turn",
});
const at = "2026-10-17T00:00:00Z";
const snapshot = {
  version: 1,
  events: [
    { seq: 2, type: "model_call", payload: call({}), runId: "r1", createdAt: at },
    { seq: 5, type: "model_call", payload: call(current), runId: "r1", createdAt: at },
  ],
};

const rows = async () =>
  (
    await sql<{
      seq: string;
      type: string;
      run_id: string | null;
      payload: Record<string, unknown>;
      created_at: Date;
    }>`select seq, type, run_id, payload, created_at from capybara.conversation_events
      where conversation_id = 'c1' order by seq`.execute(db)
  ).rows;
const payloadOf = async (seq: number) => (await rows()).find((r) => Number(r.seq) === seq)?.payload;

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
  await sql`insert into capybara.conversation_events (conversation_id, seq, type, run_id, payload)
    values
    ('c1', 1, 'user_message', null, ${JSON.stringify(user("hi"))}::jsonb),
    ('c1', 2, 'model_call', 'r1', ${JSON.stringify(call({}))}::jsonb),
    ('c1', 3, 'assistant_message', 'r1', ${JSON.stringify(reply("hello"))}::jsonb),
    ('c1', 4, 'user_message', null, ${JSON.stringify(user("again"))}::jsonb),
    ('c1', 6, 'model_call', 'r1',
      ${JSON.stringify(call({ ...current, absorbedUpToSeq: 1, media }))}::jsonb),
    ('c1', 7, 'model_call', 'r1',
      ${JSON.stringify(call({ ...current, media, mediaBudgetBytes: 1000 }))}::jsonb)`.execute(db);
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

const old = { absorbedUpToSeq: 2, tools: [], toolsOmitted: true, params: {} };

const expectMigrated = async () => {
  expect(await payloadOf(2)).toEqual(call(old));
  expect(await payloadOf(6)).toEqual(
    call({ ...current, absorbedUpToSeq: 1, media, mediaBudgetBytes: 20_971_520 }),
  );
  expect(await payloadOf(7)).toEqual(call({ ...current, media, mediaBudgetBytes: 1000 }));
  const snap = (
    await sql<{ snapshot: typeof snapshot }>`select snapshot from capybara.eval_cases`.execute(db)
  ).rows[0]?.snapshot;
  expect(snap?.events.map((e) => e.payload)).toEqual([call(old), call(current)]);
};

describe("0143_backfill_model_call_fields", () => {
  it("fills the now-required request fields of older rows and leaves current ones alone", async () => {
    await expectMigrated();
    for (const r of await rows()) {
      const parsed = ConversationEventSchema.safeParse({ type: r.type, payload: r.payload });
      expect(parsed.success, `seq ${r.seq}`).toBe(true);
    }
  });

  it("a conversation whose call predates the fields resumes: no tool notice, messages in place", async () => {
    const events = (await rows())
      .filter((r) => Number(r.seq) <= 4)
      .map(
        (r) =>
          ({
            conversationId: "c1",
            seq: Number(r.seq),
            type: r.type,
            runId: r.run_id,
            payload: r.payload,
            createdAt: r.created_at,
          }) as ConversationEvent,
      );
    // the old reader skipped a call without recorded tools; the omitted set is skipped the same way
    expect(previousToolSet(events)).toBeNull();
    expect(toolSetChange(events, ["Bash"])).toBeNull();
    const { request } = buildModelRequest({
      events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 2,
      absorbedUpToSeq: 4,
    });
    expect(request.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
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
