import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolPostHookPayload } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import type { Kernel } from "../../../src/kernel.js";
import { finishRun } from "../../../src/runtime/run-finish.js";
import { SUBAGENT_RUN_QUEUE_NAME } from "../../../src/runtime/run-queue.js";
import { type ScriptRule, scriptRules } from "../../fixtures/plugins/model-script/index.js";
import { setFakeSandboxDelays } from "../../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../../helpers/db.js";
import { accountsFor } from "../../helpers/identity.js";
import { testMembers } from "../../helpers/members.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
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
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../../helpers/runs.js";
import { type ChildRun, childRunsOf, parentWaiting, runStatus } from "../../helpers/subagents.js";

/**
 * Phase C Task 13 (spec §12): stopping a parent stops its children and writes its open `agent`
 * results; stopping one child lets the parent go on; every terminal state of a parent (here its
 * deadline) stops its children; offboarding stops a removed member's sub-agents. One kernel with
 * model-script, sandbox-fake and hooks-probe.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");
const HOOKS_PROBE = fixture("hooks-probe");

const STOPPED = "The run was stopped while this sub-agent was working; it was stopped too.";
const CHILD = "You are a sub-agent";
const agentCall = (prompt: string) => ({
  name: "agent",
  input: { description: "Task", prompt },
});

const RULES: ScriptRule[] = [
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "task-write", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "sandbox_write", input: { path: "/workspace/c.txt", content: "c" } }],
    },
  },
  // a child that keeps running until it is stopped (the barrier is never reached)
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "task-hang" },
    reply: { text: "hung", barrier: { name: "hang", count: 99, timeoutMs: 60_000 } },
  },
  { when: { systemIncludes: CHILD }, reply: { text: "child ok" } },
  {
    when: { lastUserIncludes: "SCENARIO stop-all", assistantTurns: 0 },
    reply: {
      toolCalls: [agentCall("task-write"), agentCall("task-hang-1"), agentCall("task-hang-2")],
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO stop-one", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("task-hang"), agentCall("task-a"), agentCall("task-b")] },
  },
  {
    when: { lastUserIncludes: "SCENARIO hang-one", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("task-hang")] },
  },
  {
    // the agent call dispatches, then the command runs into the parent's deadline
    when: { lastUserIncludes: "SCENARIO deadline", assistantTurns: 0 },
    reply: {
      toolCalls: [
        agentCall("task-one"),
        { name: "sandbox_bash", input: { description: "Wait", command: "sleep 30" } },
      ],
    },
  },
  { when: { lastUserIncludes: "after orphan" }, reply: { text: "after orphan done" } },
  { when: { lastToolResultIncludes: "[agentId:" }, reply: { text: "parent done" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: Kernel;
let root: string;
let subQueue: Queue;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-subagents-cancel-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE, HOOKS_PROBE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
        // the deadline test's parent runs into it; everything else stops well before
        runtime: { maxRunSeconds: 8 },
      },
    ),
  );
  subQueue = new Queue(SUBAGENT_RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
}, 180_000);

afterAll(async () => {
  await subQueue?.close();
  await k?.stop();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let member: Req;
let ownerId: string;
let memberId: string;
let orgId: string;
let agentId: string;

beforeEach(async () => {
  await subQueue.resume();
  await truncateTables(
    db,
    "capybara.audit_events, capybara.subagent_dispatches, capybara.sandboxes, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  scriptRules([]);
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  memberId = (await accounts.createLocal({ login: "member", password: PW, displayName: "M" })).id;
  owner = await session(k, "owner");
  member = await session(k, "member");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  const en = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
    payload: { enabled: true },
  });
  expect(en.statusCode, en.body).toBe(200);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: "Lead the work.",
        model: { provider: "model-script", model: "script-1" },
        tools: ["agent", "sandbox_write", "sandbox_bash"].map((name) => ({
          kind: "builtin",
          name,
        })),
        toolPolicies: { sandbox_write: "ask" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterEach(async () => {
  await setFakeSandboxDelays(root, {});
  await subQueue.resume();
  scriptRules([]);
});

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);
const agentResults = (events: ConversationEvent[]) =>
  ofType(events, "tool_result").filter((r) => r.payload.toolKey === "agent");
const finalText = (events: ConversationEvent[]) =>
  ofType(events, "assistant_message")
    .at(-1)
    ?.payload.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");

/** Waits until every child is in its expected state. */
async function childrenIn(children: ChildRun[], states: Record<string, string>) {
  await waitFor(
    async () => {
      for (const c of children) {
        const want = states[c.runId] ?? "running";
        if ((await runStatus(db, c.runId)) !== want) return null;
      }
      return true;
    },
    20_000,
    "children in place",
  );
}

/** The child whose task message contains `task`. */
async function childWithTask(children: ChildRun[], task: string): Promise<ChildRun> {
  for (const c of children) {
    const events = await eventsOf(db, c.conversationId);
    const msg = ofType(events, "user_message")[0];
    if (JSON.stringify(msg?.payload).includes(task)) return c;
  }
  throw new Error(`no child with ${task}`);
}

