import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { RUN_QUEUE_NAME } from "../../src/runtime/run-queue.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
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
 * `conversation.busy`, and eval or other people's conversations are 404.
 */

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

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] }));
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
}, 180_000);
afterAll(async () => {
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
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
});

async function setup(): Promise<{ orgId: string; agentId: string; conv: string }> {
  const orgId = await createOrg(owner);
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

describe("manual compaction", { timeout: 90_000 }, () => {
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

    const events = await eventsOf(db, conv);
    const started = ev(events, "run_started").find((e) => e.runId === runId);
    expect(started?.payload.trigger).toBe("compact");
    expect(started?.payload.triggerAccountId).toBe(ownerId);

    const summaries = ev(events, "compaction_summary").filter((e) => e.runId === runId);
    expect(summaries).toHaveLength(1);
    const usage = ev(events, "usage").filter(
      (e) => e.runId === runId && e.payload.purpose === "compaction",
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]?.payload.step).toBe(0);
    // no user message, no model step
    expect(ev(events, "model_call").filter((e) => e.runId === runId)).toEqual([]);
    expect(ev(events, "assistant_message").filter((e) => e.runId === runId)).toEqual([]);
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

  it("the Platform operation conversations.compact mirrors the route", () => {
    const op = k.app.get(PlatformOperations).get("conversations.compact");
    expect(op).not.toBeNull();
    expect(op?.mirrors).toEqual(["POST /api/v1/orgs/:orgId/conversations/:id/compact"]);
    expect(op?.authz).toEqual({ orgAction: "conversations.compact" });
    expect(op?.input.safeParse({ conversationId: randomUUID() }).success).toBe(true);
  });
});
