import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ConversationSource, ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeStoredDefinition } from "../../src/agents/definition.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { withOrgScope } from "../../src/infra/database/org-scope.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { RunAbort } from "../../src/runtime/abort.js";
import {
  CompactionService,
  type ForceCompactionInput,
} from "../../src/runtime/compaction.service.js";
import { compactionProgressKey } from "../../src/runtime/compaction-progress.js";
import { RUN_QUEUE_NAME, RunQueue } from "../../src/runtime/run-queue.js";
import { seedQueued } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  eventsOf,
  MODEL_LOOPER,
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
 * Manual compaction (context compaction spec §4.7): `POST .../compact` starts a compact run
 * (`run_started.trigger: "compact"`, no model step) that writes one `compaction_summary` and its
 * `usage`; a second request while it is queued returns it, an active ordinary run is
 * `conversation.busy`, and eval or other people's conversations are 404. A manual compaction ignores
 * `keepRecentTurns` (maintainer decision 2026-11-28): every turn before the latest is summarized.
 * It always summarizes the transcript, on a model the in-context gate lists too (ruling R13).
 */

/** What the provider received (step requests; compaction requests apart). */
const capture = captureProviderRequests();

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let runQueue: Queue;
let owner: Req;
let ownerId: string;

const compactUrl = (orgId: string, conv: string) =>
  `/api/v1/orgs/${orgId}/conversations/${conv}/compact`;

const HOOKS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/hooks-probe/index.ts", import.meta.url),
);

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_LOOPER, HOOKS_PROBE],
        // a looper turn is a tool loop of this many steps (then the wrap-up)
        runtime: { maxSteps: 6 },
      },
    ),
  );
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
});
afterAll(async () => {
  capture.restore();
  await k?.close();
  await runQueue?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.deployment_settings",
  );
  await redis.flushdb();
  capture.reset();
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
});

async function setup(): Promise<{ orgId: string; agentId: string; conv: string }> {
  const orgId = await createOrgWithProviders(k, owner);
  const agentId = await createAgent(owner, orgId);
  const conv = await createConv(owner, orgId, agentId);
  return { orgId, agentId, conv };
}

/** A history of `n` answered turns: the compaction plan keeps the last ones and summarizes the rest. */
async function seedTurns(orgId: string, conv: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await postMessage(owner, orgId, conv, `echo:turn ${i} ${"words ".repeat(40)}`);
    await waitForTerminal(db, conv, i + 1, 20_000);
  }
}

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

const ev = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter(
    (e): e is ConversationEvent & { type: T; payload: EventPayload<T> } => e.type === type,
  );

const compact = (conv: string, orgId: string, req: Req = owner) =>
  req({ method: "POST", url: compactUrl(orgId, conv), payload: {} });

/** Starts a compact run and waits until it completed; returns its id. */
async function compacted(conv: string, orgId: string): Promise<string> {
  const res = await compact(conv, orgId);
  expect(res.statusCode, res.body).toBe(202);
  const { runId } = res.json() as { runId: string };
  await waitFor(
    async () => {
      const row = await db
        .selectFrom("runs")
        .select("status")
        .where("id", "=", runId)
        .executeTakeFirst();
      return row?.status === "completed" ? row : null;
    },
    30_000,
    "compact run completed",
  );
  return runId;
}

/** The ids of the tool calls in `req` that no tool result answers. */
const unpairedCalls = (req: ModelRequest): string[] => {
  const blocks = req.messages.flatMap((m) => (m.role === "system" ? [] : m.content));
  const answered = new Set(blocks.flatMap((b) => (b.type === "tool_result" ? [b.callId] : [])));
  return blocks.flatMap((b) => (b.type === "tool_call" && !answered.has(b.id) ? [b.id] : []));
};

