import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account } from "../../src/identity/accounts.js";
import { SettingsService } from "../../src/identity/settings.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { createLogger } from "../../src/log.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { SandboxOperationIntents } from "../../src/sandbox/operation-intents.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import { runInBackgroundManaged } from "../../src/tools/builtins/sandbox/bash.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { barrier, managedTaskFixture } from "../helpers/managed-background.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { drainOutbox } from "../helpers/outbox.js";
import { startKernel, type TestKernel, waitFor } from "../helpers/runs.js";

/**
 * B3 evidence end to end (permission activation B-6): the platform's Full switch turned off by the
 * super admin goes through the real writer (`SettingsService` → `PermissionCeilingWrites`), its
 * outbox row, the outbox relay and the maintenance worker's revoke, to the exact `backgroundStop`
 * of the Full task by its recorded ref. Restricted work keeps its grant. A duplicate delivery of
 * the same revoke (again, or two at once) changes nothing. Stop before start: a revocation landing
 * before the start is dispatched never sends it; one landing while the start is in flight stops it
 * by its ref once known.
 */

const PW = "correct horse battery";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let owner: Account;
let ownerLogin: string;
let admin: Account;
/** The maintenance queue as BullMQ holds it: a finished revoke job is gone (removeOnComplete). */
let maintenance: Queue;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 8 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api", "worker"],
      // the poller never applies a cancellation here: only the revoke worker does
      sandbox: { background: { pollSeconds: 3600 } },
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 4);
  maintenance = new Queue(MAINTENANCE_QUEUE_NAME, {
    connection: new Redis(rd.url, { maxRetriesPerRequest: null }),
  });
});
afterAll(async () => {
  await maintenance?.close();
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.deployment_settings, capybara.outbox",
  );
  const accounts = accountsFor(kernelDb(raw));
  ownerLogin = `owner-${randomUUID().slice(0, 8)}`;
  owner = await accounts.createLocal({
    login: ownerLogin,
    password: PW,
    displayName: "Owner",
  });
  admin = await accounts.createLocal({
    login: `admin-${randomUUID().slice(0, 8)}`,
    password: PW,
    displayName: "Admin",
    superAdmin: true,
  });
});

/** The owner's machine allows Full; the conversation consents to Full on it. */
async function fullAccessFixture() {
  const f = await managedTaskFixture({
    kernels: [k],
    raw,
    login: ownerLogin,
    password: PW,
    accountId: owner.id,
    launch: false,
  });
  const machine = await f.db
    .selectFrom("device_machines")
    .select("id")
    .where("device_id", "=", f.deviceId)
    .executeTakeFirstOrThrow();
  await k.app.get(MachinesService).recordPolicyV3(
    machine.id,
    {
      type: "policy",
      policy: { mode: "auto", allowedDomains: [] },
      ownerCeiling: {
        version: 2,
        revision: "owner-1",
        sequence: 1,
        fullAccess: true,
        restrictedProjectReach: "os-user",
        restrictedAllowedDomains: [],
      },
    },
    "connection-1",
  );
  const preview = await k.app.get(PermissionFacts).scope(f.orgId, f.deviceId, null, null);
  if (!preview.scopeRevision) throw new Error("the fixture device has no Full scope");
  const { revision } = await k.app
    .get(PermissionProfilesService)
    .set(f.orgId, f.conversationId, owner.id, {
      profile: "full-access",
      consentScopeRevision: preview.scopeRevision,
      expectedRevision: 0,
    });
  const intent = (operationId = f.operationId) =>
    f.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("operation_id", "=", operationId)
      .executeTakeFirstOrThrow();
  const taskOf = (id: string) =>
    f.db.selectFrom("background_tasks").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  return { ...f, intent, taskOf, profileRevision: revision };
}

/** The super admin turns the platform's Full switch off (the real platform writer). */
const platformFullOff = () =>
  k.app.get(SettingsService).update({ devicesFullAccess: { permission: "off" } }, admin.id);

const revokeJobId = (operationId: string, suffix = "") =>
  `sandbox-operation-revoke-${operationId}${suffix}`;

