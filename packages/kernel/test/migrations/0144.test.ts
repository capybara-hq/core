import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDefinition, normalizeStoredDefinition } from "../../src/agents/definition.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { readSnapshot } from "../../src/evals/snapshot.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { childRunDefinition, narrowFollowUp } from "../../src/runtime/subagents/definition.js";
import { decide } from "../../src/tools/policy.js";
import { AGENT } from "../runtime/context/fixtures.js";

/**
 * 0144_retire_frozen_definition_keys.sql (no compatibility before 0.1.0): release-candidate tool
 * keys in sub-agent definitions frozen at dispatch (`subagent_started` in the log) and in eval case
 * snapshots (`definitions`, `subagent.definition`, embedded `subagent_started` events) take their
 * current keys with the holding org, as 0139 did for agent versions. A frozen deny on an rc key
 * still denies the tool on a follow-up. Migrates to the migration before it, seeds old rows, runs
 * 0144, then runs it again (idempotent).
 */
const FILE = "0144_retire_frozen_definition_keys.sql";

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

const inline = {
  name: "reader",
  description: "Reads.",
  instructions: "Read.",
  tools: ["sandbox_read", "todo__list", "Grep"],
  disallowedTools: ["sandbox_write"],
};
/** A frozen definition holding rc keys: builtin names and an extension's `todo__<tool>`. */
const frozenOld = {
  ...AGENT,
  toolPolicies: { sandbox_bash: "deny", todo__write: "ask", Glob: "ask" },
  subagents: { inline: [inline] },
};
const frozenNew = {
  ...AGENT,
  toolPolicies: { Bash: "deny", plugin__todo__write: "ask", Glob: "ask" },
  subagents: {
    inline: [
      {
        ...inline,
        tools: ["Read", "plugin__todo__list", "Grep"],
        disallowedTools: ["Write"],
      },
    ],
  },
};
const started = (definition: unknown) => ({
  parent: { conversationId: "p1", runId: "pr1", callId: "call1", step: 1 },
  agentType: "general-purpose",
  template: { source: "general" },
  definition,
  preamble: "You are a sub-agent.",
  maxSteps: 0,
});
const at = "2026-10-17T00:00:00Z";
const snapshotOf = (definition: unknown) => ({
  version: 1,
  definitions: { "1": definition },
  subagent: { definition, preamble: "You are a sub-agent." },
  events: [
    { seq: 1, type: "subagent_started", payload: started(definition), runId: null, createdAt: at },
    { seq: 2, type: "user_message", payload: { content: [] }, runId: null, createdAt: at },
  ],
});

const startedPayload = async () =>
  (
    await sql<{ payload: { definition: AgentDefinition } }>`select payload
      from capybara.conversation_events where conversation_id = 'c1' and seq = 1`.execute(db)
  ).rows[0]?.payload;
const snapshotRow = async () =>
  (await sql<{ snapshot: unknown }>`select snapshot from capybara.eval_cases`.execute(db)).rows[0]
    ?.snapshot;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  // the deployment has an extension named `todo` (an rc key `todo__write` was its tool)
  await sql`insert into capybara.extension_name_owners (name, package_name)
    values ('todo', '@example/plugin-todo')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
    values ('c1', 'o1', 'ag1', 'a1')`.execute(db);
  await sql`insert into capybara.conversation_events (conversation_id, seq, type, run_id, payload)
    values ('c1', 1, 'subagent_started', null,
      ${JSON.stringify(started(frozenOld))}::jsonb)`.execute(db);
  await sql`insert into capybara.eval_sets (id, org_id, agent_id, name, created_by)
    values ('00000000-0000-0000-0000-000000000001', 'o1', 'ag1', 's', 'a1')`.execute(db);
  await sql`insert into capybara.eval_cases
    (set_id, org_id, source_conversation_id, source_run_id, agent_version, title, snapshot,
     snapshot_bytes, plan_step, plan_run, added_by)
    values ('00000000-0000-0000-0000-000000000001', 'o1', 'c1', 'r1', 1, 't',
      ${JSON.stringify(snapshotOf(frozenOld))}::jsonb, 1, '{}'::jsonb, '{}'::jsonb, 'a1')`.execute(
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
  expect(await startedPayload()).toEqual(started(frozenNew));
  expect(await snapshotRow()).toEqual(snapshotOf(frozenNew));
};

describe("0144_retire_frozen_definition_keys", () => {
  it("rewrites rc keys in frozen sub-agent definitions of the log and of eval snapshots", async () => {
    await expectMigrated();
    const snap = readSnapshot(await snapshotRow());
    expect(snap.subagent?.definition.toolPolicies).toEqual(frozenNew.toolPolicies);
  });

  it("a frozen deny on an rc key still denies the tool on a follow-up", async () => {
    const frozen = normalizeStoredDefinition((await startedPayload())?.definition);
    // the follow-up's narrowing against the current version, as the dispatch records it
    const agent = childRunDefinition(frozen, narrowFollowUp(frozen, AGENT));
    const policy = decide({
      connectorDefault: "allow",
      agentOverride: agent.toolPolicies.Bash as "ask" | "deny" | undefined,
      fixedAsk: false,
      grant: "always",
    });
    expect(policy).toBe("deny");
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