describe("manual compaction", () => {
  it("compacts an idle conversation in a compact run: one summary and its usage, step 0, no model step", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 6);

    const res = await compact(conv, orgId);
    expect(res.statusCode, res.body).toBe(202);
    const { runId } = res.json() as { runId: string };
    expect(runId).toMatch(/[0-9a-f-]{36}/);

    const run = await waitFor(
      async () => {
        const row = await db
          .selectFrom("runs")
          .select(["status", "compact"])
          .where("id", "=", runId)
          .executeTakeFirst();
        return row?.status === "completed" ? row : null;
      },
      30_000,
      "compact run completed",
    );
    expect(run.compact).toBe(true);
    // idle compaction spec §5.1 (S12): a person's compact run is recorded as manual; its
    // run_started carries no origin (absent = manual)
    const origin = await db
      .selectFrom("runs")
      .select("compact_origin")
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    expect(origin.compact_origin).toBe("manual");

    const events = await eventsOf(db, conv);
    const started = ev(events, "run_started").find((e) => e.runId === runId);
    expect(started?.payload.trigger).toBe("compact");
    expect(started?.payload.triggerAccountId).toBe(ownerId);
    expect(started?.payload).not.toHaveProperty("compactOrigin");

    const summaries = ev(events, "compaction_summary").filter((e) => e.runId === runId);
    expect(summaries).toHaveLength(1);
    // ruling R13: model-fake passes the in-context gate, yet a manual compaction summarizes the
    // transcript
    expect(summaries[0]?.payload.method).toBe("transcript");
    expect(capture.compactions).toHaveLength(1);
    expect(capture.compactions[0]?.system).not.toEqual(capture.sent.at(-1)?.system);
    const usage = ev(events, "usage").filter(
      (e) => e.runId === runId && e.payload.purpose === "compaction",
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]?.payload.step).toBe(0);
    // no user message, no model step
    expect(ev(events, "model_call").filter((e) => e.runId === runId)).toEqual([]);
    expect(ev(events, "assistant_message").filter((e) => e.runId === runId)).toEqual([]);
  });

  it("after a finished run, keeps the #990 plan on a gated model: every turn before the latest summarized, the latest turn verbatim, then the new message", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 6);
    const before = ev(await eventsOf(db, conv), "user_message");
    const latest = before.at(-1);
    const runId = await compacted(conv, orgId);
    const events = await eventsOf(db, conv);
    const summary = ev(events, "compaction_summary").find((e) => e.runId === runId);
    // ruling R13: the transcript path with the manual plan, never the in-context one
    expect(summary?.payload.method).toBe("transcript");
    // the latest turn fits the manual tail budget whole: the summary ends right before it, and
    // its opener is kept, not re-rendered
    expect(summary?.payload.coversUpToSeq).toBe((latest?.seq ?? 0) - 1);
    expect(summary?.payload.openingSeqs).toBeUndefined();

    capture.reset();
    await postMessage(owner, orgId, conv, "echo:after");
    await waitForTerminal(db, conv, 8, 30_000);
    const request = capture.sent[0];
    const head = request?.messages[0];
    const blocks = Array.isArray(head?.content) ? head.content : [];
    const first = blocks[0]?.type === "text" ? blocks[0].text : "";
    expect(first).toMatch(/^<conversation_summary>/);
    const userTexts = (request?.messages ?? [])
      .filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .flatMap((b) => (b.type === "text" ? [b.text] : []));
    expect(userTexts.slice(1).filter((t) => !t.startsWith("From "))).toEqual([
      `echo:turn 5 ${"words ".repeat(40)}`,
      "echo:after",
    ]);
    expect(request?.messages.some((m) => m.role === "assistant")).toBe(true);
  });

  it("records a compaction with nothing to summarize and still finishes the compact run", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 1);

    const res = await compact(conv, orgId);
    expect(res.statusCode, res.body).toBe(202);
    const { runId } = res.json() as { runId: string };
    await waitFor(
      async () => {
        const row = await db
          .selectFrom("runs")
          .select("status")
          .where("id", "=", runId)
          .executeTakeFirst();
        return row?.status === "completed" ? row : null;
      },
      30_000,
      "compact run completed",
    );
    const events = (await eventsOf(db, conv)).filter((e) => e.runId === runId);
    expect(ev(events, "compaction_skipped").map((e) => e.payload)).toEqual([
      { reason: "nothing_to_summarize", turns: 1, step: 0 },
    ]);
    expect(ev(events, "compaction_summary")).toEqual([]);
    expect(ev(events, "compaction_failed")).toEqual([]);
    expect(ev(events, "usage")).toEqual([]);
    expect(ev(events, "run_finished").map((e) => e.payload.reason)).toEqual(["completed"]);
  });

  it("summarizes every turn before the latest in an agentic conversation, whatever keepRecentTurns says, and the next request starts from the summary", async () => {
    const orgId = await createOrgWithProviders(k, owner);
    const agentId = await createAgent(owner, orgId, { provider: "model-looper", model: "loop-1" });
    const conv = await createConv(owner, orgId, agentId);
    // three user turns (fewer than keepRecentTurns 4), each a tool loop of several pairs
    for (let i = 0; i < 3; i++) {
      await postMessage(owner, orgId, conv, "loop:1");
      await waitForTerminal(db, conv, i + 1, 30_000);
    }
    const before = await eventsOf(db, conv);
    const messages = ev(before, "user_message");
    expect(messages).toHaveLength(3);
    expect(
      ev(before, "tool_result").filter((e) => e.seq > (messages[2]?.seq ?? 0)).length,
    ).toBeGreaterThan(1);

    const res = await compact(conv, orgId);
    expect(res.statusCode, res.body).toBe(202);
    const { runId } = res.json() as { runId: string };
    await waitForTerminal(db, conv, 4, 30_000);
    const events = await eventsOf(db, conv);
    expect(ev(events, "compaction_skipped")).toEqual([]);
    const summaries = ev(events, "compaction_summary").filter((e) => e.runId === runId);
    expect(summaries).toHaveLength(1);
    // the latest turn fits the manual tail budget whole: the summary ends right before it
    expect(summaries[0]?.payload.coversUpToSeq).toBe((messages[2]?.seq ?? 0) - 1);
    expect(summaries[0]?.payload.openingSeqs).toBeUndefined();

    capture.reset();
    await postMessage(owner, orgId, conv, "after");
    await waitForTerminal(db, conv, 5, 30_000);
    const request = capture.sent[0];
    const call = ev(await eventsOf(db, conv), "model_call").at(-1);
    expect(call?.payload.request.summarySeq).toBe(summaries[0]?.seq);
    const head = request?.messages[0];
    const text = Array.isArray(head?.content)
      ? head.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      : "";
    expect(text).toMatch(/^<conversation_summary>/);
    // after the summary: the latest turn verbatim (its message and tool pairs), then the new message
    const rest = (request?.messages ?? []).slice(1).filter((m) => m.role !== "system");
    const userTexts = rest
      .filter((m) => m.role === "user")
      .map((m) => (Array.isArray(m.content) ? m.content : []))
      .flatMap((c) => c.flatMap((b) => (b.type === "text" ? [b.text] : [])));
    expect(userTexts.filter((t) => t === "loop:1")).toHaveLength(1);
    expect(userTexts.at(-1)).toBe("after");
    expect(rest.filter((m) => m.role === "assistant").length).toBeGreaterThan(1);
  });

  it("right after an aborted run whose reply has an unanswered tool call: a transcript summary, every call paired", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 5);
    // a step stopped mid-reply: the assistant message keeps its tool call, no result follows
    await k.app.get(EventLog).append(conv, [
      {
        type: "assistant_message",
        runId: randomUUID(),
        payload: {
          step: 1,
          content: [
            { type: "text", text: "Let me look." },
            { type: "tool_call", id: "call-aborted", name: "ReadToolOutput", input: {} },
          ],
          stopReason: "aborted",
        },
      },
    ]);
    const runId = await compacted(conv, orgId);
    const events = await eventsOf(db, conv);
    const summaries = ev(events, "compaction_summary").filter((e) => e.runId === runId);
    // ruling R13: the transcript path
    expect(summaries.map((e) => e.payload.method)).toEqual(["transcript"]);
    expect(ev(events, "compaction_failed")).toEqual([]);
    expect(capture.compactions).toHaveLength(1);
    expect(unpairedCalls(capture.compactions[0] as ModelRequest)).toEqual([]);
    // the aborted reply is in the kept latest turn: the next request still pairs its call
    capture.reset();
    await postMessage(owner, orgId, conv, "echo:after");
    await waitForTerminal(db, conv, 7, 30_000);
    expect(capture.sent[0]).toBeDefined();
    expect(unpairedCalls(capture.sent[0] as ModelRequest)).toEqual([]);
  });

  it("returns the compact run already queued instead of starting a second one", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 5);
    await runQueue.pause();
    try {
      const first = await compact(conv, orgId);
      expect(first.statusCode, first.body).toBe(202);
      const { runId } = first.json() as { runId: string };
      const second = await compact(conv, orgId);
      expect(second.statusCode, second.body).toBe(202);
      expect((second.json() as { runId: string }).runId).toBe(runId);
      const compacts = await db
        .selectFrom("runs")
        .select(["id", "status", "compact"])
        .where("conversation_id", "=", conv)
        .execute();
      expect(compacts.filter((r) => r.compact)).toEqual([
        { id: runId, status: "queued", compact: true },
      ]);
    } finally {
      await runQueue.resume();
    }
    await waitForTerminal(db, conv, 6, 30_000);
    const summaries = ev(await eventsOf(db, conv), "compaction_summary");
    expect(summaries).toHaveLength(1);
  });

  it("is 409 conversation.busy while an ordinary run is active", async () => {
    const { orgId, conv } = await setup();
    await postMessage(owner, orgId, conv, "stall");
    await waitFor(
      async () => {
        const rows = await db
          .selectFrom("runs")
          .select("status")
          .where("conversation_id", "=", conv)
          .execute();
        return rows.some((r) => r.status === "running");
      },
      20_000,
      "the ordinary run started",
    );
    const res = await compact(conv, orgId);
    expect(res.statusCode, res.body).toBe(409);
    expect(errCode(res)).toBe("conversation.busy");
    await owner({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort` });
    await waitForTerminal(db, conv, 1, 20_000);
  });

  it("compacts even when automatic compaction is disabled", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 5);
    await db
      .insertInto("deployment_settings")
      .values({ key: "compaction", value: JSON.stringify({ enabled: false }) })
      .execute();
    const res = await compact(conv, orgId);
    expect(res.statusCode, res.body).toBe(202);
    const { runId } = res.json() as { runId: string };
    await waitFor(
      async () => {
        const row = await db
          .selectFrom("runs")
          .select("status")
          .where("id", "=", runId)
          .executeTakeFirst();
        return row?.status === "completed" ? row : null;
      },
      30_000,
      "compact run completed",
    );
    expect(ev(await eventsOf(db, conv), "compaction_summary")).toHaveLength(1);
  });

  it("404 for an eval conversation", async () => {
    const { orgId, conv } = await setup();
    await db.updateTable("conversations").set({ kind: "eval" }).where("id", "=", conv).execute();
    const res = await compact(conv, orgId);
    expect(res.statusCode, res.body).toBe(404);
    expect(errCode(res)).toBe("conversation.not_found");
  });

  it("404 for a member without access to the conversation", async () => {
    const { orgId, conv } = await setup();
    const member = await accountsFor(db).createLocal({
      login: "member",
      password: PW,
      displayName: "Member",
    });
    await testMembers(db).add(orgId, member.id, "member", ownerId);
    const req = await session(k, "member");
    const res = await compact(conv, orgId, req);
    expect(res.statusCode, res.body).toBe(404);
    expect(errCode(res)).toBe("conversation.not_found");
  });

  it("403 for a guest (member and above only)", async () => {
    const { orgId, conv } = await setup();
    const guest = await accountsFor(db).createLocal({
      login: "guest",
      password: PW,
      displayName: "Guest",
    });
    await testMembers(db).add(orgId, guest.id, "guest", ownerId);
    const req = await session(k, "guest");
    const res = await compact(conv, orgId, req);
    expect(res.statusCode, res.body).toBe(403);
  });

  it("accepts a request with no body (the body is optional: the run is the idempotency key)", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 5);
    const res = await owner({ method: "POST", url: compactUrl(orgId, conv) });
    expect(res.statusCode, res.body).toBe(202);
    const { runId } = res.json() as { runId: string };
    await waitFor(
      async () => {
        const row = await db
          .selectFrom("runs")
          .select("status")
          .where("id", "=", runId)
          .executeTakeFirst();
        return row?.status === "completed" ? row : null;
      },
      30_000,
      "compact run completed",
    );
    expect(ev(await eventsOf(db, conv), "compaction_summary")).toHaveLength(1);
  });

  it("a stop aborts the compact run: run_aborted, no partial summary (spec §4.11)", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 5);
    // the compaction's model.request hook holds it long enough to stop it mid-call
    const enabled = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
      payload: { enabled: true },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const configured = await owner({
      method: "POST",
      url: "/plugins/hooks-probe/config",
      payload: { orgId, sleepMs: 10_000, sleepIn: ["model.request"] },
    });
    expect(configured.statusCode, configured.body).toBe(200);

    const res = await compact(conv, orgId);
    expect(res.statusCode, res.body).toBe(202);
    const { runId } = res.json() as { runId: string };
    // the compaction reached its model call (progress phase summarizing), where the hook holds it
    await waitFor(
      async () => {
        const raw = await redis.get(compactionProgressKey(runId));
        return raw !== null && (JSON.parse(raw) as { phase: string }).phase === "summarizing"
          ? raw
          : null;
      },
      20_000,
      "compaction reached its model call",
    );
    const stop = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort`,
    });
    expect(stop.statusCode, stop.body).toBe(202);
    await waitFor(
      async () => {
        const row = await db
          .selectFrom("runs")
          .select("status")
          .where("id", "=", runId)
          .executeTakeFirst();
        return row?.status === "aborted" ? row : null;
      },
      20_000,
      "compact run aborted",
    );

    const events = await eventsOf(db, conv);
    const aborted = ev(events, "run_aborted").filter((e) => e.runId === runId);
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.payload.reason).toBe("user");
    expect(aborted[0]?.payload.byAccountId).toBe(ownerId);
    // no partial summary and nothing billed for the aborted call
    expect(ev(events, "compaction_summary").filter((e) => e.runId === runId)).toEqual([]);
    expect(ev(events, "compaction_failed").filter((e) => e.runId === runId)).toEqual([]);
    expect(ev(events, "usage").filter((e) => e.runId === runId)).toEqual([]);
    // the abort path drops the progress key
    await waitFor(
      async () => ((await redis.get(compactionProgressKey(runId))) === null ? true : null),
      10_000,
      "progress cleared",
    );
  });

  it("the Platform operation conversations.compact mirrors the route", () => {
    const op = k.app.get(PlatformOperations).get("conversations.compact");
    expect(op).not.toBeNull();
    expect(op?.mirrors).toEqual(["POST /api/v1/orgs/:orgId/conversations/:id/compact"]);
    expect(op?.authz).toEqual({ orgAction: "conversations.compact" });
    expect(op?.input.safeParse({ conversationId: randomUUID() }).success).toBe(true);
  });
});

