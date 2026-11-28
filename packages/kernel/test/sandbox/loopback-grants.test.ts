import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceAccessError, DeviceServiceSpec } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { DeviceServices } from "../../src/sandbox/device-services.js";
import {
  LOOPBACK_REFRESH_JOB,
  type LoopbackGrantKey,
  LoopbackGrants,
  LoopbackLimitError,
  loopbackRefreshJobId,
} from "../../src/sandbox/loopback-grants.js";
import type { SandboxUseContext } from "../../src/sandbox/use-context.js";
import {
  FAKE_PERMISSION_SUPPORT,
  readFakeServiceLoopbackPorts,
} from "../fixtures/plugins/device-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor, kernelTransaction } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { drainOutbox } from "../helpers/outbox.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Loopback port grants (browser loopback port grants design §4, §6): the grant records, their
 * 24-hour expiry, the per-service port cap, revocation with a deleted conversation and with an
 * outside-sandbox ceiling switched off, each owing a `device-loopback-refresh` that sends the
 * service's live set to the device (the fake logs every ensure's ports).
 */

const SERVICE = "fake-ext.echo";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let sandboxRoot: string;
let ownerId: string;
let orgId: string;
let grants: LoopbackGrants;
/** While true, every kernel add to the maintenance queue fails (the fast path delivers nothing). */
let failing = false;

let echo: Uint8Array;
const spec = (): DeviceServiceSpec => ({
  name: SERVICE,
  runtime: "node",
  entry: "echo.mjs",
  args: [],
  files: { "echo.mjs": echo },
});

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-loopback-grants-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  echo = new Uint8Array(
    await readFile(
      fileURLToPath(new URL("../fixtures/services/echo-service.mjs", import.meta.url)),
    ),
  );
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [
          MODEL_FAKE,
          fileURLToPath(new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url)),
        ],
        extensionConfig: { "device-fake": { root: sandboxRoot } },
      },
    ),
    {
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => failing && queue === MAINTENANCE_QUEUE_NAME,
        },
      ],
    },
  );
  grants = k.app.get(LoopbackGrants);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrgWithProviders(k, await session(k, "owner"));
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

interface Setup {
  accountId: string;
  req: Req;
  deviceId: string;
  conversationId: string;
}
let s: Setup;

/** A member with a `device-fake` device of their own and a conversation bound to it. */
beforeEach(async () => {
  failing = false;
  await sql`UPDATE capybara.orgs SET settings = '{}'::jsonb WHERE id = ${orgId}`.execute(raw);
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Dev ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const req = await session(k, login);
  const deviceId = randomUUID();
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
      network_hosts: JSON.stringify([]),
      report: JSON.stringify({ support: FAKE_PERMISSION_SUPPORT }),
    })
    .execute();
  const agentId = await createAgent(req, orgId);
  const conversationId = await createConv(req, orgId, agentId);
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "=", conversationId)
    .execute();
  s = { accountId, req, deviceId, conversationId };
});

const use = (): SandboxUseContext => ({
  orgId,
  deviceId: s.deviceId,
  holderConversationId: s.conversationId,
  actor: { accountId: s.accountId, conversationId: s.conversationId },
});

afterEach(async () => {
  failing = false;
  await k.app.get(DeviceServices).stop(use(), SERVICE, AbortSignal.timeout(30_000));
});

const key = (port: number): LoopbackGrantKey => ({
  orgId,
  deviceId: s.deviceId,
  serviceId: SERVICE,
  rootConversationId: s.conversationId,
  port,
});

const grant = (port: number) =>
  kernelTransaction(k, () =>
    grants.grantIn(key(port), { source: "owner-panel", actorAccountId: s.accountId }),
  );

const rows = () =>
  db
    .selectFrom("device_loopback_grants")
    .selectAll()
    .where("device_id", "=", s.deviceId)
    .orderBy("port")
    .execute();

const audits = (action: string) =>
  db
    .selectFrom("audit_events")
    .selectAll()
    .where("action", "=", action)
    .where("target", "=", s.deviceId)
    .execute();

const owed = (jobId: string) =>
  db
    .selectFrom("outbox")
    .selectAll()
    .where("queue", "=", MAINTENANCE_QUEUE_NAME)
    .where("job_id", "=", jobId)
    .execute();

/** Makes the device's owed refreshes due and delivers them. */
const drainRefreshes = async () => {
  failing = false;
  await db
    .updateTable("outbox")
    .set({ next_attempt_at: sql<Date>`now()` })
    .where("job_name", "=", LOOPBACK_REFRESH_JOB)
    .execute();
  await drainOutbox(k.app, { jobName: LOOPBACK_REFRESH_JOB });
};

/** The ports the fake's last ensure got, once its refresh job ran. */
const lastPorts = async () => (await readFakeServiceLoopbackPorts(sandboxRoot)).at(-1);

const waitForLastPorts = async (want: number[]) => {
  await waitFor(
    async () => JSON.stringify(await lastPorts()) === JSON.stringify(want),
    20_000,
    `the service's last ensure got ${JSON.stringify(want)}`,
  );
};

