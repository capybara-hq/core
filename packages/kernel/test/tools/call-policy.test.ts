import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ContentBlock, ToolSpec } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import type { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { createLogger } from "../../src/log.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import type { ApprovalsService } from "../../src/tools/approvals.service.js";
import type { ToolPipeline, ToolStepContext } from "../../src/tools/pipeline.js";
import {
  type BuiltinHandler,
  type BuiltinTool,
  type ResolvedTool,
  specHash,
} from "../../src/tools/registry.js";
import { eventLogFor, legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { eventsOf } from "../helpers/runs.js";
import { seedConversation } from "../helpers/tool-fixtures.js";
import {
  approvalsFor,
  breakerFor,
  outputsFor,
  pipelineFor,
  questionsFor,
} from "../helpers/tools.js";

/**
 * Per-call policy keys (Platform tool spec §6.2): a builtin's `callPolicy` derives a policy key from
 * the validated input; agent policies, grants and approvals are keyed by it, `remember: false`
 * allows only "once", and an approval binds the exact input it showed.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let eventLog: EventLog;
let approvals: ApprovalsService;
const silent = createLogger("error", { write: () => {} });

const cfg = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});
const config = (): KernelConfig => cfg;

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

// ---- the fake builtin: `{ op }` -> key `Platform:<op>` ----

const SPEC: ToolSpec = {
  name: "Platform",
  description: "Fake platform tool.",
  inputSchema: {
    type: "object",
    properties: { op: { type: "string" }, v: { type: "string" } },
    required: ["op"],
  },
};

// async like the real `Platform` tool's (it reads the actor's facts)
let seen: { input: unknown; rawInput: unknown }[] = [];
/** `x.flip` asks until its precheck starts failing (the state changed while the card waited). */
let flipFails = false;
const callPolicy: NonNullable<BuiltinTool["callPolicy"]> = async (input, ctx) => {
  const op = (input as { op: string }).op;
  const key = `Platform:${op}`;
  switch (op) {
    case "x.raw":
      seen.push({ input, rawInput: ctx.rawInput });
      return { key, policy: "allow", remember: false };
    case "x.read":
      // as the real tool: a read never asks and is not remembered
      return { key, policy: "allow", remember: false };
    case "x.write":
    case "x.personal":
    case "x.other":
      return { key, policy: "ask", remember: true, summary: { zh: `做 ${op}`, en: `Do ${op}` } };
    case "x.org":
      return { key, policy: "ask", remember: false, summary: { zh: "组织写", en: "Org write" } };
    case "x.flip":
      return flipFails
        ? {
            key,
            policy: "deny",
            remember: false,
            denyReason: "Operation x.flip cannot run now: skill.name_exists: Pick another name.",
          }
        : { key, policy: "ask", remember: false, summary: { zh: "翻转", en: "Flip" } };
    case "x.gone":
      return {
        key,
        policy: "deny",
        remember: false,
        denyReason: "Platform operation x.gone is unavailable: no person is present in this run.",
      };
    default:
      return null;
  }
};

const fakeTool: ResolvedTool = {
  key: "Platform",
  source: { kind: "builtin", name: "Platform" },
  spec: SPEC,
  specHash: specHash(SPEC),
  defaultPolicy: "allow",
  callPolicy,
};

let calls: unknown[] = [];
const handler: BuiltinHandler = async (input) => {
  calls.push(input);
  return { content: [{ type: "text", text: `ran ${JSON.stringify(input)}` }] };
};

function pipeline(): ToolPipeline {
  return pipelineFor({
    db,
    eventLog,
    registry: {
      forAgent: async () => ({ tools: [fakeTool], unavailable: [] }),
      findConnector: () => undefined,
      handler: (source) =>
        source.kind === "builtin" && source.name === "Platform" ? handler : undefined,
    },
    credentials: {
      async injection() {
        return { headers: {} };
      },
      async onUnauthorized() {},
    },
    breaker: breakerFor(redis, config),
    outputs: outputsFor(db, config),
    approvals,
    questions: questionsFor(db, eventLog, config),
    config,
    log: silent,
  });
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
  approvals = approvalsFor(db, eventLog, config);
}, 120_000);

afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let seed: Awaited<ReturnType<typeof seedConversation>>;
let runId: string;
let step: number;

beforeEach(async () => {
  calls = [];
  seen = [];
  flipFails = false;
  step = 0;
  await redis.flushdb();
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  seed = await seedConversation(raw);
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${seed.orgId}, ${seed.accountId}, 'member')`.execute(raw);
  runId = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: seed.conversationId,
      status: "running",
      agent_version: 1,
      trigger_account_id: seed.accountId,
      trigger_seq: 0,
    })
    .execute();
});

const stepCtx = (over: Partial<ToolStepContext> = {}): ToolStepContext => ({
  orgId: seed.orgId,
  conversationId: seed.conversationId,
  runId,
  step,
  agentId: seed.agentId,
  agentVersion: 1,
  agent,
  accountId: seed.accountId,
  signal: new AbortController().signal,
  ...over,
});

type Call = { id: string; name: string; input: unknown };

/** A new step whose assistant message holds these calls, then the pipeline runs it. */
async function runStep(calls: Call[], over: Partial<ToolStepContext> = {}) {
  step++;
  const content: ContentBlock[] = calls.map((c) => ({ type: "tool_call", ...c }));
  await eventLog.append(seed.conversationId, [
    {
      type: "assistant_message",
      runId,
      idemKey: assistantIdemKey(runId, step),
      payload: { step, content, stopReason: "tool_use" },
    },
  ]);
  return pipeline().runStep(stepCtx(over));
}

const resultsOf = (evs: ConversationEvent[]) =>
  evs.flatMap((e) => (e.type === "tool_result" ? [e.payload] : []));
const resultOf = async (callId: string) =>
  resultsOf(await eventsOf(db, seed.conversationId)).find((r) => r.callId === callId);
const call = (id: string, op: string, v?: string): Call => ({
  id,
  name: "Platform",
  input: v === undefined ? { op } : { op, v },
});

async function approvalOf(callId: string) {
  return db
    .selectFrom("approvals")
    .selectAll()
    .where("run_id", "=", runId)
    .where("call_id", "=", callId)
    .orderBy("attempt", "desc")
    .executeTakeFirst();
}

async function grantAlways(toolKey: string) {
  await sql`INSERT INTO capybara.tool_grants (org_id, account_id, agent_id, tool_key, spec_hash)
    VALUES (${seed.orgId}, ${seed.accountId}, ${seed.agentId}, ${toolKey}, ${fakeTool.specHash})`.execute(
    raw,
  );
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  return "resolved";
};

describe("per-call policy keys", () => {
  it("an agent policy on Platform:<op> denies that operation only", async () => {
    const denying = { ...agent, toolPolicies: { "Platform:x.write": "deny" as const } };
    const out = await runStep([call("c1", "x.write"), call("c2", "x.read")], { agent: denying });
    expect(out).toEqual({ kind: "done" });
    expect(await resultOf("c1")).toMatchObject({
      isError: true,
      content: "Tool Platform is denied by policy for Platform:x.write.",
    });
    expect(calls).toEqual([{ op: "x.read" }]);
    // x.other is not covered by the x.write deny: it asks
    const asked = await runStep([call("c3", "x.other")], { agent: denying });
    expect(asked.kind).toBe("suspended");
  });

  it("a read (allow, remember:false) never prompts; tightened to ask it asks once-only despite a grant", async () => {
    expect(await runStep([call("c1", "x.read")])).toEqual({ kind: "done" });
    expect(calls).toEqual([{ op: "x.read" }]);
    expect(await approvalOf("c1")).toBeUndefined();
    await grantAlways("Platform:x.read");
    const asking = { ...agent, toolPolicies: { "Platform:x.read": "ask" as const } };
    const out = await runStep([call("c2", "x.read", "again")], { agent: asking });
    expect(out.kind).toBe("suspended");
    expect(await approvalOf("c2")).toMatchObject({
      tool_key: "Platform:x.read",
      status: "pending",
      scopes: ["once"],
    });
    expect(calls).toHaveLength(1);
  });

  it("a policy on the whole tool still applies to every operation", async () => {
    const denying = { ...agent, toolPolicies: { Platform: "deny" as const } };
    await runStep([call("c1", "x.read")], { agent: denying });
    expect(await resultOf("c1")).toMatchObject({ isError: true });
    expect(calls).toEqual([]);
  });

  it("a deny with a reason returns the reason as the tool error", async () => {
    await runStep([call("c1", "x.gone")]);
    expect(await resultOf("c1")).toMatchObject({
      isError: true,
      content: "Platform operation x.gone is unavailable: no person is present in this run.",
    });
    expect(calls).toEqual([]);
  });

  it("a deny is final before the card: no approval is created", async () => {
    flipFails = true;
    expect(await runStep([call("c1", "x.flip")])).toEqual({ kind: "done" });
    expect(await approvalOf("c1")).toBeUndefined();
    expect(await resultOf("c1")).toMatchObject({ isError: true });
  });

  it("an approved call whose policy denies on resume returns the reason and never runs (precheck)", async () => {
    expect((await runStep([call("c1", "x.flip")])).kind).toBe("suspended");
    const row = await approvalOf("c1");
    await approvals.decide(seed.orgId, row?.id ?? "", seed.accountId, {
      decision: "approve",
      scope: "once",
    });
    // the precheck fails by the time the run resumes
    flipFails = true;
    expect(await pipeline().runStep(stepCtx())).toEqual({ kind: "done" });
    expect(await resultOf("c1")).toMatchObject({
      isError: true,
      content: "Operation x.flip cannot run now: skill.name_exists: Pick another name.",
    });
    expect(calls).toEqual([]);
  });

  it("an always grant on Platform:x.personal runs that key without asking, not Platform:x.other", async () => {
    await grantAlways("Platform:x.personal");
    expect(await runStep([call("c1", "x.personal")])).toEqual({ kind: "done" });
    expect(calls).toEqual([{ op: "x.personal" }]);
    const other = await runStep([call("c2", "x.other")]);
    expect(other.kind).toBe("suspended");
    expect(calls).toHaveLength(1);
    // a grant on the bare tool key does not cover operations either
    await grantAlways("Platform");
    await runStep([call("c3", "x.other")]);
    expect((await approvalOf("c3"))?.status).toBe("pending");
  });

  it("approvals and their grants are keyed by the per-call key", async () => {
    const out = await runStep([call("c1", "x.personal")]);
    expect(out.kind).toBe("suspended");
    const row = await approvalOf("c1");
    expect(row).toMatchObject({
      tool_key: "Platform:x.personal",
      summary: { zh: "做 x.personal", en: "Do x.personal" },
      scopes: null,
    });
    const view = await approvals.describe(row?.id ?? "");
    expect(view).toMatchObject({
      toolKey: "Platform:x.personal",
      summary: { zh: "做 x.personal", en: "Do x.personal" },
      scopes: ["once", "session", "always"],
    });
    await approvals.decide(seed.orgId, row?.id ?? "", seed.accountId, {
      decision: "approve",
      scope: "always",
    });
    const grants = await db
      .selectFrom("tool_grants")
      .select("tool_key")
      .where("agent_id", "=", seed.agentId)
      .execute();
    expect(grants).toEqual([{ tool_key: "Platform:x.personal" }]);
    expect(await pipeline().runStep(stepCtx())).toEqual({ kind: "done" });
    // the next call with the same key runs on the grant
    expect(await runStep([call("c2", "x.personal", "again")])).toEqual({ kind: "done" });
    expect(calls).toEqual([{ op: "x.personal" }, { op: "x.personal", v: "again" }]);
  });

  it("remember:false asks even with a grant, offers only once, and refuses session / always", async () => {
    await grantAlways("Platform:x.org");
    const out = await runStep([call("c1", "x.org")]);
    expect(out.kind).toBe("suspended");
    const row = await approvalOf("c1");
    expect(row).toMatchObject({ tool_key: "Platform:x.org", scopes: ["once"] });
    const view = await approvals.describe(row?.id ?? "");
    expect(view?.scopes).toEqual(["once"]);
    expect(view?.summary).toEqual({ zh: "组织写", en: "Org write" });
    const id = row?.id ?? "";
    for (const scope of ["always", "session"] as const) {
      expect(
        await codeOf(
          approvals.decide(seed.orgId, id, seed.accountId, { decision: "approve", scope }),
        ),
      ).toBe("approval.scope_not_allowed");
    }
    expect((await approvalOf("c1"))?.status).toBe("pending");
    const grants = await db
      .selectFrom("conversation_tool_grants")
      .select("tool_key")
      .where("conversation_id", "=", seed.conversationId)
      .execute();
    expect(grants).toEqual([]);
    await approvals.decide(seed.orgId, id, seed.accountId, { decision: "approve", scope: "once" });
    expect(await pipeline().runStep(stepCtx())).toEqual({ kind: "done" });
    expect(calls).toEqual([{ op: "x.org" }]);
  });

  it("an approved approval whose stored input differs from the call is not used: the call asks again", async () => {
    await runStep([call("c1", "x.personal", "shown")]);
    const first = await approvalOf("c1");
    // the stored input no longer matches what the call carries (key order alone does not count)
    await sql`UPDATE capybara.approvals SET status = 'approved', scope = 'once',
      input = ${JSON.stringify({ op: "x.personal", v: "other" })}::jsonb
      WHERE id = ${first?.id ?? ""}`.execute(raw);
    const again = await pipeline().runStep(stepCtx());
    expect(again.kind).toBe("suspended");
    expect(calls).toEqual([]);
    const second = await approvalOf("c1");
    expect(second).toMatchObject({ attempt: 2, status: "pending" });
    expect(second?.input).toEqual({ op: "x.personal", v: "shown" });
    // the same input in another key order is the same input
    await sql`UPDATE capybara.approvals SET status = 'approved', scope = 'once',
      input = ${'{"v": "shown", "op": "x.personal"}'}::jsonb
      WHERE id = ${second?.id ?? ""}`.execute(raw);
    expect(await pipeline().runStep(stepCtx())).toEqual({ kind: "done" });
    expect(calls).toEqual([{ op: "x.personal", v: "shown" }]);
  });

  it("callPolicy gets the resolved input and the raw input with its output references", async () => {
    const saved = await outputsFor(db, config).save({
      orgId: seed.orgId,
      conversationId: seed.conversationId,
      callId: "earlier",
      content: "the archived text",
    });
    const ref = { $output: saved.id };
    await runStep([{ id: "c1", name: "Platform", input: { op: "x.raw", v: ref } }]);
    expect(seen).toEqual([
      { input: { op: "x.raw", v: "the archived text" }, rawInput: { op: "x.raw", v: ref } },
    ]);
    expect(calls).toEqual([{ op: "x.raw", v: "the archived text" }]);
  });

  it("an approval without a callPolicy keeps today's scopes (role escalation: once)", async () => {
    const own = await approvals.request({
      orgId: seed.orgId,
      conversationId: seed.conversationId,
      runId,
      step: 1,
      callId: "plain",
      toolKey: "plugin__probe__gated",
      specHash: "h",
      connectorId: null,
      input: {},
      requestedFor: seed.accountId,
      approverRole: null,
    });
    expect((await approvals.describe(own.id))?.scopes).toEqual(["once", "session", "always"]);
    expect((await approvals.describe(own.id))?.summary).toBeNull();
    const role = await approvals.request({
      orgId: seed.orgId,
      conversationId: seed.conversationId,
      runId,
      step: 1,
      callId: "role",
      toolKey: "plugin__probe__gated",
      specHash: "h",
      connectorId: null,
      input: {},
      requestedFor: null,
      approverRole: "admin",
    });
    expect((await approvals.describe(role.id))?.scopes).toEqual(["once"]);
  });
});