describe("idle compaction core (idle compaction spec §4.3, §5)", () => {
  /** What an idle compact run gives `CompactionService.force`: the conversation's own definition. */
  async function forceInput(orgId: string, conv: string): Promise<ForceCompactionInput> {
    const row = await db
      .selectFrom("conversations")
      .select(["agent_id", "consumed_seq", "source"])
      .where("id", "=", conv)
      .executeTakeFirstOrThrow();
    const version = await db
      .selectFrom("agent_versions")
      .select(["version", "definition"])
      .where("agent_id", "=", row.agent_id)
      .orderBy("version", "desc")
      .executeTakeFirstOrThrow();
    return {
      orgId,
      conversationId: conv,
      runId: randomUUID(),
      accountId: ownerId,
      agentId: row.agent_id,
      agent: normalizeStoredDefinition(version.definition),
      agentVersion: version.version,
      source: row.source as ConversationSource,
      conversationKind: "chat",
      absorbedUpToSeq: Number(row.consumed_seq),
      signal: new AbortController().signal,
    };
  }

  const forceIdle = (input: ForceCompactionInput) =>
    withOrgScope(input.orgId, () => k.app.get(CompactionService).force(input, "idle"));

  const probe = ({ runId: _r, signal: _s, accountId: _a, ...input }: ForceCompactionInput) =>
    withOrgScope(input.orgId, () => k.app.get(CompactionService).probeIdle(input));

  it('force(input, "idle") on a finished conversation summarizes in context', async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 6);
    const input = await forceInput(orgId, conv);
    const out = await forceIdle(input);
    expect(out.failed).toBe(false);
    const events = (await eventsOf(db, conv)).filter((e) => e.runId === input.runId);
    const summaries = ev(events, "compaction_summary");
    expect(summaries.map((e) => e.payload.method)).toEqual(["in_context"]);
    expect(out.summarySeq).toBe(summaries[0]?.seq);
    expect(ev(events, "usage").map((e) => e.payload.purpose)).toEqual(["compaction"]);
    // the in-context request: the conversation's own system prompt
    expect(capture.compactions).toHaveLength(1);
    expect(capture.compactions[0]?.system).toEqual(capture.sent.at(-1)?.system);
  });

  it('force(input, "idle") with nothing to summarize writes nothing (no compaction_skipped)', async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 1);
    const before = (await eventsOf(db, conv)).length;
    const input = await forceInput(orgId, conv);
    expect(await forceIdle(input)).toEqual({ summarySeq: null, failed: false });
    expect(await eventsOf(db, conv)).toHaveLength(before);
    expect(capture.compactions).toEqual([]);
  });

  it("probeIdle reads a planned in-context compaction and writes nothing; another model is no prefix", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 6);
    const before = (await eventsOf(db, conv)).length;
    const input = await forceInput(orgId, conv);
    const got = await probe(input);
    expect(got).toMatchObject({ planned: true, inContext: true });
    expect(got?.estimate).toBeGreaterThan(0);
    expect(got?.window).toBeGreaterThan(got?.estimate ?? 0);
    expect(got?.growth).toBeGreaterThan(0);
    expect(await eventsOf(db, conv)).toHaveLength(before);
    expect(capture.compactions).toEqual([]);

    // the last call was another model than the effective definition's: no cached prefix applies
    await sql`UPDATE capybara.conversation_events SET payload = jsonb_set(payload, '{model}', '"fake-0"')
      WHERE conversation_id = ${conv} AND type = 'model_call'`.execute(raw);
    const switched = await probe(input);
    expect(switched).toMatchObject({ planned: true, inContext: false });
  });
});

