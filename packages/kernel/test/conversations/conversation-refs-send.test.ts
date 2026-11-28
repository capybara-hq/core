import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { conversationRefText } from "../../src/conversations/conversation-ref.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ConnectorContent } from "../../src/tools/connector-content.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Referencing the sender's own conversations on send (@ conversations spec §1–§2):
 * `conversationRefs` is read as the sender at send time (outside the message's transaction) and
 * logged as one English quoted block per conversation, after the project files' blocks, with
 * `payload.conversationRefs`. The referenced conversations' logs are seeded directly.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let ownerId: string;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  // no worker: the runs the sends start stay queued, so the seeded logs are all there is
  k = await startKernel(
    runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"], extensions: [MODEL_FAKE] }),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  agentId = await createAgent(owner, orgId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const errOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string; message?: string; details?: unknown[] } }).error;

/** A new member of the org with a session. */
async function member(): Promise<{ accountId: string; req: Req; login: string }> {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Name ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  return { accountId, req: await session(k, login), login };
}

type Seed =
  | { type: "user_message"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "tool_only" }
  | { type: "compaction_summary"; text: string; coversUpToSeq: number };

/** Appends events to a conversation's log as the runtime would have written them. */
async function seed(conv: string, events: Seed[], authorAccountId = "x"): Promise<number> {
  const row = await db
    .selectFrom("conversations")
    .select("last_seq")
    .where("id", "=", conv)
    .executeTakeFirstOrThrow();
  let seq = Number(row.last_seq);
  for (const e of events) {
    seq++;
    const [type, payload] =
      e.type === "user_message"
        ? ["user_message", { content: [{ type: "text", text: e.text }], authorAccountId }]
        : e.type === "assistant_message"
          ? [
              "assistant_message",
              { step: 1, content: [{ type: "text", text: e.text }], stopReason: "end_turn" },
            ]
          : e.type === "tool_only"
            ? [
                "assistant_message",
                {
                  step: 1,
                  content: [{ type: "tool_use", id: `t${seq}`, name: "Read", input: {} }],
                  stopReason: "tool_use",
                },
              ]
            : [
                "compaction_summary",
                { coversUpToSeq: e.coversUpToSeq, text: e.text, savedTokens: 0, step: 1 },
              ];
    await db
      .insertInto("conversation_events")
      .values({ conversation_id: conv, seq, type, payload: JSON.stringify(payload) })
      .execute();
  }
  await db.updateTable("conversations").set({ last_seq: seq }).where("id", "=", conv).execute();
  return seq;
}

const send = (req: Req, conv: string, payload: Record<string, unknown>) =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`, payload });

type UserMessage = Extract<ConversationEvent, { type: "user_message" }>;
const userMessages = async (conv: string) =>
  (await eventsOf(db, conv)).filter((e): e is UserMessage => e.type === "user_message");

/** The text of a message's block `i` ("" when it is missing or not text). */
const textAt = (msg: UserMessage | undefined, i: number): string =>
  (msg?.payload.content[i] as { text?: string } | undefined)?.text ?? "";

const closing = (id: string) =>
  `End of the referenced conversation. If the Platform tool is available, more of it can be read with its conversations.events operation (conversationId ${id}).`;

/** A conversation of `m` with one exchange in its log, titled `title`. */
async function referenced(m: { req: Req }, title: string | null = "Pricing") {
  const id = await createConv(m.req, orgId, agentId);
  await db.updateTable("conversations").set({ title }).where("id", "=", id).execute();
  await seed(id, [
    { type: "user_message", text: "what about the EU plan?" },
    { type: "assistant_message", text: "Prices stay in EUR." },
  ]);
  return id;
}

describe("conversationRefs on send", () => {
  it("an excerpt without a summary: the block after the text, with its id and the closing line", async () => {
    const m = await member();
    const ref = await referenced(m);
    const conv = await createConv(m.req, orgId, agentId);
    const res = await send(m.req, conv, { text: "same for EU", conversationRefs: [{ id: ref }] });
    expect(res.statusCode, res.body).toBe(202);
    const row = await db
      .selectFrom("conversations")
      .select("updated_at")
      .where("id", "=", ref)
      .executeTakeFirstOrThrow();
    const [msg] = await userMessages(conv);
    expect(msg?.payload.content).toEqual([
      { type: "text", text: "same for EU" },
      {
        type: "text",
        text: conversationRefText({
          id: ref,
          title: "Pricing",
          agentName: "Helper",
          lastActiveAt: row.updated_at,
          running: false,
          summary: null,
          messages: [
            { role: "user", text: "what about the EU plan?" },
            { role: "assistant", text: "Prices stay in EUR." },
          ],
        }),
      },
    ]);
    const block = textAt(msg, 1);
    expect(block).toContain(
      `(id ${ref}; another conversation of this person, with the agent Helper`,
    );
    expect(block.endsWith(closing(ref))).toBe(true);
    expect(block).not.toContain("still running");
    expect(msg?.payload.conversationRefs).toEqual([
      { id: ref, title: "Pricing", source: "excerpt", upToSeq: 2 },
    ]);
  });

  it("with a summary: its text plus only the messages after what it covers, tool-only steps skipped", async () => {
    const m = await member();
    const ref = await createConv(m.req, orgId, agentId);
    await seed(ref, [
      { type: "user_message", text: "BEFORE the summary" },
      { type: "assistant_message", text: "old reply" },
      { type: "compaction_summary", text: "We settled on EUR pricing.", coversUpToSeq: 2 },
      { type: "user_message", text: "and VAT?" },
      { type: "tool_only" },
      { type: "assistant_message", text: "VAT is included." },
    ]);
    const conv = await createConv(m.req, orgId, agentId);
    const res = await send(m.req, conv, { text: "go on", conversationRefs: [{ id: ref }] });
    expect(res.statusCode, res.body).toBe(202);
    const [msg] = await userMessages(conv);
    const block = textAt(msg, 1);
    expect(block).toContain('Referenced conversation: "Untitled conversation"');
    expect(block).toContain(
      "\nSummary of the conversation: We settled on EUR pricing.\nLatest messages:\nUser: and VAT?\nAgent: VAT is included.\n",
    );
    expect(block).not.toContain("BEFORE");
    expect(block).not.toContain("old reply");
    expect(block.endsWith(closing(ref))).toBe(true);
    expect(msg?.payload.conversationRefs).toEqual([
      { id: ref, title: null, source: "summary", upToSeq: 6 },
    ]);
  });

  it("a running conversation is read as committed and says so", async () => {
    const m = await member();
    const ref = await referenced(m);
    await db
      .insertInto("runs")
      .values({
        id: randomUUID(),
        conversation_id: ref,
        status: "running",
        agent_version: 1,
        trigger_account_id: m.accountId,
        trigger_seq: 1,
      })
      .execute();
    const conv = await createConv(m.req, orgId, agentId);
    const res = await send(m.req, conv, { text: "mid-run", conversationRefs: [{ id: ref }] });
    expect(res.statusCode, res.body).toBe(202);
    const [msg] = await userMessages(conv);
    expect(textAt(msg, 1)).toContain(
      "context for this message. It was still running when referenced.\n",
    );
  });

  it("duplicates collapse in first order; blocks follow the @ resources' bodies", async () => {
    const m = await member();
    const a = await referenced(m, "A");
    const b = await referenced(m, "B");
    const conv = await createConv(m.req, orgId, agentId);
    const connectorId = randomUUID();
    vi.spyOn(k.app.get(ConnectorContent), "resolveAttachments").mockResolvedValue({
      blocks: [{ type: "text", text: "RESOURCE BODY" }],
      attachments: [{ appId: connectorId, appName: "Docs", uri: "doc://1", name: "One" }],
    });
    const res = await send(m.req, conv, {
      text: "both",
      attachments: [{ connectorId, uri: "doc://1" }],
      conversationRefs: [{ id: b }, { id: a }, { id: b }],
    });
    expect(res.statusCode, res.body).toBe(202);
    const [msg] = await userMessages(conv);
    const texts = (msg?.payload.content ?? []).map((c) => (c as { text: string }).text);
    expect(texts).toHaveLength(4);
    expect(texts[0]).toBe("both");
    expect(texts[1]).toBe("RESOURCE BODY");
    expect(texts[2]).toContain(`"B" (id ${b};`);
    expect(texts[3]).toContain(`"A" (id ${a};`);
    expect(msg?.payload.conversationRefs?.map((r) => r.id)).toEqual([b, a]);
  });

  it("refuses every unavailable conversation alike, writing nothing", async () => {
    const m = await member();
    const other = await member();
    const conv = await createConv(m.req, orgId, agentId);
    const othersConv = await referenced(other);
    const deleted = await referenced(m);
    expect(
      (await m.req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/conversations/${deleted}` }))
        .statusCode,
    ).toBe(204);
    const subagent = await referenced(m);
    await db
      .updateTable("conversations")
      .set({ kind: "subagent", parent_conversation_id: conv })
      .where("id", "=", subagent)
      .execute();
    const evalConv = await referenced(m);
    await db
      .updateTable("conversations")
      .set({ kind: "eval" })
      .where("id", "=", evalConv)
      .execute();
    // an agent no longer visible to the sender
    const gone = await createAgent(m.req, orgId);
    const invisible = await createConv(m.req, orgId, gone);
    await seed(invisible, [{ type: "user_message", text: "hi" }]);
    await sql`UPDATE capybara.agents SET deleted_at = now() WHERE id = ${gone}`.execute(raw);
    // the sender's own conversation in another org
    const elsewhere = await createOrgWithProviders(k, m.req, "Elsewhere");
    const elsewhereAgent = await createAgent(m.req, elsewhere);
    const elsewhereConv = (
      (
        await m.req({
          method: "POST",
          url: `/api/v1/orgs/${elsewhere}/conversations`,
          payload: { agentId: elsewhereAgent },
        })
      ).json() as { conversation: { id: string } }
    ).conversation.id;
    await seed(elsewhereConv, [{ type: "user_message", text: "hi" }]);

    const bodies: { code?: string; message?: string; details?: unknown[] }[] = [];
    for (const id of [
      "missing-id",
      othersConv,
      deleted,
      subagent,
      evalConv,
      invisible,
      elsewhereConv,
    ]) {
      const res = await send(m.req, conv, { text: "hi", conversationRefs: [{ id }] });
      expect(res.statusCode, `${id}: ${res.body}`).toBe(422);
      const error = errOf(res);
      expect(error).toMatchObject({
        code: "conversation.reference_unavailable",
        details: [{ id }],
      });
      bodies.push({ ...error, details: [] });
    }
    // another person's conversation is indistinguishable from a missing one
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(await userMessages(conv)).toEqual([]);
  });

  it("a conversation without a message yet is refused with reason empty; every refused id listed", async () => {
    const m = await member();
    const conv = await createConv(m.req, orgId, agentId);
    const empty = await createConv(m.req, orgId, agentId);
    const fine = await referenced(m);
    const res = await send(m.req, conv, {
      text: "hi",
      conversationRefs: [{ id: fine }, { id: empty }, { id: "nope" }],
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(errOf(res)).toMatchObject({
      code: "conversation.reference_unavailable",
      details: [{ id: "nope" }, { id: empty, reason: "empty" }],
    });
    const only = await send(m.req, conv, { text: "hi", conversationRefs: [{ id: empty }] });
    expect(errOf(only)).toMatchObject({
      code: "conversation.reference_unavailable",
      details: [{ id: empty, reason: "empty" }],
    });
    expect(await userMessages(conv)).toEqual([]);
  });

  it("refuses the conversation being written in", async () => {
    const m = await member();
    const conv = await referenced(m);
    const res = await send(m.req, conv, { text: "me", conversationRefs: [{ id: conv }] });
    expect(res.statusCode, res.body).toBe(422);
    expect(errOf(res)).toMatchObject({
      code: "conversation.reference_self",
      details: [{ id: conv }],
    });
    expect(await userMessages(conv)).toHaveLength(1);
  });

  it("more than three references, empty text or an unknown key is a validation error", async () => {
    const m = await member();
    const conv = await createConv(m.req, orgId, agentId);
    const ref = await referenced(m);
    const four = await send(m.req, conv, {
      text: "hi",
      conversationRefs: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    });
    expect(four.statusCode, four.body).toBe(400);
    const noText = await send(m.req, conv, { text: "", conversationRefs: [{ id: ref }] });
    expect(noText.statusCode, noText.body).toBe(400);
    const extra = await send(m.req, conv, {
      text: "hi",
      conversationRefs: [{ id: ref, title: "x" }],
    });
    expect(extra.statusCode, extra.body).toBe(400);
    expect(await userMessages(conv)).toEqual([]);
  });

  it("a retry with the same clientMessageId reads nothing again", async () => {
    const m = await member();
    const ref = await referenced(m);
    const conv = await createConv(m.req, orgId, agentId);
    const clientMessageId = randomUUID();
    const body = { text: "once", clientMessageId, conversationRefs: [{ id: ref }] };
    const first = await send(m.req, conv, body);
    expect(first.statusCode, first.body).toBe(202);
    // the referenced conversation goes away: a retry would be refused if it were read again
    await m.req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/conversations/${ref}` });
    const again = await send(m.req, conv, body);
    expect(again.statusCode, again.body).toBe(202);
    expect((again.json() as { event: { seq: number } }).event.seq).toBe(
      (first.json() as { event: { seq: number } }).event.seq,
    );
    expect(await userMessages(conv)).toHaveLength(1);
  });

  it("create and first-message forward conversationRefs; a refusal creates nothing", async () => {
    const m = await member();
    const ref = await referenced(m);
    const created = await m.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations`,
      payload: {
        agentId,
        message: { text: "new", clientMessageId: randomUUID(), conversationRefs: [{ id: ref }] },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const c1 = (created.json() as { conversation: { id: string } }).conversation.id;
    expect((await userMessages(c1))[0]?.payload.conversationRefs).toEqual([
      { id: ref, title: "Pricing", source: "excerpt", upToSeq: 2 },
    ]);

    const first = (message: Record<string, unknown>) =>
      m.req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations/first-message`,
        payload: { agentId, message, permission: { profile: "request-approval" } },
      });
    const home = await first({
      text: "from home",
      clientMessageId: randomUUID(),
      conversationRefs: [{ id: ref }],
    });
    expect(home.statusCode, home.body).toBe(201);
    const c2 = (home.json() as { conversation: { id: string } }).conversation.id;
    const [msg] = await userMessages(c2);
    expect(msg?.payload.content).toHaveLength(2);
    expect(textAt(msg, 1)).toContain(`(id ${ref};`);
    expect(msg?.payload.conversationRefs?.map((r) => r.id)).toEqual([ref]);

    const clientMessageId = randomUUID();
    const refused = await first({
      text: "x",
      clientMessageId,
      conversationRefs: [{ id: "missing-id" }],
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errOf(refused)?.code).toBe("conversation.reference_unavailable");
    const none = await db
      .selectFrom("conversations")
      .select("id")
      .where("create_request_id", "=", clientMessageId)
      .execute();
    expect(none).toEqual([]);
  });

  it("the latest summary lookup has its partial index", async () => {
    const r = await sql<{ indexdef: string }>`SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'capybara' AND indexname = 'conversation_events_compaction_summary_idx'`.execute(
      raw,
    );
    expect(r.rows[0]?.indexdef).toContain("WHERE (type = 'compaction_summary'::text)");
  });
});
