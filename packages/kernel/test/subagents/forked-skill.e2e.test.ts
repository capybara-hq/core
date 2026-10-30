import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { SUBAGENT_RUN_QUEUE_NAME } from "../../src/runtime/run-queue.js";
import { unreportedForkRuns, Waits } from "../../src/runtime/waits.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { AGENT_STOPPED_WITH_RUN_TEXT } from "../../src/tools/builtins/agent.js";
import { type ScriptRule, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { truncateTables } from "../helpers/db.js";
import {
  catalogItemNamed,
  seedForkedSkill,
  writeForkedSkillFiles,
} from "../helpers/forked-skills.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";
import { backdateRun, childRunsOf, parentWaiting } from "../helpers/subagents.js";

/**
 * Phase D Task 6: a person's invocation of a forked skill (`context: fork`) starts its own run,
 * whose `prepare` dispatches the sub-agent through phase C before any model call and waits; the
 * child's report is logged as the model-visible `skill_fork_result` and the parent answers.
 * One kernel, model-script, fake sandbox and SeaweedFS; skill and template rows written directly.
 */

const MODEL_SCRIPT = fileURLToPath(
  new URL("../fixtures/plugins/model-script/index.ts", import.meta.url),
);
const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

const CHILD = "You are a sub-agent";
const HEADER = 'Report from the sub-agent that ran the skill "review":';
const RULES: ScriptRule[] = [
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "HANG" },
    reply: { text: "hung", barrier: { name: "hang", count: 99, timeoutMs: 60_000 } },
  },
  { when: { systemIncludes: CHILD }, reply: { text: "child report" } },
  {
    when: { lastUserIncludes: "HOLD" },
    reply: { text: "held", barrier: { name: "hold", count: 99, timeoutMs: 3_000 } },
  },
  { when: { lastUserIncludes: "Report from the sub-agent" }, reply: { text: "parent answered" } },
  { when: {}, reply: { text: "plain answer" } },
];

const capture = captureProviderRequests();

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
let subQueue: Queue;

beforeAll(async () => {
  capture.install();
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-forked-skill-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, OBJECT_STORE, SANDBOX_FAKE],
        extensionConfig: {
          "model-script": { rules: RULES },
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
          "sandbox-fake": { root },
        },
      },
    ),
  );
  subQueue = new Queue(SUBAGENT_RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
}, 180_000);

afterAll(async () => {
  capture.restore();
  await k?.close();
  await subQueue?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let ownerId: string;
let orgId: string;

beforeEach(async () => {
  await subQueue.resume();
  scriptRules([]);
  capture.reset();
  await truncateTables(
    db,
    "capybara.skill_change_requests, capybara.agent_template_versions, capybara.agent_templates, capybara.skill_versions, capybara.skills, capybara.catalog_items, capybara.sandboxes, capybara.approvals, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts, capybara.audit_events",
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
});

const seedForked = (name: string, body: string, agent?: string, files?: Record<string, string>) =>
  seedForkedSkill(
    { db, storage: k.app.get(StorageService), orgId, ownerId },
    name,
    body,
    agent,
    files,
  );
const catalogItem = (name: string) => catalogItemNamed(db, name);

/** The plugin agent template `acme:code-reviewer`. */
async function reviewerTemplate(): Promise<string> {
  const id = randomUUID();
  await catalogItem("acme");
  await db
    .insertInto("agent_templates")
    .values({ id, org_id: orgId, name: "code-reviewer", plugin_name: "acme", current_version: 1 })
    .execute();
  await db
    .insertInto("agent_template_versions")
    .values({
      template_id: id,
      version: 1,
      definition: JSON.stringify({
        name: "code-reviewer",
        description: "Reviews code.",
        instructions: "Review the code.",
      }),
    })
    .execute();
  return id;
}

/** An agent with these org skills and plugin templates, and no `agent` tool. */
async function createAgent(skills: string[], templates: string[] = []): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: "Lead the work.",
        model: { provider: "model-script", model: "script-1" },
        tools: [],
        skills: { orgSkills: skills },
        ...(templates.length > 0 && { subagents: { templates } }),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

const invoke = async (conv: string, name: string, text: string, clientMessageId?: string) => {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
    payload: {
      text,
      skill: { name },
      ...(clientMessageId !== undefined && { clientMessageId }),
    },
  });
  expect(res.statusCode, res.body).toBe(202);
  return (res.json() as { event: { seq: number } }).event.seq;
};

const say = async (conv: string, text: string) => {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
    payload: { text },
  });
  expect(res.statusCode, res.body).toBe(202);
  return (res.json() as { event: { seq: number } }).event.seq;
};

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);
const texts = (content: readonly { type: string; text?: string }[] | string): string[] =>
  typeof content === "string"
    ? [content]
    : content.flatMap((b) => (b.type === "text" && b.text !== undefined ? [b.text] : []));