describe("loopback port grants", () => {
  it("grants once per key and returns the live row on a repeat", async () => {
    const first = await grant(3999);
    const second = await grant(3999);
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ port: 3999, source: "owner-panel", runId: null });
    const expiresIn = Date.parse(first.expiresAt) - Date.now();
    expect(expiresIn).toBeGreaterThan(23 * 3_600_000);
    expect(expiresIn).toBeLessThanOrEqual(24 * 3_600_000);
    expect(await audits("device.loopback_granted")).toHaveLength(1);
    expect(await grants.livePorts(orgId, s.deviceId, SERVICE)).toEqual([3999]);
    expect(
      (await grants.liveForRoot(orgId, s.deviceId, SERVICE, s.conversationId)).map((r) => r.id),
    ).toEqual([first.id]);
    expect(await grant(5432)).toMatchObject({ port: 5432 });
    const db5432 = (await audits("device.loopback_granted")).find(
      (a) => (a.detail as { port?: number }).port === 5432,
    );
    expect(db5432?.detail).toMatchObject({ port: 5432, database: true });
    // a grant of a call names it; the rerun finds it
    const call = { runId: randomUUID(), callId: "c1", attempt: 1 };
    const byCall = await kernelTransaction(k, () =>
      grants.grantIn(key(4000), { source: "full-access", actorAccountId: null, call }),
    );
    expect(await grants.forCall(call.runId, call.callId)).toEqual(byCall);
    expect(await grants.revoke(key(4000), s.accountId)).toBe(true);
    expect(await grants.revoke(key(4000), s.accountId)).toBe(false);
    expect(await grants.forCall(call.runId, call.callId)).toBeNull();
  });

  it("expires after 24 hours: the expiry pass revokes and owes a refresh", async () => {
    const g = await grant(3999);
    failing = true;
    await sql`UPDATE capybara.device_loopback_grants SET expires_at = now() - interval '1 second'
      WHERE id = ${g.id}`.execute(raw);
    expect(await grants.livePorts(orgId, s.deviceId, SERVICE)).toEqual([]);
    expect(await grants.expireDue()).toBe(1);
    const [row] = await rows();
    expect(row?.revoke_reason).toBe("expired");
    expect(row?.revoked_at).not.toBeNull();
    const [job] = await owed(loopbackRefreshJobId(s.deviceId, SERVICE, `r${g.id}`));
    expect(job).toMatchObject({
      job_name: LOOPBACK_REFRESH_JOB,
      org_id: orgId,
      data: { orgId, deviceId: s.deviceId, serviceId: SERVICE },
    });
    // a grant of the same key after the expiry is a new one
    failing = false;
    expect((await grant(3999)).id).not.toBe(g.id);
  });

  it("refuses a 33rd live port with loopback_limit", async () => {
    for (let p = 1; p <= 32; p++) await grant(10_000 + p);
    const err = await grant(20_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoopbackLimitError);
    expect((err as DeviceAccessError).code).toBe("loopback_limit");
    expect((err as Error).message).toMatch(/revoke one/);
    // a repeat of a live grant adds nothing to the set
    expect(await grant(10_001)).toMatchObject({ port: 10_001 });
    expect(await grants.livePorts(orgId, s.deviceId, SERVICE)).toHaveLength(32);
  });

  it("revokes a deleted conversation's grants in the deleting transaction", async () => {
    await k.app.get(DeviceServices).ensure(use(), spec(), AbortSignal.timeout(30_000));
    const g = await grant(3999);
    await drainRefreshes();
    await waitForLastPorts([3999]);
    failing = true;
    const res = await s.req({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/conversations/${s.conversationId}`,
    });
    expect(res.statusCode, res.body).toBe(204);
    const [row] = await rows();
    expect(row?.revoke_reason).toBe("conversation-deleted");
    expect(await owed(loopbackRefreshJobId(s.deviceId, SERVICE, `r${g.id}`))).toHaveLength(1);
    expect(await audits("device.loopback_revoked")).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({ reason: "conversation-deleted" }),
      }),
    ]);
    await drainRefreshes();
    await waitForLastPorts([]);
  });

  it("ceiling publication owes a refresh and the job revokes", async () => {
    await k.app.get(DeviceServices).ensure(use(), spec(), AbortSignal.timeout(30_000));
    await grant(3999);
    await drainRefreshes();
    await waitForLastPorts([3999]);
    failing = true;
    await k.app.get(OrgSettingsService).update(orgId, { outsideSandbox: "off" }, ownerId);
    const jobs = await db
      .selectFrom("outbox")
      .select(["job_id", "data"])
      .where("job_name", "=", LOOPBACK_REFRESH_JOB)
      .where("org_id", "=", orgId)
      .execute();
    const ceiling = jobs.filter((j) =>
      j.job_id.startsWith(`dlr-${s.deviceId}-${SERVICE}-corg-${orgId}-`),
    );
    expect(ceiling).toHaveLength(1);
    // the publication itself revokes nothing: the job decides
    expect((await rows())[0]?.revoke_reason).toBeNull();
    await drainRefreshes();
    await waitForLastPorts([]);
    expect((await rows())[0]?.revoke_reason).toBe("outside-sandbox-off");
    expect(await audits("device.loopback_revoked")).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({ reason: "outside-sandbox-off" }),
      }),
    ]);
  });
});