describe("idle compact runs (idle compaction spec §5.1, §5.2)", () => {
  /** The seq the idle job would be armed at: the conversation's latest run's terminal event. */
  async function armedSeqOf(conv: string): Promise<number> {
    const events = await eventsOf(db, conv);
    const last = events.filter((e) => e.type === "run_finished").at(-1);
    if (!last) throw new Error("no finished run");
    return last.seq;
  }

  const startIdle = (orgId: string, conv: string, armedSeq: number) =>
    withOrgScope(orgId, () => k.app.get(RunQueue).startIdleCompaction(conv, armedSeq));

  const runStatus = (runId: string, status: string) =>
    waitFor(
      async () => {
        const row = await db
          .selectFrom("runs")
          .select(["status", "compact_origin"])
          .where("id", "=", runId)
          .executeTakeFirst();
        return row?.status === status ? row : null;
      },
      30_000,
      `run ${status}`,
    );

  /** Holds every model call of the org in its `model.request` hook (the hooks-probe fixture). */
  async function holdModelCalls(orgId: string, sleepMs: number): Promise<void> {
    const enabled = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
      payload: { enabled: true },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const configured = await owner({
      method: "POST",
      url: "/plugins/hooks-probe/config",
      payload: { orgId, sleepMs, sleepIn: sleepMs > 0 ? ["model.request"] : [] },
    });
    expect(configured.statusCode, configured.body).toBe(200);
  }

  it("starts an idle compact run on a settled conversation: in-context summary, origin idle, run as the owner", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 6);
    const runId = await startIdle(orgId, conv, await armedSeqOf(conv));
    expect(runId).toMatch(/[0-9a-f-]{36}/);
    const run = await runStatus(runId as string, "completed");
    expect(run.compact_origin).toBe("idle");
    const events = (await eventsOf(db, conv)).filter((e) => e.runId === runId);
    const started = ev(events, "run_started");
    expect(started).toHaveLength(1);
    expect(started[0]?.payload).toMatchObject({
      trigger: "compact",
      compactOrigin: "idle",
      triggerAccountId: ownerId,
    });
    expect(ev(events, "compaction_summary").map((e) => e.payload.method)).toEqual(["in_context"]);
  });

  it("starts when only a run-less side-call usage followed the armed seq (S1)", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 6);
    const armedSeq = await armedSeqOf(conv);
    // what the title and prompt-suggestion jobs append after a run ended (no runId)
    await k.app.get(EventLog).append(conv, [
      {
        type: "usage",
        payload: {
          step: 0,
          provider: "model-fake",
          model: "fake-1",
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          purpose: "title",
        },
      },
    ]);
    const runId = await startIdle(orgId, conv, armedSeq);
    expect(runId).not.toBeNull();
    await runStatus(runId as string, "completed");
  });

  it("refuses (null) when a message arrived after the armed seq", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 6);
    const armedSeq = await armedSeqOf(conv);
    await postMessage(owner, orgId, conv, "echo:later");
    await waitForTerminal(db, conv, 7, 20_000);
    expect(await startIdle(orgId, conv, armedSeq)).toBeNull();
    expect(
      (await db.selectFrom("runs").select("id").where("compact", "=", true).execute()).length,
    ).toBe(0);
  });

  it("refuses (null) while a run is active", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 6);
    const armedSeq = await armedSeqOf(conv);
    await runQueue.pause();
    try {
      // a queued manual compact run writes nothing before it starts: only the active run refuses
      const manual = await compact(conv, orgId);
      expect(manual.statusCode, manual.body).toBe(202);
      expect(await startIdle(orgId, conv, armedSeq)).toBeNull();
    } finally {
      await runQueue.resume();
    }
    await waitForTerminal(db, conv, 7, 30_000);
  });

  it("refuses (null) while the conversation queue has a head", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 6);
    const armedSeq = await armedSeqOf(conv);
    await db
      .updateTable("conversations")
      .set({ queue_paused: true, queue_pause_reason: "run_ended" })
      .where("id", "=", conv)
      .execute();
    const queued = await seedQueued(k.app, orgId, conv, ownerId, {
      text: "echo:queued",
      clientMessageId: randomUUID(),
    });
    expect(queued.statusCode, queued.body).toBe(201);
    expect(await startIdle(orgId, conv, armedSeq)).toBeNull();
  });

  it("a manual compaction while the idle run is active returns the idle run", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 6);
    await runQueue.pause();
    let idle: string | null = null;
    try {
      idle = await startIdle(orgId, conv, await armedSeqOf(conv));
      expect(idle).not.toBeNull();
      const res = await compact(conv, orgId);
      expect(res.statusCode, res.body).toBe(202);
      expect((res.json() as { runId: string }).runId).toBe(idle);
    } finally {
      await runQueue.resume();
    }
    await runStatus(idle as string, "completed");
  });

  it("a superseded stop ends the idle run: run_aborted without an account, no summary, the queue not paused, the tree not held (S3)", async () => {
    const { orgId, conv } = await setup();
    await seedTurns(orgId, conv, 6);
    const armedSeq = await armedSeqOf(conv);
    await holdModelCalls(orgId, 10_000);
    const runId = await startIdle(orgId, conv, armedSeq);
    expect(runId).not.toBeNull();
    const idle = runId as string;
    await waitFor(
      async () => {
        const raw = await redis.get(compactionProgressKey(idle));
        return raw !== null && (JSON.parse(raw) as { phase: string }).phase === "summarizing"
          ? raw
          : null;
      },
      20_000,
      "the idle compaction reached its model call",
    );
    // a queued message waits behind the idle run (Task 8 preempts it; here the stop is sent by hand)
    const queued = await seedQueued(k.app, orgId, conv, ownerId, {
      text: "echo:queued",
      clientMessageId: randomUUID(),
    });
    expect(queued.statusCode, queued.body).toBe(201);
    await holdModelCalls(orgId, 0);
    await k.app.get(RunAbort).request(idle, null, { reason: "superseded" });
    await runStatus(idle, "aborted");

    const events = await eventsOf(db, conv);
    expect(
      ev(events, "run_aborted")
        .filter((e) => e.runId === idle)
        .map((e) => e.payload),
    ).toEqual([{ byAccountId: null, reason: "superseded" }]);
    expect(ev(events, "compaction_summary").filter((e) => e.runId === idle)).toEqual([]);
    const row = await db
      .selectFrom("conversations")
      .select(["queue_paused", "tree_stopped_at"])
      .where("id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ queue_paused: false, tree_stopped_at: null });
    // the queued message goes out after the idle run's end
    await waitFor(
      async () =>
        ev(await eventsOf(db, conv), "user_message").some((e) =>
          e.payload.content.some((b) => b.type === "text" && b.text === "echo:queued"),
        ) || null,
      20_000,
      "the queued message was sent",
    );
  });
});