/**
 * Waits until the revoke job `jobId` has run: its outbox row was relayed (the job added), then
 * the BullMQ job is gone (it completed: maintenance jobs are removed on completion).
 */
async function revokeJobRan(jobId: string): Promise<void> {
  await drainOutbox(k.app, { jobId });
  await waitFor(
    async () => (await maintenance.getJob(jobId)) == null,
    30_000,
    `the revoke job ${jobId} ran`,
  );
}

/** Adds one more delivery of the revoke of `operationId` under `jobId` (committed at once). */
const redeliver = (operationId: string, jobId: string) =>
  k.app.get(TransactionHost).run(() =>
    k.app.get(OutboxService).add({
      queue: "cap-kernel-maintenance",
      name: "sandbox-operation-revoke",
      jobId,
      data: { operationId },
    }),
  );

it("a platform Full-off write reaches the exact backgroundStop through the outbox and the worker", async () => {
  const f = await fullAccessFixture();
  await runInBackgroundManaged(f.depsOf(k), await f.ctxFor(), {
    command: "npm run dev",
    description: "Serve",
    run_in_background: true,
  });
  expect((await f.intent()).scope).toMatchObject({ profile: "full-access" });
  expect(await f.taskRow()).toMatchObject({ status: "running", launch_state: "acknowledged" });
  const ref = f.provider.only().ref;

  await k.app.get(TransactionHost).run(async () => {
    await platformFullOff();
    // inside the writer's transaction: the intent revoked, the task's cancellation owed and the
    // revoke queued as an outbox row; nothing can reach the device before the commit
    const tx = k.app.get(KernelDb);
    const intent = await tx
      .selectFrom("sandbox_operation_intents")
      .select(["state", "revoke_acknowledged"])
      .where("operation_id", "=", f.operationId)
      .executeTakeFirstOrThrow();
    expect(intent).toEqual({ state: "revoked", revoke_acknowledged: false });
    const task = await tx
      .selectFrom("background_tasks")
      .select("launch_state")
      .where("operation_id", "=", f.operationId)
      .executeTakeFirstOrThrow();
    expect(task.launch_state).toBe("cancel-pending");
    const queued = await tx
      .selectFrom("outbox")
      .select(["job_name", "job_id"])
      .where("job_name", "=", "sandbox-operation-revoke")
      .execute();
    expect(queued).toEqual([
      { job_name: "sandbox-operation-revoke", job_id: `sandbox-operation-revoke-${f.operationId}` },
    ]);
    expect(f.provider.calls.stop).toEqual([]);
  });

  // the relay hands it to the maintenance queue; only the worker's revoke acknowledges it
  await revokeJobRan(revokeJobId(f.operationId));
  expect(await f.intent()).toMatchObject({ revoke_acknowledged: true });
  expect(f.provider.calls.stop).toEqual([{ graceMs: 5000 }]);
  expect(f.provider.only()).toMatchObject({ ref, cancelled: true });
  expect(await f.taskRow()).toMatchObject({ status: "stopped", launch_state: "terminal" });
  expect(await f.finishedEvents()).toHaveLength(1);

  // the same revoke delivered again (same job id) is harmless once it has run: no second stop,
  // no second finish
  await redeliver(f.operationId, revokeJobId(f.operationId));
  await revokeJobRan(revokeJobId(f.operationId));
  expect(f.provider.calls.stop).toHaveLength(1);
  expect(await f.finishedEvents()).toHaveLength(1);
  expect(await f.intent()).toMatchObject({ state: "revoked", revoke_acknowledged: true });
  expect(await f.taskRow()).toMatchObject({ status: "stopped", launch_state: "terminal" });
});

