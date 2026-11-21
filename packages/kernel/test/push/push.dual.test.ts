import { randomUUID } from "node:crypto";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import {
  conversationEventId,
  PUSH_DELIVER_JOB,
  PUSH_FANOUT_JOB,
  PUSH_QUEUE,
  type PushDeliverData,
  pushDeliverJobId,
  pushFanoutJobId,
} from "../../src/push/jobs.js";
import { PushTokenStore } from "../../src/push/token-store.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
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
 * Push on two replicas (review focus 4): two kernels (api + worker) on one PG and Redis, one
 * completed run, three registrations of its owner. Each registration gets exactly one send
 * (`plugin_fake_push.sends`, counted across replicas) whichever replica's fast path or relay adds
 * the jobs; a replayed fanout row and a manual re-add of a delivery id send nothing more.
 */

let pgc: TestContainer;
let rd: TestContainer;
let a: TestKernel;
let b: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let queue: Queue;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const cfg = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      extensions: [MODEL_FAKE, fakeExtensionEntry("fake-push")],
      http: { port: 0, publicUrl: "https://cap.example" },
    },
  );
  a = await startKernel(cfg);
  b = await startKernel(cfg);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  queue = a.app.get<Queue>(getQueueToken(PUSH_QUEUE), { strict: false });
});
afterAll(async () => {
  await Promise.all([a?.close(), b?.close()]);
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function register(accountId: string): Promise<string> {
  const id = randomUUID();
  const sealed = a.app.get(PushTokenStore).seal(id, `ok-${id}`);
  await db
    .insertInto("push_registrations")
    .values({
      id,
      account_id: accountId,
      session_id: null,
      platform: "android",
      app_id: "com.example.app",
      provider: "fake-push",
      token_hash: sealed.tokenHash,
      master_key_id: sealed.masterKeyId,
      token_ciphertext: sealed.ciphertext,
      locale: "en",
      device_name: "Phone",
    })
    .execute();
  return id;
}

/** The registration ids of every send row of `eventId` (the message's collapse id), sorted. */
async function sendRows(eventId: string): Promise<string[]> {
  const r = await sql<{ registration_id: string }>`
    SELECT registration_id FROM plugin_fake_push.sends
    WHERE message::jsonb ->> 'collapseId' = ${eventId}
    ORDER BY registration_id`.execute(raw);
  return r.rows.map((x) => x.registration_id);
}

/** Waits until no outbox row of `jobIds` is left and the push queue holds no pending job. */
async function drained(jobIds: string[]): Promise<void> {
  await waitFor(
    async () => {
      const left = await db
        .selectFrom("outbox")
        .select("id")
        .where("job_id", "in", jobIds)
        .execute();
      if (left.length > 0) return false;
      const c = await queue.getJobCounts("waiting", "active", "delayed", "prioritized");
      return Object.values(c).every((n) => n === 0);
    },
    30_000,
    "outbox and push queue drained",
  );
}

/** Shared by the cases below, which run in order. */
let orgId: string;
let regs: string[];
let owners: { a: Req; b: Req };
let agentId: string;
let first: { eventId: string; fanoutId: string; deliverIds: string[] };

/** Posts a message through `req`'s replica and waits for the run's end; returns its ids. */
async function completedRun(req: Req) {
  const conv = await createConv(req, orgId, agentId);
  await postMessage(req, orgId, conv, "echo:hello");
  const [end] = await waitForTerminal(db, conv, 1, 30_000);
  expect(end?.type).toBe("run_finished");
  const eventId = conversationEventId(conv, end?.seq as number);
  return {
    eventId,
    fanoutId: pushFanoutJobId(eventId),
    deliverIds: regs.map((r) => pushDeliverJobId(eventId, r)),
  };
}

/** Waits until `eventId` reached every registration and everything owed is drained. */
async function deliveredOnce(run: { eventId: string; fanoutId: string; deliverIds: string[] }) {
  await waitFor(async () => (await sendRows(run.eventId)).length >= regs.length, 30_000, "sends");
  await drained([run.fanoutId, ...run.deliverIds]);
  expect(await sendRows(run.eventId)).toEqual([...regs].sort());
}

describe("push on two replicas", () => {
  beforeAll(async () => {
    const ownerId = (
      await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" })
    ).id;
    owners = { a: await session(a, "owner"), b: await session(b, "owner") };
    orgId = await createOrgWithProviders(a, owners.a);
    agentId = await createAgent(owners.a, orgId);
    regs = [await register(ownerId), await register(ownerId), await register(ownerId)];
  });

  it("a run finished through replica A owes one fanout, which owes one delivery per registration", async () => {
    first = await completedRun(owners.a);
    const job = await waitFor(
      async () => {
        const j = await queue.getJob(first.fanoutId);
        // finishedOn and returnvalue come from the same read (isCompleted() would be a second one)
        return j?.finishedOn !== undefined ? j : null;
      },
      30_000,
      "fanout completed",
    );
    expect(job.returnvalue).toBe(3);
    expect(job.attemptsMade).toBe(1);
  });

  it("each registration gets exactly one send", async () => {
    await deliveredOnce(first);
  });

  it("a replayed outbox row of the same fanout sends nothing more", async () => {
    const fanoutJob = await queue.getJob(first.fanoutId);
    await b.app.get(TransactionHost).run(() =>
      b.app.get(OutboxService).add({
        queue: PUSH_QUEUE,
        name: PUSH_FANOUT_JOB,
        jobId: first.fanoutId,
        data: fanoutJob?.data,
        orgId,
      }),
    );
    await drained([first.fanoutId, ...first.deliverIds]);
    expect(await sendRows(first.eventId)).toEqual([...regs].sort());
  });

  it("a manual re-add of one delivery id sends nothing more", async () => {
    const deliverJob = await queue.getJob(first.deliverIds[0] as string);
    expect(deliverJob?.data).toMatchObject({ eventId: first.eventId, registrationId: regs[0] });
    await a.app.get(TransactionHost).run(() =>
      a.app.get(OutboxService).add({
        queue: PUSH_QUEUE,
        name: PUSH_DELIVER_JOB,
        jobId: first.deliverIds[0] as string,
        data: deliverJob?.data as PushDeliverData,
        orgId,
      }),
    );
    await drained([first.fanoutId, ...first.deliverIds]);
    expect(await sendRows(first.eventId)).toEqual([...regs].sort());
  });

  it("a run finished through replica B: one send per registration too", async () => {
    await deliveredOnce(await completedRun(owners.b));
  });

  it("runs finishing at once on both replicas: one send per registration and event", async () => {
    const runs = await Promise.all([completedRun(owners.a), completedRun(owners.b)]);
    for (const run of runs) await deliveredOnce(run);
  });
});
