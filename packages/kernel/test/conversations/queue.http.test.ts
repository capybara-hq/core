import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentsService } from "../../src/agents/agents.service.js";
import { ConversationsService } from "../../src/conversations/conversations.service.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { ConversationQueue, QUEUE_MAX_ITEMS } from "../../src/conversations/queue.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { testMembers } from "../helpers/members.js";
import {
  createAgent,
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  runsOf,
  session,
  sleep,
  startKernel,
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";
import { openSse } from "../helpers/sse.js";

/**
 * UI refresh B Task 9: queued messages. They live in PG (not the log) until sent, go out one at a
 * time after each run ends (never ahead of an interjection), pause when a run fails or is stopped,
 * and "send now" turns one into an interjection.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let k: Kernel;
let owner: Req;
let other: Req;
let ownerId: string;
let ownerCookie: () => string;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] }));
}, 120_000);
afterAll(async () => {
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  const accounts = new AccountsService(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  const otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "X" }))
    .id;
  const jar = cookieJar();
  owner = asUser(k.http, jar);
  const login = await owner({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  ownerCookie = () => jar.header() as string;
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, otherId, "member", ownerId);
  other = await session(k, "other");
  agentId = await createAgent(owner, orgId);
});

interface Item {
  id: string;
  text: string;
  position: number;
  clientMessageId: string;
  files: unknown[];
  attachments: unknown[];
}
const base = (conv: string) => `/api/v1/orgs/${orgId}/conversations/${conv}/queue`;
const enqueue = (conv: string, text: string, clientMessageId = randomUUID(), as = owner) =>
  as({ method: "POST", url: base(conv), payload: { text, clientMessageId } });
const queueOf = async (conv: string) => {
  const r = await owner({ method: "GET", url: base(conv) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { items: Item[]; paused: boolean };
};
const userTexts = async (conv: string) =>
  (await eventsOf(db, conv))
    .filter((e) => e.type === "user_message")
    .map((e) => {
      const c = (e as Extract<ConversationEvent, { type: "user_message" }>).payload.content[0];
      return c?.type === "text" ? c.text : "";
    });
const runStatus = async (conv: string, status: string) =>
  waitFor(
    async () => (await runsOf(db, conv)).some((r) => r.status === status),
    15_000,
    `a ${status} run`,
  );
const SLOW = `slow:60:${"x".repeat(60)}`;

describe("queued messages", { timeout: 60_000 }, () => {
  it("a NUL in queued or edited text is stored as U+FFFD, like a direct send (final review m1)", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, SLOW);
    await runStatus(conv, "running");
    const q = await enqueue(conv, "echo:a\u0000b");
    expect(q.statusCode, q.body).toBe(201);
    const item = (q.json() as { item: Item }).item;
    expect(item.text).toBe("echo:a\uFFFDb");
    const edited = await owner({
      method: "PATCH",
      url: `${base(conv)}/${item.id}`,
      payload: { text: "echo:c\u0000d" },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((edited.json() as { item: Item }).item.text).toBe("echo:c\uFFFDd");
    await waitForTerminal(db, conv, 2, 30_000);
    expect((await userTexts(conv)).at(-1)).toBe("echo:c\uFFFDd");
  });

  it("wait for the active run, then go out one at a time, each as its own user message", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, SLOW);
    await runStatus(conv, "running");
    const r1 = await enqueue(conv, "echo:first");
    expect(r1.statusCode, r1.body).toBe(201);
    expect((r1.json() as { item: Item }).item).toMatchObject({ text: "echo:first", files: [] });
    expect((await enqueue(conv, "echo:second")).statusCode).toBe(201);
    // not in the log until sent
    expect(await userTexts(conv)).toEqual([SLOW]);
    expect((await queueOf(conv)).items.map((i) => i.text)).toEqual(["echo:first", "echo:second"]);

    await waitForTerminal(db, conv, 3, 30_000);
    expect(await userTexts(conv)).toEqual([SLOW, "echo:first", "echo:second"]);
    const events = await eventsOf(db, conv);
    const seqOf = (pred: (e: ConversationEvent) => boolean) => events.find(pred)?.seq as number;
    const terminals = events.filter((e) => e.type === "run_finished").map((e) => e.seq);
    const first = seqOf((e) => e.type === "user_message" && JSON.stringify(e).includes("first"));
    const second = seqOf((e) => e.type === "user_message" && JSON.stringify(e).includes("second"));
    // each went out only after the previous run ended: three runs, never absorbed mid-run
    expect(first).toBeGreaterThan(terminals[0] as number);
    expect(second).toBeGreaterThan(terminals[1] as number);
    expect(await runsOf(db, conv)).toHaveLength(3);
    const firstMsg = events.find((e) => e.seq === first) as Extract<
      ConversationEvent,
      { type: "user_message" }
    >;
    expect(firstMsg.payload.authorAccountId).toBe(ownerId);
    expect(await queueOf(conv)).toEqual({ items: [], paused: false });
  });

  it("enqueue on an idle conversation sends at once", async () => {
    const conv = await createConv(owner, orgId, agentId);
    expect((await enqueue(conv, "echo:now")).statusCode).toBe(201);
    await waitForTerminal(db, conv, 1, 20_000);
    expect(await userTexts(conv)).toEqual(["echo:now"]);
    expect((await queueOf(conv)).items).toEqual([]);
  });

  it("a failed run pauses the queue until resume", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "slowfail:60:abcdefghijklmnopqrstuvwx");
    await runStatus(conv, "running");
    await enqueue(conv, "echo:after");
    await waitForEvent(db, conv, (e) => e.type === "run_failed", 20_000, "run_failed");
    await waitFor(async () => (await queueOf(conv)).paused, 5_000, "paused");
    await sleep(500);
    expect(await userTexts(conv)).toHaveLength(1);
    expect((await queueOf(conv)).items.map((i) => i.text)).toEqual(["echo:after"]);

    const resumed = await owner({ method: "POST", url: `${base(conv)}/resume` });
    expect(resumed.statusCode, resumed.body).toBe(202);
    await waitForTerminal(db, conv, 2, 20_000);
    expect(await userTexts(conv)).toEqual(["slowfail:60:abcdefghijklmnopqrstuvwx", "echo:after"]);
    expect(await queueOf(conv)).toEqual({ items: [], paused: false });
  });

  it("a stopped run pauses the queue; edit and delete while it waits", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "stall");
    await runStatus(conv, "running");
    const a = ((await (await enqueue(conv, "echo:a")).json()) as { item: Item }).item;
    const b = ((await (await enqueue(conv, "echo:b")).json()) as { item: Item }).item;
    const c = ((await (await enqueue(conv, "echo:c")).json()) as { item: Item }).item;
    expect([a.position < b.position, b.position < c.position]).toEqual([true, true]);

    const edited = await owner({
      method: "PATCH",
      url: `${base(conv)}/${b.id}`,
      payload: { text: "echo:b2" },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((edited.json() as { item: Item }).item).toMatchObject({ id: b.id, text: "echo:b2" });
    const del = await owner({ method: "DELETE", url: `${base(conv)}/${a.id}` });
    expect(del.statusCode).toBe(204);
    const missing = await owner({ method: "DELETE", url: `${base(conv)}/${a.id}` });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe(
      "conversation.queue_item_not_found",
    );
    // empty text is only allowed for a message that carries files
    const empty = await owner({
      method: "PATCH",
      url: `${base(conv)}/${b.id}`,
      payload: { text: "" },
    });
    expect(empty.statusCode).toBe(400);

    expect(
      (await owner({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort` }))
        .statusCode,
    ).toBe(202);
    await waitForEvent(db, conv, (e) => e.type === "run_aborted", 20_000, "run_aborted");
    await waitFor(async () => (await queueOf(conv)).paused, 5_000, "paused");
    expect((await queueOf(conv)).items.map((i) => i.text)).toEqual(["echo:b2", "echo:c"]);

    await owner({ method: "POST", url: `${base(conv)}/resume` });
    await waitForTerminal(db, conv, 3, 30_000);
    expect(await userTexts(conv)).toEqual(["stall", "echo:b2", "echo:c"]);
  });

  it("send now turns an item into an interjection; the first item stays first", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, SLOW);
    await runStatus(conv, "running");
    await enqueue(conv, "echo:one");
    const two = ((await (await enqueue(conv, "echo:two")).json()) as { item: Item }).item;
    const sent = await owner({ method: "POST", url: `${base(conv)}/${two.id}/send` });
    expect(sent.statusCode, sent.body).toBe(202);
    const event = (sent.json() as { event: ConversationEvent }).event;
    expect(event.type).toBe("user_message");
    expect((await queueOf(conv)).items.map((i) => i.text)).toEqual(["echo:one"]);
    expect(await userTexts(conv)).toEqual([SLOW, "echo:two"]);
    // sending it again: the item is gone
    const again = await owner({ method: "POST", url: `${base(conv)}/${two.id}/send` });
    expect(again.statusCode).toBe(404);

    await waitFor(
      async () => (await userTexts(conv)).length === 3 && (await queueOf(conv)).items.length === 0,
      30_000,
      "queue drained",
    );
    expect(await userTexts(conv)).toEqual([SLOW, "echo:two", "echo:one"]);
  });

  it("a retried enqueue with the same clientMessageId keeps one item", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "stall");
    await runStatus(conv, "running");
    const id = randomUUID();
    const r1 = await enqueue(conv, "echo:once", id);
    const r2 = await enqueue(conv, "echo:once", id);
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 200]);
    expect((r2.json() as { item: Item }).item.id).toBe((r1.json() as { item: Item }).item.id);
    expect((await queueOf(conv)).items).toHaveLength(1);
    await owner({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort` });
  });

  it("a retry after the item was sent returns the sent message and queues nothing", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const id = randomUUID();
    expect((await enqueue(conv, "echo:sent", id)).statusCode).toBe(201);
    await waitForTerminal(db, conv, 1, 20_000);
    const again = await enqueue(conv, "echo:sent", id);
    expect(again.statusCode, again.body).toBe(200);
    const body = again.json() as { item: Item | null; event: ConversationEvent };
    expect(body.item).toBeNull();
    expect(body.event.type).toBe("user_message");
    expect((await queueOf(conv)).items).toEqual([]);
    expect(await userTexts(conv)).toEqual(["echo:sent"]);
  });

  it(`holds at most ${QUEUE_MAX_ITEMS} items`, async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "stall");
    await runStatus(conv, "running");
    for (let i = 0; i < QUEUE_MAX_ITEMS; i++) {
      expect((await enqueue(conv, `echo:${i}`)).statusCode).toBe(201);
    }
    const full = await enqueue(conv, "echo:over");
    expect(full.statusCode).toBe(409);
    expect((full.json() as { error: { code: string } }).error.code).toBe("conversation.queue_full");
    await owner({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort` });
  });

  it("another member sees 404 on every queue route", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "stall");
    await runStatus(conv, "running");
    const item = ((await (await enqueue(conv, "echo:mine")).json()) as { item: Item }).item;
    const calls = [
      { method: "GET" as const, url: base(conv) },
      { method: "POST" as const, url: base(conv), payload: { text: "x", clientMessageId: "c" } },
      { method: "PATCH" as const, url: `${base(conv)}/${item.id}`, payload: { text: "x" } },
      { method: "DELETE" as const, url: `${base(conv)}/${item.id}` },
      { method: "POST" as const, url: `${base(conv)}/${item.id}/send` },
      { method: "POST" as const, url: `${base(conv)}/resume` },
    ];
    for (const c of calls) {
      const r = await other(c);
      expect(r.statusCode, `${c.method} ${c.url}`).toBe(404);
      expect((r.json() as { error: { code: string } }).error.code).toBe("conversation.not_found");
    }
    expect((await queueOf(conv)).items.map((i) => i.text)).toEqual(["echo:mine"]);
    await owner({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort` });
  });

  it("every change sends `changed: queue` on the stream", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "stall");
    await runStatus(conv, "running");
    const cookie = ownerCookie();
    const sse = await openSse(
      `http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/conversations/${conv}/stream`,
      { cookie },
    );
    try {
      await enqueue(conv, "echo:x");
      await sse.until(
        (m) => m.some((x) => x.event === "changed" && x.data === '{"what":"queue"}'),
        10_000,
        "changed frame",
      );
    } finally {
      sse.close();
    }
    await owner({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort` });
  });
});

describe("queued messages and the author's access (review I1, M5)", { timeout: 60_000 }, () => {
  const queueRows = async (conv: string) =>
    db.selectFrom("conversation_queue").select("id").where("conversation_id", "=", conv).execute();
  const paused = async (conv: string) =>
    (
      await db
        .selectFrom("conversations")
        .select("queue_paused")
        .where("id", "=", conv)
        .executeTakeFirstOrThrow()
    ).queue_paused;

  it("a run waiting for an answer holds the queue", async () => {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Asker",
          instructions: "Ask.",
          model: { provider: "model-fake", model: "fake-1" },
        },
        visibility: "org",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const conv = await createConv(owner, orgId, (res.json() as { agent: { id: string } }).agent.id);
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
    await postMessage(owner, orgId, conv, ask);
    await runStatus(conv, "waiting");
    expect((await enqueue(conv, "echo:later")).statusCode).toBe(201);
    await sleep(1_000);
    expect(await userTexts(conv)).toEqual([ask]);
    expect((await queueOf(conv)).items.map((i) => i.text)).toEqual(["echo:later"]);
    await owner({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort` });
  });

  it("an author who can no longer see the agent: the queue pauses instead of sending", async () => {
    const conv = await createConv(other, orgId, agentId);
    await postMessage(other, orgId, conv, SLOW);
    await runStatus(conv, "running");
    expect((await enqueue(conv, "echo:after", randomUUID(), other)).statusCode).toBe(201);
    // the agent is no longer visible to the author (members only, not listed)
    await db
      .updateTable("agents")
      .set({ visibility: "members" })
      .where("id", "=", agentId)
      .execute();
    await waitForTerminal(db, conv, 1, 30_000);
    await waitFor(() => paused(conv), 10_000, "queue paused");
    expect(await userTexts(conv)).toEqual([SLOW]);
    expect(await queueRows(conv)).toHaveLength(1);
  });

  it("offboarding deletes the person's queued messages; nothing is sent after the run stops", async () => {
    const conv = await createConv(other, orgId, agentId);
    await postMessage(other, orgId, conv, SLOW);
    await runStatus(conv, "running");
    expect((await enqueue(conv, "echo:after", randomUUID(), other)).statusCode).toBe(201);
    const otherId = (
      await db
        .selectFrom("conversations")
        .select("account_id")
        .where("id", "=", conv)
        .executeTakeFirstOrThrow()
    ).account_id;
    const removed = await owner({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/members/${otherId}`,
    });
    expect(removed.statusCode, removed.body).toBeLessThan(300);
    expect(await queueRows(conv)).toEqual([]);
    await waitForTerminal(db, conv, 1, 30_000);
    await sleep(500);
    expect(await userTexts(conv)).toEqual([SLOW]);
    expect(await runsOf(db, conv)).toHaveLength(1);
  });
});

describe("offboarding and queue dispatch lock in the same order (final review m2)", {
  timeout: 60_000,
}, () => {
  const queueRows = async (conv: string) =>
    db.selectFrom("conversation_queue").select("id").where("conversation_id", "=", conv).execute();

  it("offboarding locks the conversation before its queue rows, as dispatch does", async () => {
    const conv = await createConv(other, orgId, agentId);
    // paused, so the item stays queued and no run takes conversation locks meanwhile
    await db
      .updateTable("conversations")
      .set({ queue_paused: true })
      .where("id", "=", conv)
      .execute();
    expect((await enqueue(conv, "echo:after", randomUUID(), other)).statusCode).toBe(201);
    expect(await queueRows(conv)).toHaveLength(1);
    const otherId = (
      await db
        .selectFrom("conversations")
        .select("account_id")
        .where("id", "=", conv)
        .executeTakeFirstOrThrow()
    ).account_id;
    // a dispatcher holds the conversation row lock (it would delete the head item next)
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => {
      locked = r;
    });
    const dispatcher = db.transaction().execute(async (t) => {
      await t.selectFrom("conversations").select("id").where("id", "=", conv).forUpdate().execute();
      locked();
      await held;
    });
    await lockTaken;
    const removing = owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/members/${otherId}` });
    try {
      // offboarding waits for the conversation lock...
      await waitFor(
        async () => {
          const { rows } = await sql<{ n: string }>`
            SELECT count(*) AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND datname = current_database()`.execute(db);
          return Number(rows[0]?.n) > 0;
        },
        10_000,
        "offboarding waiting for a lock",
      );
      // ...without holding the queue rows the dispatcher takes next (no lock-order inversion)
      const probe = db.transaction().execute(async (t) =>
        sql`SELECT id FROM capybara.conversation_queue WHERE conversation_id = ${conv}
            FOR UPDATE NOWAIT`.execute(t),
      );
      await expect(probe).resolves.toBeDefined();
    } finally {
      release();
      await dispatcher;
    }
    const removed = await removing;
    expect(removed.statusCode, removed.body).toBeLessThan(300);
    expect(await queueRows(conv)).toEqual([]);
  });
});

describe("@ resources are read at queue time (decision 15)", { timeout: 30_000 }, () => {
  it("reads once with the sender's credentials when queued; the sent message carries them", async () => {
    const conv = await createConv(owner, orgId, agentId);
    // Pause the queue so nothing dispatches behind the test's back: a stopped run pauses it only
    // when it holds an item at that moment. With an empty queue the worker's ensureRun after the
    // job would send whatever this test queues next (the old flake: it raced that ensureRun).
    await postMessage(owner, orgId, conv, "stall");
    await runStatus(conv, "running");
    expect((await enqueue(conv, "echo:behind")).statusCode).toBe(201);
    await owner({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort` });
    await waitForEvent(db, conv, (e) => e.type === "run_aborted", 20_000, "run_aborted");
    expect((await queueOf(conv)).paused).toBe(true);

    const reads: { orgId: string; accountId: string }[] = [];
    const eventLog = new EventLog(db, { publish: async () => {} });
    const conversations = new ConversationsService(
      db,
      eventLog,
      { get: async () => ({}) } as unknown as AgentsService,
      undefined,
      undefined,
      async (o, a, refs) => {
        reads.push({ orgId: o, accountId: a });
        return {
          blocks: refs.map((r) => ({ type: "text" as const, text: `<resource ${r.uri}>` })),
          attachments: refs.map((r) => ({
            appId: r.connectorId,
            appName: "Docs",
            uri: r.uri,
            name: "Spec",
          })),
        };
      },
    );
    const queue = new ConversationQueue({ db, eventLog, conversations });
    const connectorId = randomUUID();
    const { item } = await queue.add(orgId, conv, ownerId, {
      text: "summarize",
      clientMessageId: "with-resource",
      attachments: [{ connectorId, uri: "docs://spec" }],
    });
    expect(reads).toEqual([{ orgId, accountId: ownerId }]);
    expect(item).toMatchObject({
      text: "summarize",
      attachments: [{ connectorId, name: "Spec", uri: "docs://spec" }],
    });
    // editing changes only the text; nothing is read again
    await queue.edit(orgId, conv, ownerId, item?.id as string, "summarize briefly");
    // an edit cannot drop the text a resource needs
    await expect(queue.edit(orgId, conv, ownerId, item?.id as string, "")).rejects.toMatchObject({
      code: "validation_failed",
    });
    // a full queue answers 409 before reading any resource (review M6); two items are queued
    for (let i = 2; i < QUEUE_MAX_ITEMS; i++) {
      await queue.add(orgId, conv, ownerId, { text: `echo:${i}`, clientMessageId: `fill-${i}` });
    }
    await expect(
      queue.add(orgId, conv, ownerId, {
        text: "one more",
        clientMessageId: "over",
        attachments: [{ connectorId, uri: "docs://other" }],
      }),
    ).rejects.toMatchObject({ code: "conversation.queue_full" });
    expect(reads).toHaveLength(1);
    const event = await queue.sendNow(orgId, conv, ownerId, item?.id as string);
    expect(reads).toHaveLength(1);
    expect(event.payload).toMatchObject({
      content: [
        { type: "text", text: "summarize briefly" },
        { type: "text", text: "<resource docs://spec>" },
      ],
      attachments: [{ appId: connectorId, appName: "Docs", uri: "docs://spec", name: "Spec" }],
      authorAccountId: ownerId,
      clientMessageId: "with-resource",
    });
  });
});
