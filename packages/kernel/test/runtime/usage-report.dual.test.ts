import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { Kernel } from "../../src/kernel.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  startKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * T16 dual replica: two kernels share PG / Redis; usage.report jobs run on either worker. Killing the
 * replica that holds a delivery hands the job to the other (retry), and after deduping by eventId the
 * handler saw every usage event.
 */

const HOOKS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/hooks-probe/index.ts", import.meta.url),
);
const TOOL = "hooks-probe__probe_echo";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
const kernels: Kernel[] = [];
let a: Kernel;
let b: Kernel;
let reqA: Req;
let reqB: Req;
let orgId: string;
let agentId: string;

const config = () =>
  runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      extensions: [MODEL_FAKE, HOOKS_PROBE],
      // one delivery at a time per replica, so both replicas take jobs
      hooks: { usageReportConcurrency: 1 },
    },
  );

async function login(k: Kernel): Promise<Req> {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  a = await startKernel(config());
  b = await startKernel(config());
  kernels.push(a, b);
  reqA = await login(a);
  reqB = await login(b);
  orgId = await createOrg(reqA);
  const en = await reqA({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
    payload: { enabled: true },
  });
  expect(en.statusCode, en.body).toBe(200);
  const res = await reqA({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Metered",
        instructions: "Use tools.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "plugin", plugin: "hooks-probe", name: "probe_echo" }],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
}, 180_000);

afterAll(async () => {
  await Promise.all(kernels.map((k) => k.stop().catch(() => {})));
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Delivery = { calls: number; holder: string | null };

async function usageOf(req: Req, ids: string[]): Promise<Record<string, Delivery>> {
  const res = await req({ method: "GET", url: `/plugins/hooks-probe/usage?eventIds=${ids}` });
  return res.json() as Record<string, Delivery>;
}

async function who(req: Req): Promise<{ instanceId: string; delivered: number }> {
  const res = await req({ method: "GET", url: "/plugins/hooks-probe/whoami" });
  return res.json() as { instanceId: string; delivered: number };
}
const whoami = async (req: Req) => (await who(req)).instanceId;

const idOf = (e: ConversationEvent) => `${e.conversationId}/${e.seq}`;

describe("usage.report across two replicas", { timeout: 90_000 }, () => {
  it("every usage event is delivered exactly once, and both replicas delivered some", async () => {
    // each delivery takes ~200 ms, so while one replica is busy the other takes the next job
    const cfg = await reqA({
      method: "POST",
      url: "/plugins/hooks-probe/config",
      payload: { orgId, sleepMs: 200, sleepIn: ["usage.report"] },
    });
    expect(cfg.statusCode, cfg.body).toBe(200);
    const usage: ConversationEvent[] = [];
    for (let i = 0; i < 5; i++) {
      const conv = await createConv(reqA, orgId, agentId);
      // a manual title: no title call, so every usage event here is a step call's
      const renamed = await reqA({
        method: "PATCH",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}`,
        payload: { title: `turn ${i}` },
      });
      expect(renamed.statusCode).toBe(200);
      await postMessage(reqA, orgId, conv, `tool:${TOOL}:{"text":"${i}"}`);
      await waitForTerminal(db, conv, 1, 20_000);
      usage.push(...(await eventsOf(db, conv)).filter((e) => e.type === "usage"));
    }
    expect(usage).toHaveLength(10);
    const ids = usage.map(idOf);
    await waitFor(
      async () => {
        const d = await usageOf(reqB, ids);
        return ids.every((id) => d[id]?.calls === 1) ? d : null;
      },
      20_000,
      "all deliveries",
    );
    const [onA, onB] = [await who(reqA), await who(reqB)];
    expect(onA.delivered + onB.delivered).toBe(10);
    expect(onA.delivered).toBeGreaterThan(0);
    expect(onB.delivered).toBeGreaterThan(0);
  });

  it("killing the replica that holds a delivery: the other replica finishes it", async () => {
    const cfg = await reqA({
      method: "POST",
      url: "/plugins/hooks-probe/config",
      payload: { orgId, usageHoldOnce: true, sleepMs: 0 },
    });
    expect(cfg.statusCode, cfg.body).toBe(200);
    const conv = await createConv(reqA, orgId, agentId);
    await postMessage(reqA, orgId, conv, "echo:held");
    await waitForTerminal(db, conv, 1, 20_000);
    const [u] = (await eventsOf(db, conv)).filter((e) => e.type === "usage");
    const id = idOf(u as ConversationEvent);
    // wait until some replica holds the first delivery, then stop that replica
    const holder = await waitFor(
      async () => (await usageOf(reqA, [id]))[id]?.holder ?? null,
      10_000,
      "a replica holds the delivery",
    );
    const [idA, idB] = [await whoami(reqA), await whoami(reqB)];
    expect([idA, idB]).toContain(holder);
    const victim = holder === idA ? a : b;
    const survivor = holder === idA ? reqB : reqA;
    await victim.stop();
    // the job is retried (2 s backoff) and finished by the surviving replica
    const done = await waitFor(
      async () => {
        const d = (await usageOf(survivor, [id]))[id];
        return d && d.calls >= 2 ? d : null;
      },
      20_000,
      "delivery finished by the other replica",
    );
    // deduped by eventId the handler saw this event; the held attempt plus the retry
    expect(done.calls).toBe(2);
  });
});
