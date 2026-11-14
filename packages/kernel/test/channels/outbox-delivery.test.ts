import { fileURLToPath } from "node:url";
import type { ChannelCard } from "@capybara-hq/plugin-sdk";
import {
  fakeCardAction as cardAction,
  fakeDm as dm,
  type FakeChannelSent,
  type FakeChannelServer,
  fakeGroupMessage as group,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_QUEUE_NAME, ChannelJobs, deliverJobId } from "../../src/channels/jobs.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { COLOR_FORM } from "../fixtures/plugins/mem-connector/index.js";
import type { ScriptRule } from "../fixtures/plugins/model-script/index.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { drainOutbox } from "../helpers/outbox.js";
import {
  cardRecorded,
  createAgent,
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
import { finishedDeliveries } from "../helpers/subagents.js";

/**
 * Channel IM integration, one kernel boot for both suites: delivery owed by the transactional
 * outbox (§8.1) and sub-agent cards posted in an IM thread (phase C Task 11, Review Focus 2).
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
const MODEL_SCRIPT = fileURLToPath(
  new URL("../fixtures/plugins/model-script/index.ts", import.meta.url),
);
const ECHO = 'tool:plugin__mem-connector__echo:{"text":"hi"}';

const CHILD = "You are a sub-agent";
const agentCall = (input: Record<string, unknown>) => ({ name: "Agent", input });

const RULES: ScriptRule[] = [
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-echo", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "plugin__mem-connector__echo", input: { text: "sa-hi" } }] },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "sa-hi" },
    reply: { text: "child echoed" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-ask", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "plugin__mem-connector__ask", input: {} }] },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "color=" },
    reply: { text: "child got the color" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-deny", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "plugin__mem-connector__echo", input: { text: "deny-hi" } }] },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "Reason: wrong repo" },
    reply: { text: "child was denied" },
  },
  {
    when: { lastUserIncludes: "SA deny", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Echo it", prompt: "child-deny: go" })] },
  },
  {
    when: { lastUserIncludes: "SA approve", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Echo it", prompt: "child-echo: go" })] },
  },
  {
    // the same IM thread (conversation) as the first test: its turn left two assistant messages
    when: { lastUserIncludes: "SA ask", assistantTurns: 2 },
    reply: { toolCalls: [agentCall({ description: "Ask it", prompt: "child-ask: go" })] },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-twice", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "plugin__mem-connector__echo", input: { text: "first-echo" } }] },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "first-echo" },
    reply: { toolCalls: [{ name: "plugin__mem-connector__echo", input: { text: "second-echo" } }] },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "second-echo" },
    reply: { text: "child done twice" },
  },
  {
    when: { lastUserIncludes: "SA twice", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Echo twice", prompt: "child-twice: go" })] },
  },
  {
    when: { lastUserIncludes: "SA group", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Echo it", prompt: "child-echo: go" })] },
  },
  // a root message while the child's question waits (reply-while-question spec §4.3)
  { when: { lastUserIncludes: "SA aside" }, reply: { text: "noted aside" } },
  // the parent goes on after an immediate `Agent` result; the child works in the background
  { when: { lastToolResultIncludes: "in the background" }, reply: { text: "parent dispatched" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let im: FakeChannelServer;
let owner: Req;
let ownerId: string;
/**
 * While set, the outbox suite's direct deliver enqueues (`ChannelJobs.enqueue`) do nothing and its
 * outbox adds to the channel queue fail (`OUTBOX_DISPATCH_FAILS`): only owed rows can reach IM.
 * The sub-agent suite clears it, so its deliveries take the normal fast path.
 */
let owedMode = false;
/** While true, the outbox suite's adds to the channel queue fail. */
let failing = true;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer({ dedupeSends: false });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, MODEL_SCRIPT, CHAN_MINI, MEM_CONNECTOR],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 10_000, deliveryIdleMs: 1000 },
        extensionConfig: { "model-script": { rules: RULES } },
        // the sub-agent suite shares one IM chat: a parent woken by its children's deliveries would
        // absorb the next test's message as an interjection (waking: runtime/subagents/wake.test.ts)
        runtime: { wakeOnBackgroundTask: false },
      },
    ),
    {
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => owedMode && failing && queue === CHANNEL_QUEUE_NAME,
        },
      ],
    },
  );
  const jobs = k.app.get(ChannelJobs);
  const enqueue = jobs.enqueue.bind(jobs);
  // no direct deliver enqueue while `owedMode` is set: only the owed rows can reach IM
  (jobs as { enqueue: ChannelJobs["enqueue"] }).enqueue = async (conversationId, opts) => {
    if (owedMode) return;
    await enqueue(conversationId, opts);
  };
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Owner" })
  ).id;
  // the IM identity of the owner, shared by both suites' connections
  await sql`INSERT INTO capybara.identities (source, external_id, account_id)
    VALUES ('chan-mini:t1', 'u-owner', ${ownerId})`.execute(raw);
  owner = await session(k, "owner");
});

