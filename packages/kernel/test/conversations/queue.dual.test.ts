import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Kernel } from "../../src/kernel.js";
import { accountsFor } from "../helpers/identity.js";
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
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * UI refresh B Task 9 on two replicas: the queue is PG state dispatched inside `ensureRun` under the
 * conversation row lock, so concurrent `ensureRun` calls on both replicas send every item exactly
 * once and in order, and "send now" racing the dispatcher posts the item once.
 */

let pgc: TestContainer;
let rd: TestContainer;
let rawA: ReturnType<typeof createDb>;
let rawB: ReturnType<typeof createDb>;
let dbA: KernelSchemaDb;
let a: Kernel;
let b: Kernel;
let ownerA: Req;
let ownerB: Req;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  rawA = createDb(pgc.url, 3);
  rawB = createDb(pgc.url, 3);
  dbA = kernelDb(rawA);
  const cfg = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] });
  a = await startKernel(cfg);
  b = await startKernel(cfg);
  await accountsFor(dbA).createLocal({ login: "owner", password: PW, displayName: "O" });
  ownerA = await session(a, "owner");
  ownerB = await session(b, "owner");
  orgId = await createOrg(ownerA);
  agentId = await createAgent(ownerA, orgId);
}, 180_000);
afterAll(async () => {
  await Promise.all([a?.stop(), b?.stop()]);
  await Promise.all([rawA?.destroy(), rawB?.destroy()]);
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const base = (conv: string) => `/api/v1/orgs/${orgId}/conversations/${conv}/queue`;
const userTexts = async (conv: string) =>
  (await eventsOf(dbA, conv))
    .filter((e) => e.type === "user_message")
    .map((e) => {
      const c = (e as Extract<ConversationEvent, { type: "user_message" }>).payload.content[0];
      return c?.type === "text" ? c.text : "";
    });
const queueLen = async (conv: string) =>
  Number(
    (
      await dbA
        .selectFrom("conversation_queue")
        .select((eb) => eb.fn.countAll().as("n"))
        .where("conversation_id", "=", conv)
        .executeTakeFirstOrThrow()
    ).n,
  );

describe("queued messages on two replicas", { timeout: 90_000 }, () => {
  it("concurrent ensureRun on both replicas sends each item once, in order", async () => {
    const conv = await createConv(ownerA, orgId, agentId);
    await postMessage(ownerA, orgId, conv, "stall");
    await waitFor(async () => (await runsOf(dbA, conv)).some((r) => r.status === "running"));
    const texts = ["echo:q1", "echo:q2", "echo:q3", "echo:q4"];
    for (const [i, t] of texts.entries()) {
      const req = i % 2 === 0 ? ownerA : ownerB;
      const r = await req({
        method: "POST",
        url: base(conv),
        payload: { text: t, clientMessageId: randomUUID() },
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    await ownerB({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort` });
    await waitForTerminal(dbA, conv, 1, 20_000);
    // resume through one replica while both replicas hammer ensureRun
    const resumed = ownerA({ method: "POST", url: `${base(conv)}/resume` });
    const kicks = Array.from({ length: 20 }, (_, i) =>
      (i % 2 === 0 ? a : b).runs.queue.ensureRun(conv).catch(() => null),
    );
    await Promise.all([resumed, ...kicks]);
    // later kicks while runs finish on either replica
    const stop = Date.now() + 15_000;
    while ((await userTexts(conv)).length < 5 && Date.now() < stop) {
      await Promise.all([a.runs.queue.ensureRun(conv), b.runs.queue.ensureRun(conv)]);
      await sleep(20);
    }
    await waitForTerminal(dbA, conv, 5, 30_000);
    await sleep(300);
    expect(await userTexts(conv)).toEqual(["stall", ...texts]);
    expect(await runsOf(dbA, conv)).toHaveLength(5);
    expect(await queueLen(conv)).toBe(0);
  });

  it("send now racing the dispatcher posts the item once", async () => {
    for (let round = 0; round < 5; round++) {
      const conv = await createConv(ownerA, orgId, agentId);
      await postMessage(ownerA, orgId, conv, "stall");
      await waitFor(async () => (await runsOf(dbA, conv)).some((r) => r.status === "running"));
      const r = await ownerA({
        method: "POST",
        url: base(conv),
        payload: { text: "echo:race", clientMessageId: randomUUID() },
      });
      const item = (r.json() as { item: { id: string } }).item;
      await ownerA({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort` });
      await waitForTerminal(dbA, conv, 1, 20_000);
      // the queue is paused now; resume on A while B sends the same item now
      const [, sent] = await Promise.all([
        ownerA({ method: "POST", url: `${base(conv)}/resume` }),
        ownerB({ method: "POST", url: `${base(conv)}/${item.id}/send` }),
      ]);
      expect([202, 404]).toContain(sent.statusCode);
      await waitForTerminal(dbA, conv, 2, 20_000);
      await sleep(200);
      expect(await userTexts(conv)).toEqual(["stall", "echo:race"]);
      expect(await queueLen(conv)).toBe(0);
    }
  });
});
