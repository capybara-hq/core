import { randomUUID } from "node:crypto";
import {
  createDualReplicaHarness,
  fakeExtensionEntry,
  type Harness,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coalesceJobId, subjectKey } from "../../src/automations/events/guards.js";
import {
  AUTOMATION_COALESCE_JOB,
  TRIGGER_DISPATCH_JOB,
  triggerDispatchJobId,
} from "../../src/automations/job-ids.js";
import { AutomationStore } from "../../src/automations/store.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { enableExtensions, PW, waitFor } from "../helpers/runs.js";

/**
 * Event automations on two replicas (collaboration spec §4.3, §4.7): both replicas' maintenance
 * workers take the same `trigger-dispatch` job and the same `automation-coalesce` window (the same
 * job data under many job ids, so no BullMQ job-id dedupe hides a race), and the deliveries keyed
 * by automation and event plus the automation row lock leave exactly one run and one subject
 * conversation.
 */

const PLUGIN = "fake-trigger-source";
const store = new AutomationStore();
const SUBJECT = { kind: "item", id: "ITEM-1", title: "First item" };

let pgc: TestContainer;
let rdc: TestContainer;
let h: Harness;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let maint: Queue;
let cookie = "";
let orgId = "";
let ownerId = "";
let agentId = "";

const at = async (i: 0 | 1, method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${h.replicas[i].port}${path}`, {
    method,
    headers: {
      "x-capybara-csrf": "1",
      ...(cookie !== "" && { cookie }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  expect(replicaOf(res)).toBe(i);
  const text = await res.text();
  return {
    status: res.status,
    json: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
  };
};

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  h = await createDualReplicaHarness({
    extensions: [MODEL_FAKE, fakeExtensionEntry(PLUGIN)],
    pgUrl: pgc.url,
    redisUrl: rdc.url,
    config: { auth: { cookieSecure: false } },
  });
  raw = createDb(h.dbUrl, 3);
  db = kernelDb(raw);
  redis = new Redis(rdc.url, { maxRetriesPerRequest: null });
  maint = new Queue(MAINTENANCE_QUEUE_NAME, { connection: redis });
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "o" }))
    .id;
  const login = await h.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "x-capybara-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify({ login: "owner", password: PW }),
  });
  expect(login.status).toBe(200);
  await login.body?.cancel();
  cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const org = await at(0, "POST", "/api/v1/orgs", { name: "Acme" });
  orgId = (org.json.org as { id: string }).id;
  await enableExtensions(raw, orgId, "model-fake", PLUGIN);
  const agent = await at(1, "POST", `/api/v1/orgs/${orgId}/agents`, {
    definition: {
      name: "Watcher",
      instructions: "Be helpful.",
      model: { provider: "model-fake", model: "fake-1" },
      disabledTools: builtinsOff(),
    },
    visibility: "org",
  });
  expect(agent.status, JSON.stringify(agent.json)).toBe(201);
  agentId = (agent.json.agent as { id: string }).id;
});

afterAll(async () => {
  await maint?.close();
  redis?.disconnect();
  await raw?.destroy();
  await h?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

/** Adds `n` copies of one job under distinct ids and waits until all completed (none failed). */
async function everywhere(name: string, data: object, n = 12): Promise<void> {
  const tag = randomUUID().slice(0, 8);
  const ids = Array.from({ length: n }, (_, i) => `${name}-dual-${tag}-${i}`);
  await Promise.all(ids.map((jobId) => maint.add(name, data, { jobId })));
  await waitFor(
    async () => {
      const states = await Promise.all(ids.map((id) => maint.getJobState(id)));
      expect(states.filter((x) => x === "failed")).toEqual([]);
      return states.every((x) => x === "completed" || x === "unknown");
    },
    30_000,
    `the ${name} jobs done`,
    50,
  );
  await Promise.all(ids.map((id) => maint.remove(id).catch(() => 0)));
}

describe("event dispatch and coalescing on two replicas", () => {
  it("both replicas process the same event and window: one run, one subject conversation", async () => {
    expect(h.replicas.map((r) => r.roles.includes("worker"))).toEqual([true, true]);
    const a = await store.insertTask(db, {
      id: randomUUID(),
      orgId,
      accountId: ownerId,
      agentId,
      name: "Triage",
      prompt: "echo:triaged",
      trigger: { kind: "event", source: PLUGIN, types: ["item.created"], filter: [] },
      mode: "subject",
      conversationId: null,
      chat: null,
      model: null,
      effort: null,
      deviceId: null,
      status: "active",
      nextRunAt: null,
      jitterSeconds: 0,
      expiresAt: null,
    });
    // a stored event no job was owed for: the test is the only dispatcher
    const eventId = randomUUID();
    await db
      .insertInto("trigger_events")
      .values({
        id: eventId,
        org_id: orgId,
        plugin: PLUGIN,
        type: "item.created",
        subject: JSON.stringify(SUBJECT),
        facts: JSON.stringify({ status: "open" }),
        summary: "ITEM-1 was opened.",
        dedupe_key: eventId,
        state: "pending",
      })
      .execute();

    // the same event dispatched by many jobs at once, over both replicas' workers
    await everywhere(TRIGGER_DISPATCH_JOB, { orgId, eventId });
    expect(triggerDispatchJobId(eventId)).not.toMatch(/:/);
    const deliveries = await db
      .selectFrom("automation_event_deliveries")
      .select(["event_id", "automation_run_id"])
      .where("automation_id", "=", a.id)
      .execute();
    expect(deliveries).toEqual([{ event_id: eventId, automation_run_id: null }]);

    // the window's delayed job (owed once) and many copies flush at once
    const windowJob = `${coalesceJobId(a.id, SUBJECT)}-${eventId}`;
    await waitFor(
      async () => (await maint.getJobState(windowJob)) === "delayed",
      30_000,
      "the window's delayed job",
      50,
    );
    await (await maint.getJob(windowJob))?.promote();
    await everywhere(AUTOMATION_COALESCE_JOB, {
      orgId,
      automationId: a.id,
      subjectKey: subjectKey(SUBJECT),
    });

    const runs = await waitFor(
      async () => {
        const rs = await store.listRuns(db, a.id, 50);
        return rs.length >= 1 && rs.every((r) => r.status !== "pending" && r.status !== "running")
          ? rs
          : null;
      },
      60_000,
      "the settled run",
      100,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "completed", triggerKey: eventId });
    expect(
      await db
        .selectFrom("automation_runs")
        .select("id")
        .where("automation_id", "=", a.id)
        .execute(),
    ).toHaveLength(1);
    const convs = await db
      .selectFrom("conversations")
      .select("id")
      .where("automation_id", "=", a.id)
      .execute();
    expect(convs).toHaveLength(1);
    expect(
      await db
        .selectFrom("runs")
        .select("id")
        .where("automation_run_id", "=", runs[0]?.id ?? "")
        .execute(),
    ).toHaveLength(1);
  });
});