it("a revocation that arrives before the start is acknowledged stops it by its ref once known", async () => {
  const f = await fullAccessFixture();
  const entered = barrier();
  const release = barrier();
  f.provider.state.beforeStart = async () => {
    entered.resolve();
    await release.promise;
  };
  const launch = runInBackgroundManaged(f.depsOf(k), await f.ctxFor(), {
    command: "npm run dev",
    description: "Serve",
    run_in_background: true,
  });
  await entered.promise;
  expect((await f.intent()).state).toBe("dispatching");

  await platformFullOff();
  // dispatched but unacknowledged: revoked with an unknown outcome, the exact revoke owed
  expect(await f.intent()).toMatchObject({ state: "revoked", outcome_unknown: true });
  await revokeJobRan(revokeJobId(f.operationId));
  // the worker applied the operation's tombstone; with no ref yet no backgroundStop was sent
  expect(await f.intent()).toMatchObject({ state: "revoked", revoke_acknowledged: true });
  expect(f.provider.calls.stop).toEqual([]);

  // the start returns: its ref joins the owed cancellation, which the worker applies exactly
  release.resolve();
  await expect(launch).rejects.toThrow(/is being stopped/);
  expect(f.provider.calls.start).toBe(1);
  // the acknowledgement owes the exact revoke of the attached ref under its own job
  await revokeJobRan(revokeJobId(f.operationId, "-ack"));
  expect(f.provider.calls.stop).toEqual([{ graceMs: 5000 }]);
  expect(f.provider.only().cancelled).toBe(true);
  expect(await f.taskRow()).toMatchObject({ status: "stopped", launch_state: "terminal" });
  expect(await f.intent()).toMatchObject({ revoke_acknowledged: true });
  expect(f.provider.executions.size).toBe(1);
});

it("Full-off revokes only Full work: a restricted sibling keeps its grant and keeps running", async () => {
  const f = await fullAccessFixture();
  // the machine reports every root of the instance, so restricted work stays within its reach
  await f.db
    .updateTable("device_machines")
    .set({ roots: JSON.stringify({ workspace: "/work", skills: "/skills", tmp: "/tmp" }) })
    .where("device_id", "=", f.deviceId)
    .execute();
  const fullTask = await f.launchAnother();
  await k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, owner.id, {
    profile: "approve-for-me",
    expectedRevision: f.profileRevision,
  });
  const restrictedTask = await f.launchAnother();
  const opOf = async (id: string) => (await f.taskOf(id)).operation_id as string;
  expect((await f.intent(await opOf(fullTask))).scope).toMatchObject({ profile: "full-access" });
  expect((await f.intent(await opOf(restrictedTask))).scope).toMatchObject({
    profile: "approve-for-me",
  });

  await platformFullOff();
  expect((await f.intent(await opOf(fullTask))).state).toBe("revoked");
  expect((await f.intent(await opOf(restrictedTask))).state).toBe("background-running");
  await revokeJobRan(revokeJobId(await opOf(fullTask)));
  expect(await f.intent(await opOf(fullTask))).toMatchObject({ revoke_acknowledged: true });
  expect(f.provider.calls.stop).toEqual([{ graceMs: 5000 }]);
  expect(f.provider.executions.get(await opOf(fullTask))?.cancelled).toBe(true);
  expect(f.provider.executions.get(await opOf(restrictedTask))?.cancelled).toBeUndefined();
  expect(await f.taskOf(fullTask)).toMatchObject({ status: "stopped", launch_state: "terminal" });
  expect(await f.taskOf(restrictedTask)).toMatchObject({
    status: "running",
    launch_state: "acknowledged",
  });
  expect(await f.intent(await opOf(restrictedTask))).toMatchObject({
    state: "background-running",
    revoke_acknowledged: false,
  });
});

it("a revocation that lands before the start is dispatched: the start is never sent", async () => {
  const f = await fullAccessFixture();
  const intents = k.app.get(SandboxOperationIntents);
  const claim = intents.claimDispatch.bind(intents);
  // the platform write commits between the start's admission and its dispatch claim
  const spy = vi
    .spyOn(intents, "claimDispatch")
    .mockImplementationOnce(async (...args: Parameters<typeof claim>) => {
      await platformFullOff();
      return claim(...args);
    });
  await expect(
    runInBackgroundManaged(f.depsOf(k), await f.ctxFor(), {
      command: "npm run dev",
      description: "Serve",
      run_in_background: true,
    }),
  ).rejects.toThrow(/was not started/);
  spy.mockRestore();
  expect(f.provider.calls.start).toBe(0);
  // nothing was dispatched: a definite outcome, and the operation's tombstone is still applied
  expect(await f.intent()).toMatchObject({ state: "revoked", outcome_unknown: false });
  await revokeJobRan(revokeJobId(f.operationId));
  expect(await f.intent()).toMatchObject({ revoke_acknowledged: true });
  expect(f.provider.calls.stop).toEqual([]);
  expect(f.provider.executions.size).toBe(0);
  expect(await f.taskRow()).toMatchObject({ launch_state: "terminal" });
});

