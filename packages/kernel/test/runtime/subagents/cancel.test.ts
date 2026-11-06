import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { Offboarding } from "../../../src/orgs/offboarding.js";
import { RunAbort } from "../../../src/runtime/abort.js";
import { SUBAGENT_RUN_QUEUE_NAME } from "../../../src/runtime/run-queue.js";
import { Waits } from "../../../src/runtime/waits.js";
import {
  openBarrier,
  type ScriptRule,
  scriptRules,
} from "../../fixtures/plugins/model-script/index.js";
import { setFakeSandboxDelays } from "../../fixtures/plugins/sandbox-fake/index.js";
import { legacyDbFor } from "../../helpers/conversations.js";
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
  type TestKernel,
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../../helpers/runs.js";
import {
  type ChildRun,
  childRunsOf,
  finishedDeliveries,
  runStatus,
} from "../../helpers/subagents.js";

/**
 * Phase C Task 13 (spec §12) with background sub-agents (agent map spec §5.4, §6): a parent run
 * that ends (stopped by a person, at its deadline, as an orphan) leaves its children running;
 * stopping one child delivers its finish as `aborted`; offboarding stops a removed member's
 * sub-agents. One kernel with model-script, sandbox-fake and hooks-probe.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");
const HOOKS_PROBE = fixture("hooks-probe");

const CHILD = "You are a sub-agent";
const agentCall = (prompt: string) => ({
  name: "Agent",
  input: { description: "Task", prompt },
});

const RULES: ScriptRule[] = [
  // the tree root → T1 → T2 → T3 (plus a sibling of T1): each level dispatches the next, then holds
  // until it is stopped
  {
    when: {
      systemIncludes: CHILD,
      lastUserIncludes: "tree-T",
      lastToolResultIncludes: "background",
    },
    reply: { text: "held", barrier: { name: "hang", count: 99, timeoutMs: 60_000 } },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "tree-T1", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("tree-T2")] },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "tree-T2", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("tree-T3")] },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "tree-T3" },
    reply: { text: "deep", barrier: { name: "hang", count: 99, timeoutMs: 60_000 } },
  },
  {
    when: { lastUserIncludes: "SCENARIO tree", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("tree-T1"), agentCall("task-hang-sibling")] },
  },
  // root → D1 → D2 → D3: D1 and D2 finish after dispatching, D3 works on
  {
    when: {
      systemIncludes: CHILD,
      lastUserIncludes: "deep-D",
      lastToolResultIncludes: "background",
    },
    reply: { text: "level done" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "deep-D1", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("deep-D2")] },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "deep-D2", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("task-hang-D3")] },
  },
  {
    when: { lastUserIncludes: "SCENARIO deep", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("deep-D1")] },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "task-write", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "Write", input: { file_path: "/workspace/c.txt", content: "c" } }],
    },
  },
  // a child that keeps running until it is stopped or the test opens the barrier
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
    // the parent's next step holds until the test stops the parent run
    when: { lastUserIncludes: "SCENARIO stop-all", assistantTurns: 1 },
    reply: { text: "never", barrier: { name: "parent-hold", count: 99, timeoutMs: 60_000 } },
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
        { name: "Bash", input: { description: "Wait", command: "sleep 30" } },
      ],
    },
  },
  { when: { lastUserIncludes: "after orphan" }, reply: { text: "after orphan done" } },
  { when: { lastToolResultIncludes: "in the background" }, reply: { text: "parent done" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
let subQueue: Queue;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
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
  await k?.close();
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
        tools: ["Agent", "Write", "Bash"].map((name) => ({
          kind: "builtin",
          name,
        })),
        toolPolicies: { Write: "ask" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterEach(async () => {
  // children held at a barrier go on, so no test leaves running work behind
  openBarrier("hang");
  openBarrier("parent-hold");
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
  ofType(events, "tool_result").filter((r) => r.payload.toolKey === "Agent");
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

/** Waits for the parent's finished deliveries of `children`; their payloads by child. */
async function deliveredFor(conv: string, children: ChildRun[]) {
  const ds = await finishedDeliveries(db, conv, children.length);
  return new Map(ds.map((d) => [d.subagentId, d]));
}

