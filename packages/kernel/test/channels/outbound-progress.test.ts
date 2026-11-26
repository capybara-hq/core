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
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CHANNEL_QUEUE_NAME } from "../../src/channels/outbound.js";
import { conversationTopic } from "../../src/conversations/event-log.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_BUS } from "../../src/infra/tokens.js";
import { defineOperation, type PlatformOperation } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import type { ScriptRule } from "../fixtures/plugins/model-script/index.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrgWithProviders,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * The channel progress card (conversation process blocks spec §6.2, §6.3): one progress message per
 * run, edited in place, instead of narration messages; the answer and blocking cards are new
 * messages; handoffs merge into one message after the answer; `off` keeps the streaming draft; a
 * channel without edits gets a start message and throttled milestones. Single replica; the
 * takeover is in outbound-progress.dual.test.ts.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const CHAN_MINI = fixture("chan-mini");
const CHAN_NOEDIT = fixture("chan-noedit");
const CHAN_TEXTPROGRESS = fixture("chan-textprogress");
const MEM_CONNECTOR = fixture("mem-connector");
const MODEL_SCRIPT = fixture("model-script");
const UI_PROBE = fixture("ui-probe");

const PROBE = "plugin__ui-probe__probe";
const ECHO = "plugin__mem-connector__echo";
const LINK_A = "platform.progress-link-a";
const LINK_B = "platform.progress-link-b";

const linkOp = (id: string, en: string, zh: string, url: string) =>
  defineOperation({
    id,
    description: "Test only: hands off to a review page.",
    input: z.object({}).strict(),
    example: {},
    authz: { orgAction: "agents.use" },
    mirrors: [],
    confirm: "read",
    run: async () => ({ staged: true }),
    handoff: () => ({ kind: "handoff", title: { zh, en }, target: { type: "link", url } }),
  }) as PlatformOperation;

const platformCall = (operation: string) => ({
  name: "Platform",
  input: { action: "call", operation, params: {} },
});
const pinnedProbe = (text: string) => ({
  name: PROBE,
  input: { card: "card", cardExtra: { placement: "pinned", text } },
});

/** Scripted runs, keyed by the person's message (each test starts its own conversation). */
const RULES: ScriptRule[] = [
  {
    when: { lastUserIncludes: "narr", assistantTurns: 0 },
    reply: { text: "Let me look first.", toolCalls: [{ name: PROBE, input: {} }] },
  },
  {
    when: { lastUserIncludes: "narr", assistantTurns: 1 },
    reply: { text: "Now checking more.", toolCalls: [{ name: PROBE, input: {} }] },
  },
  { when: { lastUserIncludes: "narr", assistantTurns: 2 }, reply: { text: "narr answer" } },
  {
    when: { lastUserIncludes: "approve", assistantTurns: 0 },
    reply: { text: "Asking first.", toolCalls: [{ name: ECHO, input: { text: "hi" } }] },
  },
  { when: { lastUserIncludes: "approve", assistantTurns: 1 }, reply: { text: "approved answer" } },
  {
    when: { lastUserIncludes: "handoff", assistantTurns: 0 },
    reply: { text: "Opening the first review.", toolCalls: [platformCall(LINK_A)] },
  },
  {
    when: { lastUserIncludes: "handoff", assistantTurns: 1 },
    reply: { text: "Opening the second review.", toolCalls: [platformCall(LINK_B)] },
  },
  { when: { lastUserIncludes: "handoff", assistantTurns: 2 }, reply: { text: "handoff answer" } },
  {
    when: { lastUserIncludes: "pinned", assistantTurns: 0 },
    reply: { text: "Planning.", toolCalls: [pinnedProbe("Todo 1/2")] },
  },
  {
    when: { lastUserIncludes: "pinned", assistantTurns: 1 },
    reply: { text: "Next item.", toolCalls: [pinnedProbe("Todo 2/2")] },
  },
  { when: { lastUserIncludes: "pinned", assistantTurns: 2 }, reply: { text: "pinned answer" } },
  // a pinned change, a wait for approval (the job ends), then a second pinned change
  {
    when: { lastUserIncludes: "milestone", assistantTurns: 0 },
    reply: { text: "Plan.", toolCalls: [pinnedProbe("Step 1/2")] },
  },
  {
    when: { lastUserIncludes: "milestone", assistantTurns: 1 },
    reply: { toolCalls: [{ name: ECHO, input: { text: "hi" } }] },
  },
  {
    when: { lastUserIncludes: "milestone", assistantTurns: 2 },
    reply: { toolCalls: [pinnedProbe("Step 2/2")] },
  },
  {
    when: { lastUserIncludes: "milestone", assistantTurns: 3 },
    reply: { text: "milestone answer" },
  },
  { when: { lastUserIncludes: "explode" }, reply: { fail: "invalid_request" } },
  // narration, then an empty final reply: the last narration is promoted to the answer
  {
    when: { lastUserIncludes: "silent", assistantTurns: 0 },
    reply: { text: "Checking quietly.", toolCalls: [{ name: PROBE, input: {} }] },
  },
  {
    when: { lastUserIncludes: "silent", assistantTurns: 1 },
    reply: { text: "All **done** here.", toolCalls: [{ name: PROBE, input: {} }] },
  },
  { when: { lastUserIncludes: "silent", assistantTurns: 2 }, reply: {} },
];

