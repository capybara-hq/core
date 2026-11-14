import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeDm as dm,
  type FakeChannelServer,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMMAND_ASK_TEXT_MAX_CHARS,
  type ConversationEvent,
} from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { Waits } from "../../src/runtime/waits.js";
import { REVIEW_SYSTEM_PROMPT } from "../../src/sandbox/review/index.js";
import { ScheduledTaskFirer } from "../../src/schedules/fire.js";
import { SCHED_SCAN_JOB } from "../../src/schedules/job-ids.js";
import { type ScheduledTaskInsert, ScheduledTaskStore } from "../../src/schedules/store.js";
import type { TaskRun } from "../../src/schedules/types.js";
import { scriptRules } from "../fixtures/plugins/model-script/index.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
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
 * Auto mode spec §5.1, §5.4: the command review in the tool pipeline. A call is reviewed after
 * argument validation and the tool policy, before the plugin hooks and `tool_call_started`; a deny
 * ends it, an ask parks the run on a `command` approval (attended) or is a deny at once
 * (unattended), and the result carries the decision. The device is the fake sandbox (real /bin/sh
 * in a temporary directory); the model is `model-fake` (`tool:<key>:<json>` calls the tool).
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);
const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const MODEL_SCRIPT = fileURLToPath(
  new URL("../fixtures/plugins/model-script/index.ts", import.meta.url),
);
const HOOKS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/hooks-probe/src/index.ts", import.meta.url),
);
const SOURCE = "chan-mini:t1";
const PUSH = { command: "git push origin main", description: "Push the branch" };

let pgc: TestContainer;
let rd: TestContainer;
let im: FakeChannelServer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
let owner: Req;
let ownerId: string;
let otherId: string;
let orgId: string;
let agentId: string;
let taskAgentId: string;
let connId: string;
const store = new ScheduledTaskStore();

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer({ dedupeSends: false });
  root = await mkdtemp(join(tmpdir(), "cap-review-pipeline-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE, CHAN_MINI, HOOKS_PROBE],
        extensionConfig: { "sandbox-fake": { root } },
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 10_000 },
      },
    ),
  );
  // the tests fire scheduled runs themselves: the worker's scan would race them
  k.app.get(SchedulerRegistry).getCronJob(SCHED_SCAN_JOB).stop();
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "X" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, otherId, "member", ownerId);
  const created = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Use the device.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins(
          ["Bash", "Write", "Edit"].map((name) => ({ kind: "builtin" as const, name })),
        ),
      },
      visibility: "org",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  agentId = (created.json() as { agent: { id: string } }).agent.id;
  // a second agent whose model is scripted: a scheduled task's message carries its schedule
  // header before the prompt, which `model-fake`'s `tool:` directive does not accept
  const taskAgent = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Scheduled coder",
        instructions: "Use the device.",
        model: { provider: "model-script", model: "script-1" },
        disabledTools: onlyBuiltins([
          { kind: "builtin", name: "Bash" },
          { kind: "builtin", name: "Write" },
        ]),
      },
      visibility: "org",
    },
  });
  expect(taskAgent.statusCode, taskAgent.body).toBe(201);
  taskAgentId = (taskAgent.json() as { agent: { id: string } }).agent.id;
  // the IM side: the owner's identity and a connected channel (the DM thread is made by a message)
  await sql`INSERT INTO capybara.identities (source, external_id, account_id)
    VALUES (${SOURCE}, 'u-owner', ${ownerId})`.execute(raw);
  const enabled = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
    payload: { enabled: true },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  const channel = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/channels`,
    payload: {
      plugin: "chan-mini",
      name: "Bot",
      agentId,
      config: { platformUrl: im.url, appId: "cli_1", appSecret: "app-secret-1234567" },
    },
  });
  expect(channel.statusCode, channel.body).toBe(201);
  connId = (channel.json() as { channel: { id: string } }).channel.id;
  await waitFor(async () => im.active(connId).length === 1, 10_000, "long connection");
});

afterAll(async () => {
  await k?.close();
  await im?.stop();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>;
type ApprovalRequested = Extract<ConversationEvent, { type: "approval_requested" }>;

const results = async (conv: string): Promise<ToolResult[]> =>
  (await eventsOf(db, conv)).filter((e): e is ToolResult => e.type === "tool_result");

/** Posts one tool call and waits for the run's terminal event (the call allowed or denied). */
async function call(conv: string, key: string, input: unknown, n: number): Promise<ToolResult> {
  await postMessage(owner, orgId, conv, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, conv, n, 30_000);
  const r = (await results(conv)).at(-1);
  expect(r?.payload.toolKey).toBe(key);
  return r as ToolResult;
}

/** The call's pending `command` approval (waits until it exists). */
async function pendingCommandAsk(conv: string) {
  return waitFor(
    async () =>
      db
        .selectFrom("approvals")
        .select(["id", "detail", "scopes", "tool_key"])
        .where("conversation_id", "=", conv)
        .where("kind", "=", "command")
        .where("status", "=", "pending")
        .executeTakeFirst(),
    30_000,
    "the command ask",
  );
}

const waitRunWaiting = (conv: string) =>
  waitFor(
    async () =>
      (
        await db
          .selectFrom("runs")
          .select("status")
          .where("conversation_id", "=", conv)
          .executeTakeFirst()
      )?.status === "waiting",
    15_000,
    "run waiting",
  );

const decide = (id: string, payload: Record<string, unknown>, req: Req = owner) =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`, payload });