/** The single child run of a conversation, once it is `running`. */
async function onlyChild(conv: string, label: string): Promise<ChildRun> {
  return waitFor(
    async () => {
      const [c] = await childRunsOf(db, conv);
      return c && (await runStatus(db, c.runId)) === "running" ? c : null;
    },
    20_000,
    label,
  );
}

/** Starts `SCENARIO tree`: the root's children T1 and a sibling, T1's child T2, T2's child T3. */
async function startTree() {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, "SCENARIO tree");
  await waitForTerminal(db, conv, 1, 20_000);
  const top = await waitFor(
    async () => {
      const c = await childRunsOf(db, conv);
      return c.length === 2 ? c : null;
    },
    20_000,
    "the root's two children",
  );
  const t1 = await childWithTask(top, "tree-T1");
  const sibling = await childWithTask(top, "task-hang-sibling");
  const t2 = await onlyChild(t1.conversationId, "T2");
  const t3 = await onlyChild(t2.conversationId, "T3");
  await childrenIn([t1, t2, t3, sibling], {});
  return { conv, t1, t2, t3, sibling };
}

/** The `run_aborted` accounts of a conversation's log. */
async function abortedBy(conv: string) {
  return ofType(await eventsOf(db, conv), "run_aborted").map((e) => e.payload.byAccountId);
}

describe("stopping a sub-agent stops its descendants", () => {
  it("stopping a child stops its grandchildren and great-grandchildren", async () => {
    const { conv, t1, t2, t3, sibling } = await startTree();
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${t1.conversationId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    expect((res.json() as { runId: string }).runId).toBe(t1.runId);
    await allStopped([t1.runId, t2.runId, t3.runId]);
    for (const c of [t1, t2, t3]) expect(await abortedBy(c.conversationId)).toEqual([ownerId]);
    // each stopped agent delivers its finish to its own parent as stopped by the user
    for (const [parent, c] of [
      [conv, t1],
      [t1.conversationId, t2],
      [t2.conversationId, t3],
    ] as const) {
      expect((await deliveredFor(parent, [c])).get(c.conversationId)).toMatchObject({
        status: "aborted",
        abortedBy: "user",
      });
    }
    // the sibling outside the stopped subtree keeps working
    expect(await runStatus(db, sibling.runId)).toBe("running");
  }, 60_000);

  it("the root's owner stops a depth-2 agent with its child; anyone else gets 404", async () => {
    const { conv, t1, t2, t3, sibling } = await startTree();
    for (const c of [t2, t3]) {
      const read = await owner({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/conversations/${c.conversationId}`,
      });
      expect(read.statusCode, read.body).toBe(200);
      const other = await member({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/conversations/${c.conversationId}`,
      });
      expect(other.statusCode).toBe(404);
    }
    const denied = await member({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${t2.conversationId}/abort`,
    });
    expect(denied.statusCode).toBe(404);
    expect(await runStatus(db, t2.runId)).toBe("running");
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${t2.conversationId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    await allStopped([t2.runId, t3.runId]);
    expect(await abortedBy(t3.conversationId)).toEqual([ownerId]);
    // above the stopped agent nothing stops
    expect(await runStatus(db, t1.runId)).toBe("running");
    expect(await runStatus(db, sibling.runId)).toBe("running");
    // a deleted root takes its tree out of reach
    await db
      .updateTable("conversations")
      .set({ deleted_at: new Date() })
      .where("id", "=", conv)
      .execute();
    const gone = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${t2.conversationId}`,
    });
    expect(gone.statusCode).toBe(404);
  }, 60_000);

  it("a child that only has working descendants: its stop stops them", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO deep");
    await waitForTerminal(db, conv, 1, 20_000);
    const d1 = await waitFor(async () => (await childRunsOf(db, conv))[0], 20_000, "D1");
    const d2 = await waitFor(
      async () => (await childRunsOf(db, d1.conversationId))[0],
      20_000,
      "D2",
    );
    const d3 = await onlyChild(d2.conversationId, "D3");
    await childrenIn([d1, d2, d3], { [d1.runId]: "completed", [d2.runId]: "completed" });
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${d1.conversationId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    await allStopped([d3.runId]);
    expect(await abortedBy(d3.conversationId)).toEqual([ownerId]);
    // a subtree with nothing working answers run.not_active
    const again = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${d1.conversationId}/abort`,
    });
    expect([again.statusCode, (again.json() as { error: { code: string } }).error.code]).toEqual([
      409,
      "run.not_active",
    ]);
  }, 60_000);

  it("a child stopped by a person mid-dispatch: its end stops the descendants it dispatched", async () => {
    const { t1, t2, t3, sibling } = await startTree();
    // only T1's run is asked to stop, as if T2 were dispatched after the tree stop read the tree
    await k.app.get(RunAbort).request(t1.runId, ownerId);
    await allStopped([t1.runId, t2.runId, t3.runId]);
    expect(await abortedBy(t3.conversationId)).toEqual([ownerId]);
    expect(await runStatus(db, sibling.runId)).toBe("running");
  }, 60_000);

  it("deleting the root conversation stops the whole tree", async () => {
    const { conv, t1, t2, t3, sibling } = await startTree();
    const res = await owner({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}`,
    });
    expect(res.statusCode, res.body).toBe(204);
    await allStopped([t1.runId, t2.runId, t3.runId, sibling.runId]);
    // nothing woke the deleted root
    const runs = await db
      .selectFrom("runs")
      .select("status")
      .where("conversation_id", "=", conv)
      .execute();
    expect(runs).toEqual([{ status: "completed" }]);
  }, 60_000);

  it("the wait sweep stops the working tree of a deleted root", async () => {
    const { conv, t1, t2, t3, sibling } = await startTree();
    // the root was marked deleted without the tree stop (a crash in between)
    await db
      .updateTable("conversations")
      .set({ deleted_at: new Date() })
      .where("id", "=", conv)
      .execute();
    const r = await k.app.get(Waits).sweep();
    expect(r.stopped).toBeGreaterThanOrEqual(4);
    await allStopped([t1.runId, t2.runId, t3.runId, sibling.runId]);
  }, 60_000);
});

