import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import { intervalTick, LockedIntervalScheduler } from "../../src/infra/schedule/locked-interval.js";
import { ScheduledRuns } from "../../src/infra/schedule/scheduled-runs.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { DeviceServices } from "../../src/sandbox/device-services.js";
import {
  LOOPBACK_EXPIRY_JOB,
  LOOPBACK_EXPIRY_MS,
  LoopbackExpiryJob,
} from "../../src/sandbox/loopback-expiry.job.js";
import {
  LOOPBACK_REFRESH_JOB,
  type LoopbackGrantKey,
  type LoopbackGrantRow,
  LoopbackGrants,
  LoopbackLimitError,
  oweRefresh,
} from "../../src/sandbox/loopback-grants.js";
import { CommandReviewService } from "../../src/sandbox/review/review.service.js";
import {
  FAKE_PERMISSION_SUPPORT,
  readFakeSandboxOps,
  readFakeServiceLoopbackPorts,
} from "../fixtures/plugins/device-fake/index.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrgWithProviders,
  enableExtensions,
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
 * Loopback port grants across two replicas (browser loopback port grants design §4). Both
 * replicas run the api and worker roles on one PostgreSQL and Valkey, with one `device-fake` root,
 * so either may run the conversation, deliver the outbox and run the refresh job. A grant is one
 * row, one `permission_reviewed` event and one refresh of the service's live set: the refresh job
 * id is deterministic (`dlr-<device>-<service>-<change>`), so the same change owed twice while its
 * job waits still runs once. The expiry pass is a `@LockedInterval` job: once per tick across
 * replicas.
 */

const FAKE_DEVICE_ACCESS = fileURLToPath(
  new URL("../fixtures/extensions/fake-device-access/index.ts", import.meta.url),
);
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url),
);
const NAVIGATE = "plugin__fake-device-access__navigate";
const URL_3999 = "http://127.0.0.1:3999/";
const SERVICE_ID = "fake-device-access.echo";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let maintenance: Queue;
let sandboxRoot: string;
let a: TestKernel;
let b: TestKernel;
let ownerId: string;
let orgId: string;
let accountId: string;
let memberLogin: string;
let req: Req;
let deviceId: string;
let conversationId: string;

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-loopback-dual-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  maintenance = new Queue(MAINTENANCE_QUEUE_NAME, { connection: redis });
  const cfg = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      extensions: [MODEL_FAKE, SANDBOX_FAKE, FAKE_DEVICE_ACCESS],
      extensionConfig: { "device-fake": { root: sandboxRoot } },
    },
  );
  a = await startKernel(cfg);
  b = await startKernel(cfg);
  // the echo service's launch passes the command review on whichever replica runs the call
  for (const k of [a, b]) {
    vi.spyOn(k.app.get(CommandReviewService), "review").mockResolvedValue({
      decision: "allow",
      by: "rule",
      reason: "test",
      rule: null,
    });
  }
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrgWithProviders(a, await session(a, "owner"));
  await enableExtensions(raw, orgId, "fake-device-access");
  const login = `m-${randomUUID().slice(0, 8)}`;
  memberLogin = login;
  accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Dev ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  req = await session(a, login);
  deviceId = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: accountId,
      name: "Box",
      provider: "device-fake",
      network_mode: "allowlist",
      network_hosts: JSON.stringify(["a.dev"]),
      report: JSON.stringify({ support: FAKE_PERMISSION_SUPPORT }),
    })
    .execute();
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Browser",
        instructions: "Use the browser.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([]),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const agentId = (res.json() as { agent: { id: string } }).agent.id;
  conversationId = await createConv(req, orgId, agentId);
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "=", conversationId)
    .execute();
});