const conversationOfTaskRun = async (taskId: string): Promise<string> => {
  const r = await waitFor(
    async () =>
      db
        .selectFrom("conversations")
        .select("id")
        .where("scheduled_task_id", "=", taskId)
        .executeTakeFirst(),
    30_000,
    "the task conversation",
  );
  return r.id;
};

/**
 * Inserts an active scheduled task with a due run, scripts the first reply of its prompt to call
 * `toolCalls`, fires the run and waits for its terminal event.
 */
async function fireScheduled(
  prompt: string,
  toolCalls: { name: string; input: Record<string, unknown> }[],
): Promise<{ terminal: ConversationEvent[]; conversationId: string }> {
  const task = await store.insertTask(db, {
    id: randomUUID(),
    orgId,
    accountId: ownerId,
    agentId: taskAgentId,
    name: prompt,
    prompt,
    trigger: { kind: "cron", expr: "*/5 * * * *", timeZone: "UTC" },
    mode: "new",
    conversationId: null,
    chat: null,
    model: null,
    effort: null,
    deviceId: null,
    status: "active",
    nextRunAt: new Date(Date.now() + 86_400_000),
    jitterSeconds: 0,
    expiresAt: null,
  } satisfies ScheduledTaskInsert);
  const run = await store.insertRun(db, {
    id: randomUUID(),
    taskId: task.id,
    orgId,
    scheduledFor: new Date(),
    trial: false,
  });
  if (!run) throw new Error("tick taken");
  scriptRules([{ when: { lastUserIncludes: prompt, assistantTurns: 0 }, reply: { toolCalls } }]);
  await k.app.get(ScheduledTaskFirer).fire(run.id);
  const conv = await conversationOfTaskRun(task.id);
  const terminal = await waitFor(
    async () => {
      const e = await eventsOf(db, conv);
      return e.some((x) => x.type === "run_finished" || x.type === "run_failed") ? e : null;
    },
    30_000,
    "the scheduled run ended",
  );
  scriptRules([]);
  return { terminal, conversationId: conv };
}

/**
 * The unattended ask turned deny: no card, no approval row in PG, the reason in the result, the run
 * finishes. The `approvals` table is checked too: the absent event alone would pass on a change
 * that wrote the row without emitting the event.
 */
