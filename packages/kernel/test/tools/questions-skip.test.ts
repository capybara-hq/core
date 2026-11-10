import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { Waits } from "../../src/runtime/waits.js";
import { INPUT_SKIPPED_TEXT, QUESTION_SKIPPED_TEXT } from "../../src/tools/pipeline.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { seedQueued } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
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
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Reply while a question waits (spec 2026-11-10): a message by the run's starter closes the run's
 * pending questions as skipped, the run resumes at once and the model reads the skipped result,
 * then the message. Two replicas: A (api + worker), B (api only).
 */

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let ka: TestKernel;
let kb: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let reqA: Req;
let reqB: Req;
let orgId: string;
let ownerId: string;

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);
const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const urls = { pg: pgc.url, redis: rd.url };
  const plugins = [MODEL_FAKE, MEM_CONNECTOR];
  ka = await startKernel(runConfig(urls, { extensions: plugins, roles: ["api", "worker"] }));
  kb = await startKernel(runConfig(urls, { extensions: plugins, roles: ["api"] }));
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
}, 120_000);

afterAll(async () => {
  await kb?.close();
  await ka?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  const owner = await accountsFor(db).createLocal({
    login: "owner",
    password: PW,
    displayName: "O",
  });
  ownerId = owner.id;
  memState().askCalls = [];
  reqA = await session(ka, "owner");
  reqB = await session(kb, "owner");
  orgId = await createOrg(reqA);
});

