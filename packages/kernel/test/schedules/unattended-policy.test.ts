import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  Connector,
  ConnectorOpenArgs,
  ContentBlock,
  ToolHandler,
  ToolResult,
  ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import type { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { assistantIdemKey, modelCallIdemKey } from "../../src/runtime/model-call.js";
import { type ScheduledTaskInsert, ScheduledTaskStore } from "../../src/schedules/store.js";
import {
  UNATTENDED_ASK_ERROR,
  UNATTENDED_CONNECTION_ERROR,
  UNATTENDED_QUESTION_ERROR,
} from "../../src/schedules/unattended.js";
import type { ApprovalsService } from "../../src/tools/approvals.service.js";
import { type ConnectorAuth, CredentialMissing } from "../../src/tools/credentials.js";
import type { ToolPipeline, ToolStepContext } from "../../src/tools/pipeline.js";
import { type BuiltinHandler, type ResolvedTool, specHash } from "../../src/tools/registry.js";
import { eventLogFor, legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { eventsOf } from "../helpers/runs.js";
import { seedConnector, seedConversation } from "../helpers/tool-fixtures.js";
import {
  approvalsFor,
  breakerFor,
  outputsFor,
  type PipelineTestDeps,
  pipelineFor,
  questionsFor,
} from "../helpers/tools.js";

/**
 * Scheduled tasks spec §7 (Task 7): the policy of unattended runs (task grants, `unattendedAsk`,
 * `forbiddenTools`, `SkillWrite`, the other waits for a person) and trial runs, whose approvals
 * become task grants. Runs the real pipeline with the default policy (`createDecidePolicy`).
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let eventLog: EventLog;
const silent = createLogger("error", { write: () => {} });
const store = new ScheduledTaskStore();

const base = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});
const config = (): KernelConfig => base;

const agent: AgentDefinition = {
  name: "Helper",
  avatarUrl: null,
  instructions: "Be helpful.",
  model: { provider: "stub", model: "s-1" },
  fallback: null,
  modelParams: {},
  fallbackParams: {},
  disabledTools: builtinsOff(),
  toolPolicies: {},
};

const spec = (name: string, extra: Partial<ToolSpec> = {}): ToolSpec => ({
  name,
  description: `${name} tool.`,
  inputSchema: { type: "object" },
  ...extra,
});

function pluginTool(
  name: string,
  policy: ResolvedTool["defaultPolicy"],
  extra: Partial<ToolSpec> = {},
  requiredRole?: ResolvedTool["requiredRole"],
): ResolvedTool {
  const s = spec(name, extra);
  return {
    key: `plugin__probe__${name}`,
    source: { kind: "plugin", plugin: "probe", name },
    spec: s,
    specHash: specHash(s),
    defaultPolicy: policy,
    ...(requiredRole !== undefined && { requiredRole }),
  };
}

function builtinTool(name: string, policy: ResolvedTool["defaultPolicy"]): ResolvedTool {
  const s = spec(name);
  return {
    key: name,
    source: { kind: "builtin", name },
    spec: s,
    specHash: specHash(s),
    defaultPolicy: policy,
  };
}

function appTool(slug: string, connectorId: string, name: string): ResolvedTool {
  const s = spec(name);
  return {
    key: `mcp__${slug}__${name}`,
    source: { kind: "connector", connectorId, name },
    spec: s,
    specHash: specHash(s),
    defaultPolicy: "allow",
  };
}

async function seedAppTool(connectorId: string, name: string): Promise<void> {
  const s = spec(name);
  await sql`INSERT INTO capybara.connector_tools (connector_id, name, spec, spec_hash, status, default_policy)
    VALUES (${connectorId}, ${name}, ${JSON.stringify(s)}::jsonb, ${specHash(s)}, 'enabled', 'allow')`.execute(
    raw,
  );
}

const GATED = pluginTool("gated", "ask");
const BANNED = pluginTool("banned", "deny");
const FIXED = pluginTool("fixed", "ask", { annotations: { requiresUserInteraction: true } });
const ADMIN = pluginTool("admin", "ask", {}, "admin");
const SKILL_WRITE = builtinTool("SkillWrite", "allow");
const ASK_USER = builtinTool("AskUserQuestion", "allow");

let calls: string[] = [];
const ran =
  (name: string): ToolHandler =>
  async () => {
    calls.push(name);
    return { content: [{ type: "text", text: `${name} ran` }] };
  };
const handlers: Record<string, ToolHandler> = {
  plugin__probe__gated: ran("gated"),
  plugin__probe__banned: ran("banned"),
  plugin__probe__fixed: ran("fixed"),
  plugin__probe__admin: ran("admin"),
  plugin__probe__form: async () => {
    calls.push("form");
    return {
      kind: "input_required",
      form: { title: "t", fields: [{ key: "a", label: "A", schema: { type: "string" } }] },
    };
  },
};
const builtinHandlers: Record<string, BuiltinHandler> = {
  SkillWrite: async () => {
    calls.push("SkillWrite");
    return { content: [{ type: "text", text: "skill written" }] };
  },
  AskUserQuestion: async () => {
    calls.push("AskUserQuestion");
    return {
      kind: "input_required",
      form: { title: "q", fields: [{ key: "q0", label: "Q?", schema: { type: "string" } }] },
    };
  },
};

let connCall: (args: ConnectorOpenArgs) => Promise<ToolResult>;
const testConnector: Connector = {
  kind: "test",
  endpointSchema: z.object({}),
  async open(args) {
    return {
      async listTools() {
        return [];
      },
      async callTool() {
        calls.push("connector");
        await args.auth();
        return connCall(args);
      },
      async close() {},
    };
  },
};

let resolved: ResolvedTool[] = [];
/** The approvals the pipeline asks through and the tests decide on. */
let approvals: ApprovalsService;

function pipeline(): ToolPipeline {
  const deps: PipelineTestDeps = {
    db,
    eventLog,
    registry: {
      forAgent: async () => ({ tools: resolved, unavailable: [], hidden: [], toolSearch: false }),
      findConnector: (kind: string) => (kind === "test" ? testConnector : undefined),
      handler: (source) =>
        source.kind === "plugin"
          ? handlers[`plugin__${source.plugin}__${source.name}`]
          : source.kind === "builtin"
            ? builtinHandlers[source.name]
            : undefined,
    },
    credentials: {
      async injection(_orgId: string, connectorId: string, auth: ConnectorAuth) {
        if (auth.type === "none") return { headers: {} };
        throw new CredentialMissing(connectorId, auth.ownership);
      },
      async onUnauthorized() {},
    },
    breaker: breakerFor(redis, config),
    outputs: outputsFor(db, config),
    approvals,
    questions: questionsFor(db, eventLog, config),
    config,
    log: silent,
    // what OrgToolSwitches.isToolOff reads: the org's `enabled = false` rows
    switches: {
      isToolOff: async (orgId, plugin, tool) =>
        (await db
          .selectFrom("org_tool_switches")
          .select("tool")
          .where("org_id", "=", orgId)
          .where("plugin", "=", plugin)
          .where("tool", "=", tool)
          .where("enabled", "=", false)
          .executeTakeFirst()) !== undefined,
    },
  };
  return pipelineFor(deps);
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 10);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  eventLog = eventLogFor(db, createBus(redis, sub, "kernel"));
}, 120_000);

afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let seed: Awaited<ReturnType<typeof seedConversation>>;
let runId: string;
let taskId: string;
let taskRunId: string;

const taskRow = (): ScheduledTaskInsert => ({
  id: taskId,
  orgId: seed.orgId,
  accountId: seed.accountId,
  agentId: seed.agentId,
  name: "Daily digest",
  prompt: "Summarize.",
  trigger: { kind: "cron", expr: "0 9 * * *", timeZone: "UTC" },
  mode: "conversation",
  conversationId: seed.conversationId,
  chat: null,
  model: null,
  effort: null,
  deviceId: null,
  status: "active",
  nextRunAt: null,
  jitterSeconds: 0,
  expiresAt: null,
});

/** The run of `conversationId` serving `taskRunId` (null: a person's run). */
async function insertRun(
  id: string,
  conversationId: string,
  servedTaskRun: string | null,
  status: "running" | "completed" = "running",
) {
  await db
    .insertInto("runs")
    .values({
      id,
      conversation_id: conversationId,
      status,
      agent_version: 1,
      trigger_account_id: seed.accountId,
      trigger_seq: 1,
      scheduled_task_run_id: servedTaskRun,
    })
    .execute();
}

/** A task, its task run (trial or not) and the run serving it. */
async function seedTaskRun(trial: boolean): Promise<void> {
  taskId = randomUUID();
  taskRunId = randomUUID();
  await store.insertTask(db, taskRow());
  await store.insertRun(db, {
    id: taskRunId,
    taskId,
    orgId: seed.orgId,
    scheduledFor: new Date(),
    trial,
    status: "running",
  });
  // the task's message is the run's boundary (seq 1 = trigger_seq)
  await eventLog.append(seed.conversationId, [
    {
      type: "user_message",
      idemKey: `user_message:${randomUUID()}`,
      payload: {
        authorAccountId: seed.accountId,
        content: [{ type: "text", text: "Summarize." }],
        schedule: {
          taskId,
          taskRunId,
          scheduledFor: new Date().toISOString(),
          trial,
          taskName: "Daily digest",
          localTime: "09:00",
        },
      },
    },
  ]);
  await insertRun(runId, seed.conversationId, taskRunId);
}

