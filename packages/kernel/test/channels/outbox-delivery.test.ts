import { fileURLToPath } from "node:url";
import type { ChannelCard } from "@capybara-hq/plugin-sdk";
import {
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
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { drainOutbox } from "../helpers/outbox.js";
import {
  cardRecorded,
  createAgent,
  createConv,
  createOrg,
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
 * Transactional outbox spec §8.1 (IM delivery): for a conversation with a channel target, every
 * event append (a reply, an approval decision, a question answer, a wait stop) owes the
 * conversation's deliver job in its own transaction; a conversation without one writes nothing.
 *
 * The owed path is isolated: every add to `cap-kernel-channels` through the outbox fails while
 * `failing` is set (the `OUTBOX_DISPATCH_FAILS` seam, so the fast path delivers nothing), and the
 * direct enqueues of `ChannelJobs.enqueue` (the `run.started` hint, a delivery's follow-up) do
 * nothing. What reaches IM got there through an owed row an explicit relay pass delivered.
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
const ECHO = 'tool:plugin__mem-connector__echo:{"text":"hi"}';

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let im: FakeChannelServer;
let owner: Req;
let orgId: string;
let connId: string;
/** While true, the outbox's adds to the channel queue fail. */
let failing = true;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer({ dedupeSends: false });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, CHAN_MINI, MEM_CONNECTOR],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 10_000, deliveryIdleMs: 1000 },
      },
    ),
    {
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => failing && queue === CHANNEL_QUEUE_NAME,
        },
      ],
    },
  );
  // no direct deliver enqueue: only the owed rows can reach IM
  (k.app.get(ChannelJobs) as { enqueue: ChannelJobs["enqueue"] }).enqueue = async () => {};
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Owner" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
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
  await sql`INSERT INTO capybara.identities (source, external_id, account_id)
    VALUES ('chan-mini:t1', 'u-owner', ${ownerId})`.execute(raw);
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
}, 120_000);

afterAll(async () => {
  await k?.close();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
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

describe("IM delivery is owed (transactional outbox §8.1)", { timeout: 60_000 }, () => {
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