async function enableMem(): Promise<void> {
  const en = await reqA({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/mem-connector`,
    payload: { enabled: true },
  });
  expect(en.statusCode, en.body).toBe(200);
}

async function createAgent(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await reqA({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        ...extra,
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

const opt = (label: string) => ({ label, description: `${label} option` });
const question = (q = "Which database should I use?") => ({
  question: q,
  header: "Database",
  multiSelect: false,
  options: [opt("Postgres"), opt("Mongo")],
});
const ASK_INPUT = { questions: [question()] };
const ASK = `tool:AskUserQuestion:${JSON.stringify(ASK_INPUT)}`;

const runStatus = async (runId: string) =>
  (await db.selectFrom("runs").select("status").where("id", "=", runId).executeTakeFirst())?.status;

/** Waits until `n` questions were asked in `convId` and the run waits; returns the last run. */
async function waiting(convId: string, n = 1) {
  const asked = await waitFor(
    async () => {
      const qs = ofType(await eventsOf(db, convId), "question_asked");
      return qs.length >= n ? qs : null;
    },
    10_000,
    `${n} question(s) asked`,
  );
  const runId = asked.at(-1)?.runId as string;
  await waitFor(async () => (await runStatus(runId)) === "waiting", 10_000, "run waiting");
  return { runId, questionIds: asked.map((e) => e.payload.questionId) };
}

const questionRow = (id: string) =>
  db
    .selectFrom("questions")
    .select(["status", "answered_by"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

const send = (r: Req, convId: string, body: Record<string, unknown>) =>
  r({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
    payload: body,
  });

const answer = (r: Req, id: string, body: Record<string, unknown>) =>
  r({ method: "POST", url: `/api/v1/orgs/${orgId}/questions/${id}/answer`, payload: body });

describe("a message skips the pending question", { timeout: 60_000 }, () => {
  it("the starter's message skips the question; the run resumes at once and reads the skipped result, then the message", async () => {
    const convId = await createConv(reqA, orgId, await createAgent());
    await postMessage(reqA, orgId, convId, ASK);
    const { runId, questionIds } = await waiting(convId);
    const [qid] = questionIds as [string];

    // sent on B (api only): the run resumes on A's worker, no timeout job involved
    const msgSeq = await postMessage(reqB, orgId, convId, "echo:moved on");
    await waitForTerminal(db, convId, 1);

    expect(await questionRow(qid)).toEqual({ status: "skipped", answered_by: ownerId });
    const evs = await eventsOf(db, convId);
    const answered = ofType(evs, "question_answered");
    expect(answered.map((e) => e.payload)).toEqual([
      {
        questionId: qid,
        callId: expect.any(String),
        answer: null,
        byAccountId: ownerId,
        outcome: "skipped",
        skippedBySeq: msgSeq,
      },
    ]);
    expect(answered[0]?.seq).toBeGreaterThan(msgSeq);
    expect(answered[0]?.runId).toBe(runId);
    expect(ofType(evs, "tool_result").map((e) => e.payload)).toMatchObject([
      {
        toolKey: "AskUserQuestion",
        content: QUESTION_SKIPPED_TEXT,
        isError: false,
        display: {
          summary: {
            zh: "用户没有回答，直接发了消息",
            en: "User sent a message instead of answering",
          },
        },
      },
    ]);
    // the tool was not called again: no second start for the call
    expect(ofType(evs, "tool_call_started")).toHaveLength(1);
    const calls = ofType(evs, "model_call");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.payload.request.absorbedUpToSeq).toBeGreaterThanOrEqual(msgSeq);
    expect(ofType(evs, "run_finished").map((e) => e.runId)).toEqual([runId]);
    const reply = ofType(evs, "assistant_message").at(-1);
    expect(reply?.payload.content).toEqual([{ type: "text", text: "moved on" }]);

    // the card's answer after the skip: 409 with the skip reason
    const late = await answer(reqB, qid, { answer: { q0: "Postgres" } });
    expect(late.statusCode, late.body).toBe(409);
    expect(errCode(late)).toBe("question.already_answered");
    expect((late.json() as { error: { message: string } }).error.message).toBe(
      "Question was skipped: the user sent a message instead",
    );
    const got = await reqB({ method: "GET", url: `/api/v1/orgs/${orgId}/questions/${qid}` });
    expect(got.json()).toMatchObject({ question: { status: "skipped" } });
  });

  it("an overdue question is not skipped: its expiry wins and the message follows the expired result", async () => {
    const convId = await createConv(reqA, orgId, await createAgent());
    await postMessage(reqA, orgId, convId, ASK);
    const { questionIds } = await waiting(convId);
    const [qid] = questionIds as [string];
    await sql`UPDATE capybara.questions SET expires_at = now() - interval '1 minute'
      WHERE id = ${qid}`.execute(raw);
    await postMessage(reqA, orgId, convId, "echo:after expiry");
    expect((await questionRow(qid)).status).toBe("pending");
    // the wait-timeout job's work: expire, then resume
    await ka.app.get(Waits).expire("input", qid);
    expect((await questionRow(qid)).status).toBe("expired");
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "question_answered").map((e) => e.payload.outcome)).toEqual(["expired"]);
    expect(ofType(evs, "tool_result")[0]?.payload.content).toMatch(/did not answer within/);
  });

  it("a message in another conversation skips nothing", async () => {
    const agentId = await createAgent();
    const convId = await createConv(reqA, orgId, agentId);
    const other = await createConv(reqA, orgId, agentId);
    await postMessage(reqA, orgId, convId, ASK);
    const { runId, questionIds } = await waiting(convId);
    await postMessage(reqA, orgId, other, "echo:elsewhere");
    await waitForTerminal(db, other, 1);
    expect((await questionRow(questionIds[0] as string)).status).toBe("pending");
    expect(await runStatus(runId)).toBe("waiting");
  });

  it("a question of a run someone else started is not skipped (only the starter may skip)", async () => {
    const convId = await createConv(reqA, orgId, await createAgent());
    await postMessage(reqA, orgId, convId, ASK);
    const { runId, questionIds } = await waiting(convId);
    const other = await accountsFor(db).createLocal({
      login: "other",
      password: PW,
      displayName: "X",
    });
    await testMembers(db).add(orgId, other.id, "member", ownerId);
    await db
      .updateTable("runs")
      .set({ trigger_account_id: other.id })
      .where("id", "=", runId)
      .execute();
    const seq = await postMessage(reqA, orgId, convId, "echo:not mine");
    expect((await questionRow(questionIds[0] as string)).status).toBe("pending");
    expect(await runStatus(runId)).toBe("waiting");
    // the message stays an ordinary interjection
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "question_answered")).toEqual([]);
    expect(evs.find((e) => e.seq === seq)?.type).toBe("user_message");
  });

  it("a retried message (same clientMessageId) skips nothing", async () => {
    const convId = await createConv(reqA, orgId, await createAgent());
    await postMessage(reqA, orgId, convId, ASK);
    const first = await waiting(convId);
    // the message asks again: it skips question 1, the resumed run asks question 2
    const sent = await send(reqA, convId, { text: ASK, clientMessageId: "m-1" });
    expect(sent.statusCode, sent.body).toBe(202);
    const second = await waiting(convId, 2);
    expect((await questionRow(first.questionIds[0] as string)).status).toBe("skipped");
    const retry = await send(reqA, convId, { text: ASK, clientMessageId: "m-1" });
    expect(retry.statusCode, retry.body).toBe(202);
    expect((retry.json() as { event: { seq: number } }).event.seq).toBe(
      (sent.json() as { event: { seq: number } }).event.seq,
    );
    expect((await questionRow(second.questionIds[1] as string)).status).toBe("pending");
    expect(await runStatus(second.runId)).toBe("waiting");
  });

  it("a message logged while the asking step streamed does not skip the question asked after it", async () => {
    const convId = await createConv(reqA, orgId, await createAgent());
    await postMessage(
      reqA,
      orgId,
      convId,
      `slowtool:600:AskUserQuestion:${JSON.stringify(ASK_INPUT)}`,
    );
    await waitForEvent(db, convId, (e) => e.type === "run_started");
    const msgSeq = await postMessage(reqA, orgId, convId, "echo:early");
    const { questionIds } = await waiting(convId);
    const asked = ofType(await eventsOf(db, convId), "question_asked")[0];
    expect(asked?.seq).toBeGreaterThan(msgSeq);
    expect((await questionRow(questionIds[0] as string)).status).toBe("pending");
    const ok = await answer(reqA, questionIds[0] as string, { answer: { q0: "Postgres" } });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, convId, 1);
  });

  it("two questions in one step: the calls run in order, so a message skips the pending one; the next is asked after it and waits (log order)", async () => {
    const convId = await createConv(reqA, orgId, await createAgent());
    const two = [
      { name: "AskUserQuestion", input: { questions: [question("First?")] } },
      { name: "AskUserQuestion", input: { questions: [question("Second?")] } },
    ];
    await postMessage(reqA, orgId, convId, `tools:${JSON.stringify(two)}`);
    const first = await waiting(convId, 1);
    const m1 = await postMessage(reqA, orgId, convId, "echo:neither");
    // the resume runs the second call, which asks after the message: not skipped (D5)
    const second = await waiting(convId, 2);
    expect(second.runId).toBe(first.runId);
    expect((await questionRow(second.questionIds[0] as string)).status).toBe("skipped");
    expect((await questionRow(second.questionIds[1] as string)).status).toBe("pending");
    const m2 = await postMessage(reqA, orgId, convId, "echo:still neither");
    await waitForTerminal(db, convId, 1);
    expect((await questionRow(second.questionIds[1] as string)).status).toBe("skipped");
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "question_answered").map((e) => e.payload.skippedBySeq)).toEqual([m1, m2]);
    expect(ofType(evs, "tool_result").map((e) => e.payload.content)).toEqual([
      QUESTION_SKIPPED_TEXT,
      QUESTION_SKIPPED_TEXT,
    ]);
    // one run, resumed twice; the next model call takes both messages in
    expect(ofType(evs, "model_call")).toHaveLength(2);
    expect(ofType(evs, "model_call")[1]?.payload.request.absorbedUpToSeq).toBeGreaterThanOrEqual(
      m2,
    );
    expect(ofType(evs, "run_finished").map((e) => e.runId)).toEqual([first.runId]);
  });

  it("a question and an approval in one step: the message skips the question, never the approval; the message is taken in after the decision", async () => {
    await enableMem();
    const agentId = await createAgent({
      disabledTools: onlyBuiltins([
        { kind: "builtin", name: "AskUserQuestion" },
        { kind: "plugin", plugin: "mem-connector", name: "echo" },
      ]),
      toolPolicies: { "plugin__mem-connector__echo": "ask" },
    });
    const convId = await createConv(reqA, orgId, agentId);
    const calls = [
      { name: "AskUserQuestion", input: ASK_INPUT },
      { name: "plugin__mem-connector__echo", input: { text: "hi" } },
    ];
    await postMessage(reqA, orgId, convId, `tools:${JSON.stringify(calls)}`);
    const { runId, questionIds } = await waiting(convId);
    const msgSeq = await postMessage(reqA, orgId, convId, "echo:after both");
    expect((await questionRow(questionIds[0] as string)).status).toBe("skipped");
    // the resumed step reaches the second call, which waits for its approval
    const approval = await waitForEvent(db, convId, (e) => e.type === "approval_requested");
    await waitFor(async () => (await runStatus(runId)) === "waiting", 10_000, "run waiting");
    const approvalId = approval.type === "approval_requested" ? approval.payload.approvalId : "";
    const pending = await db
      .selectFrom("approvals")
      .select("status")
      .where("id", "=", approvalId)
      .executeTakeFirstOrThrow();
    expect(pending.status).toBe("pending");
    const decided = await reqB({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
      payload: { decision: "approve", scope: "once" },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    const results = ofType(evs, "tool_result").map((e) => e.payload.content);
    expect(results[0]).toBe(QUESTION_SKIPPED_TEXT);
    expect(results).toHaveLength(2);
    const last = ofType(evs, "model_call").at(-1);
    expect(last?.payload.request.absorbedUpToSeq).toBeGreaterThanOrEqual(msgSeq);
    expect(ofType(evs, "assistant_message").at(-1)?.payload.content).toEqual([
      { type: "text", text: "after both" },
    ]);
  });

  it("a queued item sent now while the question waits skips it like a direct message", async () => {
    const convId = await createConv(reqA, orgId, await createAgent());
    await postMessage(reqA, orgId, convId, ASK);
    const { runId, questionIds } = await waiting(convId);
    const queued = await seedQueued(ka.app, orgId, convId, ownerId, {
      text: "echo:from the queue",
      clientMessageId: "q-1",
    });
    expect(queued.statusCode, queued.body).toBe(201);
    const itemId = (queued.json() as { item: { id: string } }).item.id;
    const res = await reqB({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/queue/${itemId}/send`,
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    await waitForTerminal(db, convId, 1);
    expect((await questionRow(questionIds[0] as string)).status).toBe("skipped");
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "run_finished").map((e) => e.runId)).toEqual([runId]);
    expect(ofType(evs, "assistant_message").at(-1)?.payload.content).toEqual([
      { type: "text", text: "from the queue" },
    ]);
  });

  it("an extension tool's input request: the kernel writes the skipped result and never calls the tool again", async () => {
    await enableMem();
    const agentId = await createAgent({
      disabledTools: onlyBuiltins([{ kind: "plugin", plugin: "mem-connector", name: "ask" }]),
    });
    const convId = await createConv(reqA, orgId, agentId);
    await postMessage(reqA, orgId, convId, 'tool:plugin__mem-connector__ask:{"rounds":1}');
    await waiting(convId);
    await postMessage(reqA, orgId, convId, "echo:no color");
    await waitForTerminal(db, convId, 1);
    expect(memState().askCalls).toHaveLength(1);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "tool_result").map((e) => e.payload)).toMatchObject([
      {
        toolKey: "plugin__mem-connector__ask",
        content: INPUT_SKIPPED_TEXT,
        isError: true,
        display: {
          summary: { zh: "用户没有提供输入，直接发了消息", en: "User sent a message instead" },
        },
      },
    ]);
  });
});