async function setScheduleSettings(s: Record<string, unknown>): Promise<void> {
  await sql`UPDATE capybara.orgs SET settings = jsonb_set(settings, '{scheduledTasks}', ${JSON.stringify(s)}::jsonb)
    WHERE id = ${seed.orgId}`.execute(raw);
}

async function setMember(accountId: string, role: string) {
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${seed.orgId}, ${accountId}, ${role})
    ON CONFLICT (org_id, account_id) DO UPDATE SET role = EXCLUDED.role`.execute(raw);
}

const grant = (tool: ResolvedTool, hash = tool.specHash) =>
  store.addGrant(db, taskId, {
    toolKey: tool.key,
    specHash: hash,
    connectorId: tool.source.kind === "connector" ? tool.source.connectorId : null,
  });

beforeEach(async () => {
  calls = [];
  connCall = async () => ({ content: [{ type: "text", text: "connector ran" }] });
  await redis.flushdb();
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  seed = await seedConversation(raw);
  await setMember(seed.accountId, "member");
  runId = randomUUID();
  approvals = approvalsFor(db, eventLog, config);
  resolved = [GATED, BANNED, FIXED, ADMIN, SKILL_WRITE, ASK_USER, pluginTool("form", "allow")];
});

const stepCtx = (over: Partial<ToolStepContext> = {}): ToolStepContext => ({
  orgId: seed.orgId,
  conversationId: seed.conversationId,
  runId,
  step: 1,
  agentId: seed.agentId,
  agentVersion: 1,
  agent,
  accountId: seed.accountId,
  signal: new AbortController().signal,
  ...over,
});

type Call = { id: string; name: string; input: unknown };

async function assistant(
  conversationId: string,
  run: string,
  list: Call[],
  step = 1,
): Promise<void> {
  const content: ContentBlock[] = list.map((c) => ({ type: "tool_call", ...c }));
  await eventLog.append(conversationId, [
    {
      type: "assistant_message",
      runId: run,
      idemKey: assistantIdemKey(run, step),
      payload: { step, content, stopReason: "tool_use" },
    },
  ]);
}

async function runCalls(list: Call[], over: Partial<ToolStepContext> = {}) {
  await assistant(over.conversationId ?? seed.conversationId, over.runId ?? runId, list);
  const outcome = await pipeline().runStep(stepCtx(over));
  return { outcome, evs: await eventsOf(db, over.conversationId ?? seed.conversationId) };
}

/**
 * A `model_call` of the run at `step` that absorbed up to `absorbedUpToSeq` (only the fields the
 * policy reads; written directly, bumping `last_seq` like the event log).
 */
async function modelCall(step: number, absorbedUpToSeq: number): Promise<void> {
  await sql`WITH s AS (
      UPDATE capybara.conversations SET last_seq = last_seq + 1 WHERE id = ${seed.conversationId}
      RETURNING last_seq)
    INSERT INTO capybara.conversation_events (conversation_id, seq, type, run_id, idem_key, payload)
    SELECT ${seed.conversationId}, s.last_seq, 'model_call', ${runId},
      ${modelCallIdemKey(runId, step, 1)},
      ${JSON.stringify({ step, attempt: 1, request: { absorbedUpToSeq } })}::jsonb
    FROM s`.execute(raw);
}

const resultsOf = (evs: ConversationEvent[]) =>
  evs.flatMap((e) => (e.type === "tool_result" ? [e.payload] : []));

const missingGrants = async () => (await store.updateRun(db, taskRunId, {}))?.missingGrants ?? null;

const approvalRows = () => db.selectFrom("approvals").selectAll().execute();

describe("unattended runs (spec §7)", () => {
  beforeEach(async () => {
    await seedTaskRun(false);
  });

  it("granted ask runs", async () => {
    await grant(GATED);
    const { outcome, evs } = await runCalls([{ id: "c1", name: GATED.key, input: {} }]);
    expect(outcome).toEqual({ kind: "done" });
    expect(calls).toEqual(["gated"]);
    expect(resultsOf(evs)[0]).toMatchObject({ isError: false, content: "gated ran" });
    expect(await approvalRows()).toEqual([]);
    expect(await missingGrants()).toEqual([]);
  });

  it("ungranted ask fails and records missing_grants", async () => {
    const { outcome, evs } = await runCalls([
      { id: "c1", name: GATED.key, input: {} },
      { id: "c2", name: GATED.key, input: {} },
      { id: "c3", name: ADMIN.key, input: {} },
    ]);
    expect(outcome).toEqual({ kind: "done" });
    expect(calls).toEqual([]);
    expect(resultsOf(evs).map((r) => [r.isError, r.content])).toEqual([
      [true, UNATTENDED_ASK_ERROR(GATED.key)],
      [true, UNATTENDED_ASK_ERROR(GATED.key)],
      [true, UNATTENDED_ASK_ERROR(ADMIN.key)],
    ]);
    expect(UNATTENDED_ASK_ERROR("X")).toBe(
      "This scheduled run cannot ask for approval; the task's owner can add X to the task's approved tools.",
    );
    // appended once per key, in order
    expect(await missingGrants()).toEqual([GATED.key, ADMIN.key]);
    expect(await approvalRows()).toEqual([]);
  });

  it("wait mode creates an approval for the creator", async () => {
    await setScheduleSettings({ unattendedAsk: "wait" });
    const { outcome } = await runCalls([{ id: "c1", name: GATED.key, input: {} }]);
    expect(outcome).toMatchObject({ kind: "suspended", waitingFor: { kind: "approval" } });
    const rows = await approvalRows();
    expect(rows.map((r) => [r.tool_key, r.requested_for, r.approver_role])).toEqual([
      [GATED.key, seed.accountId, null],
    ]);
    expect(await missingGrants()).toEqual([]);
  });

  it("forbidden tool is denied even with a grant", async () => {
    await setScheduleSettings({ forbiddenTools: [GATED.key] });
    await grant(GATED);
    const { evs } = await runCalls([{ id: "c1", name: GATED.key, input: {} }]);
    expect(calls).toEqual([]);
    expect(resultsOf(evs)[0]).toMatchObject({
      isError: true,
      content: `Tool ${GATED.key} is denied by policy.`,
    });
    // a deny is not a missing grant: the owner cannot add it
    expect(await missingGrants()).toEqual([]);
  });

  it("a deny is never lifted by a grant", async () => {
    await grant(BANNED);
    const { evs } = await runCalls([{ id: "c1", name: BANNED.key, input: {} }]);
    expect(calls).toEqual([]);
    expect(resultsOf(evs)[0]).toMatchObject({ isError: true });
  });

  it("SkillWrite on a private agent is refused", async () => {
    await sql`UPDATE capybara.agents SET visibility = 'private' WHERE id = ${seed.agentId}`.execute(
      raw,
    );
    await sql`INSERT INTO capybara.agent_versions (agent_id, version, definition, created_by)
      VALUES (${seed.agentId}, 1, ${JSON.stringify(agent)}::jsonb, ${seed.accountId})`.execute(raw);
    // attended, the same call runs without asking on a private agent (R4)
    const attendedRun = randomUUID();
    await insertRun(attendedRun, seed.conversationId, null, "completed");
    await runCalls([{ id: "a1", name: "SkillWrite", input: {} }], { runId: attendedRun });
    expect(calls).toEqual(["SkillWrite"]);
    calls = [];
    // unattended: an ask outside the grants, even with a grant
    await grant(SKILL_WRITE);
    const { evs } = await runCalls([{ id: "c1", name: "SkillWrite", input: {} }]);
    expect(calls).toEqual([]);
    expect(resultsOf(evs).at(-1)).toMatchObject({
      isError: true,
      content: UNATTENDED_ASK_ERROR("SkillWrite"),
    });
  });

  it("fixed-ask tool is never covered", async () => {
    await grant(FIXED);
    const { evs } = await runCalls([{ id: "c1", name: FIXED.key, input: {} }]);
    expect(calls).toEqual([]);
    expect(resultsOf(evs)[0]).toMatchObject({
      isError: true,
      content: UNATTENDED_ASK_ERROR(FIXED.key),
    });
    expect(await missingGrants()).toEqual([FIXED.key]);
  });

  it("stale spec hash is a missing grant", async () => {
    await grant(GATED, "an-older-definition");
    const { evs } = await runCalls([{ id: "c1", name: GATED.key, input: {} }]);
    expect(calls).toEqual([]);
    expect(resultsOf(evs)[0]).toMatchObject({ content: UNATTENDED_ASK_ERROR(GATED.key) });
    expect(await missingGrants()).toEqual([GATED.key]);
  });

  it("a grant never overrides an org admin's tool switch-off", async () => {
    await grant(GATED);
    await sql`INSERT INTO capybara.org_tool_switches (org_id, plugin, tool, enabled, updated_by)
      VALUES (${seed.orgId}, 'probe', 'gated', false, ${seed.accountId})`.execute(raw);
    const { evs } = await runCalls([{ id: "c1", name: GATED.key, input: {} }]);
    expect(calls).toEqual([]);
    expect(resultsOf(evs)[0]).toMatchObject({ isError: true });
    expect(resultsOf(evs)[0]?.content).toContain("turned off");
  });

  it("sub-agent of a scheduled run uses the task's grants", async () => {
    await grant(GATED);
    const child = randomUUID();
    const childRun = randomUUID();
    await sql`INSERT INTO capybara.conversations
        (id, org_id, agent_id, account_id, kind, parent_conversation_id, subagent_depth)
      VALUES (${child}, ${seed.orgId}, ${seed.agentId}, ${seed.accountId}, 'subagent',
        ${seed.conversationId}, 1)`.execute(raw);
    // inherited lineage (Task 4): the child run serves the same task run
    await insertRun(childRun, child, taskRunId);
    const parent = {
      conversationId: seed.conversationId,
      runId,
      callId: "p1",
      depth: 0,
      rootConversationId: seed.conversationId,
    };
    const { evs } = await runCalls(
      [
        { id: "c1", name: GATED.key, input: {} },
        { id: "c2", name: ADMIN.key, input: {} },
      ],
      { conversationId: child, runId: childRun, parent },
    );
    expect(calls).toEqual(["gated"]);
    expect(resultsOf(evs).map((r) => r.content)).toEqual([
      "gated ran",
      UNATTENDED_ASK_ERROR(ADMIN.key),
    ]);
    // recorded on the root task run
    expect(await missingGrants()).toEqual([ADMIN.key]);
  });

  it("AskUserQuestion does not wait", async () => {
    expect(UNATTENDED_QUESTION_ERROR).toBe(
      "No one is present in this scheduled run; decide with the information you have, or state the open question in your final answer.",
    );
    const { outcome, evs } = await runCalls([
      { id: "c1", name: "AskUserQuestion", input: {} },
      { id: "c2", name: "plugin__probe__form", input: {} },
    ]);
    expect(outcome).toEqual({ kind: "done" });
    expect(resultsOf(evs).map((r) => [r.isError, r.content])).toEqual([
      [true, UNATTENDED_QUESTION_ERROR],
      [true, UNATTENDED_QUESTION_ERROR],
    ]);
    expect(calls).toEqual(["form"]);
    expect(await db.selectFrom("questions").selectAll().execute()).toEqual([]);
    expect(await missingGrants()).toEqual([]);
  });

  it("AskUserQuestion waits as today in wait mode", async () => {
    await setScheduleSettings({ unattendedAsk: "wait" });
    const { outcome } = await runCalls([{ id: "c1", name: "AskUserQuestion", input: {} }]);
    expect(outcome).toMatchObject({ kind: "suspended", waitingFor: { kind: "input" } });
  });

  it("missing personal connection is recorded", async () => {
    const priv = await seedConnector(raw, seed.orgId, seed.accountId, {
      slug: "priv",
      name: "Private Docs",
      auth: { type: "bearer", ownership: "personal" },
    });
    await seedAppTool(priv, "read");
    resolved = [appTool("priv", priv, "read")];
    const { evs } = await runCalls([{ id: "c1", name: "mcp__priv__read", input: {} }]);
    expect(evs.filter((e) => e.type === "connection_required")).toEqual([]);
    expect(resultsOf(evs)[0]).toMatchObject({
      isError: true,
      content: UNATTENDED_CONNECTION_ERROR("Private Docs"),
    });
    expect(await missingGrants()).toEqual(["connection:priv"]);
  });

  it("a connector elicitation is declined", async () => {
    const docs = await seedConnector(raw, seed.orgId, seed.accountId, { slug: "docs" });
    await seedAppTool(docs, "read");
    resolved = [appTool("docs", docs, "read")];
    let answer: unknown;
    connCall = async (args) => {
      answer = await args.onElicit?.({
        mode: "form",
        message: "Which?",
        requestedSchema: { type: "object", properties: { a: { type: "string" } } },
      });
      return { content: [{ type: "text", text: "went on" }] };
    };
    const { outcome, evs } = await runCalls([{ id: "c1", name: "mcp__docs__read", input: {} }]);
    expect(outcome).toEqual({ kind: "done" });
    expect(answer).toEqual({ action: "decline" });
    expect(resultsOf(evs)[0]?.content).toContain("went on");
    expect(await db.selectFrom("questions").selectAll().execute()).toEqual([]);
  });

  it("a person's message the run absorbed makes the rest of the run attended", async () => {
    // a person writes into the conversation while the scheduled run is in progress
    const [msg] = await eventLog.append(seed.conversationId, [
      {
        type: "user_message",
        idemKey: `user_message:${randomUUID()}`,
        payload: {
          authorAccountId: seed.accountId,
          content: [{ type: "text", text: "stop and ask me first" }],
        },
      },
    ]);
    const seqOf = (msg as ConversationEvent).seq;
    // not absorbed yet: still unattended
    const first = await runCalls([{ id: "c1", name: GATED.key, input: {} }]);
    expect(resultsOf(first.evs)[0]).toMatchObject({ content: UNATTENDED_ASK_ERROR(GATED.key) });
    // the run's next model call absorbed it
    await modelCall(2, seqOf);
    await assistant(seed.conversationId, runId, [{ id: "c2", name: GATED.key, input: {} }], 2);
    const outcome = await pipeline().runStep(stepCtx({ step: 2 }));
    expect(outcome).toMatchObject({ kind: "suspended", waitingFor: { kind: "approval" } });
    expect((await approvalRows()).map((r) => r.requested_for)).toEqual([seed.accountId]);
  });

  it("a scheduled message absorbed later keeps the run unattended", async () => {
    const [msg] = await eventLog.append(seed.conversationId, [
      {
        type: "user_message",
        idemKey: `user_message:${randomUUID()}`,
        payload: {
          authorAccountId: seed.accountId,
          content: [{ type: "text", text: "next tick" }],
          schedule: {
            taskId,
            taskRunId: randomUUID(),
            scheduledFor: new Date().toISOString(),
            trial: false,
            taskName: "Daily digest",
            localTime: "09:00",
          },
        },
      },
    ]);
    await modelCall(1, (msg as ConversationEvent).seq);
    const { evs } = await runCalls([{ id: "c1", name: GATED.key, input: {} }]);
    expect(resultsOf(evs)[0]).toMatchObject({ content: UNATTENDED_ASK_ERROR(GATED.key) });
  });
});

describe("trial runs (spec §7)", () => {
  beforeEach(async () => {
    await seedTaskRun(true);
  });

  const askAndDecide = async (
    tool: ResolvedTool,
    decider: string,
    scope: "once" | "session" | "always",
  ) => {
    const { outcome } = await runCalls([{ id: "c1", name: tool.key, input: {} }]);
    expect(outcome).toMatchObject({ kind: "suspended", waitingFor: { kind: "approval" } });
    const [row] = await approvalRows();
    await approvals.decide(seed.orgId, (row as { id: string }).id, decider, {
      decision: "approve",
      scope,
    });
  };

  it("trial approvals become task grants", async () => {
    // attended: the ask reaches the creator, not a refusal
    await askAndDecide(GATED, seed.accountId, "once");
    expect(await store.listGrants(db, taskId)).toEqual([
      { toolKey: GATED.key, specHash: GATED.specHash, connectorId: null },
    ]);
    expect(await missingGrants()).toEqual([]);
  });

  it("a trial approval with scope always is kept too", async () => {
    await askAndDecide(GATED, seed.accountId, "always");
    expect((await store.listGrants(db, taskId)).map((g) => g.toolKey)).toEqual([GATED.key]);
  });

  it("role-escalated trial approval is not kept", async () => {
    const admin = randomUUID();
    await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${admin}, 'A')`.execute(raw);
    await setMember(admin, "admin");
    await askAndDecide(ADMIN, admin, "once");
    expect(await store.listGrants(db, taskId)).toEqual([]);
  });

  it("a forbidden tool approved in a trial is not kept", async () => {
    await setScheduleSettings({ forbiddenTools: [GATED.key] });
    await askAndDecide(GATED, seed.accountId, "once");
    expect(await store.listGrants(db, taskId)).toEqual([]);
  });

  it("an attended run's approval adds no task grant", async () => {
    const other = randomUUID();
    await db.updateTable("runs").set({ status: "completed" }).where("id", "=", runId).execute();
    await insertRun(other, seed.conversationId, null);
    runId = other;
    await askAndDecide(GATED, seed.accountId, "once");
    expect(await store.listGrants(db, taskId)).toEqual([]);
  });
});