const LONG = "The quick brown fox jumps over the lazy dog while streaming tokens to IM. ".repeat(2);

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let im: FakeChannelServer;
let owner: Req;
let detailedId: string;
let briefId: string;
let offId: string;
let noEditId: string;
let defaultId: string;
let fakeDetailedId: string;
let textId: string;
let noEditBriefId: string;
let orgId: string;
let channelQueue: Queue<{ conversationId?: string }>;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer({ dedupeSends: false });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [
          MODEL_FAKE,
          MODEL_SCRIPT,
          CHAN_MINI,
          CHAN_NOEDIT,
          CHAN_TEXTPROGRESS,
          MEM_CONNECTOR,
          UI_PROBE,
        ],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 10_000, deliveryIdleMs: 1000 },
        extensionConfig: { "model-script": { rules: RULES } },
      },
    ),
  );
  k.app
    .get(PlatformOperations)
    .register([
      linkOp(LINK_A, "Review A", "审阅 A", "/admin/review?a=1"),
      linkOp(LINK_B, "Review B", "审阅 B", "/admin/review?b=1"),
    ]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Owner" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  channelQueue = new Queue(CHANNEL_QUEUE_NAME, { connection: new Redis(rd.url) });
  for (const plugin of [
    "chan-mini",
    "chan-noedit",
    "chan-textprogress",
    "mem-connector",
    "ui-probe",
  ]) {
    const en = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
      payload: { enabled: true },
    });
    expect(en.statusCode, en.body).toBe(200);
  }
  const agent = async (name: string, model: { provider: string; model: string }) => {
    const ag = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name,
          instructions: "Be helpful.",
          model,
          disabledTools: onlyBuiltins([{ kind: "builtin", name: "Platform" }]),
          toolPolicies: { [ECHO]: "ask" },
        },
        visibility: "org",
      },
    });
    expect(ag.statusCode, ag.body).toBe(201);
    return (ag.json() as { agent: { id: string } }).agent.id;
  };
  const scripted = await agent("Scripted", { provider: "model-script", model: "script-1" });
  const fake = await agent("Fake", { provider: "model-fake", model: "fake-1" });
  for (const source of ["chan-mini:t1", "chan-noedit:t1", "chan-textprogress:t1"]) {
    for (const user of [
      "u-n1",
      "u-n2",
      "u-a1",
      "u-h1",
      "u-b1",
      "u-o1",
      "u-m1",
      "u-r1",
      "u-r2",
      "u-t1",
      "u-f1",
      "u-s1",
      "u-m2",
      "u-g1",
      "u-x1",
      "u-e1",
      "u-tp1",
      "u-q1",
      "u-q2",
      "u-mb1",
      "u-fl1",
    ]) {
      await sql`INSERT INTO capybara.identities (source, external_id, account_id)
        VALUES (${source}, ${user}, ${ownerId})`.execute(raw);
    }
  }
  const mk = async (
    plugin: string,
    appId: string,
    agentId: string,
    processDisplay?: "detailed" | "brief" | "off",
  ) => {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/channels`,
      payload: {
        plugin,
        name: appId,
        agentId,
        config: { platformUrl: im.url, appId, appSecret: "app-secret-1234567" },
        ...(processDisplay !== undefined && { processDisplay }),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { channel: { id: string } }).channel.id;
    await waitFor(async () => im.active(id).length === 1, 10_000, `${appId} long connection`);
    return id;
  };
  detailedId = await mk("chan-mini", "cli_pd", scripted, "detailed");
  briefId = await mk("chan-mini", "cli_pb", scripted, "brief");
  offId = await mk("chan-mini", "cli_po", fake, "off");
  // no setting: a direct chat defaults to detailed
  noEditId = await mk("chan-noedit", "cli_pn", scripted);
  // no setting on an edit channel: groups default to brief
  defaultId = await mk("chan-mini", "cli_pg", scripted);
  // the streaming checks run on model-fake, which streams in chunks
  fakeDetailedId = await mk("chan-mini", "cli_pf", fake, "detailed");
  // cards and edits but no features.progress: the card goes out as text
  textId = await mk("chan-textprogress", "cli_pt", scripted, "detailed");
  noEditBriefId = await mk("chan-noedit", "cli_pnb", scripted, "brief");
});

afterAll(async () => {
  await channelQueue?.close();
  await k?.close();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type ProgressCard = Extract<ChannelCard, { kind: "progress" }>;
const sentTo = (app: string, chatId: string) =>
  im.sent.filter((s) => s.appId === app && s.target.chatId === chatId);
const updatesOf = (messageId: string) => im.updated.filter((u) => u.messageId === messageId);
const cardOf = (s: FakeChannelSent | undefined) => s?.message.cards?.[0];
const progressOf = (s: FakeChannelSent | undefined) => {
  const c = cardOf(s);
  return c?.kind === "progress" ? (c as ProgressCard) : undefined;
};
/** The progress card a message shows last: its last update, else as sent. */
const lastProgress = (s: FakeChannelSent) =>
  progressOf(updatesOf(s.messageId).at(-1) ?? s) as ProgressCard;

async function convOf(conn: string, chatId: string): Promise<string> {
  return waitFor(
    async () => {
      const r = await sql<{ conversation_id: string }>`SELECT conversation_id
        FROM capybara.channel_threads WHERE connection_id = ${conn} AND chat_id = ${chatId}
          AND archived_at IS NULL`.execute(raw);
      return r.rows[0]?.conversation_id;
    },
    10_000,
    "conversation",
  );
}

async function deliveryRow(conversationId: string) {
  return db
    .selectFrom("channel_deliveries")
    .select([
      "last_seq",
      "progress_message_id",
      "progress_run_id",
      "milestone_at",
      "progress_reposted",
    ])
    .where("conversation_id", "=", conversationId)
    .executeTakeFirstOrThrow();
}

/** No run of the conversation is active and its delivery read the whole log. */
async function settled(conversationId: string): Promise<void> {
  await waitFor(
    async () => {
      const active = await db
        .selectFrom("runs")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .where("status", "in", ["queued", "running", "waiting"])
        .executeTakeFirst();
      if (active) return false;
      const c = await db
        .selectFrom("conversations")
        .select("last_seq")
        .where("id", "=", conversationId)
        .executeTakeFirstOrThrow();
      const d = await db
        .selectFrom("channel_deliveries")
        .select("last_seq")
        .where("conversation_id", "=", conversationId)
        .executeTakeFirst();
      return d?.last_seq === c.last_seq;
    },
    20_000,
    "delivery settled",
  );
}

/** The progress message's finished form has arrived (the run's final edit). */
async function finished(s: FakeChannelSent): Promise<ProgressCard> {
  return waitFor(
    async () => {
      const c = lastProgress(s);
      return c.state === "finished" ? c : undefined;
    },
    20_000,
    "finished progress card",
  );
}

/** No delivery job of the conversation is left in the channel queue (the current one ended). */
async function jobsDone(conversationId: string): Promise<void> {
  await waitFor(
    async () => {
      const jobs = await channelQueue.getJobs(["active", "waiting", "prioritized", "delayed"]);
      return jobs.every((j) => j.data.conversationId !== conversationId);
    },
    20_000,
    "no delivery job of the conversation left",
  );
}

/** The ended progress card (the run's final edit) in state `state`. */
async function ended(s: FakeChannelSent, state: ProgressCard["state"]): Promise<ProgressCard> {
  return waitFor(
    async () => {
      const c = lastProgress(s);
      return c.state === state ? c : undefined;
    },
    20_000,
    `${state} progress card`,
  );
}

async function runIds(conversationId: string): Promise<string[]> {
  const r = await db
    .selectFrom("runs")
    .select("id")
    .where("conversation_id", "=", conversationId)
    .orderBy("created_at")
    .execute();
  return r.map((x) => x.id);
}

describe("channel progress card (process blocks spec §6.2)", () => {
  it("narration sends nothing, the answer sends one message", async () => {
    const chat = "dm-u-n1";
    im.push(detailedId, dm("pn1", "u-n1", "narr please"));
    const conv = await convOf(detailedId, chat);
    await settled(conv);
    const msgs = sentTo("cli_pd", chat);
    expect(msgs).toHaveLength(2);
    expect(progressOf(msgs[0])).toBeDefined();
    expect(msgs[1]?.message).toEqual({ text: "narr answer" });
    const all = [...msgs, ...im.updated.filter((u) => u.target.chatId === chat)];
    // narration only ever shows inside the progress card's status line
    for (const m of all.filter((x) => progressOf(x) === undefined)) {
      expect(m.message.text).not.toContain("Let me look first.");
      expect(m.message.text).not.toContain("Now checking more.");
    }
  });

  it("one progress message per run, edited", async () => {
    const chat = "dm-u-n2";
    im.push(detailedId, dm("pn2", "u-n2", "narr twice"));
    const conv = await convOf(detailedId, chat);
    await settled(conv);
    const first = sentTo("cli_pd", chat)[0] as FakeChannelSent;
    const card = progressOf(first) as ProgressCard;
    expect(card.state).toBe("running");
    expect(card.url).toBe(`https://cap.example/chat/${conv}`);
    const done = await finished(first);
    // edited in place: no other progress message for the run
    expect(done.title).toMatch(/^Worked for /);
    expect(done.steps).toEqual([]);
    expect(done.status).toBeUndefined();
    expect(done.meta).toBe("2 tools");
    const [run1] = await runIds(conv);
    expect(await deliveryRow(conv)).toMatchObject({
      progress_message_id: first.messageId,
      progress_run_id: run1,
    });

    // a second run in the same conversation gets its own progress message, and run_started
    // clears the previous run's re-post flag
    await db
      .updateTable("channel_deliveries")
      .set({ progress_reposted: true })
      .where("conversation_id", "=", conv)
      .execute();
    im.push(detailedId, dm("pn2b", "u-n2", "and again"));
    await waitFor(async () => (await runIds(conv)).length === 2, 10_000, "second run");
    await settled(conv);
    const msgs = sentTo("cli_pd", chat);
    const progress = msgs.filter((m) => progressOf(m) !== undefined);
    expect(progress).toHaveLength(2);
    expect(msgs.filter((m) => progressOf(m) === undefined).map((m) => m.message.text)).toEqual([
      "narr answer",
      "done",
    ]);
    await finished(progress[1] as FakeChannelSent);
    const [, run2] = await runIds(conv);
    expect(await deliveryRow(conv)).toMatchObject({
      progress_message_id: progress[1]?.messageId,
      progress_run_id: run2,
      progress_reposted: false,
    });
  });

  it("approval card still posts a new message", async () => {
    const chat = "dm-u-a1";
    im.push(detailedId, dm("pa1", "u-a1", "approve this"));
    const conv = await convOf(detailedId, chat);
    const approval = await waitFor(
      async () => sentTo("cli_pd", chat).find((s) => cardOf(s)?.kind === "approval"),
      20_000,
      "approval card",
    );
    const progressMsg = sentTo("cli_pd", chat)[0] as FakeChannelSent;
    expect(progressOf(progressMsg)).toBeDefined();
    // the progress card shows the wait at once (an edit, which does not notify), with the
    // narration as its status line and the step
    const waiting = await waitFor(
      async () =>
        updatesOf(progressMsg.messageId)
          .map(progressOf)
          .find((c) => c?.state === "waiting"),
      10_000,
      "progress card waiting",
    );
    expect(waiting.status).toBe("Asking first.");
    expect(waiting.steps).toHaveLength(1);
    expect(waiting.steps[0]).toContain("hi");
    im.push(
      detailedId,
      cardAction(
        "pa1-ok",
        "u-a1",
        {
          cardKind: "approval",
          cardId: (cardOf(approval) as { id: string }).id,
          action: "approve",
        },
        approval.target,
      ),
    );
    await settled(conv);
    await finished(progressMsg);
    const msgs = sentTo("cli_pd", chat);
    expect(msgs.map((m) => cardOf(m)?.kind ?? m.message.text)).toEqual([
      "progress",
      "approval",
      "approved answer",
    ]);
  });

  it("handoffs merge after the answer", async () => {
    const chat = "dm-u-h1";
    im.push(detailedId, dm("ph1", "u-h1", "handoff now"));
    const conv = await convOf(detailedId, chat);
    await settled(conv);
    const msgs = sentTo("cli_pd", chat);
    expect(msgs).toHaveLength(3);
    expect(progressOf(msgs[0])).toBeDefined();
    expect(msgs[1]?.message.text).toBe("handoff answer");
    const merged = msgs[2] as FakeChannelSent;
    expect(merged.message.text).toBe("Needs your action (2)");
    expect(merged.message.cards).toEqual([
      { kind: "bind", text: "Review A", url: "https://cap.example/admin/review?a=1" },
      { kind: "bind", text: "Review B", url: "https://cap.example/admin/review?b=1" },
    ]);
    // the card listed them while running and keeps them when finished
    const done = await finished(msgs[0] as FakeChannelSent);
    expect(done.pending).toEqual([
      { text: "Review A", url: "https://cap.example/admin/review?a=1" },
      { text: "Review B", url: "https://cap.example/admin/review?b=1" },
    ]);
  });

  it("brief edits without steps", async () => {
    const chat = "dm-u-b1";
    im.push(briefId, dm("pb1", "u-b1", "narr briefly"));
    const conv = await convOf(briefId, chat);
    await settled(conv);
    const msgs = sentTo("cli_pb", chat);
    expect(msgs).toHaveLength(2);
    const progressMsg = msgs[0] as FakeChannelSent;
    expect(msgs[1]?.message.text).toBe("narr answer");
    const done = await finished(progressMsg);
    expect(done.meta).toBe("2 tools");
    for (const m of [progressMsg, ...updatesOf(progressMsg.messageId)]) {
      const c = progressOf(m) as ProgressCard;
      expect(c.steps).toEqual([]);
      expect(c.status).toBeUndefined();
    }
  });

  it("off keeps the streaming draft", async () => {
    const chat = "dm-u-o1";
    im.push(offId, dm("po1", "u-o1", `slow:60:${LONG}`));
    const conv = await convOf(offId, chat);
    await settled(conv);
    const msgs = sentTo("cli_po", chat);
    expect(msgs).toHaveLength(1);
    const draft = msgs[0] as FakeChannelSent;
    expect(progressOf(draft)).toBeUndefined();
    expect(LONG.startsWith(draft.message.text)).toBe(true);
    const ups = updatesOf(draft.messageId);
    expect(ups.length).toBeGreaterThanOrEqual(2);
    expect(ups.at(-1)?.message.text).toBe(LONG);
    expect(await deliveryRow(conv)).toMatchObject({
      progress_message_id: null,
      progress_run_id: null,
    });
  });

  it("no-edit channel sends start and throttled milestones", async () => {
    const chat = "dm-u-m1";
    im.push(noEditId, dm("pm1", "u-m1", "pinned list"));
    const conv = await convOf(noEditId, chat);
    await settled(conv);
    // the second pinned change came within a minute of the first milestone: no message for it
    // then; the run's end sends it as a trailing milestone
    expect(sentTo("cli_pn", chat).map((m) => m.message.text)).toEqual([
      "Working on it",
      "Todo 1/2",
      "pinned answer",
      "Todo 2/2",
    ]);
    expect(im.updated.filter((u) => u.target.chatId === chat)).toEqual([]);
    const row = await deliveryRow(conv);
    const [run] = await runIds(conv);
    expect(row.progress_run_id).toBe(run);
    expect(row.progress_message_id).toBeNull();
    expect(row.milestone_at).not.toBeNull();
  });

  it("rejected edit re-posts once", async () => {
    const chat = "dm-u-r1";
    // every edit of this chat is rejected: the first handoff's edit (the run still going)
    // re-posts the card once; later edits, the final one included, post nothing more
    im.failNext("/update", 400, 50, undefined, "rejected", undefined, chat);
    im.push(detailedId, dm("pr1", "u-r1", "handoff rejected"));
    const conv = await convOf(detailedId, chat);
    await settled(conv);
    const msgs = sentTo("cli_pd", chat);
    const progress = msgs.filter((m) => progressOf(m) !== undefined);
    expect(progress).toHaveLength(2);
    expect(msgs.filter((m) => progressOf(m) === undefined).map((m) => m.message.text)).toEqual([
      "handoff answer",
      "Needs your action (2)",
    ]);
    expect((await deliveryRow(conv)).progress_message_id).toBe(progress[1]?.messageId);
    expect(im.updated.filter((u) => u.target.chatId === chat)).toEqual([]);
  });

  it("rejected edit re-posts once across jobs", async () => {
    const chat = "dm-u-r2";
    // every edit of the progress card ("Working", "Waiting …", "Worked for …") is rejected; the
    // approval card's own update goes through
    for (const textIncludes of ["Work", "Waiting"]) {
      im.failNext("/update", 400, 50, undefined, "rejected", undefined, {
        chatId: chat,
        textIncludes,
      });
    }
    im.push(detailedId, dm("pr2", "u-r2", "approve after rejection"));
    const conv = await convOf(detailedId, chat);
    const approval = await waitFor(
      async () => sentTo("cli_pd", chat).find((s) => cardOf(s)?.kind === "approval"),
      20_000,
      "approval card",
    );
    // the first job re-posted the card when its waiting edit was rejected, then ended
    await jobsDone(conv);
    expect(sentTo("cli_pd", chat).filter((m) => progressOf(m) !== undefined)).toHaveLength(2);
    im.push(
      detailedId,
      cardAction(
        "pr2-ok",
        "u-r2",
        {
          cardKind: "approval",
          cardId: (cardOf(approval) as { id: string }).id,
          action: "approve",
        },
        approval.target,
      ),
    );
    await settled(conv);
    await jobsDone(conv);
    // the next job's rejected edits post no further card (the fake does not dedupe sends)
    const msgs = sentTo("cli_pd", chat);
    expect(msgs.filter((m) => progressOf(m) !== undefined)).toHaveLength(2);
    expect(msgs.filter((m) => cardOf(m) === undefined).map((m) => m.message.text)).toEqual([
      "approved answer",
    ]); // the re-post has its own flag; milestone_at stays the no-edit milestones' only
    expect(await deliveryRow(conv)).toMatchObject({
      progress_message_id: msgs.filter((m) => progressOf(m) !== undefined)[1]?.messageId,
      progress_reposted: true,
      milestone_at: null,
    });
  });

  it("a job after an ended run does not touch its finished card", async () => {
    const chat = "dm-u-e1";
    im.push(detailedId, dm("pe1", "u-e1", "narr first"));
    const conv = await convOf(detailedId, chat);
    await settled(conv);
    await finished(sentTo("cli_pd", chat)[0] as FakeChannelSent);
    await jobsDone(conv);
    // the finished card can no longer be edited (too old on a real platform)
    im.failNext("/update", 400, 50, undefined, "rejected", undefined, {
      chatId: chat,
      textIncludes: "Worked",
    });
    const before = updatesOf((sentTo("cli_pd", chat)[0] as FakeChannelSent).messageId).length;
    im.push(detailedId, dm("pe2", "u-e1", "and again"));
    await waitFor(async () => (await runIds(conv)).length === 2, 10_000, "second run");
    await settled(conv);
    await jobsDone(conv);
    const msgs = sentTo("cli_pd", chat);
    // the old card is neither edited again nor posted anew; the new run has its own card
    expect(msgs.map((m) => cardOf(m)?.kind ?? m.message.text)).toEqual([
      "progress",
      "narr answer",
      "progress",
      "done",
    ]);
    expect(updatesOf((msgs[0] as FakeChannelSent).messageId)).toHaveLength(before);
  });

  it("a retryable edit failure does not hold back the answer", async () => {
    const chat = "dm-u-t1";
    // a rate limit asking for 30 s: a failed job would come back far too late for this test
    im.failNext("/update", 429, 1, 30_000, undefined, undefined, chat);
    im.push(detailedId, dm("pt1", "u-t1", "handoff later"));
    const conv = await convOf(detailedId, chat);
    await waitFor(
      async () => sentTo("cli_pd", chat).some((m) => m.message.text === "handoff answer"),
      10_000,
      "answer in the same job",
    );
    await settled(conv);
    const done = await finished(sentTo("cli_pd", chat)[0] as FakeChannelSent);
    expect(done.pending).toHaveLength(2);
    // no delivery attempt failed: the card caught up at a later interval of the same job
    const retried = (await channelQueue.getJobs(["delayed", "failed", "waiting"])).filter(
      (j) => j.data.conversationId === conv && j.attemptsMade > 0,
    );
    expect(retried).toEqual([]);
  });

  it("a failed run's card ends as failed, with the failure message", async () => {
    const chat = "dm-u-f1";
    im.push(detailedId, dm("pf1", "u-f1", "explode"));
    const conv = await convOf(detailedId, chat);
    await settled(conv);
    const msgs = sentTo("cli_pd", chat);
    const card = await ended(msgs[0] as FakeChannelSent, "failed");
    expect(card.title).toBe("Failed");
    expect(card.steps).toEqual([]);
    expect(msgs.slice(1).map((m) => m.message.text)).toEqual([
      "Sorry, something went wrong. Please try again later.",
    ]);
  });

  it("a stopped run's card ends as stopped", async () => {
    const chat = "dm-u-s1";
    im.push(detailedId, dm("ps1", "u-s1", "approve then stop"));
    const conv = await convOf(detailedId, chat);
    await waitFor(
      async () => sentTo("cli_pd", chat).find((s) => cardOf(s)?.kind === "approval"),
      20_000,
      "approval card",
    );
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    await settled(conv);
    const card = await ended(sentTo("cli_pd", chat)[0] as FakeChannelSent, "stopped");
    expect(card.title).toBe("Stopped");
    expect(card.status).toBeUndefined();
  });

  it("no-edit channel keeps milestone_at across jobs", async () => {
    const chat = "dm-u-m2";
    im.push(noEditId, dm("pm2", "u-m2", "milestone run"));
    const conv = await convOf(noEditId, chat);
    const approval = await waitFor(
      async () => sentTo("cli_pn", chat).find((s) => cardOf(s)?.kind === "approval"),
      20_000,
      "approval card",
    );
    await jobsDone(conv);
    im.push(
      noEditId,
      cardAction(
        "pm2-ok",
        "u-m2",
        {
          cardKind: "approval",
          cardId: (cardOf(approval) as { id: string }).id,
          action: "approve",
        },
        approval.target,
      ),
    );
    await settled(conv);
    // the second pinned change came in a new job within a minute of the first milestone (PG);
    // the run's end sends it as a trailing milestone
    expect(
      sentTo("cli_pn", chat)
        .filter((m) => cardOf(m) === undefined)
        .map((m) => m.message.text),
    ).toEqual(["Working on it", "Step 1/2", "milestone answer", "Step 2/2"]);
  });

  it("a group connection without a setting shows the brief card", async () => {
    const chat = "grp-brief";
    im.push(defaultId, group("pg1", "u-g1", "narr in a group", { chatId: chat }));
    const conv = await convOf(defaultId, chat);
    await settled(conv);
    const msgs = sentTo("cli_pg", chat);
    expect(msgs.map((m) => cardOf(m)?.kind ?? m.message.text)).toEqual(["progress", "narr answer"]);
    const progressMsg = msgs[0] as FakeChannelSent;
    await finished(progressMsg);
    for (const m of [progressMsg, ...updatesOf(progressMsg.messageId)]) {
      const c = progressOf(m) as ProgressCard;
      expect(c.steps).toEqual([]);
      expect(c.status).toBeUndefined();
    }
  });

  it("a step_reset drops the streamed status line and sends no draft", async () => {
    const chat = "dm-u-x1";
    let delta: { runId: string; step: number } | undefined;
    const bus = k.app.get(KERNEL_BUS) as {
      publish(topic: string, payload: unknown): Promise<void>;
      subscribe(topic: string, h: (m: unknown) => unknown): Promise<() => Promise<void>>;
    };
    im.push(fakeDetailedId, dm("px1", "u-x1", `slow:150:${LONG}`));
    const conv = await convOf(fakeDetailedId, chat);
    const unsubscribe = await bus.subscribe(conversationTopic(conv), (m) => {
      const d = m as { kind?: string; runId?: string; step?: number };
      if (d.kind === "delta" && d.runId !== undefined && d.step !== undefined)
        delta ??= { runId: d.runId, step: d.step };
    });
    try {
      const cardMsg = await waitFor(
        async () => sentTo("cli_pf", chat).find((m) => progressOf(m) !== undefined),
        20_000,
        "progress card",
      );
      // the streamed text shows as the status line
      await waitFor(
        async () =>
          updatesOf(cardMsg.messageId).some((u) =>
            LONG.startsWith(progressOf(u)?.status ?? "\u0000"),
          ),
        20_000,
        "streamed status line",
      );
      const at = await waitFor(async () => delta, 10_000, "a delta");
      await bus.publish(conversationTopic(conv), {
        kind: "delta",
        runId: at.runId,
        step: at.step,
        delta: "step_reset",
      });
      await settled(conv);
      const done = await finished(cardMsg);
      expect(done.status).toBeUndefined();
      // the edit after the reset shows no status (later deltas do not start at offset 0)
      const live = updatesOf(cardMsg.messageId)
        .map(progressOf)
        .filter((c) => c?.state === "running");
      expect(live.at(-1)?.status).toBeUndefined();
      // one card, one answer with the whole text: no draft
      expect(sentTo("cli_pf", chat).map((m) => cardOf(m)?.kind ?? m.message.text)).toEqual([
        "progress",
        LONG,
      ]);
    } finally {
      await unsubscribe();
    }
  });

  it("a channel without features.progress gets the card as a text message, edited", async () => {
    const chat = "dm-u-tp1";
    im.push(textId, dm("ptp1", "u-tp1", "handoff as text"));
    const conv = await convOf(textId, chat);
    await settled(conv);
    const msgs = sentTo("cli_pt", chat);
    expect(msgs).toHaveLength(3);
    const progressMsg = msgs[0] as FakeChannelSent;
    // never a native progress card: the plugin has no `progress` branch
    expect(progressMsg.message.cards).toBeUndefined();
    expect(progressMsg.message.text).toMatch(/^Working · Elapsed /);
    expect(progressMsg.message.text).toContain(`(https://cap.example/chat/${conv})`);
    // the answer and the merged handoffs keep flowing as usual
    expect(msgs[1]?.message).toEqual({ text: "handoff answer" });
    expect(msgs[2]?.message.text).toBe("Needs your action (2)");
    expect(msgs[2]?.message.cards?.map((c) => c.kind)).toEqual(["bind", "bind"]);
    // the text message is edited in place, down to its finished form
    const last = await waitFor(
      async () => {
        const u = updatesOf(progressMsg.messageId).at(-1);
        return u?.message.text.startsWith("Worked for ") ? u : undefined;
      },
      20_000,
      "finished progress text",
    );
    expect(last.message.cards).toBeUndefined();
    expect(last.message.text).toContain("[Review A](https://cap.example/admin/review?a=1)");
    for (const u of updatesOf(progressMsg.messageId)) expect(u.message.cards).toBeUndefined();
  });

  it("a run without an answer after its last narration gets that narration as its answer", async () => {
    const chat = "dm-u-q1";
    im.push(detailedId, dm("pq1", "u-q1", "silent work"));
    const conv = await convOf(detailedId, chat);
    await settled(conv);
    const msgs = sentTo("cli_pd", chat);
    expect(msgs.map((m) => cardOf(m)?.kind ?? m.message.text)).toEqual([
      "progress",
      "All **done** here.",
    ]);
    const done = await finished(msgs[0] as FakeChannelSent);
    expect(done.meta).toBe("2 tools");
  });

  it("a channel without edits promotes the last narration too", async () => {
    const chat = "dm-u-q2";
    im.push(noEditId, dm("pq2", "u-q2", "silent plain"));
    const conv = await convOf(noEditId, chat);
    await settled(conv);
    expect(sentTo("cli_pn", chat).map((m) => m.message.text)).toEqual([
      "Working on it",
      "All **done** here.",
    ]);
  });

  it("brief on a channel without edits sends no start message and no milestones", async () => {
    const chat = "dm-u-mb1";
    im.push(noEditBriefId, dm("pmb1", "u-mb1", "pinned brief"));
    const conv = await convOf(noEditBriefId, chat);
    await settled(conv);
    expect(sentTo("cli_pnb", chat).map((m) => m.message.text)).toEqual(["pinned answer"]);
    const [run] = await runIds(conv);
    expect(await deliveryRow(conv)).toMatchObject({
      progress_run_id: run,
      progress_message_id: null,
      milestone_at: null,
    });
  });

  it("a new run first lands the previous run's pending final edit", async () => {
    const chat = "dm-u-fl1";
    // the first run's final edit fails retryably once; the next attempt goes through
    im.failNext("/update", 429, 1, 30_000, undefined, undefined, {
      chatId: chat,
      textIncludes: "Worked",
    });
    // the job is blocked on the first card's held send until both runs are logged: once released
    // it reads the first run's end and the second run's start in one catch-up, so no throttled
    // refresh (which would retry the edit, retryAfter aside) runs between them
    const hold = im.holdNext("/send", { onlyCards: true });
    im.push(detailedId, dm("pfl1", "u-fl1", "narr one"));
    const conv = await convOf(detailedId, chat);
    const ran = async (n: number) => {
      await waitFor(
        async () => {
          const r = await db
            .selectFrom("runs")
            .select("status")
            .where("conversation_id", "=", conv)
            .execute();
          return r.length === n && r.every((x) => !["queued", "running"].includes(x.status));
        },
        20_000,
        `run ${n} ended`,
      );
    };
    await ran(1);
    im.push(detailedId, dm("pfl2", "u-fl1", "narr two"));
    await ran(2);
    // the delivery is still at the first card's send
    expect((await deliveryRow(conv)).progress_run_id).toBeNull();
    hold.release();
    await settled(conv);
    await jobsDone(conv);
    const cards = sentTo("cli_pd", chat).filter((m) => progressOf(m) !== undefined);
    expect(cards).toHaveLength(2);
    // the first card reached its finished form (the flush before the second card)
    expect(lastProgress(cards[0] as FakeChannelSent).state).toBe("finished");
    expect((await finished(cards[1] as FakeChannelSent)).state).toBe("finished");
  });
});