describe("races across replicas (lock order: conversation, then question)", {
  timeout: 180_000,
}, () => {
  const ROUNDS = 12;

  it("answer on B and a message on A at once: exactly one question_answered, no deadlock", async () => {
    const agentId = await createAgent();
    for (let i = 0; i < ROUNDS; i++) {
      const convId = await createConv(reqA, orgId, agentId);
      await postMessage(reqA, orgId, convId, ASK);
      const { questionIds } = await waiting(convId);
      const [a, m] = await Promise.all([
        answer(reqB, questionIds[0] as string, { answer: { q0: "Postgres" } }),
        send(reqA, convId, { text: "echo:raced" }),
      ]);
      expect(m.statusCode, m.body).toBe(202);
      expect([200, 409], a.body).toContain(a.statusCode);
      await waitForTerminal(db, convId, 1, 20_000);
      const evs = await eventsOf(db, convId);
      const outcomes = ofType(evs, "question_answered").map((e) => e.payload.outcome);
      expect(outcomes).toEqual([a.statusCode === 200 ? "answered" : "skipped"]);
      expect(ofType(evs, "tool_result")).toHaveLength(1);
      expect(ofType(evs, "run_finished")).toHaveLength(1);
    }
  });

  it("expiry and a message at once: exactly one wins", async () => {
    const agentId = await createAgent();
    const waits = ka.app.get(Waits);
    for (let i = 0; i < ROUNDS; i++) {
      const convId = await createConv(reqA, orgId, agentId);
      await postMessage(reqA, orgId, convId, ASK);
      const { questionIds } = await waiting(convId);
      const qid = questionIds[0] as string;
      await sql`UPDATE capybara.questions SET expires_at = now() + interval '40 milliseconds'
        WHERE id = ${qid}`.execute(raw);
      await new Promise((r) => setTimeout(r, 40));
      const [e, m] = await Promise.all([
        waits.expire("input", qid),
        send(reqB, convId, { text: "echo:raced" }),
      ]);
      expect(m.statusCode, m.body).toBe(202);
      if (e.notDueUntil !== undefined) {
        await new Promise((r) => setTimeout(r, 60));
        await waits.expire("input", qid);
      }
      await waitForTerminal(db, convId, 1, 20_000);
      const outcomes = ofType(await eventsOf(db, convId), "question_answered").map(
        (x) => x.payload.outcome,
      );
      expect(outcomes).toHaveLength(1);
      expect(["expired", "skipped"]).toContain(outcomes[0]);
    }
  });

  it("stop and a message at once: either stopped (the message starts the next run) or skipped then stopped", async () => {
    const agentId = await createAgent();
    for (let i = 0; i < ROUNDS; i++) {
      const convId = await createConv(reqA, orgId, agentId);
      await postMessage(reqA, orgId, convId, ASK);
      const { questionIds } = await waiting(convId);
      const [stop, m] = await Promise.all([
        reqB({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${convId}/abort` }),
        send(reqA, convId, { text: "echo:raced" }),
      ]);
      expect(m.statusCode, m.body).toBe(202);
      expect([200, 202, 409], stop.body).toContain(stop.statusCode);
      await waitFor(
        async () => {
          const evs = await eventsOf(db, convId);
          const active = await db
            .selectFrom("runs")
            .select("id")
            .where("conversation_id", "=", convId)
            .where("status", "in", ["queued", "running", "waiting"])
            .execute();
          return active.length === 0 && evs.length > 0;
        },
        20_000,
        "runs settled",
      );
      const outcomes = ofType(await eventsOf(db, convId), "question_answered").map(
        (x) => x.payload.outcome,
      );
      expect(outcomes).toHaveLength(1);
      expect(["cancelled", "skipped"]).toContain(outcomes[0]);
      expect((await questionRow(questionIds[0] as string)).status).toBe(outcomes[0]);
    }
  });
});
