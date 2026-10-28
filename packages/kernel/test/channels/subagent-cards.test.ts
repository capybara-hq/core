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
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { COLOR_FORM } from "../fixtures/plugins/mem-connector/index.js";
import type { ScriptRule } from "../fixtures/plugins/model-script/index.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  cardRecorded,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Phase C Task 11, Review Focus 2: a sub-agent of a conversation started from IM needs an approval
 * (or an answer); the card is posted in the thread from the parent's `subagent_waiting`, and
 * handling it there resumes the child, then the parent, whose reply reaches the thread.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const CHAN_MINI = fixture("chan-mini");
const MEM_CONNECTOR = fixture("mem-connector");
const MODEL_SCRIPT = fixture("model-script");

const CHILD = "You are a sub-agent";
const agentCall = (input: Record<string, unknown>) => ({ name: "agent", input });

const RULES: ScriptRule[] = [
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-echo", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "mem-connector__echo", input: { text: "sa-hi" } }] },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "sa-hi" },
    reply: { text: "child echoed" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-ask", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "mem-connector__ask", input: {} }] },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "color=" },
    reply: { text: "child got the color" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-deny", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "mem-connector__echo", input: { text: "deny-hi" } }] },
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
    when: { lastToolResultIncludes: "child was denied" },
    reply: { text: "parent saw the denial" },
  },
  {
    when: { lastUserIncludes: "SA approve", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Echo it", prompt: "child-echo: go" })] },
  },
  { when: { lastToolResultIncludes: "child echoed" }, reply: { text: "parent saw the echo" } },
  {
    // the same IM thread (conversation) as the first test: its turn left two assistant messages
    when: { lastUserIncludes: "SA ask", assistantTurns: 2 },
    reply: { toolCalls: [agentCall({ description: "Ask it", prompt: "child-ask: go" })] },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-twice", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "mem-connector__echo", input: { text: "first-echo" } }] },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "first-echo" },
    reply: { toolCalls: [{ name: "mem-connector__echo", input: { text: "second-echo" } }] },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "second-echo" },
    reply: { text: "child done twice" },
  },
  {
    when: { lastUserIncludes: "SA twice", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Echo twice", prompt: "child-twice: go" })] },
  },
  { when: { lastToolResultIncludes: "child done twice" }, reply: { text: "parent saw both" } },
  {
    when: { lastUserIncludes: "SA group", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Echo it", prompt: "child-echo: go" })] },
  },
  {
    when: { lastToolResultIncludes: "child got the color" },
    reply: { text: "parent saw the color" },
  },
];

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let im: FakeChannelServer;
let owner: Req;
let ownerId: string;
let orgId: string;
let connId: string;

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
        channels: { scanIntervalMs: 100, leaseTtlMs: 2000, deliveryIdleMs: 1000 },
        extensionConfig: { "model-script": { rules: RULES } },
      },
    ),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  ownerId = (
    await new AccountsService(db).createLocal({
      login: "owner",
      password: PW,
      displayName: "Owner",
    })
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
        name: "Lead",
        instructions: "Lead the work.",
        model: { provider: "model-script", model: "script-1" },
        tools: [
          { kind: "builtin", name: "agent" },
          { kind: "plugin", plugin: "mem-connector", name: "echo" },
          { kind: "plugin", plugin: "mem-connector", name: "ask" },
        ],
        toolPolicies: { "mem-connector__echo": "ask" },
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
      config: { platformUrl: im.url, appId: "cli_sa", appSecret: "app-secret-1234567" },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  connId = (res.json() as { channel: { id: string } }).channel.id;
  await waitFor(async () => im.active(connId).length === 1, 10_000, "long connection");
}, 180_000);

afterAll(async () => {
  await k?.stop();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const CHAT = "dm-u-owner";
const GROUP = "grp-sa";
const sent = () => im.sent.filter((s) => s.appId === "cli_sa" && s.target.chatId === CHAT);
const cardOf = (s: FakeChannelSent | undefined) => s?.message.cards?.[0];
const updatesOf = (messageId: string) => im.updated.filter((u) => u.messageId === messageId);
const finalText = (s: FakeChannelSent) =>
  updatesOf(s.messageId).at(-1)?.message.text ?? s.message.text;

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

describe("sub-agent cards in an IM thread", { timeout: 60_000 }, () => {
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
      toolName: "echo",
      state: "pending",
      webUrl: `https://cap.example/chat/${conv}?subagent=${child}`,
    });
    expect(card.inputPreview).toContain("sa-hi");
    const events: ConversationEvent[] = await eventsOf(db, conv);
    expect(events.some((e) => e.type === "subagent_waiting")).toBe(true);
    expect(await runStatus(conv)).toBe("waiting");

    const n = sent().length;
    im.push(
      connId,
      cardAction(
        "sa1-act",
        "u-owner",
        { cardKind: "approval", cardId: card.id, action: "approve", scope: "once" },
        cardMsg.target,
      ),
    );
    await waitFor(
      async () =>
        sent()
          .slice(n)
          .some((s) => finalText(s) === "parent saw the echo"),
      30_000,
      "parent reply in the thread",
    );
    expect(await runStatus(child)).toBe("completed");
    // the thread gets the reply before the parent's worker commits run_finished
    await waitFor(async () => (await runStatus(conv)) === "completed", 10_000, "parent done");
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
    await waitFor(
      async () => inChat().some((x) => finalText(x) === "parent saw the denial"),
      30_000,
      "parent reply",
    );
    const child = await childOf(await convOf(chat));
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
    const n = sent().length;
    im.push(
      connId,
      cardAction(
        "sa2-a",
        "u-owner",
        { cardKind: "question", cardId: card.id, action: "answer", answer: { color: "blue" } },
        cardMsg.target,
      ),
    );
    await waitFor(
      async () =>
        sent()
          .slice(n)
          .some((s) => finalText(s) === "parent saw the color"),
      30_000,
      "parent reply in the thread",
    );
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
    await waitFor(
      async () => inChat().some((x) => finalText(x) === "parent saw both"),
      30_000,
      "parent reply",
    );
  });

  it("in a group thread, someone other than the starter clicking a child's card is told they cannot handle it", async () => {
    const memberId = (
      await new AccountsService(db).createLocal({ login: "member", password: PW, displayName: "M" })
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
    const m = inGroup().length;
    im.push(
      connId,
      cardAction(
        "sa3-ok",
        "u-owner",
        { cardKind: "approval", cardId: card.id, action: "approve", scope: "once" },
        cardMsg.target,
      ),
    );
    await waitFor(
      async () =>
        inGroup()
          .slice(m)
          .some((x) => finalText(x) === "parent saw the echo"),
      30_000,
      "parent reply in the group",
    );
  });
});