afterAll(async () => {
  await maintenance?.resume().catch(() => {});
  await a?.app
    .get(DeviceServices)
    .stop(
      {
        orgId,
        deviceId,
        holderConversationId: conversationId,
        actor: { accountId, conversationId },
      },
      SERVICE_ID,
      AbortSignal.timeout(30_000),
    )
    .catch(() => {});
  vi.restoreAllMocks();
  await Promise.all([a?.close(), b?.close()]);
  await maintenance?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

const grants = () =>
  db
    .selectFrom("device_loopback_grants")
    .selectAll()
    .where("device_id", "=", deviceId)
    .orderBy("created_at")
    .execute();

/** The refresh jobs still owed by the outbox (not yet in BullMQ). */
const owedRefreshes = async () =>
  (
    await sql<{ n: string }>`SELECT count(*)::text AS n FROM capybara.outbox
      WHERE job_name = ${LOOPBACK_REFRESH_JOB}`.execute(raw)
  ).rows[0]?.n;

/** The refresh jobs in BullMQ that have not finished. */
const pendingRefreshJobs = async () =>
  (await maintenance.getJobs(["waiting", "active", "delayed", "prioritized"])).filter(
    (j) => j?.name === LOOPBACK_REFRESH_JOB,
  );

/** The `ifRunning` ensures the fake got: only the refresh job sends one in this file. */
const ifRunningEnsures = async () =>
  (await readFakeSandboxOps(sandboxRoot)).filter(
    (l) => l[0] === "service-if-running" && l[2] === SERVICE_ID,
  ).length;

/** Waits until no refresh is owed or unfinished. */
const settled = () =>
  waitFor(
    async () => (await owedRefreshes()) === "0" && (await pendingRefreshJobs()).length === 0,
    30_000,
    "the refreshes settled",
  );

/** What the refresh jobs run after `fn` settles add: their ensures and the sets they sent. */
async function refreshesOf(fn: () => Promise<unknown>) {
  await settled();
  const ensures = await ifRunningEnsures();
  const sent = (await readFakeServiceLoopbackPorts(sandboxRoot)).length;
  await fn();
  await settled();
  return {
    ensures: (await ifRunningEnsures()) - ensures,
    sent: (await readFakeServiceLoopbackPorts(sandboxRoot)).slice(sent),
  };
}

const key = (port: number): LoopbackGrantKey => ({
  orgId,
  deviceId,
  serviceId: SERVICE_ID,
  rootConversationId: conversationId,
  port,
});

/** A grant from the owner's panel on replica `k`. */
const panelGrant = (k: TestKernel, port: number) =>
  k.app
    .get(TransactionHost)
    .run(() =>
      k.app
        .get(LoopbackGrants)
        .grantIn(key(port), { source: "owner-panel", actorAccountId: accountId }),
    );

const livePorts = () => a.app.get(LoopbackGrants).livePorts(orgId, deviceId, SERVICE_ID);

const audits = (action: string) =>
  db.selectFrom("audit_events").select(["action", "detail"]).where("action", "=", action).execute();

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

describe("loopback port grants on two replicas", () => {
  it("one grant leads to one refresh across two replicas", async () => {
    const profiles = a.app.get(PermissionProfilesService);
    const view = await profiles.get(orgId, conversationId, accountId);
    await profiles.set(orgId, conversationId, accountId, {
      profile: "full-access",
      expectedRevision: view.revision,
      consentScopeRevision: view.scopeRevision ?? undefined,
    });
    // the refresh job waits in the paused queue, so a second owe of its change meets it there
    await maintenance.pause();
    await postMessage(
      req,
      orgId,
      conversationId,
      `tool:${NAVIGATE}:${JSON.stringify({ url: URL_3999, service: true })}`,
    );
    await waitForTerminal(db, conversationId, 1, 30_000);

    const [grant, ...moreGrants] = await grants();
    expect(moreGrants).toEqual([]);
    expect(grant).toMatchObject({ source: "full-access", service_id: SERVICE_ID, port: 3999 });
    const reviews = ofType(await eventsOf(db, conversationId), "permission_reviewed").filter(
      (e) => e.payload.scopeKind === "loopback-port",
    );
    expect(reviews).toHaveLength(1);
    // the re-run's own ensure already sent the granted port
    expect(await readFakeServiceLoopbackPorts(sandboxRoot)).toContainEqual([3999]);

    await waitFor(async () => (await owedRefreshes()) === "0", 20_000, "the outbox delivered");
    expect(await pendingRefreshJobs()).toHaveLength(1);
    // the same change owed again on the other replica (a retried owe) while the job waits
    const outbox = b.app.get(OutboxService);
    await b.app
      .get(TransactionHost)
      .run(() => oweRefresh(outbox, { orgId, deviceId, serviceId: SERVICE_ID }, `g${grant?.id}`));
    await waitFor(async () => (await owedRefreshes()) === "0", 20_000, "the outbox delivered");

    const sentBefore = (await readFakeServiceLoopbackPorts(sandboxRoot)).length;
    const refreshesBefore = await ifRunningEnsures();
    await maintenance.resume();
    await waitFor(
      async () => (await pendingRefreshJobs()).length === 0 && (await ifRunningEnsures()) > 0,
      30_000,
      "the refresh ran",
    );
    expect((await ifRunningEnsures()) - refreshesBefore).toBe(1);
    expect((await readFakeServiceLoopbackPorts(sandboxRoot)).slice(sentBefore)).toEqual([[3999]]);
  });

  it("the expiry job runs once per tick across replicas", async () => {
    const [grant] = await grants();
    expect(grant?.revoked_at).toBeNull();
    await sql`UPDATE capybara.device_loopback_grants
      SET expires_at = now() - interval '1 minute' WHERE id = ${grant?.id}`.execute(raw);
    // no scheduled tick competes: the timers stop, the current tick's marker goes
    for (const k of [a, b]) k.app.get(LockedIntervalScheduler).stop(LOOPBACK_EXPIRY_JOB);
    for (const k of [a, b]) {
      const scheduled = k.app.get(ScheduledRuns);
      await expect.poll(() => scheduled.inFlightCount, { timeout: 30_000 }).toBe(0);
    }
    const marker = `cron:${LOOPBACK_EXPIRY_JOB}:${intervalTick(LOOPBACK_EXPIRY_MS, Date.now()).tick}`;
    const locks = a.app.get(LockService);
    const holder = await locks.holderOf(marker);
    if (holder !== null) await locks.releaseIf(marker, holder);

    const runs = [a, b].map((k) => vi.spyOn(k.app.get(LoopbackGrants), "expireDue"));
    try {
      await Promise.all([
        a.app.get(LoopbackExpiryJob).expire(),
        b.app.get(LoopbackExpiryJob).expire(),
      ]);
      expect(runs.reduce((n, x) => n + x.mock.calls.length, 0)).toBe(1);
    } finally {
      for (const x of runs) x.mockRestore();
    }
    const [after] = await grants();
    expect(after).toMatchObject({ revoke_reason: "expired" });
    const revoked = await audits("device.loopback_revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.detail).toMatchObject({ grantId: grant?.id, reason: "expired" });
  });

  it("the same port granted on both replicas at once is one grant and one refresh", async () => {
    let rows: LoopbackGrantRow[] = [];
    const ran = await refreshesOf(async () => {
      rows = await Promise.all([panelGrant(a, 4000), panelGrant(b, 4000)]);
    });
    expect(rows[0]?.id).toBe(rows[1]?.id);
    const granted = (await audits("device.loopback_granted")).filter(
      (e) => (e.detail as { port?: number }).port === 4000,
    );
    expect(granted).toHaveLength(1);
    expect(ran).toEqual({ ensures: 1, sent: [[4000]] });
  });

  it("two replicas granting past the 32-port cap at once admit one", async () => {
    for (let port = 5000; (await livePorts()).length < 31; port++) await panelGrant(a, port);
    const settledGrants = await Promise.allSettled([panelGrant(a, 6000), panelGrant(b, 6001)]);
    const admitted = settledGrants.filter((r) => r.status === "fulfilled");
    const refused = settledGrants.filter((r) => r.status === "rejected");
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(LoopbackLimitError);
    expect(await livePorts()).toHaveLength(32);
  });

  it("a revoke on the other replica narrows the device once", async () => {
    const before = await livePorts();
    expect(before).toContain(4000);
    const ran = await refreshesOf(async () => {
      expect(await b.app.get(LoopbackGrants).revoke(key(4000), accountId)).toBe(true);
    });
    expect(ran).toEqual({ ensures: 1, sent: [before.filter((p) => p !== 4000)] });
    expect(await livePorts()).not.toContain(4000);
  });

  it("deleting the conversation on the other replica revokes each grant once", async () => {
    const live = await livePorts();
    expect(live).toHaveLength(31);
    // the service stops first, so no process outlives the file; an ifRunning ensure still logs
    await a.app.get(DeviceServices).stop(
      {
        orgId,
        deviceId,
        holderConversationId: conversationId,
        actor: { accountId, conversationId },
      },
      SERVICE_ID,
      AbortSignal.timeout(30_000),
    );
    const reqB = await session(b, memberLogin);
    const ran = await refreshesOf(async () => {
      const res = await reqB({
        method: "DELETE",
        url: `/api/v1/orgs/${orgId}/conversations/${conversationId}`,
      });
      expect(res.statusCode, res.body).toBe(204);
    });
    // the deleting transaction owes two changes (the revoke's and the root's ceiling bump); each
    // sends the empty set
    expect(ran.sent.length).toBeGreaterThan(0);
    expect(ran.sent).toEqual(ran.sent.map(() => []));
    expect(ran.ensures).toBe(ran.sent.length);
    expect(await livePorts()).toEqual([]);
    const deleted = (await audits("device.loopback_revoked")).filter(
      (e) => (e.detail as { reason?: string }).reason === "conversation-deleted",
    );
    expect(deleted).toHaveLength(live.length);
  });
});