async function allStopped(runIds: string[]) {
  await waitFor(
    async () => {
      for (const id of runIds) if ((await runStatus(db, id)) !== "aborted") return null;
      return true;
    },
    10_000,
    "all runs aborted",
  );
}

/** Every child ended `run_aborted` by nobody, and the parent recorded each as `aborted`. */
async function expectStoppedWithParent(conv: string, children: ChildRun[]) {
  for (const c of children) {
    const cev = await eventsOf(db, c.conversationId);
    expect(ofType(cev, "run_aborted").map((e) => e.payload.byAccountId)).toEqual([null]);
  }
  await waitFor(
    async () =>
      ofType(await eventsOf(db, conv), "subagent_finished").length === children.length || null,
    10_000,
    "subagent_finished for every child",
  );
  const finished = ofType(await eventsOf(db, conv), "subagent_finished");
  expect(finished.map((e) => e.payload.status)).toEqual(children.map(() => "aborted"));
}

describe("stopping a parent that waits on sub-agents", () => {
  it("leaves the parent and its three children (one waiting for approval) aborted, with the stop text in the parent's calls", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO stop-all");
    const { runId, children } = await parentWaiting(db, conv, 3);
    const writer = await childWithTask(children, "task-write");
    await childrenIn(children, { [writer.runId]: "waiting" });

    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    await allStopped([runId, ...children.map((c) => c.runId)]);

    const events = await eventsOf(db, conv);
    expect(ofType(events, "run_aborted").map((e) => e.payload.byAccountId)).toEqual([ownerId]);
    const results = agentResults(events);
    const calls = ofType(events, "subagent_dispatched").map((e) => e.payload.callId);
    expect(results.map((r) => r.payload.callId).sort()).toEqual([...calls].sort());
    for (const r of results) {
      expect(r.payload).toMatchObject({ content: STOPPED, isError: true, step: 1 });
    }
    // a person stopped the parent; its children were stopped with it (§4.4 "stopped with this run")
    await expectStoppedWithParent(conv, children);
    // the child's approval was cancelled with it
    const approvals = await db.selectFrom("approvals").select("status").execute();
    expect(approvals).toEqual([{ status: "cancelled" }]);
    // nothing resumed the stopped parent
    expect(await runStatus(db, runId)).toBe("aborted");
    expect(ofType(events, "model_call").filter((e) => e.payload.step === 2)).toEqual([]);

    // the stop results are audited and fire tool.postExecute like any agent result (Task 11)
    const audits = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "detail"])
      .where("action", "=", "tool.called")
      .execute();
    const agentAudits = audits.filter(
      (a) => (a.detail as { toolKey?: string }).toolKey === "agent",
    );
    expect(agentAudits.map((a) => (a.detail as { callId: string }).callId).sort()).toEqual(
      [...calls].sort(),
    );
    for (const a of agentAudits) {
      expect(a.actor_account_id).toBe(ownerId);
      expect(a.detail).toMatchObject({ conversationId: conv, runId, isError: true });
    }
    const post = await waitFor(
      async () => {
        const r = await owner({
          method: "GET",
          url: `/plugins/hooks-probe/counts?orgId=${orgId}&conversationId=${conv}`,
        });
        const last = (r.json() as { last: Record<string, unknown> }).last;
        return (last["tool.postExecute"] as ToolPostHookPayload | undefined) ?? null;
      },
      10_000,
      "parent postExecute",
    );
    expect(post).toMatchObject({ toolKey: "agent", content: STOPPED, isError: true, runId });
    expect(calls).toContain(post.callId);
    // once per call: three agent results, three tool.postExecute (review m7); the cancelled
    // approval of the writer child fires none
    const postCount = async () => {
      const r = await owner({ method: "GET", url: `/plugins/hooks-probe/counts?orgId=${orgId}` });
      return (r.json() as { counts: Record<string, number> }).counts["tool.postExecute"] ?? 0;
    };
    await waitFor(async () => (await postCount()) >= 3 || null, 10_000, "3 postExecute");
    expect(await postCount()).toBe(3);
  }, 60_000);
});

describe("stopping one sub-agent", () => {
  it("gives the parent 'stopped by the user' for it; the parent completes after the others", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO stop-one");
    const { runId, children } = await parentWaiting(db, conv, 3);
    const hang = await childWithTask(children, "task-hang");
    await childrenIn(
      children,
      Object.fromEntries(
        children.map((c) => [c.runId, c.runId === hang.runId ? "running" : "completed"]),
      ),
    );
    expect(await runStatus(db, runId)).toBe("waiting");
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${hang.conversationId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, conv, 1, 20_000);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("parent done");
    const byChild = new Map(
      ofType(events, "subagent_dispatched").map((d) => [d.payload.callId, d.payload.subagentId]),
    );
    for (const r of agentResults(events)) {
      const child = byChild.get(r.payload.callId);
      if (child === hang.conversationId) {
        expect(r.payload.isError).toBe(true);
        expect(r.payload.content).toMatch(
          /^The user stopped this sub-agent\.\n\n\[agentId: [^ ]+ · stopped by the user · /,
        );
      } else {
        expect(r.payload.content).toMatch(/^child ok\n\n/);
      }
    }
    const cev = await eventsOf(db, hang.conversationId);
    expect(ofType(cev, "run_aborted").map((e) => e.payload.byAccountId)).toEqual([ownerId]);
  }, 60_000);
});