const finalText = (events: ConversationEvent[]) =>
  texts(ofType(events, "assistant_message").at(-1)?.payload.content ?? []).join("");
const isChild = (r: { system: { text: string }[] }) => r.system.some((s) => s.text.includes(CHILD));

/**
 * The history is append-only: each parent request is a strict prefix of the next one, its last
 * turn included, so a report merged into an already sent turn fails (batch 3 review C1, batch 4
 * review I1).
 */
function expectAppendOnly(reqs: readonly { messages: unknown[] }[]): void {
  for (let i = 1; i < reqs.length; i++) {
    const prev = (reqs[i - 1] as { messages: unknown[] }).messages;
    const next = (reqs[i] as { messages: unknown[] }).messages;
    expect(next.slice(0, prev.length), `request ${i}`).toEqual(prev);
  }
}

const LEAD = (agentType: string, args: string) =>
  `The user ran the skill "review" in a sub-agent (${agentType}) with /review${args === "" ? "" : ` ${args}`}. The sub-agent gets the skill's instructions as its task; its report follows. Do not do the task yourself.`;

describe("forked skills (phase D Task 6)", { timeout: 90_000 }, () => {
  it("/review src dispatches acme:code-reviewer before any model call; the report precedes the parent's answer", async () => {
    const review = await seedForked("review", "Review $ARGUMENTS carefully.", "code-reviewer");
    const template = await reviewerTemplate();
    const agentId = await createAgent([review.id], [template]);
    const conv = await createConv(owner, orgId, agentId);
    await subQueue.pause();
    const seq = await invoke(conv, "review", "src");
    const { runId, children } = await parentWaiting(db, conv, 1);
    let events = await eventsOf(db, conv);
    const msg = ofType(events, "user_message")[0];
    expect(texts(msg?.payload.content ?? [])).toEqual([LEAD("acme:code-reviewer", "src")]);
    expect(msg?.payload.skill).toMatchObject({
      id: review.id,
      mode: "fork",
      agentType: "acme:code-reviewer",
      arguments: "src",
    });
    const dispatched = ofType(events, "subagent_dispatched");
    expect(dispatched.map((d) => d.payload)).toEqual([
      expect.objectContaining({
        callId: `skill-${seq}`,
        invokedSeq: seq,
        step: 0,
        agentType: "acme:code-reviewer",
      }),
    ]);
    expect(ofType(events, "model_call")).toEqual([]);
    expect(capture.sent).toEqual([]);

    await subQueue.resume();
    await waitForTerminal(db, conv, 1, 30_000);
    events = await eventsOf(db, conv);
    const child = children[0] as (typeof children)[number];
    const cev = await eventsOf(db, child.conversationId);
    const started = ofType(cev, "subagent_started")[0];
    expect(started?.payload.agentType).toBe("acme:code-reviewer");
    expect(started?.payload.template.invokedSkill).toEqual({
      id: review.id,
      version: 1,
      name: "review",
    });
    // the child's first request: its system text, and the rendered skill as the only message
    const childReqs = capture.sent.filter(isChild);
    expect(childReqs[0]?.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<skill_invocation name="review" version="1">\nReview src carefully.\n</skill_invocation>',
          },
        ],
      },
    ]);
    const report = ofType(events, "skill_fork_result");
    expect(report).toHaveLength(1);
    expect(report[0]?.payload).toMatchObject({
      invokedSeq: seq,
      subagentId: child.conversationId,
      childRunId: child.runId,
    });
    const text = report[0]?.payload.text ?? "";
    expect(text.startsWith(`${HEADER}\n\nchild report\n\n[agentId: ${child.conversationId}`)).toBe(
      true,
    );
    // the parent need not have the agent tool: no resume hint (batch 3 review m2)
    expect(text).toMatch(/ tokens\.\]$/);
    expect(text).not.toContain("resume");
    // the parent's request: the report right after the invocation, in the same user turn
    const parentReqs = capture.sent.filter((r) => !isChild(r));
    expect(parentReqs).toHaveLength(1);
    expect(parentReqs[0]?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: LEAD("acme:code-reviewer", "src") },
          { type: "text", text },
        ],
      },
    ]);
    expect(finalText(events)).toBe("parent answered");
    expect(ofType(events, "run_finished").map((e) => e.runId)).toEqual([runId]);
    // model_call only after the report
    const firstCall = ofType(events, "model_call")[0];
    expect((firstCall?.seq ?? 0) > (report[0]?.seq ?? Infinity)).toBe(true);
  });

  it("agent: Explore and an unknown agent both run as general-purpose; the unknown one is warned", async () => {
    const explore = await seedForked("review", "Explore it.", "Explore");
    const nobody = await seedForked("deep", "Deep.", "nonexistent");
    const agentId = await createAgent([explore.id, nobody.id]);
    const conv = await createConv(owner, orgId, agentId);
    await invoke(conv, "review", "");
    await waitForTerminal(db, conv, 1, 30_000);
    await invoke(conv, "deep", "x");
    await waitForTerminal(db, conv, 2, 30_000);
    const children = await childRunsOf(db, conv);
    expect(children).toHaveLength(2);
    const started = await Promise.all(
      children.map(
        async (c) => ofType(await eventsOf(db, c.conversationId), "subagent_started")[0],
      ),
    );
    expect(started.map((s) => s?.payload.agentType)).toEqual([
      "general-purpose",
      "general-purpose",
    ]);
    expect(started[0]?.payload.warnings ?? []).toEqual([]);
    expect(started[1]?.payload.warnings).toContain(
      'Skill "deep" asked for sub-agent type "nonexistent", which this agent does not have; it ran as general-purpose.',
    );
    expect(ofType(await eventsOf(db, conv), "skill_fork_result")).toHaveLength(2);
  });

  it("Review Focus 3: a fork posted while an inline run is active starts its own run, dispatching first", async () => {
    const review = await seedForked("review", "Review it.");
    const agentId = await createAgent([review.id]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, "HOLD");
    await waitFor(
      async () => (await runsOf(db, conv)).some((r) => r.status === "running") || null,
      10_000,
      "first run running",
    );
    const forkSeq = await invoke(conv, "review", "");
    await waitForTerminal(db, conv, 2, 40_000);
    const events = await eventsOf(db, conv);
    const runs = await runsOf(db, conv);
    expect(runs).toHaveLength(2);
    const [first, second] = runs as unknown as [{ id: string }, { id: string }];
    const firstEnd = ofType(events, "run_finished").find((e) => e.runId === first.id);
    expect(firstEnd?.payload.consumedUpToSeq).toBeLessThan(forkSeq);
    // nothing of the first run absorbed the fork
    for (const c of ofType(events, "model_call").filter((e) => e.runId === first.id)) {
      expect(c.payload.request.absorbedUpToSeq ?? 0).toBeLessThan(forkSeq);
    }
    const ofSecond = events.filter((e) => e.runId === second.id);
    const dispatchAt = ofSecond.findIndex((e) => e.type === "subagent_dispatched");
    const callAt = ofSecond.findIndex((e) => e.type === "model_call");
    expect(dispatchAt).toBeGreaterThanOrEqual(0);
    expect(callAt).toBeGreaterThan(dispatchAt);
    expect(finalText(events)).toBe("parent answered");
  });

  it("Review Focus 4: the same clientMessageId twice gives one message and one dispatch", async () => {
    const review = await seedForked("review", "Review it.");
    const agentId = await createAgent([review.id]);
    const conv = await createConv(owner, orgId, agentId);
    await subQueue.pause();
    const a = await invoke(conv, "review", "x", "client-1");
    const b = await invoke(conv, "review", "x", "client-1");
    expect(b).toBe(a);
    await parentWaiting(db, conv, 1);
    await subQueue.resume();
    await waitForTerminal(db, conv, 1, 30_000);
    const events = await eventsOf(db, conv);
    expect(ofType(events, "user_message")).toHaveLength(1);
    expect(await childRunsOf(db, conv)).toHaveLength(1);
    expect(ofType(events, "subagent_dispatched")).toHaveLength(1);
  });

  it("stopping the parent while the child works: both aborted, the report has the stop text and comes before the next message", async () => {
    const review = await seedForked("review", "HANG $ARGUMENTS");
    const agentId = await createAgent([review.id]);
    const conv = await createConv(owner, orgId, agentId);
    await invoke(conv, "review", "now");
    const { runId } = await parentWaiting(db, conv, 1);
    await waitFor(
      async () => (await childRunsOf(db, conv)).every((c) => c.status === "running") || null,
      20_000,
      "child running",
    );
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitFor(
      async () => (await childRunsOf(db, conv)).every((c) => c.status === "aborted") || null,
      15_000,
      "child aborted",
    );
    let events = await eventsOf(db, conv);
    expect(ofType(events, "run_aborted").map((e) => e.runId)).toEqual([runId]);
    const report = ofType(events, "skill_fork_result");
    expect(report.map((r) => r.payload.text)).toEqual([
      `${HEADER}\n\n${AGENT_STOPPED_WITH_RUN_TEXT}`,
    ]);
    capture.reset();
    await say(conv, "and now?");
    await waitForTerminal(db, conv, 2, 30_000);
    events = await eventsOf(db, conv);
    const req = capture.sent.filter((r) => !isChild(r))[0];
    expect(req?.messages.map((m) => texts(m.content))).toEqual([
      [LEAD("general-purpose", "now"), `${HEADER}\n\n${AGENT_STOPPED_WITH_RUN_TEXT}`],
      ["and now?"],
    ]);
  });

  it("the wait sweep writes a missing report of a finished fork run", async () => {
    const review = await seedForked("review", "Review it.");
    const agentId = await createAgent([review.id]);
    const conv = await createConv(owner, orgId, agentId);
    await invoke(conv, "review", "");
    await waitForTerminal(db, conv, 1, 30_000);
    const [run] = await runsOf(db, conv);
    // a crash before the report: remove it, and age the run past the sweep's grace period
    await db
      .deleteFrom("conversation_events")
      .where("conversation_id", "=", conv)
      .where("type", "=", "skill_fork_result")
      .execute();
    await backdateRun(db, (run as { id: string }).id);
    const r = await k.app.get(Waits).sweep();
    expect(r.repaired).toBeGreaterThanOrEqual(1);
    const report = ofType(await eventsOf(db, conv), "skill_fork_result");
    expect(report).toHaveLength(1);
    expect(report[0]?.payload.text).toContain("child report");
    expect((await k.app.get(Waits).sweep()).repaired).toBe(0);
  });

  it("C1 P1: a message posted during the fork wait is not absorbed by the fork's first step; the report precedes the first model call", async () => {
    const review = await seedForked("review", "Review it.");
    const agentId = await createAgent([review.id]);
    const conv = await createConv(owner, orgId, agentId);
    await subQueue.pause();
    const forkSeq = await invoke(conv, "review", "src");
    await parentWaiting(db, conv, 1);
    const midSeq = await say(conv, "MID");
    await subQueue.resume();
    await waitFor(
      async () => {
        const r = await runsOf(db, conv);
        return (r.length === 2 && r.every((x) => x.status === "completed")) || null;
      },
      40_000,
      "both runs completed",
    );
    const events = await eventsOf(db, conv);
    const report = ofType(events, "skill_fork_result");
    expect(report).toHaveLength(1);
    const calls = ofType(events, "model_call");
    expect((report[0]?.seq ?? Infinity) < (calls[0]?.seq ?? 0)).toBe(true);
    expect(calls[0]?.payload.request.absorbedUpToSeq).toBe(forkSeq);
    const parent = capture.sent.filter((r) => !isChild(r));
    expect(parent[0]?.messages.map((m) => texts(m.content))).toEqual([
      [LEAD("general-purpose", "src"), report[0]?.payload.text],
    ]);
    expect(
      parent
        .at(-1)
        ?.messages.map((m) => texts(m.content))
        .at(-1),
    ).toEqual(["MID"]);
    expect(midSeq).toBeGreaterThan(forkSeq);
    expectAppendOnly(parent);
  });

  it("C1 P2 (Review Focus 3): a fork and a plain message posted while an inline run is active: the fork dispatches before any model call of its run", async () => {
    const review = await seedForked("review", "Review it.");
    const agentId = await createAgent([review.id]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, "HOLD");
    await waitFor(
      async () => (await runsOf(db, conv)).some((r) => r.status === "running") || null,
      10_000,
      "first run running",
    );
    const forkSeq = await invoke(conv, "review", "");
    await say(conv, "AFTER");
    await waitFor(
      async () => {
        const r = await runsOf(db, conv);
        return (
          (r.length >= 3 && r.every((x) => !["queued", "running", "waiting"].includes(x.status))) ||
          null
        );
      },
      40_000,
      "three runs ended",
    );
    const events = await eventsOf(db, conv);
    const forkRun = ofType(events, "subagent_dispatched")[0]?.runId;
    expect(forkRun).toBeDefined();
    const ofFork = events.filter((e) => e.runId === forkRun);
    const dispatchAt = ofFork.findIndex((e) => e.type === "subagent_dispatched");
    const reportAt = ofFork.findIndex((e) => e.type === "skill_fork_result");
    const callAt = ofFork.findIndex((e) => e.type === "model_call");
    expect(dispatchAt).toBeGreaterThanOrEqual(0);
    expect(reportAt).toBeGreaterThan(dispatchAt);
    expect(callAt).toBeGreaterThan(reportAt);
    const report = ofType(events, "skill_fork_result")[0];
    expect(report?.payload.text).toContain("child report");
    expect(report?.payload.invokedSeq).toBe(forkSeq);
    expectAppendOnly(capture.sent.filter((r) => !isChild(r)));
  });

  it("batch 4 S1: two forks and messages during the first fork's wait: append-only, each report before its run's first model call", async () => {
    const review = await seedForked("review", "Review $ARGUMENTS.");
    const agentId = await createAgent([review.id]);
    const conv = await createConv(owner, orgId, agentId);
    await subQueue.pause();
    const one = await invoke(conv, "review", "one");
    await parentWaiting(db, conv, 1);
    await say(conv, "MID1");
    const two = await invoke(conv, "review", "two");
    await say(conv, "MID2");
    await subQueue.resume();
    await waitFor(
      async () => {
        const r = await runsOf(db, conv);
        return (r.length >= 3 && r.every((x) => x.status === "completed")) || null;
      },
      60_000,
      "every run completed",
    );
    const events = await eventsOf(db, conv);
    const reports = ofType(events, "skill_fork_result");
    expect(reports.map((r) => r.payload.invokedSeq)).toEqual([one, two]);
    for (const r of reports) {
      const first = events.find((e) => e.type === "model_call" && e.runId === r.runId);
      expect(first, `a model call of the run of report ${r.seq}`).toBeDefined();
      expect(r.seq).toBeLessThan(first?.seq ?? 0);
    }
    const parent = capture.sent.filter((r) => !isChild(r));
    expectAppendOnly(parent);
    const last = parent.at(-1)?.messages.map((m) => texts(m.content)) ?? [];
    expect(last.flat()).toEqual(
      expect.arrayContaining(["MID1", "MID2", reports[0]?.payload.text, reports[1]?.payload.text]),
    );
  });

  it("batch 4 S4: a fork run ends without its report, the next message is answered, then the sweep writes the report late at its log position", async () => {
    const review = await seedForked("review", "Review it.");
    const agentId = await createAgent([review.id]);
    const conv = await createConv(owner, orgId, agentId);
    await subQueue.pause();
    const forkSeq = await invoke(conv, "review", "now");
    const { runId } = await parentWaiting(db, conv, 1);
    // the run's terminal path skipped pairing: it ended and consumed the fork, with no report
    await db
      .updateTable("runs")
      .set({ status: "aborted", finished_at: sql`now()` })
      .where("id", "=", runId)
      .execute();
    await db
      .updateTable("conversations")
      .set({ consumed_seq: String(forkSeq) })
      .where("id", "=", conv)
      .execute();
    await say(conv, "X");
    await waitForTerminal(db, conv, 1, 30_000);
    await waitFor(
      async () =>
        (await runsOf(db, conv)).filter((r) => r.status === "completed").length === 1 || null,
      30_000,
      "X answered",
    );
    expect(ofType(await eventsOf(db, conv), "skill_fork_result")).toEqual([]);
    await backdateRun(db, runId);
    expect((await k.app.get(Waits).sweep()).repaired).toBeGreaterThanOrEqual(1);
    const report = ofType(await eventsOf(db, conv), "skill_fork_result");
    expect(report).toHaveLength(1);
    expect(report[0]?.payload.text).toBe(`${HEADER}\n\n${AGENT_STOPPED_WITH_RUN_TEXT}`);
    await subQueue.resume();
    await say(conv, "Y");
    await waitFor(
      async () =>
        (await runsOf(db, conv)).filter((r) => r.status === "completed").length === 2 || null,
      30_000,
      "Y answered",
    );
    const parent = capture.sent.filter((r) => !isChild(r));
    expectAppendOnly(parent);
    expect(parent.at(-1)?.messages.map((m) => texts(m.content))).toEqual([
      [LEAD("general-purpose", "now")],
      ["X"],
      ["plain answer"],
      [report[0]?.payload.text],
      ["Y"],
    ]);
  });

  it("I1: the wait sweep never selects a finished fork child (its task message carries the skill record)", async () => {
    const review = await seedForked("review", "Review it.");
    const agentId = await createAgent([review.id]);
    const conv = await createConv(owner, orgId, agentId);
    await invoke(conv, "review", "");
    await waitForTerminal(db, conv, 1, 30_000);
    const [run] = await runsOf(db, conv);
    const [child] = await childRunsOf(db, conv);
    await backdateRun(db, (run as { id: string }).id);
    await backdateRun(db, child?.runId as string);
    expect(await unreportedForkRuns(db)).toEqual([]);
  });

  it("m1: the shell-injection line follows the sub-agent's tools, not the parent's", async () => {
    const body = "Run !`ls` first.\nReview $ARGUMENTS.";
    const narrow = await seedForked("review", body, "code-reviewer");
    const general = await seedForked("probe", body);
    const template = randomUUID();
    await catalogItem("acme");
    await db
      .insertInto("agent_templates")
      .values({
        id: template,
        org_id: orgId,
        name: "code-reviewer",
        plugin_name: "acme",
        current_version: 1,
      })
      .execute();
    await db
      .insertInto("agent_template_versions")
      .values({
        template_id: template,
        version: 1,
        definition: JSON.stringify({
          name: "code-reviewer",
          description: "Reviews code.",
          instructions: "Review the code.",
          tools: [],
        }),
      })
      .execute();
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Lead",
          instructions: "Lead the work.",
          model: { provider: "model-script", model: "script-1" },
          tools: [{ kind: "builtin", name: "sandbox_bash" }],
          skills: { orgSkills: [narrow.id, general.id] },
          subagents: { templates: [template] },
        },
        visibility: "org",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const agentId = (res.json() as { agent: { id: string } }).agent.id;
    const conv = await createConv(owner, orgId, agentId);
    await invoke(conv, "review", "a");
    await waitForTerminal(db, conv, 1, 30_000);
    await invoke(conv, "probe", "b");
    await waitForTerminal(db, conv, 2, 30_000);
    const children = await childRunsOf(db, conv);
    const tasks = await Promise.all(
      children.map(async (c) =>
        texts(
          ofType(await eventsOf(db, c.conversationId), "user_message")[0]?.payload.content ?? [],
        ).join(""),
      ),
    );
    const HINT = "run those commands with sandbox_bash";
    expect(tasks.map((t) => t.includes(HINT))).toEqual([false, true]);
  });

  describe("final review I1: the sub-agent's skill_load of the invoked skill", () => {
    const SCRIPT = { "scripts/run.sh": '#!/bin/sh\necho "review ok"\n' };
    const LOAD_RULES: ScriptRule[] = [
      {
        when: { systemIncludes: CHILD, lastToolResultIncludes: "Loaded skill" },
        reply: { text: "child loaded" },
      },
      {
        when: { systemIncludes: CHILD, assistantTurns: 0 },
        reply: { toolCalls: [{ name: "skill_load", input: { name: "review" } }] },
      },
      { when: { systemIncludes: CHILD }, reply: { text: "child refused" } },
    ];

    /** The parent agent: sandbox_bash, the given skills and sub-agents. */
    async function lead(skills: string[], subagents?: Record<string, unknown>): Promise<string> {
      const res = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/agents`,
        payload: {
          definition: {
            name: "Lead",
            instructions: "Lead the work.",
            model: { provider: "model-script", model: "script-1" },
            tools: [{ kind: "builtin", name: "sandbox_bash" }],
            skills: { orgSkills: skills },
            ...(subagents !== undefined && { subagents }),
          },
          visibility: "org",
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { agent: { id: string } }).agent.id;
    }

    /** The child's skill_load result, after the parent's fork run ended. */
    async function childLoad(conv: string): Promise<{ isError: boolean; content: string }> {
      await waitForTerminal(db, conv, 1, 60_000);
      const [child] = await childRunsOf(db, conv);
      const events = await eventsOf(db, child?.conversationId as string);
      const result = ofType(events, "tool_result").find((r) => r.payload.toolKey === "skill_load");
      expect(result, "the child called skill_load").toBeDefined();
      return {
        isError: result?.payload.isError === true,
        content: JSON.stringify(result?.payload.content),
      };
    }

    it("a general-purpose child loads the invoked skill and copies its script", async () => {
      scriptRules(LOAD_RULES);
      const review = await seedForked("review", "Review $ARGUMENTS.", undefined, SCRIPT);
      const conv = await createConv(owner, orgId, await lead([review.id]));
      await invoke(conv, "review", "src");
      const r = await childLoad(conv);
      expect(r.isError, r.content).toBe(false);
      expect(r.content).toContain("/skills/review/");
    });

    it("an org-agent child loads the invoked skill (checked against the parent's agent)", async () => {
      scriptRules(LOAD_RULES);
      const review = await seedForked("review", "Review $ARGUMENTS.", "analyst", SCRIPT);
      const analyst = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/agents`,
        payload: {
          definition: {
            name: "Analyst",
            instructions: "Analyse.",
            model: { provider: "model-script", model: "script-1" },
            tools: [{ kind: "builtin", name: "sandbox_bash" }],
            subagents: { dispatchable: true },
          },
          visibility: "org",
        },
      });
      expect(analyst.statusCode, analyst.body).toBe(201);
      const analystId = (analyst.json() as { agent: { id: string } }).agent.id;
      const conv = await createConv(
        owner,
        orgId,
        await lead([review.id], {
          agents: [{ agentId: analystId, as: "analyst", description: "Analyses." }],
        }),
      );
      await invoke(conv, "review", "src");
      const msg = ofType(await eventsOf(db, conv), "user_message")[0];
      expect(msg?.payload.skill).toMatchObject({ mode: "fork", agentType: "analyst" });
      const r = await childLoad(conv);
      expect(r.isError, r.content).toBe(false);
      expect(r.content).toContain("/skills/review/");
    });

    it("a trial draft of the parent conversation loads in the child", async () => {
      scriptRules(LOAD_RULES);
      const agentId = await lead([]);
      const conv = await createConv(owner, orgId, agentId);
      const { prefix, manifest } = await writeForkedSkillFiles(
        { storage: k.app.get(StorageService), orgId },
        "review",
        "Review $ARGUMENTS.",
        undefined,
        SCRIPT,
      );
      await db
        .insertInto("skill_change_requests")
        .values({
          id: randomUUID(),
          org_id: orgId,
          agent_id: agentId,
          skill_id: null,
          proposed_version: JSON.stringify({ skillId: randomUUID(), version: 1, manifest }),
          object_prefix: prefix,
          requested_by_account: ownerId,
          requested_in_conversation: conv,
        })
        .execute();
      await invoke(conv, "review", "src");
      const r = await childLoad(conv);
      expect(r.isError, r.content).toBe(false);
      expect(r.content).toContain("/skills/review/");
    });

    it("Review Focus 5 in the child: deleted after the dispatch -> removed", async () => {
      scriptRules(LOAD_RULES);
      const review = await seedForked("review", "Review $ARGUMENTS.", undefined, SCRIPT);
      const conv = await createConv(owner, orgId, await lead([review.id]));
      await subQueue.pause();
      await invoke(conv, "review", "src");
      await parentWaiting(db, conv, 1);
      await db
        .updateTable("skills")
        .set({ deleted_at: new Date() })
        .where("id", "=", review.id)
        .execute();
      await subQueue.resume();
      const r = await childLoad(conv);
      expect(r.isError).toBe(true);
      expect(r.content).toContain('Skill \\"review\\" was removed');
    });
  });
});
