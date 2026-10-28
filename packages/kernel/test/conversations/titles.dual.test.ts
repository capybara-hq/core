import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { runTitleJob } from "../../src/conversations/titles.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import type { ModelPurposesService } from "../../src/models/purposes.js";
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
  sleep,
  startKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * UI refresh B Task 7, two replicas: a title attempt runs once across replicas (claimed in PG), so
 * concurrent executions write one title and one usage event.
 */

let pgc: TestContainer;
let rd: TestContainer;
let rawA: ReturnType<typeof createDb>;
let rawB: ReturnType<typeof createDb>;
let dbA: KernelSchemaDb;
let dbB: KernelSchemaDb;
let a: Kernel;
let b: Kernel;
let owner: Req;
let orgId: string;
let agentId: string;
let ownerId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  rawA = createDb(pgc.url, 3);
  rawB = createDb(pgc.url, 3);
  dbA = kernelDb(rawA);
  dbB = kernelDb(rawB);
  const cfg = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] });
  a = await startKernel(cfg);
  b = await startKernel(cfg);
  ownerId = (
    await new AccountsService(dbA).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  owner = await session(a, "owner");
  orgId = await createOrg(owner);
  agentId = await createAgent(owner, orgId);
}, 180_000);
afterAll(async () => {
  await Promise.all([a?.stop(), b?.stop()]);
  await Promise.all([rawA?.destroy(), rawB?.destroy()]);
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const titleUsage = async (id: string) =>
  (await eventsOf(dbA, id)).filter(
    (e) => e.type === "usage" && (e.payload as { purpose?: string }).purpose === "title",
  );

describe("titles on two replicas", { timeout: 90_000 }, () => {
  it("conversations finishing on either replica get one title and one usage event each", async () => {
    const convs = await Promise.all([1, 2, 3, 4].map(() => createConv(owner, orgId, agentId)));
    await Promise.all(convs.map((c, i) => postMessage(owner, orgId, c, `echo:topic ${i}`)));
    for (const c of convs) await waitForTerminal(dbA, c, 1, 30_000);
    for (const c of convs) {
      await waitFor(
        async () =>
          (
            await dbA
              .selectFrom("conversations")
              .select("title")
              .where("id", "=", c)
              .executeTakeFirstOrThrow()
          ).title !== null,
        20_000,
        "title",
      );
    }
    await sleep(500);
    for (const c of convs) expect(await titleUsage(c)).toHaveLength(1);
  });

  it("the same attempt executed concurrently by two replicas: one call, one title, one usage", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const seed = new EventLog(dbA, { publish: async () => {} });
    await seed.append(conv, [
      {
        type: "user_message",
        payload: { content: [{ type: "text", text: "budget" }], authorAccountId: ownerId },
      },
      {
        type: "assistant_message",
        payload: { step: 0, content: [{ type: "text", text: "Ok." }], stopReason: "end_turn" },
      },
    ]);
    let calls = 0;
    const purposes = (name: string): Pick<ModelPurposesService, "chat"> => ({
      chat: async () => {
        calls++;
        await sleep(200);
        return {
          content: [{ type: "text", text: `Title ${name}` }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          provider: "model-fake",
          model: "fake-1",
        };
      },
    });
    const replica = (db: KernelSchemaDb, name: string) =>
      runTitleJob(
        {
          db,
          eventLog: new EventLog(db, { publish: async () => {} }),
          purposes: purposes(name),
          log: console,
        },
        conv,
        0,
      );
    await Promise.all([replica(dbA, "A"), replica(dbB, "B")]);
    expect(calls).toBe(1);
    expect(await titleUsage(conv)).toHaveLength(1);
    const row = await dbA
      .selectFrom("conversations")
      .select(["title", "title_attempts"])
      .where("id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(row.title_attempts).toBe(1);
    expect(row.title).toMatch(/^Title [AB]$/);
  });
});