describe("a parent's terminal state stops its children", () => {
  it("the parent's deadline ends it and its children stop", async () => {
    // the child stays queued (as if its replica were slow) while the parent runs into its deadline
    // in a slow sandbox command
    await subQueue.pause();
    await setFakeSandboxDelays(root, { exec: 30_000 });
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO deadline");
    const [t] = await waitForTerminal(db, conv, 1, 30_000);
    expect(t?.type).toBe("run_finished");
    expect(t?.payload).toMatchObject({ reason: "max_duration" });
    const children = await childRunsOf(db, conv);
    expect(children).toHaveLength(1);
    await subQueue.resume();
    await allStopped(children.map((c) => c.runId));
    await expectStoppedWithParent(conv, children);
    // the finished parent is not resumed by its child's report
    const runs = await db
      .selectFrom("runs")
      .select("status")
      .where("conversation_id", "=", conv)
      .execute();
    expect(runs).toEqual([{ status: "completed" }]);
  }, 60_000);
});

describe("a parent that ends as an orphan (review m1, m2)", () => {
  /**
   * A parent waiting on a hanging child whose run is then lost: `running` again (as after a resume)
   * with no job and no lock holder, the state the orphan repairs look for.
   */
  async function orphanedParent(): Promise<{ conv: string; runId: string; child: ChildRun }> {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO hang-one");
    const { runId, children } = await parentWaiting(db, conv, 1);
    const [child] = children as [ChildRun];
    await childrenIn(children, {});
    await db
      .updateTable("runs")
      .set({ status: "running", waiting_since: null, wait_expires_at: null })
      .where("id", "=", runId)
      .execute();
    return { conv, runId, child };
  }

  async function expectStopped(conv: string, child: ChildRun) {
    await allStopped([child.runId]);
    const results = agentResults(await eventsOf(db, conv));
    expect(results.map((r) => r.payload)).toEqual([
      expect.objectContaining({ content: STOPPED, isError: true, step: 1 }),
    ]);
    await expectStoppedWithParent(conv, [child]);
  }

  it("a stop of an orphaned parent writes its open agent call's result and stops the child", async () => {
    const { conv, runId, child } = await orphanedParent();
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(await runStatus(db, runId)).toBe("aborted");
    await expectStopped(conv, child);
  }, 60_000);

  it("ensureRun's orphan repair writes the open agent call's result and stops the child at once", async () => {
    const { conv, runId, child } = await orphanedParent();
    await postMessage(owner, orgId, conv, "after orphan");
    await waitFor(
      async () => ((await runStatus(db, runId)) === "failed" ? true : null),
      10_000,
      "orphan marked failed",
    );
    // stopped now, not by the 10-minute sweep
    await expectStopped(conv, child);
    await waitForTerminal(db, conv, 2, 30_000);
    expect(finalText(await eventsOf(db, conv))).toBe("after orphan done");
  }, 60_000);
});

describe("offboarding", () => {
  it("an offboarded member's sub-agents stop", async () => {
    const conv = await createConv(member, orgId, agentId);
    await postMessage(member, orgId, conv, "SCENARIO hang-one");
    const { runId, children } = await parentWaiting(db, conv, 1);
    await childrenIn(children, {});
    const res = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/members/${memberId}` });
    expect(res.statusCode, res.body).toBeLessThan(300);
    await allStopped([runId, ...children.map((c) => c.runId)]);
    const events = await eventsOf(db, conv);
    expect(agentResults(events).map((r) => r.payload.content)).toEqual([STOPPED]);
    await expectStoppedWithParent(conv, children);
  }, 60_000);

  it("the offboarding sweep stops a former member's sub-agent runs", async () => {
    await subQueue.pause();
    const conv = await createConv(member, orgId, agentId);
    await postMessage(member, orgId, conv, "SCENARIO hang-one");
    const { runId, children } = await parentWaiting(db, conv, 1);
    // the parent ended without stopping its child, and the membership went away without the
    // offboarding steps (a crash between the two): only the offboarding sweep catches the child
    await finishRun(db, k.runs.eventLog, {
      conversationId: conv,
      runId,
      status: "aborted",
      consumed: null,
      event: { type: "run_aborted", payload: { byAccountId: null, reason: "user" } },
    });
    await db.deleteFrom("memberships").where("account_id", "=", memberId).execute();
    expect(await k.identity.offboarding.sweep()).toBe(1);
    await subQueue.resume();
    await allStopped(children.map((c) => c.runId));
    await waitForEvent(db, conv, (e) => e.type === "subagent_finished", 10_000);
  }, 60_000);
});
