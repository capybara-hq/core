import { randomUUID } from "node:crypto";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { ScheduledTasksService } from "../../src/schedules/scheduled-tasks.service.js";
import { ScheduledTaskStore } from "../../src/schedules/store.js";
import type { ScheduledTask } from "../../src/schedules/types.js";
import { UNATTENDED_ASK_ERROR } from "../../src/schedules/unattended.js";
import { SCHEDULE_TOOL_NAMES } from "../../src/tools/builtin-names.js";
import { BuiltinTools } from "../../src/tools/builtins/builtin-tools.js";
import { notYoursText, scheduleWords } from "../../src/tools/builtins/schedules.js";
import { createDecidePolicy } from "../../src/tools/policy.js";
import {
  type BuiltinCallContext,
  type BuiltinTool,
  type CallPolicy,
  type ResolvedTool,
  ToolRegistry,
} from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * The schedule builtins (scheduled tasks spec §11): `ScheduleCreate` / `ScheduleUpdate` are fixed
 * asks whose kernel-rendered card shows the whole task and whose result is exactly the approved
 * input; `here` targets this conversation or its IM direct chat; an unattended run can never
 * create or widen a task; `ScheduleList` / `ScheduleDelete` touch only the person's own tasks.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
const store = new ScheduledTaskStore();

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], extensions: [MODEL_FAKE] },
    ),
  );
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let orgId: string;
let ownerId: string;
let aliceId: string;
let bobId: string;
let owner: Req;
let alice: Req;
let agentId: string;
let definition: AgentDefinition;

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.deployment_settings");
  const accounts = accountsFor(db);
  const mk = async (login: string) =>
    (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  ownerId = await mk("owner");
  aliceId = await mk("alice");
  bobId = await mk("bob");
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  await testMembers(db).add(orgId, bobId, "member", ownerId);
  alice = await session(k, "alice");
  definition = {
    name: "Helper",
    avatarUrl: null,
    instructions: "Be helpful.",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
    modelParams: {},
    fallbackParams: {},
    disabledTools: builtinsOff(...SCHEDULE_TOOL_NAMES, "CurrentTime"),
    toolPolicies: {},
  };
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: definition.name,
        instructions: definition.instructions,
        model: definition.model,
        disabledTools: definition.disabledTools,
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

const svc = () => k.app.get(ScheduledTasksService);
const tool = (name: string): BuiltinTool => {
  const t = k.app
    .get(BuiltinTools)
    .list()
    .find((x) => x.spec.name === name);
  if (!t) throw new Error(`no builtin ${name}`);
  return t;
};
const callCtx = (accountId: string, conversationId: string): BuiltinCallContext => ({
  orgId,
  accountId,
  agentId,
  conversationId,
  callId: randomUUID(),
  signal: new AbortController().signal,
});
const policyOf = async (name: string, input: unknown, accountId: string, conv: string) =>
  (await tool(name).callPolicy?.(input, {
    orgId,
    accountId,
    agentId,
    conversationId: conv,
    runId: null,
  })) as CallPolicy;
const textOf = (r: Awaited<ReturnType<BuiltinTool["run"]>>) =>
  "content" in r ? r.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError) return e.message;
    throw e;
  }
  throw new Error("expected a tool error");
}
const tasksOf = (accountId: string) => store.listForAccount(db, orgId, accountId);
const grantsOf = async (taskId: string) =>
  (await store.listGrants(db, taskId)).map((g) => g.toolKey).sort();

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);

/** A direct chat of `accountId` on a connection of the agent, bound to `conv` and delivered. */
async function seedDm(conv: string, accountId: string): Promise<string> {
  const connectionId = randomUUID();
  await sql`INSERT INTO capybara.channel_connections (id, org_id, plugin, name, agent_id, created_by)
    VALUES (${connectionId}, ${orgId}, 'fake-im', 'Team bot', ${agentId}, ${ownerId})`.execute(raw);
  await sql`INSERT INTO capybara.channel_threads
      (id, connection_id, chat_id, thread_key, account_id, conversation_id)
    VALUES (${randomUUID()}, ${connectionId}, 'chat-dm-1', ${`dm:ext-${accountId.slice(0, 8)}`},
      ${accountId}, ${conv})`.execute(raw);
  await sql`INSERT INTO capybara.channel_deliveries (conversation_id, connection_id, target, last_seq, updated_at)
    VALUES (${conv}, ${connectionId}, ${JSON.stringify({ chatId: "chat-dm-1", chatType: "dm" })}::jsonb,
      0, now())`.execute(raw);
  return connectionId;
}

