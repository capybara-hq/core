import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { createKv } from "../../src/ctx/kv.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  TOO_MANY_WATCHED_WAITS_TEXT,
  WAIT_SKIPPED_TEXT,
  watchWithoutWatcherText,
} from "../../src/tools/pipeline.js";
import { QuestionsService } from "../../src/tools/questions.service.js";
import {
  TOOL_WATCH_QUEUE,
  TOOL_WATCH_TIMINGS,
  toolWatchJobId,
} from "../../src/tools/tool-watch-queue.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrgWithProviders,
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
 * Watched input waits (browser long waits spec §5): an extension tool's `InputRequired.watch`
 * parks the run as a question whose watcher the `tool-watch` job polls; `settle`, three failures
 * or a durable refusal wake it (`woken`), the deadline expires it, the person ends it with the
 * form or skips it with a message. `fake-watch`'s `wait` tool is scripted through `ctx.kv`.
 * Polls run every 150 ms here (the `TOOL_WATCH_TIMINGS` seam).
 */

const WAIT = "plugin__fake-watch__wait";
const NOWATCH = "plugin__fake-watch__nowatch";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let kv: ReturnType<typeof createKv>;
let owner: Req;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, fakeExtensionEntry("fake-watch")],
        tools: { maxWatchedWaitsPerAccount: 2 },
      },
    ),
    { overrides: [{ provide: TOOL_WATCH_TIMINGS, useValue: { intervalMs: 150, timeoutMs: 300 } }] },
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  kv = createKv(redis, "fake-watch");
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  const on = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/fake-watch`,
    payload: { enabled: true },
  });
  expect(on.statusCode, on.body).toBe(200);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Waiter",
        instructions: "Wait.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

/** Starts a conversation whose run calls `wait` with `input`; resolves once it is parked. */
async function parked(key: string, input: Record<string, unknown> = {}) {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, `tool:${WAIT}:${JSON.stringify({ key, ...input })}`);
  const q = await waitFor(
    async () =>
      db.selectFrom("questions").selectAll().where("conversation_id", "=", conv).executeTakeFirst(),
    10_000,
    "the watched question",
  );
  await waitFor(
    async () => {
      const run = await db
        .selectFrom("runs")
        .select("status")
        .where("id", "=", q.run_id)
        .executeTakeFirst();
      return run?.status === "waiting";
    },
    10_000,
    "the run waiting",
  );
  return { conv, q };
}

const polls = async (key: string) => Number((await kv.get(`fake-watch:${key}:polls`)) ?? 0);

/** The `wait` call's result, after the run ended. */
async function resultOf(conv: string, toolKey = WAIT) {
  await waitForTerminal(db, conv, 1, 20_000);
  const r = ofType(await eventsOf(db, conv), "tool_result").find(
    (e) => e.payload.toolKey === toolKey,
  );
  expect(r).toBeDefined();
  return r?.payload as { content: string; isError: boolean };
}

const statusOf = async (id: string) =>
  (await db.selectFrom("questions").select("status").where("id", "=", id).executeTakeFirstOrThrow())
    .status;

describe("watched input waits", () => {
  it("parks the run, polls the watcher while pending, and a settle wakes it", async () => {
    const { conv, q } = await parked("go1");
    const asked = ofType(await eventsOf(db, conv), "question_asked")[0];
    expect(asked?.payload.watch).toBe(true);
    // the watcher is polled while the run stays parked
    await waitFor(async () => (await polls("go1")) >= 2, 10_000, "two polls");
    expect(
      (
        await db
          .selectFrom("runs")
          .select("status")
          .where("id", "=", q.run_id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("waiting");
    await kv.set("fake-watch:go1", "go", { ttlSeconds: 60 });
    const r = await resultOf(conv);
    expect(JSON.parse(r.content)).toEqual({ outcome: "woken", answer: null, signal: "go" });
    expect(await statusOf(q.id)).toBe("woken");
    const answered = ofType(await eventsOf(db, conv), "question_answered")[0];
    expect(answered?.payload).toMatchObject({ outcome: "woken", answer: null, byAccountId: null });
  });

  it("the watcher gets the call's identity as the handler does", async () => {
    const { conv } = await parked("id1");
    await waitFor(async () => (await kv.get("fake-watch:id1:ctx")) !== null, 10_000, "a poll");
    await kv.set("fake-watch:id1", "go", { ttlSeconds: 60 });
    await resultOf(conv);
    const watched = JSON.parse((await kv.get("fake-watch:id1:ctx")) as string);
    const handled = JSON.parse((await kv.get("fake-watch:id1:handler")) as string);
    expect(watched).toMatchObject({
      orgId,
      conversationId: conv,
      rootConversationId: conv,
      callId: handled.callId,
      idempotencyKey: handled.idempotencyKey,
      role: "owner",
      source: "web",
      state: { key: "id1" },
    });
    expect(watched.accountId).toBe(watched.ownerAccountId);
    expect(handled.conversationId).toBe(conv);
  });

  it("the deadline expires the wait without a settle", async () => {
    const { conv, q } = await parked("late1", { deadlineMs: 1_500 });
    const r = await resultOf(conv);
    expect(JSON.parse(r.content)).toMatchObject({ outcome: "expired", answer: null });
    expect(await statusOf(q.id)).toBe("expired");
  });

  it("a deadline past approvalTimeoutHours is clamped to it", async () => {
    const { q } = await parked("clamp1", { deadlineMs: 48 * 3_600_000 });
    const hours = (new Date(q.expires_at).getTime() - new Date(q.created_at).getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(24, 1);
  });

  it("three failed polls in a row wake the call", async () => {
    await kv.set("fake-watch:fail1", "fail", { ttlSeconds: 60 });
    const { conv, q } = await parked("fail1");
    const r = await resultOf(conv);
    expect(JSON.parse(r.content)).toMatchObject({ outcome: "woken", signal: "fail" });
    expect(await polls("fail1")).toBe(3);
    expect(await statusOf(q.id)).toBe("woken");
  });

  it("a watcher that never answers is aborted and counted as a failure", async () => {
    await kv.set("fake-watch:hang1", "hang", { ttlSeconds: 60 });
    const { conv } = await parked("hang1");
    const r = await resultOf(conv);
    expect(JSON.parse(r.content)).toMatchObject({ outcome: "woken", signal: "hang" });
    expect(await polls("hang1")).toBe(3);
  });

  it("wake, answer and expire at once: exactly one settles the question", async () => {
    const { conv, q } = await parked("race-w", { deadlineMs: 60_000 });
    const questions = k.app.get(QuestionsService);
    // due now: expire may win too
    await sql`UPDATE capybara.questions SET expires_at = now() + interval '200 milliseconds' WHERE id = ${q.id}`.execute(
      raw,
    );
    await Promise.allSettled([
      questions.wake(q.id),
      owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/questions/${q.id}/answer`,
        payload: { answer: { end: "end" } },
      }),
      waitFor(
        async () =>
          (
            await sql<{
              due: boolean;
            }>`SELECT expires_at <= now() AS due FROM capybara.questions WHERE id = ${q.id}`.execute(
              raw,
            )
          ).rows[0]?.due,
        5_000,
        "due",
      ).then(() => questions.expire(q.id)),
    ]);
    await waitForTerminal(db, conv, 1, 20_000);
    const answered = ofType(await eventsOf(db, conv), "question_answered");
    expect(answered).toHaveLength(1);
    expect(["woken", "answered", "expired"]).toContain(await statusOf(q.id));
    expect(
      ofType(await eventsOf(db, conv), "tool_result").filter((e) => e.payload.toolKey === WAIT),
    ).toHaveLength(1);
  });

  it("the person ends the wait with the form: outcome answered", async () => {
    const { conv, q } = await parked("end1");
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/questions/${q.id}/answer`,
      payload: { answer: { end: "end" } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const r = await resultOf(conv);
    expect(JSON.parse(r.content)).toEqual({
      outcome: "answered",
      answer: { end: "end" },
      signal: null,
    });
  });

  it("a message skips the wait: the wait's own text, not an error, and it is never woken", async () => {
    const { conv, q } = await parked("skip1");
    await postMessage(owner, orgId, conv, "never mind");
    await waitForTerminal(db, conv, 1, 20_000);
    const r = ofType(await eventsOf(db, conv), "tool_result").find(
      (e) => e.payload.toolKey === WAIT,
    );
    expect(r?.payload).toMatchObject({ content: WAIT_SKIPPED_TEXT, isError: false });
    expect(await statusOf(q.id)).toBe("skipped");
    const before = await polls("skip1");
    await kv.set("fake-watch:skip1", "go", { ttlSeconds: 60 });
    // the next poll finds it settled and ends without calling the watcher again
    const queue = k.app.get<Queue>(getQueueToken(TOOL_WATCH_QUEUE), { strict: false });
    await waitFor(
      async () => (await queue.getJob(toolWatchJobId(q.id))) === undefined,
      10_000,
      "the poll job ended",
    );
    expect(await polls("skip1")).toBe(before);
    expect(await statusOf(q.id)).toBe("skipped");
  });

  it("the extension switched off in the org wakes the wait without calling the watcher", async () => {
    const { conv, q } = await parked("off1");
    await waitFor(async () => (await polls("off1")) >= 1, 10_000, "a poll");
    const off = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/fake-watch`,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    const before = await polls("off1");
    const r = await resultOf(conv);
    expect(r.isError).toBe(true);
    expect(await statusOf(q.id)).toBe("woken");
    expect(await polls("off1")).toBe(before);
  });

  it("the tool switched off in the org wakes the wait without calling the watcher", async () => {
    const { conv, q } = await parked("toff1");
    await waitFor(async () => (await polls("toff1")) >= 1, 10_000, "a poll");
    const url = `/api/v1/orgs/${orgId}/extensions/fake-watch/tools/wait`;
    const preview = await owner({ method: "PUT", url, payload: { enabled: false } });
    const confirm = (preview.json() as { confirm: string }).confirm;
    const applied = await owner({ method: "PUT", url, payload: { enabled: false, confirm } });
    expect(applied.statusCode, applied.body).toBe(200);
    const before = await polls("toff1");
    const r = await resultOf(conv);
    expect(r.isError).toBe(true);
    expect(await statusOf(q.id)).toBe("woken");
    expect(await polls("toff1")).toBe(before);
  });

  it("a watched wait from a tool without a watcher is an error result", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, `tool:${NOWATCH}:{}`);
    const r = await resultOf(conv, NOWATCH);
    expect(r).toMatchObject({ content: watchWithoutWatcherText(NOWATCH), isError: true });
    const qs = await db
      .selectFrom("questions")
      .select("id")
      .where("conversation_id", "=", conv)
      .execute();
    expect(qs).toEqual([]);
  });

  it("the account's pending watched waits are capped", async () => {
    await parked("cap1");
    await parked("cap2");
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, `tool:${WAIT}:${JSON.stringify({ key: "cap3" })}`);
    const r = await resultOf(conv);
    expect(r).toMatchObject({ content: TOO_MANY_WATCHED_WAITS_TEXT, isError: true });
  });

  it("concurrent asks at the cap: exactly one passes", async () => {
    await parked("race0");
    const convs = await Promise.all([
      createConv(owner, orgId, agentId),
      createConv(owner, orgId, agentId),
    ]);
    await Promise.all(
      convs.map((c, i) =>
        postMessage(owner, orgId, c, `tool:${WAIT}:${JSON.stringify({ key: `race${i + 1}` })}`),
      ),
    );
    // one parks; the other ends with the cap's text
    const states = await waitFor(
      async () => {
        const out = await Promise.all(
          convs.map(async (c) => {
            const q = await db
              .selectFrom("questions")
              .select("status")
              .where("conversation_id", "=", c)
              .executeTakeFirst();
            const r = ofType(await eventsOf(db, c), "tool_result").find(
              (e) => e.payload.toolKey === WAIT,
            );
            return q?.status === "pending" ? "parked" : r ? r.payload.content : null;
          }),
        );
        return out.every((x) => x !== null) ? out : null;
      },
      20_000,
      "both runs settled",
    );
    expect([...states].sort()).toEqual(["parked", TOO_MANY_WATCHED_WAITS_TEXT].sort());
    const count = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM capybara.questions WHERE status = 'pending'`.execute(raw);
    expect(count.rows[0]?.n).toBe(2);
  });
});
