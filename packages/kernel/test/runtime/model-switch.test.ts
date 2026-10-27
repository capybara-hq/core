import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import {
  createAgent,
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * UI refresh B Task 8: model and effort switches are `model_switched` events written before the
 * message that carries them; they apply from the next run that starts; a switched-to model that
 * disappears falls back to the agent's model with a logged notice.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let k: Kernel;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;

const FAKE_1 = { provider: "model-fake", model: "fake-1" };
const FAKE_2 = { provider: "model-fake", model: "fake-2" };

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensionConfig: { "model-fake": { models: [{ id: "fake-1" }, { id: "fake-2" }] } },
      },
    ),
  );
}, 120_000);
afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  ownerId = (
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  agentId = await createAgent(owner, orgId, FAKE_1);
});

type Ev = ConversationEvent;
const send = (conv: string, payload: Record<string, unknown>) =>
  owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
    payload,
  });
const ofType = (events: Ev[], type: string) => events.filter((e) => e.type === type);
const callsOfRun = (events: Ev[], runId: string) =>
  events.filter((e) => e.type === "model_call" && e.runId === runId) as Extract<
    Ev,
    { type: "model_call" }
  >[];
const selectionOf = async (conv: string) =>
  (
    (await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations/${conv}` })).json() as {
      conversation: { selection: unknown };
    }
  ).conversation.selection;

describe("model and effort switching", { timeout: 60_000 }, () => {
  it("a message with another model: model_switched before the message, the next run uses it", async () => {
    const conv = await createConv(owner, orgId, agentId);
    expect(await selectionOf(conv)).toEqual({ model: null, effort: null });
    const res = await send(conv, { text: "echo:one", model: FAKE_2 });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, conv, 1, 20_000);
    let events = await eventsOf(db, conv);
    expect(events.slice(0, 2).map((e) => e.type)).toEqual(["model_switched", "user_message"]);
    expect(events[0]?.payload).toEqual({
      model: FAKE_2,
      effort: null,
      byAccountId: ownerId,
      reason: "user",
    });
    const [run1] = await runsOf(db, conv);
    expect(ofType(events, "run_started")[0]?.payload).toMatchObject({ model: FAKE_2 });
    expect(callsOfRun(events, run1?.id as string).map((c) => c.payload.model)).toEqual(["fake-2"]);
    expect(await selectionOf(conv)).toEqual({ model: FAKE_2, effort: null });

    // the same selection again (or nothing) writes no event; the choice stays for the conversation
    expect((await send(conv, { text: "echo:two", model: FAKE_2 })).statusCode).toBe(202);
    await waitForTerminal(db, conv, 2, 20_000);
    events = await eventsOf(db, conv);
    expect(ofType(events, "model_switched")).toHaveLength(1);
    const run2 = (await runsOf(db, conv))[1]?.id as string;
    expect(callsOfRun(events, run2).map((c) => c.payload.model)).toEqual(["fake-2"]);

    // back to the agent's model: the agent's own model normalizes to null
    expect((await send(conv, { text: "echo:three", model: FAKE_1 })).statusCode).toBe(202);
    await waitForTerminal(db, conv, 3, 20_000);
    events = await eventsOf(db, conv);
    expect(ofType(events, "model_switched").at(-1)?.payload).toMatchObject({ model: null });
    const run3 = (await runsOf(db, conv))[2]?.id as string;
    expect(callsOfRun(events, run3).map((c) => c.payload.model)).toEqual(["fake-1"]);
    expect(await selectionOf(conv)).toEqual({ model: null, effort: null });
  });

  it("effort: a declared value reaches the request; an undeclared one is 400 and nothing is written", async () => {
    const conv = await createConv(owner, orgId, agentId);
    expect((await send(conv, { text: "echo:e", effort: "high" })).statusCode).toBe(202);
    await waitForTerminal(db, conv, 1, 20_000);
    const events = await eventsOf(db, conv);
    expect(ofType(events, "model_switched")[0]?.payload).toMatchObject({
      model: null,
      effort: "high",
    });
    const call = ofType(events, "model_call")[0] as Extract<Ev, { type: "model_call" }>;
    expect(call.payload.request.params?.effort).toBe("high");

    const bad = await send(conv, { text: "echo:x", effort: "xhigh" });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: { code: string } }).error.code).toBe("validation_failed");
    const unknown = await send(conv, {
      text: "echo:x",
      model: { provider: "model-fake", model: "nope" },
    });
    expect(unknown.statusCode).toBe(400);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe(
      "agent.model_unavailable",
    );
    // nothing written by the rejected messages (the title call's usage may land meanwhile)
    const written = (evs: Ev[]) => evs.filter((e) => e.type !== "usage");
    expect(written(await eventsOf(db, conv))).toEqual(written(events));
  });

  it("a switch while a run is active applies from the next run", async () => {
    const conv = await createConv(owner, orgId, agentId);
    expect(
      (await send(conv, { text: "slow:40:abcdefghijklmnopqrstuvwxyz0123456789" })).statusCode,
    ).toBe(202);
    await waitForEvent(db, conv, (e) => e.type === "model_call", 10_000);
    expect((await send(conv, { text: "echo:mid", model: FAKE_2 })).statusCode).toBe(202);
    await waitForTerminal(db, conv, 1, 20_000);
    const run1 = (await runsOf(db, conv))[0]?.id as string;
    let events = await eventsOf(db, conv);
    expect(callsOfRun(events, run1).every((c) => c.payload.model === "fake-1")).toBe(true);
    // the next run that starts uses fake-2 (whether or not run 1 absorbed the interjection)
    expect((await send(conv, { text: "echo:after" })).statusCode).toBe(202);
    const runs = await waitForTerminal(db, conv, 2, 20_000);
    events = await eventsOf(db, conv);
    const later = runs.at(-1)?.runId as string;
    expect(callsOfRun(events, later).map((c) => c.payload.model)).toEqual(["fake-2"]);
  });

  it("a switched-to model that disappears falls back to the agent's model with a notice", async () => {
    const conv = await createConv(owner, orgId, agentId);
    expect((await send(conv, { text: "echo:one", model: FAKE_2 })).statusCode).toBe(202);
    await waitForTerminal(db, conv, 1, 20_000);
    // fake-2 leaves the provider's (cached) model list
    const keys = await redis.keys("capk:models:model-fake:*");
    expect(keys.length).toBeGreaterThan(0);
    try {
      for (const key of keys) {
        const list = JSON.parse((await redis.get(key)) as string) as { id: string }[];
        await redis.set(key, JSON.stringify(list.filter((m) => m.id !== "fake-2")), "KEEPTTL");
      }
      expect((await send(conv, { text: "echo:two" })).statusCode).toBe(202);
      await waitForTerminal(db, conv, 2, 20_000);
    } finally {
      await redis.del(...keys);
    }
    const events = await eventsOf(db, conv);
    const run2 = (await runsOf(db, conv))[1]?.id as string;
    const fallback = ofType(events, "model_switched").at(-1) as Ev;
    expect(fallback).toMatchObject({
      runId: run2,
      payload: { model: null, effort: null, byAccountId: null, reason: "unavailable" },
    });
    const started = events.find((e) => e.type === "run_started" && e.runId === run2) as Ev;
    expect(fallback.seq).toBeLessThan(started.seq);
    expect(started.payload).toMatchObject({ model: FAKE_1 });
    expect(callsOfRun(events, run2).map((c) => c.payload.model)).toEqual(["fake-1"]);
    expect(ofType(events, "run_finished")).toHaveLength(2);
    expect(await selectionOf(conv)).toEqual({ model: null, effort: null });
  });

  it("create on first send with a model and effort: the switch precedes the first message", async () => {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations`,
      payload: {
        agentId,
        message: { text: "echo:first", clientMessageId: "m-1", model: FAKE_2, effort: "low" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const { conversation } = res.json() as { conversation: { id: string; selection: unknown } };
    expect(conversation.selection).toEqual({ model: FAKE_2, effort: "low" });
    await waitForTerminal(db, conversation.id, 1, 20_000);
    const events = await eventsOf(db, conversation.id);
    expect(events.slice(0, 2).map((e) => [e.seq, e.type])).toEqual([
      [1, "model_switched"],
      [2, "user_message"],
    ]);
    const call = ofType(events, "model_call")[0] as Extract<Ev, { type: "model_call" }>;
    expect(call.payload.model).toBe("fake-2");
    expect(call.payload.request.params?.effort).toBe("low");
  });
  it("a switch publishes `changed: selection`; a retried old switch does not move the cache", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const spy = vi.spyOn(k.runs.eventLog, "publishChanged");
    try {
      const r1 = await send(conv, { text: "echo:a", clientMessageId: "sw-1", model: FAKE_2 });
      expect(r1.statusCode).toBe(202);
      expect(spy).toHaveBeenCalledWith(conv, "selection");
    } finally {
      spy.mockRestore();
    }
    await waitForTerminal(db, conv, 1, 20_000);
    expect(
      (await send(conv, { text: "echo:b", clientMessageId: "sw-2", model: FAKE_1 })).statusCode,
    ).toBe(202);
    await waitForTerminal(db, conv, 2, 20_000);
    expect(await selectionOf(conv)).toEqual({ model: null, effort: null });
    const before = (await eventsOf(db, conv)).filter((e) => e.type !== "usage");
    // the first message retried: its switch event is deduped, and the cache keeps the log's answer
    expect(
      (await send(conv, { text: "echo:a", clientMessageId: "sw-1", model: FAKE_2 })).statusCode,
    ).toBe(202);
    expect(await selectionOf(conv)).toEqual({ model: null, effort: null });
    expect((await eventsOf(db, conv)).filter((e) => e.type !== "usage")).toEqual(before);
  });

  it("a resumed run keeps the selection it started with after a later switch", async () => {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        // default builtin tools (ask_user) so the run can wait for an answer
        definition: { name: "Asker", instructions: "Ask.", model: FAKE_1 },
        visibility: "org",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const asker = (res.json() as { agent: { id: string } }).agent.id;
    const conv = await createConv(owner, orgId, asker);
    const ask = `tool:ask_user:${JSON.stringify({
      questions: [
        {
          question: "Which one?",
          header: "Pick",
          multiSelect: false,
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
      ],
    })}`;
    expect((await send(conv, { text: ask, model: FAKE_2 })).statusCode).toBe(202);
    const asked = (await waitForEvent(
      db,
      conv,
      (e) => e.type === "question_asked",
      15_000,
    )) as Extract<Ev, { type: "question_asked" }>;
    const runId = asked.runId as string;
    await waitFor(async () =>
      (await runsOf(db, conv)).some((r) => r.id === runId && r.status === "waiting"),
    );
    // switch back to the agent's model while the run waits
    expect((await send(conv, { text: "echo:meanwhile", model: FAKE_1 })).statusCode).toBe(202);
    const answered = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/questions/${asked.payload.questionId}/answer`,
      payload: { answer: { q0: "A" } },
    });
    expect(answered.statusCode, answered.body).toBe(200);
    await waitFor(
      async () => (await runsOf(db, conv)).find((r) => r.id === runId)?.status === "completed",
      20_000,
      "resumed run completed",
    );
    const calls = callsOfRun(await eventsOf(db, conv), runId);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.map((c) => c.payload.model).every((m) => m === "fake-2")).toBe(true);
  });
});

describe("a queued message carries its model / effort pick (final review I1)", {
  timeout: 60_000,
}, () => {
  const enqueue = (conv: string, payload: Record<string, unknown>) =>
    owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/queue`,
      payload,
    });

  it("dispatch writes model_switched before the queued user_message; the run uses the pick", async () => {
    const conv = await createConv(owner, orgId, agentId);
    expect((await send(conv, { text: "slow:30:abcdefghijklmnopqrstuvwxyz0123" })).statusCode).toBe(
      202,
    );
    await waitForEvent(db, conv, (e) => e.type === "model_call", 10_000);
    const q = await enqueue(conv, {
      text: "echo:queued",
      clientMessageId: "q-pick",
      model: FAKE_2,
      effort: "low",
    });
    expect(q.statusCode, q.body).toBe(201);
    expect(q.json().item).toMatchObject({ model: FAKE_2, effort: "low" });
    // nothing is switched while the message waits in the queue
    expect(await selectionOf(conv)).toEqual({ model: null, effort: null });
    const runs = await waitForTerminal(db, conv, 2, 30_000);
    const events = await eventsOf(db, conv);
    const msg = events.find(
      (e) =>
        e.type === "user_message" &&
        (e.payload as { clientMessageId?: string }).clientMessageId === "q-pick",
    ) as Ev;
    const before = events[events.indexOf(msg) - 1] as Ev;
    expect(before.type).toBe("model_switched");
    expect(before.payload).toEqual({
      model: FAKE_2,
      effort: "low",
      byAccountId: ownerId,
      reason: "user",
    });
    const run2 = runs.at(-1)?.runId as string;
    const calls = callsOfRun(events, run2);
    expect(calls.map((c) => c.payload.model)).toEqual(["fake-2"]);
    expect(calls[0]?.payload.request.params?.effort).toBe("low");
    expect(await selectionOf(conv)).toEqual({ model: FAKE_2, effort: "low" });
  });

  it("an undeclared effort or an unknown model is refused when queued, and nothing is queued", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const bad = await enqueue(conv, { text: "echo:x", clientMessageId: "q-bad", effort: "xhigh" });
    expect(bad.statusCode).toBe(400);
    const gone = await enqueue(conv, {
      text: "echo:y",
      clientMessageId: "q-gone",
      model: { provider: "model-fake", model: "nope" },
    });
    expect(gone.statusCode).toBe(400);
    expect(gone.json().error.code).toBe("agent.model_unavailable");
    const list = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/queue`,
    });
    expect(list.json().items).toEqual([]);
    expect(await eventsOf(db, conv)).toEqual([]);
  });

  it("send now carries the pick too", async () => {
    const conv = await createConv(owner, orgId, agentId);
    expect((await send(conv, { text: "slow:30:abcdefghijklmnopqrstuvwxyz0123" })).statusCode).toBe(
      202,
    );
    await waitForEvent(db, conv, (e) => e.type === "model_call", 10_000);
    const q = await enqueue(conv, { text: "echo:now", clientMessageId: "q-now", model: FAKE_2 });
    expect(q.statusCode, q.body).toBe(201);
    const itemId = q.json().item.id as string;
    const now = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/queue/${itemId}/send`,
    });
    expect(now.statusCode, now.body).toBeLessThan(300);
    const events = await eventsOf(db, conv);
    const msg = events.findIndex(
      (e) =>
        e.type === "user_message" &&
        (e.payload as { clientMessageId?: string }).clientMessageId === "q-now",
    );
    expect(events[msg - 1]?.type).toBe("model_switched");
    expect(await selectionOf(conv)).toEqual({ model: FAKE_2, effort: null });
  });
});
