import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type EventLog, payloadJson } from "../../src/conversations/event-log.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { eventLogFor, legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let rawA: ReturnType<typeof createDb>;
let rawB: ReturnType<typeof createDb>;
let dbA: KernelSchemaDb;
let dbB: KernelSchemaDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let bus: ReturnType<typeof createBus>;
let logA: EventLog;
let logB: EventLog;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  // 两个独立连接池，模拟两个副本并发写同一会话。
  rawA = createDb(pgc.url, 10);
  rawB = createDb(pgc.url, 10);
  dbA = legacyDbFor(rawA);
  dbB = legacyDbFor(rawB);
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  bus = createBus(redis, sub, "kernel");
  logA = eventLogFor(dbA, bus);
  logB = eventLogFor(dbB, bus);
}, 120_000);
afterAll(async () => {
  await k?.stop();
  await sub?.close();
  redis?.disconnect();
  await rawA?.destroy();
  await rawB?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let conversationId: string;
let accountId: string;

beforeEach(async () => {
  await truncateTables(rawA, "capybara.accounts, capybara.orgs");
  accountId = randomUUID();
  const orgId = randomUUID();
  const agentId = randomUUID();
  conversationId = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
    rawA,
  );
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(rawA);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(rawA);
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${accountId})`.execute(rawA);
});

const userMsg = (text: string) => ({
  type: "user_message" as const,
  payload: { content: [{ type: "text", text }], authorAccountId: accountId },
});

async function lastSeq(): Promise<number> {
  const r = await dbA
    .selectFrom("conversations")
    .select("last_seq")
    .where("id", "=", conversationId)
    .executeTakeFirstOrThrow();
  return Number(r.last_seq);
}

describe("EventLog", () => {
  it("两个连接池各并发 append 50 次：seq 连续 1..100、无重复", async () => {
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      jobs.push(logA.append(conversationId, [userMsg(`a${i}`)]));
      jobs.push(logB.append(conversationId, [userMsg(`b${i}`)]));
    }
    await Promise.all(jobs);
    const events = await logA.readAfter(conversationId, 0, 500);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(await lastSeq()).toBe(100);
  });

  it("一次 append 多条事件分配连续 seq，并按顺序返回", async () => {
    await logA.append(conversationId, [userMsg("first")]);
    const out = await logA.append(conversationId, [
      userMsg("x"),
      { type: "reminder", runId: "r1", payload: { step: 1, text: "Be brief." } },
    ]);
    expect(out.map((e) => [e.seq, e.type, e.runId])).toEqual([
      [2, "user_message", null],
      [3, "reminder", "r1"],
    ]);
    expect(out[0]?.conversationId).toBe(conversationId);
    expect(out[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("同一 idemKey 并发 append 10 次只产生一条事件，都返回同一 seq", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 === 0 ? logA : logB).append(conversationId, [{ ...userMsg("hi"), idemKey: "k1" }]),
      ),
    );
    const seqs = new Set(results.map((r) => r[0]?.seq));
    expect([...seqs]).toEqual([1]);
    expect((await logA.readAfter(conversationId, 0)).length).toBe(1);
    expect(await lastSeq()).toBe(1);
    expect((await logA.findByIdem(conversationId, "k1"))?.seq).toBe(1);
    expect(await logA.findByIdem(conversationId, "nope")).toBeUndefined();
  });

  it("非法 payload 被拒，不分配 seq", async () => {
    await expect(
      logA.append(conversationId, [
        { type: "user_message", payload: { content: "not blocks", authorAccountId: accountId } },
      ]),
    ).rejects.toThrow();
    await expect(
      logA.append(conversationId, [{ type: "no_such_type", payload: {} } as never]),
    ).rejects.toThrow();
    await expect(
      logA.append(conversationId, [
        {
          type: "run_finished",
          payload: { reason: "bored", consumedUpToSeq: 1 },
        },
      ]),
    ).rejects.toThrow();
    expect(await lastSeq()).toBe(0);
  });

  it("提交后在 kernel bus 主题 conv.<id> 上发布 { kind: 'events', toSeq }", async () => {
    const got: unknown[] = [];
    const off = await bus.subscribe(`conv.${conversationId}`, (p) => {
      got.push(p);
    });
    try {
      await logA.append(conversationId, [userMsg("a"), userMsg("b")]);
      await expect.poll(() => got).toEqual([{ kind: "events", toSeq: 2 }]);
    } finally {
      await off();
    }
  });

  it("在外部 trx 中 append 后回滚：没有事件、last_seq 不变、不发布", async () => {
    const got: unknown[] = [];
    const off = await bus.subscribe(`conv.${conversationId}`, (p) => {
      got.push(p);
    });
    try {
      await expect(
        dbA.transaction().execute(async () => {
          const out = await logA.appendIn(conversationId, [userMsg("a")]);
          expect(out[0]?.seq).toBe(1);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await logA.readAfter(conversationId, 0)).toEqual([]);
      expect(await lastSeq()).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      expect(got).toEqual([]);
    } finally {
      await off();
    }
  });

  it("readAfter 按 seq 升序、遵守 afterSeq 与 limit", async () => {
    for (let i = 0; i < 5; i++) await logA.append(conversationId, [userMsg(`m${i}`)]);
    expect((await logA.readAfter(conversationId, 2, 2)).map((e) => e.seq)).toEqual([3, 4]);
    expect((await logA.readAfter(conversationId, 5)).length).toBe(0);
  });

  it("a NUL in any string is stored as U+FFFD (jsonb rejects \\u0000), so the append succeeds", async () => {
    const [ev] = await logA.append(conversationId, [userMsg("x\0y")]);
    expect(ev?.payload).toMatchObject({ content: [{ type: "text", text: "x\uFFFDy" }] });
    const [read] = await logA.readAfter(conversationId, 0, 10);
    expect(read?.payload).toMatchObject({ content: [{ type: "text", text: "x\uFFFDy" }] });
  });

  it("payloadJson maps NUL to U+FFFD in values and keys, and leaves an escaped backslash alone", () => {
    expect(JSON.parse(payloadJson({ "k\0": ["a\0", { b: "\0" }], n: 1 }))).toEqual({
      "k\uFFFD": ["a\uFFFD", { b: "\uFFFD" }],
      n: 1,
    });
    // a literal backslash followed by "u0000" is text, not a NUL
    expect(JSON.parse(payloadJson({ s: "\\u0000" }))).toEqual({ s: "\\u0000" });
  });

  it("会话不存在 → conversation.not_found", async () => {
    await expect(logA.append(randomUUID(), [userMsg("a")])).rejects.toMatchObject({
      code: "conversation.not_found",
    });
  });
});