it("two deliveries of the revoke running at once stop the task exactly once", async () => {
  const f = await fullAccessFixture();
  await runInBackgroundManaged(f.depsOf(k), await f.ctxFor(), {
    command: "npm run dev",
    description: "Serve",
    run_in_background: true,
  });
  // the first delivery to reach the device is held there until the other one has run
  const entered = barrier();
  const release = barrier();
  const stop = f.provider.impl.background?.stop.bind(f.provider.impl.background);
  if (!stop || !f.provider.impl.background) throw new Error("no background stop");
  let reached = 0;
  f.provider.impl.background.stop = async (...args: Parameters<typeof stop>) => {
    reached++;
    entered.resolve();
    await release.promise;
    return stop(...args);
  };
  const jobs = [revokeJobId(f.operationId), revokeJobId(f.operationId, "-again")];
  await k.app.get(TransactionHost).run(async () => {
    await platformFullOff();
    // a second copy of the same obligation under another job id (a redelivery)
    await k.app.get(OutboxService).add({
      queue: "cap-kernel-maintenance",
      name: "sandbox-operation-revoke",
      jobId: jobs[1] as string,
      data: { operationId: f.operationId },
    });
  });
  for (const id of jobs) await drainOutbox(k.app, { jobId: id });
  await entered.promise;
  // one delivery holds the stop on the device; the other runs to its end meanwhile (it finds the
  // stop claimed and keeps the revocation owed, a later attempt deferred)
  await waitFor(
    async () => {
      // a second stop reaching the device ends the wait too, and fails below
      if (reached > 1) return true;
      const left = await Promise.all(jobs.map((id) => maintenance.getJob(id)));
      return left.filter((j) => j != null).length === 1;
    },
    30_000,
    "the second delivery ran while the first holds the stop",
  );
  expect(reached).toBe(1);
  release.resolve();
  for (const id of jobs)
    await waitFor(async () => (await maintenance.getJob(id)) == null, 30_000, `${id} ran`);
  expect(reached).toBe(1);
  expect(f.provider.calls.stop).toHaveLength(1);
  expect(await f.finishedEvents()).toHaveLength(1);
  expect(await f.intent()).toMatchObject({ revoke_acknowledged: true });
  expect(await f.taskRow()).toMatchObject({ status: "stopped", launch_state: "terminal" });
});

it("turning Full off again writes no new revocation", async () => {
  const f = await fullAccessFixture();
  await runInBackgroundManaged(f.depsOf(k), await f.ctxFor(), {
    command: "npm run dev",
    description: "Serve",
    run_in_background: true,
  });
  await platformFullOff();
  await revokeJobRan(revokeJobId(f.operationId));
  expect(await f.intent()).toMatchObject({ revoke_acknowledged: true });
  const before = await f.intent();
  const publish = vi.spyOn(k.app.get(PermissionCeilingWrites), "publishLocked");
  const queued = vi.spyOn(k.app.get(OutboxService), "add");
  await platformFullOff();
  // no publication and no revoke job: the stored choice did not change
  expect(publish).not.toHaveBeenCalled();
  expect(queued.mock.calls.filter(([job]) => job.name === "sandbox-operation-revoke")).toEqual([]);
  publish.mockRestore();
  queued.mockRestore();
  expect(await f.intent()).toMatchObject({
    state: "revoked",
    revoke_acknowledged: true,
    reconcile_attempt: before.reconcile_attempt,
    updated_at: before.updated_at,
  });
  expect(f.provider.calls.stop).toHaveLength(1);
});