afterAll(async () => {
  await k?.close();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/**
 * Transactional outbox spec §8.1 (IM delivery): for a conversation with a channel target, every
 * event append (a reply, an approval decision, a question answer, a wait stop) owes the
 * conversation's deliver job in its own transaction; a conversation without one writes nothing.
 *
 * The owed path is isolated: every add to `cap-kernel-channels` through the outbox fails while
 * `failing` is set (the `OUTBOX_DISPATCH_FAILS` seam, so the fast path delivers nothing), and the
 * direct enqueues of `ChannelJobs.enqueue` (the `run.started` hint, a delivery's follow-up) do
 * nothing. What reaches IM got there through an owed row an explicit relay pass delivered.
 */
describe("IM delivery is owed (transactional outbox §8.1)", () => {
  let orgId: string;
  let connId: string;

  beforeAll(async () => {
    owedMode = true;
    orgId = await createOrg(owner, "Owed");
    for (const plugin of ["chan-mini", "mem-connector"]) {
      const en = await owner({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
        payload: { enabled: true },
      });
      expect(en.statusCode, en.body).toBe(200);
    }
    const ag = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Helper",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: onlyBuiltins([{ kind: "plugin", plugin: "mem-connector", name: "echo" }]),
          toolPolicies: { "plugin__mem-connector__echo": "ask" },
        },
        visibility: "org",
      },
    });
    expect(ag.statusCode, ag.body).toBe(201);
    const agentId = (ag.json() as { agent: { id: string } }).agent.id;
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/channels`,
      payload: {
        plugin: "chan-mini",
        name: "chan-mini",
        agentId,
        unboundPolicy: "bind",
        config: { platformUrl: im.url, appId: "cli_owed", appSecret: "app-secret-1234567" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    connId = (res.json() as { channel: { id: string } }).channel.id;
    await waitFor(async () => im.active(connId).length === 1, 10_000, "long connection");
  });

  const sentTo = (chatId: string) =>
    im.sent.filter((s) => s.appId === "cli_owed" && s.target.chatId === chatId);
  const updatesOf = (messageId: string) => im.updated.filter((u) => u.messageId === messageId);
  const finalText = (s: FakeChannelSent) =>
    updatesOf(s.messageId).at(-1)?.message.text ?? s.message.text;
  const cardOf = (s: FakeChannelSent | undefined) => s?.message.cards?.[0];

  /** The conversation of the live thread in `chatId`. */
  function convOf(chatId: string): Promise<string> {
    return waitFor(
      async () => {
        const r = await sql<{ conversation_id: string }>`SELECT conversation_id
          FROM capybara.channel_threads WHERE connection_id = ${connId} AND chat_id = ${chatId}
            AND archived_at IS NULL`.execute(raw);
        return r.rows[0]?.conversation_id;
      },
      10_000,
      "conversation",
    );
  }

  /** The owed deliver rows of a conversation. */
  async function owedOf(conv: string) {
    return db
      .selectFrom("outbox")
      .select(["queue", "job_name", "job_id", "data", "org_id"])
      .where("job_name", "=", "deliver")
      .where(sql<boolean>`data->>'conversationId' = ${conv}`)
      .orderBy("id")
      .execute();
  }

  /**
   * Waits until the conversation's title job is through: its first run's completion enqueues it, and
   * it appends a `usage` event (purpose `title`) after the run's terminal event, which a conversation
   * with a channel target owes a delivery for.
   */
  async function titleSettled(conv: string): Promise<void> {
    await waitFor(
      async () => {
        const c = await db
          .selectFrom("conversations")
          .select("title")
          .where("id", "=", conv)
          .executeTakeFirstOrThrow();
        if (c.title !== null) return true;
        const r = await sql<{ n: string }>`SELECT count(*) AS n FROM capybara.conversation_events
          WHERE conversation_id = ${conv} AND type = 'usage'
            AND payload->>'purpose' = 'title'`.execute(raw);
        return Number(r.rows[0]?.n) > 0;
      },
      15_000,
      "the title job through",
    );
  }

  async function lastSeq(conv: string): Promise<number> {
    const r = await db
      .selectFrom("conversations")
      .select("last_seq")
      .where("id", "=", conv)
      .executeTakeFirstOrThrow();
    return Number(r.last_seq);
  }

  /**
   * Lets the channel queue's adds succeed, runs one relay pass over the owed rows and waits until
   * they are delivered (a concurrent pass may hold some: {@link drainOutbox}).
   */
  async function relay(): Promise<void> {
    failing = false;
    await db
      .updateTable("outbox")
      .set({ next_attempt_at: sql<Date>`now()` as unknown as Date })
      .where("queue", "=", CHANNEL_QUEUE_NAME)
      .execute();
    await drainOutbox(k.app, { queue: CHANNEL_QUEUE_NAME });
  }

  it("a reply in an IM conversation is delivered with the fast path disabled", async () => {
    failing = true;
    const chat = "dm-u-owner";
    im.push(connId, dm("r1", "u-owner", "echo:owed reply"));
    const conv = await convOf(chat);
    const [terminal] = await waitForTerminal(db, conv);
    await titleSettled(conv);
    // the run is over, nothing reached IM: the delivery is owed, not lost
    expect(sentTo(chat)).toEqual([]);
    const owed = await owedOf(conv);
    expect(owed.map((r) => r.job_id)).toContain(deliverJobId(conv, terminal?.seq ?? 0));
    expect(owed.map((r) => r.job_id)).toContain(deliverJobId(conv, await lastSeq(conv)));
    for (const r of owed) {
      expect(r).toMatchObject({
        queue: CHANNEL_QUEUE_NAME,
        job_name: "deliver",
        data: { conversationId: conv },
        org_id: orgId,
      });
    }
    await relay();
    await waitFor(
      async () => sentTo(chat).some((s) => finalText(s) === "owed reply"),
      15_000,
      "the reply in IM",
    );
    expect(await owedOf(conv)).toEqual([]);
  });

  it("an approval card updates in IM with the fast path disabled", async () => {
    failing = true;
    const chat = "grp-owed";
    im.push(connId, group("ap1", "u-owner", ECHO, { chatId: chat }));
    const conv = await convOf(chat);
    const req = await waitForEvent(db, conv, (e) => e.type === "approval_requested");
    const approvalId = (req.payload as { approvalId: string }).approvalId;
    expect(sentTo(chat)).toEqual([]);
    await relay();
    const cardMsg = await waitFor(
      async () => sentTo(chat).find((s) => cardOf(s)?.kind === "approval"),
      15_000,
      "approval card",
    );
    await cardRecorded(db, cardMsg);
    await waitFor(async () => (await owedOf(conv)).length === 0, 10_000, "rows delivered");

    // decided on the web: the decision's transaction owes the card update (and the run's resume,
    // which waits with it: a pass fails the queues after the first failed one, as in an outage)
    failing = true;
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
      payload: { decision: "approve" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const decided = await waitForEvent(db, conv, (e) => e.type === "approval_decided");
    const owed = (await owedOf(conv)).map((r) => r.job_id);
    expect(owed).toContain(deliverJobId(conv, decided.seq));
    const approved = () =>
      updatesOf(cardMsg.messageId).find(
        (u) => (cardOf(u) as { state?: string } | undefined)?.state === "approved",
      );
    expect(approved()).toBeUndefined();
    await relay();
    const up = await waitFor(async () => approved(), 15_000, "card updated");
    expect(cardOf(up) as Extract<ChannelCard, { kind: "approval" }>).toMatchObject({
      kind: "approval",
      state: "approved",
    });
    await waitFor(
      async () => sentTo(chat).some((s) => finalText(s).startsWith("Tool result:")),
      15_000,
      "reply after approval",
    );
  });

  it("binding a conversation to an IM target owes its delivery at the current log position", async () => {
    failing = true;
    const agentId = await createAgent(owner, orgId);
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "echo:before the bind");
    await waitForTerminal(db, conv);
    // nothing appends after the bind's read of the log position
    await titleSettled(conv);
    const last = await lastSeq(conv);
    expect(await owedOf(conv)).toEqual([]);
    await k.app
      .get(ChannelJobs)
      .bind(orgId, conv, connId, { chatId: "dm-bind", chatType: "dm" }, 1);
    expect(await lastSeq(conv)).toBe(last);
    expect((await owedOf(conv)).map((r) => r.job_id)).toEqual([deliverJobId(conv, last)]);
    const d = await db
      .selectFrom("channel_deliveries")
      .select(["last_seq", "connection_id"])
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    expect({ seq: Number(d.last_seq), connection: d.connection_id }).toEqual({
      seq: 1,
      connection: connId,
    });
    // the owed row is cleared so later tests see no rows of this conversation
    await db.deleteFrom("outbox").where("job_id", "=", deliverJobId(conv, last)).execute();
  });

  it("a web-only conversation writes no outbox row on append", async () => {
    failing = true;
    const agentId = await createAgent(owner, orgId);
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "echo:web only");
    await waitForTerminal(db, conv);
    expect(await lastSeq(conv)).toBeGreaterThan(1);
    // a deliver row would stay: the channel queue's adds fail
    expect(await owedOf(conv)).toEqual([]);
    const channelRows = await db
      .selectFrom("outbox")
      .select("job_id")
      .where("queue", "=", CHANNEL_QUEUE_NAME)
      .where("job_id", "like", `%${conv}%`)
      .execute();
    expect(channelRows).toEqual([]);
  });
});

/**
 * Phase C Task 11, Review Focus 2: a sub-agent of a conversation started from IM needs an approval
 * (or an answer); the card is posted in the thread from the parent's `subagent_waiting`, and
 * handling it there resumes the child, then the parent, whose reply reaches the thread.
 */
describe("sub-agent cards in an IM thread", () => {
  let orgId: string;
  let connId: string;

  beforeAll(async () => {
    owedMode = false;
    orgId = await createOrg(owner, "Subagent");
    for (const plugin of ["chan-mini", "mem-connector"]) {
      const en = await owner({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
        payload: { enabled: true },
      });
      expect(en.statusCode, en.body).toBe(200);
    }
    const ag = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Lead",
          instructions: "Lead the work.",
          model: { provider: "model-script", model: "script-1" },
          disabledTools: onlyBuiltins([
            { kind: "builtin", name: "Agent" },
            { kind: "plugin", plugin: "mem-connector", name: "echo" },
            { kind: "plugin", plugin: "mem-connector", name: "ask" },
          ]),
          toolPolicies: { "plugin__mem-connector__echo": "ask" },
        },
        visibility: "org",
      },
    });
    expect(ag.statusCode, ag.body).toBe(201);
    const agentId = (ag.json() as { agent: { id: string } }).agent.id;
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/channels`,
      payload: {
        plugin: "chan-mini",
        name: "chan-mini",
        agentId,
        unboundPolicy: "bind",
        config: { platformUrl: im.url, appId: "cli_sa", appSecret: "app-secret-1234567" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    connId = (res.json() as { channel: { id: string } }).channel.id;
    await waitFor(async () => im.active(connId).length === 1, 10_000, "long connection");
  });

  const CHAT = "dm-u-owner";
  const GROUP = "grp-sa";
  const sent = () => im.sent.filter((s) => s.appId === "cli_sa" && s.target.chatId === CHAT);
  const cardOf = (s: FakeChannelSent | undefined) => s?.message.cards?.[0];
  const updatesOf = (messageId: string) => im.updated.filter((u) => u.messageId === messageId);
  /** Waits for the parent's finished delivery of its child with `text` (agent map spec §4.5). */
  async function childDelivered(conv: string, text: string): Promise<void> {
    await waitFor(
      async () => (await finishedDeliveries(db, conv, 1)).some((d) => d.text === text) || null,
      30_000,
      `the delivery "${text}"`,
    );
  }

  async function convOf(chatId: string): Promise<string> {
    return waitFor(
      async () => {
        const r = await sql<{ conversation_id: string }>`SELECT conversation_id
          FROM capybara.channel_threads WHERE connection_id = ${connId} AND chat_id = ${chatId}
            AND archived_at IS NULL`.execute(raw);
        return r.rows[0]?.conversation_id;
      },
      10_000,
      "conversation",
    );
  }

  async function childOf(parent: string): Promise<string> {
    return waitFor(
      async () =>
        (
          await db
            .selectFrom("conversations")
            .select("id")
            .where("parent_conversation_id", "=", parent)
            .orderBy("created_at", "desc")
            .executeTakeFirst()
        )?.id,
      20_000,
      "child conversation",
    );
  }

  const runStatus = async (conv: string) =>
    (
      await db
        .selectFrom("runs")
        .select("status")
        .where("conversation_id", "=", conv)
        .orderBy("created_at", "desc")
        .executeTakeFirst()
    )?.status;

  it("Review Focus 2: a child's approval card is posted in the thread; approving there resumes child and parent", async () => {
    const before = sent().length;
    im.push(connId, dm("sa1", "u-owner", "SA approve"));
    const conv = await convOf(CHAT);
    const child = await childOf(conv);
    const cardMsg = await waitFor(
      async () =>
        sent()
          .slice(before)
          .find((s) => cardOf(s)?.kind === "approval"),
      20_000,
      "approval card",
    );
    await cardRecorded(db, cardMsg);
    const card = cardOf(cardMsg) as Extract<ChannelCard, { kind: "approval" }>;
    const approval = await db
      .selectFrom("approvals")
      .select(["id", "conversation_id", "requested_for"])
      .where("id", "=", card.id)
      .executeTakeFirstOrThrow();
    // the child's approval, asked of the person who wrote in the thread
    expect(approval).toEqual({ id: card.id, conversation_id: child, requested_for: ownerId });
    expect(card).toMatchObject({
      kind: "approval",
      toolName: "mem-connector [echo]",
      state: "pending",
      webUrl: `https://cap.example/chat/${conv}?subagent=${child}`,
    });
    expect(card.inputPreview).toContain("sa-hi");
    const events: ConversationEvent[] = await eventsOf(db, conv);
    expect(events.some((e) => e.type === "subagent_waiting")).toBe(true);
    // the parent's run ended after the dispatch; only the child waits
    await waitFor(async () => (await runStatus(conv)) === "completed", 10_000, "parent done");

    im.push(
      connId,
      cardAction(
        "sa1-act",
        "u-owner",
        { cardKind: "approval", cardId: card.id, action: "approve", scope: "once" },
        cardMsg.target,
      ),
    );
    await childDelivered(conv, "child echoed");
    expect(await runStatus(child)).toBe("completed");
    // the card shows the decision once the child is done
    const up = await waitFor(
      async () =>
        updatesOf(cardMsg.messageId).find(
          (u) => (cardOf(u) as { state?: string } | undefined)?.state === "approved",
        ),
      10_000,
      "card updated",
    );
    expect(cardOf(up)).toMatchObject({ kind: "approval", state: "approved" });
  });

  it("a child's approval denied on the web with a reason: the child's result and its card carry it", async () => {
    const chat = "grp-deny";
    const inChat = () => im.sent.filter((x) => x.appId === "cli_sa" && x.target.chatId === chat);
    im.push(connId, group("sa6", "u-owner", "@bot SA deny", { chatId: chat }));
    const cardMsg = await waitFor(
      async () => inChat().find((x) => cardOf(x)?.kind === "approval"),
      20_000,
      "approval card",
    );
    await cardRecorded(db, cardMsg);
    const card = cardOf(cardMsg) as Extract<ChannelCard, { kind: "approval" }>;
    const decide = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${card.id}/decision`,
      payload: { decision: "deny", reason: "wrong repo" },
    });
    expect(decide.statusCode, decide.body).toBe(200);
    const conv = await convOf(chat);
    await childDelivered(conv, "child was denied");
    const child = await childOf(conv);
    const result = (await eventsOf(db, child)).find((e) => e.type === "tool_result");
    expect(JSON.stringify(result?.payload)).toContain("Reason: wrong repo");
    const up = await waitFor(
      async () =>
        updatesOf(cardMsg.messageId).find(
          (u) => (cardOf(u) as { state?: string } | undefined)?.state === "denied",
        ),
      10_000,
      "card denied",
    );
    expect(cardOf(up)).toMatchObject({
      kind: "approval",
      state: "denied",
      denyReason: "wrong repo",
    });
  });

  it("a child's question card is posted in the thread; answering there resumes child and parent", async () => {
    const before = sent().length;
    im.push(connId, dm("sa2", "u-owner", "SA ask"));
    const cardMsg = await waitFor(
      async () =>
        sent()
          .slice(before)
          .find((s) => cardOf(s)?.kind === "question"),
      20_000,
      "question card",
    );
    await cardRecorded(db, cardMsg);
    const card = cardOf(cardMsg) as Extract<ChannelCard, { kind: "question" }>;
    const conv = await convOf(CHAT);
    const child = await childOf(conv);
    // links to the parent with the child open, like the child's approval cards
    expect(card).toMatchObject({
      kind: "question",
      state: "pending",
      form: COLOR_FORM,
      webUrl: `https://cap.example/chat/${conv}?subagent=${child}`,
    });
    // a sub-agent's question is answered on its card only: no text reply offered, and a message
    // in the root conversation leaves it pending (reply-while-question spec §4.3)
    expect(card.textReply).toBeUndefined();
    const aside = sent().length;
    im.push(connId, dm("sa2-m", "u-owner", "SA aside"));
    await waitFor(
      async () =>
        sent()
          .slice(aside)
          .some((s) => s.message.text.includes("noted aside")) || null,
      20_000,
      "root reply to the aside",
    );
    const q = await db
      .selectFrom("questions")
      .select("status")
      .where("id", "=", card.id)
      .executeTakeFirstOrThrow();
    expect(q.status).toBe("pending");
    im.push(
      connId,
      cardAction(
        "sa2-a",
        "u-owner",
        { cardKind: "question", cardId: card.id, action: "answer", answer: { color: "blue" } },
        cardMsg.target,
      ),
    );
    await childDelivered(conv, "child got the color");
    const up = await waitFor(
      async () =>
        updatesOf(cardMsg.messageId).find(
          (u) => (cardOf(u) as { state?: string } | undefined)?.state === "answered",
        ),
      10_000,
      "question card answered",
    );
    expect(cardOf(up)).toMatchObject({
      kind: "question",
      answerSummary: "blue",
      webUrl: `https://cap.example/chat/${conv}?subagent=${child}`,
    });
  });

  it("a child's next request brings its earlier, decided card up to date before the child is done", async () => {
    const chat = "grp-twice";
    const inChat = () => im.sent.filter((x) => x.appId === "cli_sa" && x.target.chatId === chat);
    im.push(connId, group("sa4", "u-owner", "@bot SA twice", { chatId: chat }));
    const first = await waitFor(
      async () => inChat().find((x) => cardOf(x)?.kind === "approval"),
      20_000,
      "first approval card",
    );
    await cardRecorded(db, first);
    const firstId = (cardOf(first) as { id: string }).id;
    im.push(
      connId,
      cardAction(
        "sa4-a",
        "u-owner",
        { cardKind: "approval", cardId: firstId, action: "approve", scope: "once" },
        first.target,
      ),
    );
    const second = await waitFor(
      async () =>
        inChat().find(
          (x) => cardOf(x)?.kind === "approval" && (cardOf(x) as { id: string }).id !== firstId,
        ),
      20_000,
      "second approval card",
    );
    // the child is waiting on the second approval, not done, and the first card shows approved
    const conv = await convOf(chat);
    expect(await runStatus(await childOf(conv))).toBe("waiting");
    expect(
      updatesOf(first.messageId).some(
        (u) => (cardOf(u) as { state?: string } | undefined)?.state === "approved",
      ),
    ).toBe(true);
    await cardRecorded(db, second);
    im.push(
      connId,
      cardAction(
        "sa4-b",
        "u-owner",
        { cardKind: "approval", cardId: (cardOf(second) as { id: string }).id, action: "approve" },
        second.target,
      ),
    );
    await childDelivered(conv, "child done twice");
  });

  it("in a group thread, someone other than the starter clicking a child's card is told they cannot handle it", async () => {
    const memberId = (
      await accountsFor(db).createLocal({ login: "member", password: PW, displayName: "M" })
    ).id;
    await testMembers(db).add(orgId, memberId, "member", ownerId);
    await sql`INSERT INTO capybara.identities (source, external_id, account_id)
      VALUES ('chan-mini:t1', 'u-member', ${memberId})`.execute(raw);
    const inGroup = () => im.sent.filter((x) => x.appId === "cli_sa" && x.target.chatId === GROUP);
    im.push(connId, group("sa3", "u-owner", "@bot SA group", { chatId: GROUP }));
    const cardMsg = await waitFor(
      async () => inGroup().find((x) => cardOf(x)?.kind === "approval"),
      20_000,
      "approval card in the group",
    );
    await cardRecorded(db, cardMsg);
    const card = cardOf(cardMsg) as Extract<ChannelCard, { kind: "approval" }>;
    const n = inGroup().length;
    im.push(
      connId,
      cardAction(
        "sa3-x",
        "u-member",
        { cardKind: "approval", cardId: card.id, action: "approve", scope: "once" },
        cardMsg.target,
      ),
    );
    const reply = await waitFor(async () => inGroup().slice(n)[0], 10_000, "explanation");
    expect(reply.message.text).toBe("You can't handle this request.");
    const row = await db
      .selectFrom("approvals")
      .select(["status", "requested_for"])
      .where("id", "=", card.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "pending", requested_for: ownerId });

    // the starter can
    im.push(
      connId,
      cardAction(
        "sa3-ok",
        "u-owner",
        { cardKind: "approval", cardId: card.id, action: "approve", scope: "once" },
        cardMsg.target,
      ),
    );
    await childDelivered(await convOf(GROUP), "child echoed");
  });
});