async function expectUnattendedDeny(
  conversationId: string,
  terminal: ConversationEvent[],
  rule: string,
  kind: "command" | "write" = "command",
): Promise<Extract<ConversationEvent, { type: "tool_result" }>> {
  expect(terminal.filter((e) => e.type === "approval_requested")).toEqual([]);
  const rows = await db
    .selectFrom("approvals")
    .select("id")
    .where("conversation_id", "=", conversationId)
    .execute();
  expect(rows, "the unattended deny created no approval row").toEqual([]);
  expect(terminal.some((e) => e.type === "tool_call_started")).toBe(false);
  expect(terminal.some((e) => e.type === "run_finished")).toBe(true);
  const r = terminal.find(
    (e): e is Extract<ConversationEvent, { type: "tool_result" }> => e.type === "tool_result",
  );
  expect(r, "the call's result").toBeDefined();
  expect(r?.payload.isError).toBe(true);
  expect(r?.payload.content).toContain(`This ${kind} needs approval`);
  expect(r?.payload.content).toContain("no one can approve it now");
  expect(r?.payload.review).toMatchObject({ decision: "deny", by: "rule", rule });
  return r as Extract<ConversationEvent, { type: "tool_result" }>;
}

describe("the command review in the pipeline", () => {
  it("an allowed command runs and its result records the rule's decision", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const r = await call(conv, "Bash", { command: "echo hi", description: "Greet" }, 1);
    expect(r.payload.isError).toBe(false);
    expect(r.payload.content).toContain("hi");
    expect(r.payload.review).toMatchObject({ decision: "allow", by: "rule", rule: "allow.read" });
    const rows = await db
      .selectFrom("approvals")
      .select("id")
      .where("conversation_id", "=", conv)
      .execute();
    expect(rows).toEqual([]);
  });

  it("a deny ends the call before it starts, whatever the mode and approvals", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const r = await call(conv, "Bash", { command: "rm -rf /", description: "Clean up" }, 1);
    expect(r.payload.isError).toBe(true);
    expect(r.payload.content).toContain("Command blocked by review:");
    expect(r.payload.review).toMatchObject({
      decision: "deny",
      by: "rule",
      rule: "deny.root-delete",
    });
    const events = await eventsOf(db, conv);
    expect(events.some((e) => e.type === "tool_call_started")).toBe(false);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    // a deny is never grantable, in auto as in sandbox mode
    const grants = await db
      .selectFrom("conversation_tool_grants")
      .select("tool_key")
      .where("conversation_id", "=", conv)
      .execute();
    expect(grants).toEqual([]);
  });

  it("an ask waits for the person; approving once runs the command and records who allowed it", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(PUSH)}`);
    const ask = await pendingCommandAsk(conv);
    await waitRunWaiting(conv);
    expect(ask.tool_key).toBe("Bash");
    expect(ask.detail as Record<string, unknown>).toMatchObject({
      kind: "command",
      command: PUSH.command,
      rule: "ask.force-push",
      mode: "auto",
    });
    expect(ask.scopes).toEqual(["once", "session"]);
    const requested = (await eventsOf(db, conv)).find(
      (e): e is ApprovalRequested => e.type === "approval_requested",
    );
    expect(requested?.payload.command).toMatchObject({
      kind: "command",
      command: PUSH.command,
      rule: "ask.force-push",
    });
    // the command has not run: no tool_call_started yet
    expect((await eventsOf(db, conv)).some((e) => e.type === "tool_call_started")).toBe(false);

    expect((await decide(ask.id, { decision: "approve", scope: "once" })).statusCode).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
    const r = (await results(conv)).at(-1) as ToolResult;
    // it ran: the fake shell's `git push` fails in a directory that is not a repository
    expect(r.payload.isError).toBe(false);
    expect(r.payload.content).toContain("[exit code: 128]");
    expect(r.payload.review).toMatchObject({
      decision: "allow",
      by: "person",
      rule: "ask.force-push",
      scope: "once",
    });
    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("org_id", "=", orgId)
      .where("action", "=", "device.command_allowed")
      .execute();
    expect(
      audits.filter((a) => (a.detail as { conversationId?: string }).conversationId === conv),
    ).toHaveLength(1);
  });

  it("the person declines the held command with a reason; the model gets P-D12's text", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(PUSH)}`);
    const ask = await pendingCommandAsk(conv);
    await waitRunWaiting(conv);
    expect((await decide(ask.id, { decision: "deny", reason: "not this branch" })).statusCode).toBe(
      200,
    );
    await waitForTerminal(db, conv, 1, 30_000);
    const r = (await results(conv)).at(-1) as ToolResult;
    expect(r.payload.isError).toBe(true);
    expect(r.payload.content).toBe(
      "The user declined to run this command: not this branch. Continue without it or ask the user.",
    );
    expect(r.payload.review).toMatchObject({
      decision: "deny",
      by: "person",
      rule: "ask.force-push",
    });
    expect((await eventsOf(db, conv)).some((e) => e.type === "tool_call_started")).toBe(false);
  });

  it("an ask's expiry and the run's stop end the call with their texts", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(PUSH)}`);
    const ask = await pendingCommandAsk(conv);
    await waitRunWaiting(conv);
    // make it due, then let the wait timeout do what the job would
    await db
      .updateTable("approvals")
      .set({ expires_at: sql<Date>`now() - interval '1 hour'` })
      .where("id", "=", ask.id)
      .execute();
    await k.app.get(Waits).expire("approval", ask.id);
    await waitForTerminal(db, conv, 1, 30_000);
    const expired = (await results(conv)).at(-1) as ToolResult;
    expect(expired.payload.isError).toBe(true);
    expect(expired.payload.content).toContain("Approval timed out after");
    expect(expired.payload.review).toMatchObject({ decision: "deny", by: "person" });

    const conv2 = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv2, `tool:Bash:${JSON.stringify(PUSH)}`);
    await pendingCommandAsk(conv2);
    await waitRunWaiting(conv2);
    const aborted = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv2}/abort`,
      payload: {},
    });
    expect([200, 202]).toContain(aborted.statusCode);
    await waitForTerminal(db, conv2, 1, 30_000);
    const stopped = (await results(conv2)).at(-1) as ToolResult;
    expect(stopped.payload.isError).toBe(true);
    expect(stopped.payload.content).toBe("The run was stopped while waiting for approval.");
  });

  it("本会话允许同类 covers the rule for the conversation, never another rule", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(PUSH)}`);
    const ask = await pendingCommandAsk(conv);
    await waitRunWaiting(conv);
    expect((await decide(ask.id, { decision: "approve", scope: "session" })).statusCode).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
    const grants = await db
      .selectFrom("conversation_tool_grants")
      .select(["tool_key", "spec_hash"])
      .where("conversation_id", "=", conv)
      .execute();
    expect(grants).toEqual([{ tool_key: "command:ask.force-push", spec_hash: "command" }]);

    // the same rule again: no second ask, the call runs
    const again = await call(
      conv,
      "Bash",
      { command: "git push --force origin main", description: "Force push" },
      2,
    );
    expect(again.payload.isError).toBe(false);
    expect(again.payload.review).toMatchObject({
      decision: "allow",
      by: "rule",
      rule: "ask.force-push",
    });
    const rows = await db
      .selectFrom("approvals")
      .select("id")
      .where("conversation_id", "=", conv)
      .execute();
    expect(rows).toHaveLength(1);

    // a different rule asks again
    await postMessage(
      owner,
      orgId,
      conv,
      `tool:Bash:${JSON.stringify({ command: "git push origin :feature", description: "Drop" })}`,
    );
    const other = await waitFor(
      async () =>
        db
          .selectFrom("approvals")
          .select(["id", "detail"])
          .where("conversation_id", "=", conv)
          .where("status", "=", "pending")
          .executeTakeFirst(),
      30_000,
      "the second rule's ask",
    );
    expect(other.detail as Record<string, unknown>).toMatchObject({ rule: "ask.remote-destroy" });
    expect((await decide(other.id, { decision: "deny" })).statusCode).toBe(200);
    await waitForTerminal(db, conv, 3, 30_000);

    // a deny rule is never granted, whatever the conversation allows: no card, a deny text
    const denied = await call(conv, "Bash", { command: "rm -rf /", description: "Clean" }, 4);
    expect(denied.payload.isError).toBe(true);
    expect(denied.payload.content).toContain("Command blocked by review:");
    expect(denied.payload.review).toMatchObject({ decision: "deny", by: "rule" });
  });

  it("a classifier ask offers only once (no rule to remember)", async () => {
    // a mapped `review` purpose whose answer is ask; a classifier ask has no rule hit (P-D2)
    await db
      .insertInto("model_purpose_mappings")
      .values({
        org_id: null,
        purpose: "review",
        provider: "model-script",
        model: "script-2",
        params: "{}",
      })
      .execute();
    scriptRules([
      {
        when: { systemIncludes: REVIEW_SYSTEM_PROMPT },
        reply: { text: JSON.stringify({ decision: "ask", reason: "Needs a person's decision." }) },
      },
    ]);
    try {
      const conv = await createConv(owner, orgId, agentId);
      const unsure = { command: "some-unknown-binary --flag", description: "Run it" };
      await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(unsure)}`);
      const ask = await pendingCommandAsk(conv);
      expect(ask.detail as Record<string, unknown>).toMatchObject({
        rule: null,
        reason: "Needs a person's decision.",
      });
      expect(ask.scopes).toEqual(["once"]);
      await waitRunWaiting(conv);
      const refused = await decide(ask.id, { decision: "approve", scope: "session" });
      expect(refused.statusCode).toBe(409);
      expect((refused.json() as { error: { code: string } }).error.code).toBe(
        "approval.scope_not_allowed",
      );
      expect((await decide(ask.id, { decision: "deny" })).statusCode).toBe(200);
      await waitForTerminal(db, conv, 1, 30_000);
    } finally {
      scriptRules([]);
      await db.deleteFrom("model_purpose_mappings").where("purpose", "=", "review").execute();
    }
  });

  it("an unsure ask with no classifier offers only once: a stored catch-all grant covers nothing", async () => {
    const conv = await createConv(owner, orgId, agentId);
    // a session grant keyed to the `unsure.*` catch-all can no longer be created; an old row must
    // never suppress the ask (it would whitelist every parser-unreadable command for the conversation)
    await db
      .insertInto("conversation_tool_grants")
      .values({
        conversation_id: conv,
        tool_key: "command:unsure.uncovered",
        spec_hash: "command",
        connector_id: null,
      })
      .execute();
    const unsure = { command: "some-unknown-binary --flag", description: "Run it" };
    await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(unsure)}`);
    const ask = await pendingCommandAsk(conv);
    await waitRunWaiting(conv);
    // the catch-all has no grantable rule class: `once` only, as a classifier ask
    expect(ask.detail as Record<string, unknown>).toMatchObject({ rule: null });
    expect(ask.scopes).toEqual(["once"]);
    const refused = await decide(ask.id, { decision: "approve", scope: "session" });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { code: string } }).error.code).toBe(
      "approval.scope_not_allowed",
    );
    expect((await decide(ask.id, { decision: "deny" })).statusCode).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
  });

  it("a command over the ask ceiling is refused with an actionable error and never runs", async () => {
    const conv = await createConv(owner, orgId, agentId);
    // `git push --force` would be an ask; at 40,000 characters it is too long to show for approval
    const huge = { command: `${PUSH.command}${" ".repeat(40_000)}`, description: "Push" };
    await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(huge)}`);
    await waitForTerminal(db, conv, 1, 30_000);
    const r = (await results(conv)).at(-1) as ToolResult;
    expect(r.payload.isError).toBe(true);
    expect(r.payload.content).toContain("too long to review");
    expect(r.payload.content).toContain("script file");
    expect(r.payload.review).toMatchObject({ decision: "deny", rule: null });
    const evs = await eventsOf(db, conv);
    expect(evs.some((e) => e.type === "tool_call_started")).toBe(false);
    expect(evs.some((e) => e.type === "approval_requested")).toBe(false);
    const rows = await db
      .selectFrom("approvals")
      .select("id")
      .where("conversation_id", "=", conv)
      .execute();
    expect(rows).toEqual([]);
  });

  it("a long command's approval holds the full text; the ask event is clamped and the record hashes it", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const long = `${PUSH.command}${" ".repeat(3_500)}`;
    await postMessage(
      owner,
      orgId,
      conv,
      `tool:Bash:${JSON.stringify({ command: long, description: "Push" })}`,
    );
    const ask = await pendingCommandAsk(conv);
    await waitRunWaiting(conv);
    const detail = ask.detail as { kind: string; command: string; rule: string };
    // the approval binds the whole command: the person approves exactly what runs
    expect(detail.command).toBe(long);
    expect(detail.rule).toBe("ask.force-push");
    // the timeline event stays clamped (display only)
    const requested = (await eventsOf(db, conv)).find(
      (e): e is ApprovalRequested => e.type === "approval_requested",
    );
    expect(requested?.payload.command?.command).toHaveLength(COMMAND_ASK_TEXT_MAX_CHARS);
    expect(requested?.payload.command?.command.endsWith("…")).toBe(true);
    expect((await decide(ask.id, { decision: "approve", scope: "once" })).statusCode).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
    const r = (await results(conv)).at(-1) as ToolResult;
    expect(r.payload.isError).toBe(false);
    expect(r.payload.review).toMatchObject({
      decision: "allow",
      by: "person",
      rule: "ask.force-push",
      scope: "once",
      commandHash: createHash("sha256").update(long).digest("hex"),
    });
  });

  it("an unattended run asks no one: the ask is a deny at once, with no approval and no grant", async () => {
    const task = await store.insertTask(db, {
      id: randomUUID(),
      orgId,
      accountId: ownerId,
      agentId: taskAgentId,
      name: "Push",
      prompt: "Push the branch",
      trigger: { kind: "cron", expr: "*/5 * * * *", timeZone: "UTC" },
      mode: "new",
      conversationId: null,
      chat: null,
      model: null,
      effort: null,
      deviceId: null,
      status: "active",
      nextRunAt: new Date(Date.now() + 86_400_000),
      jitterSeconds: 0,
      expiresAt: null,
    } satisfies ScheduledTaskInsert);
    const run = await store.insertRun(db, {
      id: randomUUID(),
      taskId: task.id,
      orgId,
      scheduledFor: new Date(),
      trial: false,
    });
    if (!run) throw new Error("tick taken");
    // the scripted model calls the held command when the task's message arrives
    scriptRules([
      {
        // only the first answer calls the tool: after the result the model says "done"
        when: { lastUserIncludes: "Push the branch", assistantTurns: 0 },
        reply: { toolCalls: [{ name: "Bash", input: PUSH }] },
      },
    ]);
    await k.app.get(ScheduledTaskFirer).fire(run.id);
    const conv = await conversationOfTaskRun(task.id);
    const terminal = await waitFor(
      async () => {
        const e = await eventsOf(db, conv);
        return e.some((x) => x.type === "run_finished" || x.type === "run_failed") ? e : null;
      },
      30_000,
      "the scheduled run ended",
    );
    scriptRules([]);
    expect(terminal.filter((e) => e.type === "approval_requested")).toEqual([]);
    // no event and no row: the unattended branch never calls requestCommand
    const approvals = await db
      .selectFrom("approvals")
      .select("id")
      .where("conversation_id", "=", conv)
      .execute();
    expect(approvals).toEqual([]);
    const r = terminal.find((e): e is ToolResult => e.type === "tool_result");
    expect(r?.payload.isError).toBe(true);
    expect(r?.payload.content).toContain("This command needs approval");
    expect(r?.payload.content).toContain("no one can approve it now");
    expect(r?.payload.review).toMatchObject({ decision: "deny", by: "rule" });
    expect(terminal.some((e) => e.type === "tool_call_started")).toBe(false);
    const taskRun = (await store.updateRun(db, run.id, {})) as TaskRun;
    // no `missing_grants` entry: command asks are not a task grant class (P-D3)
    expect(taskRun.missingGrants ?? []).toEqual([]);
  });

  it("a scheduled task hitting sudo gets no approval and no wait: the ask is a deny, the run continues", async () => {
    const { terminal, conversationId } = await fireScheduled("Update the system packages", [
      { name: "Bash", input: { command: "sudo apt-get update", description: "Update packages" } },
    ]);
    await expectUnattendedDeny(conversationId, terminal, "ask.sudo");
  });

  it("a scheduled task writing outside the workspace is denied at once with ask.outside-write", async () => {
    const { terminal, conversationId } = await fireScheduled("Write the shared config", [
      {
        name: "Write",
        input: { file_path: "/etc/capybara-t15/note.txt", content: "x" },
      },
    ]);
    await expectUnattendedDeny(conversationId, terminal, "ask.outside-write", "write");
  });

  it("an IM run by the device owner is attended: the ask waits for the card", async () => {
    const messageId = `m-${randomUUID().slice(0, 8)}`;
    im.push(connId, dm(messageId, "u-owner", `tool:Bash:${JSON.stringify(PUSH)}`));
    const thread = await waitFor(
      async () =>
        db
          .selectFrom("channel_threads")
          .select("conversation_id")
          .where("connection_id", "=", connId)
          .where("thread_key", "=", "dm:u-owner")
          .where("archived_at", "is", null)
          .executeTakeFirst(),
      15_000,
      "the IM thread's conversation",
    );
    const ask = await pendingCommandAsk(thread.conversation_id);
    expect(ask.detail as Record<string, unknown>).toMatchObject({ rule: "ask.force-push" });
    expect((await decide(ask.id, { decision: "deny" })).statusCode).toBe(200);
  });

  it("file writes: outside the workspace asks (once), Capybara's own files are denied", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(
      owner,
      orgId,
      conv,
      `tool:Write:${JSON.stringify({ file_path: "/etc/capybara-t7/note.txt", content: "x" })}`,
    );
    const ask = await pendingCommandAsk(conv);
    await waitRunWaiting(conv);
    expect(ask.tool_key).toBe("Write");
    expect(ask.detail as Record<string, unknown>).toMatchObject({
      kind: "write",
      command: "Write",
      path: "/etc/capybara-t7/note.txt",
      rule: "ask.outside-write",
    });
    // a write has no 本会话允许同类 on a classifier ask either; the rule ask does (grantable rule)
    expect(ask.scopes).toEqual(["once", "session"]);
    expect((await decide(ask.id, { decision: "approve", scope: "once" })).statusCode).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
    const written = (await results(conv)).at(-1) as ToolResult;
    expect(written.payload.isError).toBe(false);
    expect(written.payload.content).toContain("Created /etc/capybara-t7/note.txt");
    expect(written.payload.review).toMatchObject({
      decision: "allow",
      by: "person",
      rule: "ask.outside-write",
    });

    // Capybara's own device files: denied by the review, never a card
    const denied = await call(
      conv,
      "Write",
      { file_path: "~/.capybara-device/config.json", content: "{}" },
      2,
    );
    expect(denied.payload.isError).toBe(true);
    expect(denied.payload.content).toContain("This write is blocked by review:");
    expect(denied.payload.review).toMatchObject({
      decision: "deny",
      by: "rule",
      rule: "deny.tooling-edit",
    });
  });

  it("a plugin policy hook still runs after the review and its deny wins", async () => {
    const enabled = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
      payload: { enabled: true },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const configured = await owner({
      method: "POST",
      url: `/plugins/hooks-probe/config`,
      payload: { orgId, denyTools: ["Bash"] },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    const conv = await createConv(owner, orgId, agentId);
    const r = await call(conv, "Bash", { command: "echo hi", description: "Greet" }, 1);
    expect(r.payload.isError).toBe(true);
    expect(r.payload.content).toContain('Tool call blocked by the "hooks-probe" policy hook');
    // the review ran first (an allowed command), then the hook denied it before execution
    const counts = await owner({
      method: "GET",
      url: `/plugins/hooks-probe/counts?orgId=${orgId}`,
    });
    expect((counts.json() as { counts: Record<string, number> }).counts["tool.preExecute"]).toBe(1);

    // a deny by review: the hook never sees the call
    const before =
      (counts.json() as { counts: Record<string, number> }).counts["tool.preExecute"] ?? 0;
    const denied = await call(conv, "Bash", { command: "rm -rf /", description: "Clean" }, 2);
    expect(denied.payload.review).toMatchObject({ decision: "deny", by: "rule" });
    const after = await owner({
      method: "GET",
      url: `/plugins/hooks-probe/counts?orgId=${orgId}`,
    });
    expect((after.json() as { counts: Record<string, number> }).counts["tool.preExecute"]).toBe(
      before,
    );
    await owner({
      method: "POST",
      url: `/plugins/hooks-probe/config`,
      payload: { orgId },
    });
  });
});