describe("a parent run that ends leaves its background children running", () => {
  it("stopping the root run leaves background children running", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO stop-all");
    const children = await waitFor(
      async () => {
        const c = await childRunsOf(db, conv);
        return c.length === 3 ? c : null;
      },
      20_000,
      "three children",
    );
    const writer = await childWithTask(children, "task-write");
    await childrenIn(children, { [writer.runId]: "waiting" });
    const parentRun = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    await allStopped([parentRun.id]);
    // the root run's end, seen again (a redelivered job, the failure path), stops no child
    expect(await k.app.get(Waits).stopDescendantsOfStopped(parentRun.id)).toBe(0);
    // the dispatches' results were written with them: nothing to pair at the stop
    const events = await eventsOf(db, conv);
    expect(agentResults(events).map((r) => r.payload.isError)).toEqual([false, false, false]);
    // nothing stopped the children, nor cancelled the writer's approval
    await new Promise((r) => setTimeout(r, 500));
    await childrenIn(children, { [writer.runId]: "waiting" });
    const approvals = await db.selectFrom("approvals").select("status").execute();
    expect(approvals).toEqual([{ status: "pending" }]);
    openBarrier("hang");
    const hung = children.filter((c) => c.runId !== writer.runId);
    const ds = await finishedDeliveries(db, conv, 2);
    expect(ds.map((d) => [d.status, d.text])).toEqual([
      ["completed", "hung"],
      ["completed", "hung"],
    ]);
    expect(new Set(ds.map((d) => d.subagentId))).toEqual(
      new Set(hung.map((c) => c.conversationId)),
    );
  }, 60_000);

  it("the parent's deadline ends it; its child keeps running and delivers its reply", async () => {
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
    const ds = await deliveredFor(conv, children);
    expect(ds.get(children[0]?.conversationId as string)).toMatchObject({
      status: "completed",
      text: "child ok",
    });
    // the finished parent run is not resumed by the delivery: it stays completed, and what the
    // delivery starts is a wake run of its own (agent map spec §5.3)
    const runs = await db
      .selectFrom("runs")
      .select(["id", "status", "budget_run_id"])
      .where("conversation_id", "=", conv)
      .orderBy("created_at")
      .execute();
    expect(runs[0]?.status).toBe("completed");
    for (const wake of runs.slice(1)) expect(wake.budget_run_id).toBe(runs[0]?.id);
  }, 60_000);

  it("ensureRun's orphan repair of the parent run leaves its child running", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO hang-one");
    await waitForTerminal(db, conv, 1, 20_000);
    const [child] = (await childRunsOf(db, conv)) as [ChildRun];
    await childrenIn([child], {});
    // the parent run is lost: `running` with no job and no lock holder
    const run = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    await db.updateTable("runs").set({ status: "running" }).where("id", "=", run.id).execute();
    await postMessage(owner, orgId, conv, "after orphan");
    await waitFor(
      async () => ((await runStatus(db, run.id)) === "failed" ? true : null),
      10_000,
      "orphan marked failed",
    );
    // the orphan's run_failed, then the new run's end
    await waitForTerminal(db, conv, 3, 30_000);
    expect(finalText(await eventsOf(db, conv))).toBe("after orphan done");
    expect(await runStatus(db, child.runId)).toBe("running");
    openBarrier("hang");
    expect((await deliveredFor(conv, [child])).get(child.conversationId)?.text).toBe("hung");
  }, 60_000);
});