const dailyTask = (accountId: string, name = "Digest"): Promise<ScheduledTask> =>
  svc().create(orgId, accountId, {
    agentId,
    name,
    prompt: "Summarize yesterday.",
    trigger: { kind: "cron", expr: "0 9 * * *" },
    timeZone: "UTC",
    mode: "new",
    grants: [{ toolKey: "CurrentTime" }],
  });

describe("schedule tools (spec §11)", { timeout: 120_000 }, () => {
  it("ScheduleCreate asks and the created task matches the approved input", async () => {
    await db
      .updateTable("accounts")
      .set({ time_zone: "Asia/Shanghai" })
      .where("id", "=", aliceId)
      .execute();
    const conv = await createConv(alice, orgId, agentId);
    const input = {
      name: "Morning brief",
      prompt: "Summarize the news for me.",
      cron: "0 9 * * 1-5",
      mode: "new",
      approvedTools: ["CurrentTime"],
    };
    await postMessage(alice, orgId, conv, `tool:ScheduleCreate:${JSON.stringify(input)}`);
    const asked = await waitFor(
      async () => ofType(await eventsOf(db, conv), "approval_requested")[0],
      20_000,
      "approval_requested",
    );
    expect(asked.payload.toolKey).toBe("ScheduleCreate");
    const res = await alice({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/approvals/${asked.payload.approvalId}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const approval = (res.json() as { approval: Record<string, unknown> }).approval;
    // only "once", a fixed ask, and the kernel's card: name, schedule with zone, target, tools
    expect(approval.scopes).toEqual(["once"]);
    expect(asked.payload.policy).toBe("fixed");
    expect(approval.summary).toEqual({
      zh:
        "创建定时任务「Morning brief」：每个工作日 09:00（Asia/Shanghai）；" +
        "运行位置：每次运行新建对话；预先批准的工具：CurrentTime",
      en:
        'Create the scheduled task "Morning brief": every weekday at 09:00 (Asia/Shanghai); ' +
        "runs in a new conversation for every run; approved tools: CurrentTime",
    });
    expect(await tasksOf(aliceId)).toEqual([]);
    const ok = await alice({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${asked.payload.approvalId}/decision`,
      payload: { decision: "approve", scope: "once" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
    const result = ofType(await eventsOf(db, conv), "tool_result").at(-1)?.payload;
    expect(result).toMatchObject({ toolKey: "ScheduleCreate", isError: false });
    const [task] = await tasksOf(aliceId);
    expect(task).toMatchObject({
      accountId: aliceId,
      agentId,
      name: "Morning brief",
      prompt: "Summarize the news for me.",
      trigger: { kind: "cron", expr: "0 9 * * 1-5", timeZone: "Asia/Shanghai" },
      mode: "new",
      conversationId: null,
      chat: null,
      status: "active",
    });
    expect(await grantsOf(task?.id ?? "")).toEqual(["CurrentTime"]);
    expect(result?.content).toContain(`id ${task?.id}`);
  });

  it("here in an IM DM creates a chat task", async () => {
    const conv = await createConv(alice, orgId, agentId);
    const connectionId = await seedDm(conv, aliceId);
    const input = {
      name: "Check",
      prompt: "Check the build.",
      runAt: "2099-01-01T15:00",
      mode: "here",
    };
    const p = await policyOf("ScheduleCreate", input, aliceId, conv);
    expect(p.summary?.en).toContain("runs in the direct chat on Team bot");
    expect(p.summary?.zh).toContain("运行位置：Team bot 的私聊");
    const r = await tool("ScheduleCreate").run(input, callCtx(aliceId, conv));
    expect(textOf(r)).toContain("the direct chat on Team bot");
    const [task] = await tasksOf(aliceId);
    expect(task).toMatchObject({
      mode: "chat",
      conversationId: null,
      chat: { connectionId, chatId: "chat-dm-1", chatType: "dm" },
      trigger: { kind: "once", at: "2099-01-01T15:00" },
    });
  });

  it("here in a web conversation creates a conversation task", async () => {
    const conv = await createConv(alice, orgId, agentId);
    const input = {
      name: "Again",
      prompt: "Look at this again.",
      runAt: "2099-01-01T15:00",
      mode: "here",
    };
    const p = await policyOf("ScheduleCreate", input, aliceId, conv);
    expect(p.summary?.en).toContain("runs in this conversation");
    await tool("ScheduleCreate").run(input, callCtx(aliceId, conv));
    const [task] = await tasksOf(aliceId);
    expect(task).toMatchObject({ mode: "conversation", conversationId: conv, chat: null });
    // no run_context yet: the org's zone, else UTC
    expect(task?.trigger.timeZone).toBe("UTC");
  });

  it("an unattended run cannot create a task", async () => {
    const conv = await createConv(alice, orgId, agentId);
    const { tools } = await k.app.get(ToolRegistry).forAgent(orgId, definition);
    const create = tools.find((t) => t.key === "ScheduleCreate") as ResolvedTool;
    const update = tools.find((t) => t.key === "ScheduleUpdate") as ResolvedTool;
    expect(create).toBeDefined();
    // even a task grant for it does not let it through
    const task = await dailyTask(aliceId);
    await store.addGrant(db, task.id, {
      toolKey: "ScheduleCreate",
      specHash: create.specHash,
      connectorId: null,
    });
    const input = { name: "X", prompt: "Y", cron: "0 9 * * *", mode: "new" };
    const decide = createDecidePolicy(db);
    const ctx = async (t: ResolvedTool, unattendedAsk: "fail" | "wait" | null) => ({
      orgId,
      accountId: aliceId,
      agentId,
      conversationId: conv,
      runId: randomUUID(),
      callPolicy: await policyOf(t.key, input, aliceId, conv),
      ...(unattendedAsk !== null && {
        unattended: {
          taskId: task.id,
          taskRunId: randomUUID(),
          trial: false,
          unattendedAsk,
          forbiddenTools: [],
        },
      }),
    });
    expect(await decide(create, definition, await ctx(create, "fail"))).toEqual({
      refused: UNATTENDED_ASK_ERROR("ScheduleCreate"),
      missingGrant: "ScheduleCreate",
    });
    // wait mode and attended runs: a fixed ask, never a grant
    expect(await decide(create, definition, await ctx(create, "wait"))).toMatchObject({
      ask: { toolKey: "ScheduleCreate", policy: "fixed" },
    });
    expect(await decide(create, definition, await ctx(create, null))).toMatchObject({
      ask: { toolKey: "ScheduleCreate", policy: "fixed" },
    });
    // the update of an own task is refused the same way
    const upd = { id: task.id, approvedTools: ["CurrentTime", "ScheduleList"] };
    const updCtx = {
      ...(await ctx(update, "fail")),
      callPolicy: await policyOf("ScheduleUpdate", upd, aliceId, conv),
    };
    expect(await decide(update, definition, updCtx)).toMatchObject({
      refused: UNATTENDED_ASK_ERROR("ScheduleUpdate"),
    });
  });

  it("ScheduleDelete refuses another member's task", async () => {
    const bobs = await dailyTask(bobId, "Bob's digest");
    const mine = await dailyTask(aliceId, "Alice's digest");
    const conv = await createConv(owner, orgId, agentId);
    // the owner is an org admin, and still cannot delete bob's task through the tool
    expect(await refusal(tool("ScheduleDelete").run({ id: bobs.id }, callCtx(ownerId, conv)))).toBe(
      notYoursText(bobs.id),
    );
    expect(await store.getTask(db, orgId, bobs.id)).not.toBeNull();
    const aliceConv = await createConv(alice, orgId, agentId);
    expect(
      await refusal(tool("ScheduleDelete").run({ id: bobs.id }, callCtx(aliceId, aliceConv))),
    ).toBe(notYoursText(bobs.id));
    const r = await tool("ScheduleDelete").run({ id: mine.id }, callCtx(aliceId, aliceConv));
    expect(textOf(r)).toContain('Deleted scheduled task "Alice\'s digest"');
    expect(await store.getTask(db, orgId, mine.id)).toBeNull();
  });

  it("ScheduleUpdate shows the diff and grants exactly the approved list", async () => {
    const task = await dailyTask(aliceId);
    const conv = await createConv(alice, orgId, agentId);
    const input = { id: task.id, cron: "0 10 * * 1", approvedTools: ["ScheduleList"] };
    const p = await policyOf("ScheduleUpdate", input, aliceId, conv);
    expect(p).toMatchObject({ key: "ScheduleUpdate", policy: "ask", remember: false });
    expect(p.summary?.en).toBe(
      'Change the scheduled task "Digest": schedule every day at 09:00 (UTC) → every Monday at ' +
        "10:00 (UTC); approved tools: ScheduleList (adds ScheduleList; removes CurrentTime)",
    );
    expect(p.summary?.zh).toBe(
      "修改定时任务「Digest」：时间 每天 09:00（UTC） → 每周一 10:00（UTC）；" +
        "预先批准的工具：ScheduleList（新增 ScheduleList；移除 CurrentTime）",
    );
    await tool("ScheduleUpdate").run(input, callCtx(aliceId, conv));
    expect(await grantsOf(task.id)).toEqual(["ScheduleList"]);
    expect((await store.getTask(db, orgId, task.id))?.trigger).toEqual({
      kind: "cron",
      expr: "0 10 * * 1",
      timeZone: "UTC",
    });
    // a refused grant rolls the whole change back
    const bad = { id: task.id, name: "Renamed", approvedTools: ["ScheduleCreate"] };
    expect(await refusal(tool("ScheduleUpdate").run(bad, callCtx(aliceId, conv)))).toContain(
      "Remove it from approvedTools",
    );
    expect((await store.getTask(db, orgId, task.id))?.name).toBe("Digest");
    expect(await grantsOf(task.id)).toEqual(["ScheduleList"]);
    // another member's task is denied before anyone is asked
    const bobs = await dailyTask(bobId);
    expect(await policyOf("ScheduleUpdate", { id: bobs.id, name: "Mine" }, aliceId, conv)).toEqual({
      key: "ScheduleUpdate",
      policy: "deny",
      remember: false,
      denyReason: notYoursText(bobs.id),
    });
  });

  it("ScheduleList lists only the person's own tasks", async () => {
    const mine = await dailyTask(aliceId, "Alice's digest");
    await dailyTask(bobId, "Bob's digest");
    const conv = await createConv(alice, orgId, agentId);
    const text = textOf(await tool("ScheduleList").run({}, callCtx(aliceId, conv)));
    expect(text).toContain(`- ${mine.id}: "Alice's digest", every day at 09:00 (UTC), active`);
    expect(text).not.toContain("Bob's digest");
  });

  it("the tools are hidden while the org has scheduled tasks turned off", async () => {
    const before = await k.app.get(ToolRegistry).forAgent(orgId, definition);
    expect(before.tools.map((t) => t.key)).toEqual(
      expect.arrayContaining([...SCHEDULE_TOOL_NAMES]),
    );
    await k.app
      .get(OrgSettingsService)
      .update(orgId, { scheduledTasks: { enabled: false } }, ownerId);
    const after = await k.app.get(ToolRegistry).forAgent(orgId, definition);
    for (const n of SCHEDULE_TOOL_NAMES) expect(after.tools.map((t) => t.key)).not.toContain(n);
    expect(after.unavailable).toEqual([]);
  });

  it("schedules read in words, an unusual cron as its expression", () => {
    expect(scheduleWords({ kind: "cron", expr: "15 * * * *", timeZone: "UTC" }).en).toBe(
      "every hour at minute 15 (UTC)",
    );
    expect(scheduleWords({ kind: "cron", expr: "0 8 1 * *", timeZone: "UTC" }).zh).toBe(
      "每月 1 日 08:00（UTC）",
    );
    expect(scheduleWords({ kind: "cron", expr: "0 8,20 * * *", timeZone: "UTC" }).en).toBe(
      'on the cron schedule "0 8,20 * * *" (UTC)',
    );
  });
});