describe("stopping one sub-agent", () => {
  it("a stopped child delivers a finished delivery with status aborted", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO stop-one");
    await waitForTerminal(db, conv, 1, 20_000);
    expect(finalText(await eventsOf(db, conv))).toBe("parent done");
    const children = await childRunsOf(db, conv);
    const hang = await childWithTask(children, "task-hang");
    await childrenIn(
      children,
      Object.fromEntries(
        children.map((c) => [c.runId, c.runId === hang.runId ? "running" : "completed"]),
      ),
    );
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${hang.conversationId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    const ds = await deliveredFor(conv, children);
    for (const c of children) {
      const d = ds.get(c.conversationId);
      if (c.runId === hang.runId) {
        expect(d).toMatchObject({ status: "aborted", abortedBy: "user", text: "" });
      } else {
        expect(d).toMatchObject({ status: "completed", text: "child ok" });
      }
    }
    const cev = await eventsOf(db, hang.conversationId);
    expect(ofType(cev, "run_aborted").map((e) => e.payload.byAccountId)).toEqual([ownerId]);
  }, 60_000);
});

describe("offboarding", () => {
  it("an offboarded member's sub-agents stop", async () => {
    const conv = await createConv(member, orgId, agentId);
    await postMessage(member, orgId, conv, "SCENARIO hang-one");
    await waitForTerminal(db, conv, 1, 20_000);
    const children = await childRunsOf(db, conv);
    await childrenIn(children, {});
    const res = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/members/${memberId}` });
    expect(res.statusCode, res.body).toBeLessThan(300);
    await allStopped(children.map((c) => c.runId));
    const ds = await deliveredFor(conv, children);
    expect([...ds.values()].map((d) => d.status)).toEqual(["aborted"]);
  }, 60_000);

  it("the offboarding sweep stops a former member's sub-agent runs", async () => {
    await subQueue.pause();
    const conv = await createConv(member, orgId, agentId);
    await postMessage(member, orgId, conv, "SCENARIO hang-one");
    await waitForTerminal(db, conv, 1, 20_000);
    const children = await childRunsOf(db, conv);
    // the membership went away without the offboarding steps (a crash): only the offboarding
    // sweep catches the child
    await db.deleteFrom("memberships").where("account_id", "=", memberId).execute();
    expect(await k.app.get(Offboarding).sweep()).toBe(1);
    await subQueue.resume();
    await allStopped(children.map((c) => c.runId));
    await waitForEvent(db, conv, (e) => e.type === "subagent_finished", 10_000);
  }, 60_000);
});
