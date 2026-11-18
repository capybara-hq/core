import { randomUUID } from "node:crypto";
import { DEFAULT_SANDBOX_ROOTS } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account } from "../../src/identity/accounts.js";
import { SettingsService } from "../../src/identity/settings.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import { LocalInstanceBindings } from "../../src/local-devices/instance-bindings.js";
import { LocalDeviceProvider } from "../../src/local-devices/local-device-provider.js";
import { localProviderEntry } from "../../src/local-devices/local-devices.module.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { LocalDeviceRelay } from "../../src/local-devices/relay.js";
import { createLogger } from "../../src/log.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { HOLDER_REVOKE, SandboxOperationIntents } from "../../src/sandbox/operation-intents.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import { LOCAL_PROVIDER, SandboxProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { runInBackgroundManaged } from "../../src/tools/builtins/sandbox/bash.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { barrier, managedTaskFixture } from "../helpers/managed-background.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { drainOutbox } from "../helpers/outbox.js";
import { startKernel, type TestKernel, waitFor } from "../helpers/runs.js";
import { seedDevice } from "../helpers/sandbox.js";
import { seedConversation } from "../helpers/tool-fixtures.js";
import { stagedHello } from "../local-devices/fake-machine-v3.js";

/**
 * B3 evidence end to end (permission activation B-6): the platform's Full switch turned off by the
 * super admin goes through the real writer (`SettingsService` → `PermissionCeilingWrites`), its
 * outbox row, the outbox relay and the maintenance worker's revoke, to the exact `backgroundStop`
 * of the Full task by its recorded ref. Restricted work keeps its grant. A duplicate delivery of
 * the same revoke (again, or two at once) changes nothing. Stop before start: a revocation landing
 * before the start is dispatched never sends it; one landing while the start is in flight stops it
 * by its ref once known. A crashed holder's revocation is durable too (W5-P3a): owed in an outbox
 * row before its holder record is forgotten, it reaches the device by operation id even when the
 * inline revoke fails once on a database error; nothing is ever killed broadly.
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

// final review M1: a start revoked while its ref is unknown ends its task `lost` / `terminal`;
// a ref arriving later is no proof the process ended, so its exact stop runs before the
// revocation is acknowledged
it.each([
  ["a dead holder's revocation", "holder"],
  ["an abandoned unknown launch", "abandon"],
] as const)(
  "%s: a late ref is stopped exactly before the revocation is acknowledged",
  async (_name, how) => {
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
    const dispatching = await f.intent();
    expect(dispatching.state).toBe("dispatching");
    const intents = k.app.get(SandboxOperationIntents);
    // the dispatcher's lease lapsed: an acquirer revokes its holder (or the launch is given up)
    if (how === "holder") await intents.revokeHolders(f.deviceId, [dispatching.holder_token ?? ""]);
    else await intents.abandonBackgroundLaunch(f.operationId, "expired");
    expect(await f.taskRow()).toMatchObject({ status: "lost", launch_state: "terminal" });
    // the first revoke runs before the ref is known: only the operation's tombstone
    await revokeJobRan(revokeJobId(f.operationId, how === "holder" ? "" : "-expired"));
    expect(f.provider.calls.stop).toEqual([]);

    // the late ref joins the owed cancellation; acknowledging needs a verified stop by that ref
    const order: string[] = [];
    const stop = f.provider.impl.background?.stop.bind(f.provider.impl.background);
    if (!stop || !f.provider.impl.background) throw new Error("no background stop");
    f.provider.impl.background.stop = async (...args: Parameters<typeof stop>) => {
      order.push("stop");
      return stop(...args);
    };
    const acknowledge = intents.acknowledgeRevocation.bind(intents);
    const ack = vi.spyOn(intents, "acknowledgeRevocation").mockImplementation(async (id) => {
      order.push("acknowledge");
      return acknowledge(id);
    });
    try {
      release.resolve();
      // the call reports no started task (its record ended when the launch was revoked)
      await expect(launch).rejects.toThrow(/was not started/);
      expect(await f.intent()).toMatchObject({ state: "revoked", revoke_acknowledged: false });
      await revokeJobRan(revokeJobId(f.operationId, "-ack"));
    } finally {
      ack.mockRestore();
    }
    expect(order).toEqual(["stop", "acknowledge"]);
    expect(f.provider.calls.stop).toEqual([{ graceMs: 5000 }]);
    expect(f.provider.only()).toMatchObject({ ref: f.provider.only().ref, cancelled: true });
    expect(await f.intent()).toMatchObject({ state: "revoked", revoke_acknowledged: true });
    // the task's record stays as it ended (lost, its slot freed)
    expect(await f.taskRow()).toMatchObject({ status: "lost", launch_state: "terminal" });
  },
);

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

// ---- a crashed holder (permission runtime cutover B-1, W5-P3a gap (c))

const db = () => kernelDb(raw);
const signal = () => AbortSignal.timeout(20_000);
const ROOTS = { ...DEFAULT_SANDBOX_ROOTS, workspace: "/Users/owner/capybara" };
const support = {
  version: 1 as const,
  restricted: null,
  fullAccess: true,
  background: true,
  unavailableReason: "Restricted per-instance validation pending",
};

/** A local device whose machine answers through the staged transport; `frames` records each op. */
async function localDevice() {
  const seed = await seedConversation(raw);
  const deviceId = randomUUID();
  await db()
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: seed.orgId,
      owner_kind: "personal",
      owner_account_id: seed.accountId,
      source: "local",
      provider: LOCAL_PROVIDER,
      name: "Laptop",
    })
    .execute();
  await db()
    .insertInto("device_machines")
    .values({
      org_id: seed.orgId,
      device_id: deviceId,
      account_id: seed.accountId,
      credential_hash: randomUUID(),
      name: "Laptop",
      os: "darwin",
      arch: "arm64",
      program_version: "0.1.0",
      roots: JSON.stringify(ROOTS),
    })
    .execute();
  const frames: { op: string; args: Record<string, unknown> }[] = [];
  const relay = k.app.get(LocalDeviceRelay);
  vi.spyOn(relay, "connection").mockResolvedValue({ connectionId: "c1", maxFrameBytes: 69632 });
  vi.spyOn(relay, "callV3").mockImplementation(async (_d, op, args) => {
    frames.push({ op, args });
    if (op === "create") return { roots: ROOTS };
    if (op === "revokeOperation") return null;
    if (op === "bindInstance") {
      const g = args.instanceGeneration as string;
      return {
        instanceId: args.instanceId as string,
        instanceGeneration: g,
        bindingId: args.bindingId as string,
        runtimeIdentity: {
          runtimeHash: "a".repeat(64),
          helperHash: "b".repeat(64),
          imageFingerprint: "c".repeat(64),
          instanceGeneration: g,
        },
        permissionSupport: support,
        ownerCeiling: stagedHello().ownerCeiling,
      };
    }
    throw new Error(`unexpected device op ${op}`);
  });
  // the production @local registration, over the answering transport
  k.app.get(SandboxProviders).register(
    localProviderEntry({
      provider: k.app.get(LocalDeviceProvider),
      relay,
      bindings: k.app.get(LocalInstanceBindings),
    }),
  );
  const ctx = {
    orgId: seed.orgId,
    deviceId,
    holderConversationId: seed.conversationId,
    actor: { accountId: seed.accountId, conversationId: seed.conversationId },
  };
  return { ...seed, deviceId, ctx, frames };
}

/** One operation intent of `f`'s device, as an admission (or a crashed holder) left it. */
async function seedIntent(
  f: { orgId: string; accountId: string; conversationId: string; deviceId: string },
  o: {
    holder?: string;
    generation: string;
    state: "admitted" | "dispatching" | "started-or-unknown" | "background-running" | "completed";
    method?: "exec" | "backgroundStart";
    provider?: string;
    deviceId?: string;
  },
): Promise<string> {
  const operationId = randomUUID();
  const method = o.method ?? "exec";
  await db()
    .insertInto("sandbox_operation_intents")
    .values({
      operation_id: operationId,
      org_id: f.orgId,
      account_id: f.accountId,
      device_id: o.deviceId ?? f.deviceId,
      root_conversation_id: f.conversationId,
      conversation_id: f.conversationId,
      run_id: null,
      call_id: null,
      ordinal: 0,
      method,
      input_hash: "a".repeat(64),
      admission_hash: "b".repeat(64),
      input: "{}",
      scope: "{}",
      epochs: JSON.stringify({ platform: 0, org: 0, device: 0, root: 0 }),
      provider: o.provider ?? LOCAL_PROVIDER,
      provider_version: "test",
      instance_generation: o.generation,
      deadline: new Date(Date.now() + 60_000),
      retain_until: new Date(Date.now() + 120_000),
      state: o.state,
      execution_id: randomUUID(),
      holder_token: o.holder ?? randomUUID(),
      ...(o.state === "background-running" && {
        execution_ref: JSON.stringify({
          operationId,
          executionId: "x",
          instanceId: o.deviceId ?? f.deviceId,
          instanceGeneration: o.generation,
        }),
      }),
    })
    .execute();
  return operationId;
}

/** The admitted Bash a crashed replica held on the device's current instance. */
const admittedBash = (
  f: Awaited<ReturnType<typeof localDevice>>,
  holder: string,
  generation: string,
): Promise<string> => seedIntent(f, { holder, generation, state: "admitted" });

/** A managed background task reserved for `operationId` (dispatched, no exact ref yet). */
async function launchingTask(
  f: { orgId: string; accountId: string; conversationId: string; deviceId: string },
  operationId: string,
  launchState: "pending" | "dispatched",
): Promise<string> {
  const id = `bt_${randomUUID()
    .replace(/[^a-z2-7]/g, "")
    .slice(0, 6)
    .padEnd(6, "a")}`;
  await db()
    .insertInto("background_tasks")
    .values({
      id,
      org_id: f.orgId,
      conversation_id: f.conversationId,
      sandbox_conversation_id: f.conversationId,
      device_id: f.deviceId,
      run_id: randomUUID(),
      call_id: `call-${id}`,
      trigger_account_id: f.accountId,
      description: "d",
      command: "sleep 600",
      sid: null,
      output_path: `/workspace/.capybara/tasks/${id}.out`,
      status: "running",
      deadline_at: new Date(Date.now() + 3_600_000),
      sandbox_created_at: null,
      launch_state: launchState,
      operation_id: operationId,
      working_root: "/workspace",
      retain_until: new Date(Date.now() + 86_400_000),
      ...(launchState === "dispatched" && {
        input_digest: "d".repeat(64),
        run_execution_id: randomUUID(),
        task_tag: randomUUID(),
        instance_id: f.deviceId,
        instance_provider: LOCAL_PROVIDER,
        instance_provider_version: "test",
        instance_generation: "1",
        profile_revision: 0,
        ceiling_revision: "c",
      }),
    })
    .execute();
  return id;
}

/** A cloud device of a fresh org (the intents tests need no instance). */
async function intentDevice() {
  const seed = await seedConversation(raw);
  const deviceId = await seedDevice(raw, seed.orgId, seed.accountId);
  return { ...seed, deviceId };
}

const stateOf = async (operationId: string) =>
  (
    await db()
      .selectFrom("sandbox_operation_intents")
      .select("state")
      .where("operation_id", "=", operationId)
      .executeTakeFirstOrThrow()
  ).state;

it("revokeIncarnation revokes the generation's admitted, dispatching and started-or-unknown intents only", async () => {
  const f = await intentDevice();
  const other = await seedDevice(raw, f.orgId, f.accountId);
  const g = "1700000000001";
  const ids = {
    admitted: await seedIntent(f, { generation: g, state: "admitted" }),
    dispatching: await seedIntent(f, { generation: g, state: "dispatching" }),
    unknown: await seedIntent(f, { generation: g, state: "started-or-unknown" }),
    running: await seedIntent(f, {
      generation: g,
      state: "background-running",
      method: "backgroundStart",
    }),
    completed: await seedIntent(f, { generation: g, state: "completed" }),
    olderGeneration: await seedIntent(f, { generation: "1600000000000", state: "admitted" }),
    otherProvider: await seedIntent(f, { generation: g, state: "dispatching", provider: "x" }),
    otherDevice: await seedIntent(f, {
      generation: g,
      state: "started-or-unknown",
      deviceId: other,
    }),
  };
  await k.app
    .get(SandboxOperationIntents)
    .revokeIncarnation(f.deviceId, { provider: LOCAL_PROVIDER, generation: g });
  expect({
    admitted: await stateOf(ids.admitted),
    dispatching: await stateOf(ids.dispatching),
    unknown: await stateOf(ids.unknown),
    running: await stateOf(ids.running),
    completed: await stateOf(ids.completed),
    olderGeneration: await stateOf(ids.olderGeneration),
    otherProvider: await stateOf(ids.otherProvider),
    otherDevice: await stateOf(ids.otherDevice),
  }).toEqual({
    admitted: "revoked",
    dispatching: "revoked",
    unknown: "revoked",
    running: "background-running",
    completed: "completed",
    olderGeneration: "admitted",
    otherProvider: "dispatching",
    otherDevice: "started-or-unknown",
  });
});

it("a revoked launch without an exact ref ends its task and frees its maxTasks slot", async () => {
  const f = await intentDevice();
  const intents = k.app.get(SandboxOperationIntents);
  const store = k.app.get(BackgroundTaskStore);
  const dead = randomUUID();
  // a crashed holder's dispatched start, and an admitted one of a resumed generation
  const dispatched = await seedIntent(f, {
    holder: dead,
    generation: "1",
    state: "dispatching",
    method: "backgroundStart",
  });
  const admitted = await seedIntent(f, {
    generation: "2",
    state: "admitted",
    method: "backgroundStart",
  });
  const t1 = await launchingTask(f, dispatched, "dispatched");
  const t2 = await launchingTask(f, admitted, "pending");
  expect(await store.countRunning(f.conversationId)).toBe(2);
  await intents.revokeHolders(f.deviceId, [dead]);
  await intents.revokeIncarnation(f.deviceId, { provider: LOCAL_PROVIDER, generation: "2" });
  // the exact revokes are acknowledged (the device confirmed): the tasks stay ended
  await intents.acknowledgeRevocation(dispatched);
  await intents.acknowledgeRevocation(admitted);
  expect(await store.countRunning(f.conversationId)).toBe(0);
  for (const id of [t1, t2]) {
    const task = await store.get(id);
    expect(task).toMatchObject({ status: "lost", launchState: "terminal" });
    expect(task?.lostReason).toMatch(/revoked/);
    expect(task?.finishedAt).toBeInstanceOf(Date);
  }
});

it("a crashed holder's revocation survives a failed inline revoke: the owed job revokes its admitted Bash and the device gets the exact revoke", async () => {
  const original = k.app.get(SandboxProviders).forName(LOCAL_PROVIDER);
  const redis = new Redis(rd.url);
  try {
    await crashedHolderScenario(redis);
  } finally {
    vi.restoreAllMocks();
    if (original) k.app.get(SandboxProviders).register(original);
    redis.disconnect();
  }
});

async function crashedHolderScenario(redis: Redis) {
  const f = await localDevice();
  const sandbox = k.app.get(SandboxService);
  // the first holder makes and binds the instance, then leaves
  await sandbox.ensureRunning(f.ctx, signal());
  const instance = await sandbox.currentInstance(f.deviceId);
  if (!instance) throw new Error("expected the running instance");
  // a replica crashed holding an admitted Bash: its holder record stays, its lease is gone
  const dead = randomUUID();
  const operationId = await admittedBash(f, dead, String(instance.createdAt.getTime()));
  await redis.hset(`capk:sandbox-holders:${f.deviceId}`, dead, Date.now() + 600_000);
  await redis.pexpire(`capk:sandbox-holders:${f.deviceId}`, 600_000);
  // the revocation fails once on a database error (the inline one or the job's, whichever
  // runs first); the other delivers it
  const intents = k.app.get(SandboxOperationIntents);
  const revokeHolders = intents.revokeHolders.bind(intents);
  let failed = 0;
  const calls: string[][] = [];
  vi.spyOn(intents, "revokeHolders").mockImplementation(async (deviceId, tokens) => {
    calls.push([...tokens]);
    if (failed++ === 0) throw new Error("Connection terminated unexpectedly");
    return revokeHolders(deviceId, tokens);
  });

  const outbox = k.app.get(OutboxService);
  const add = outbox.add.bind(outbox);
  const owed: string[] = [];
  vi.spyOn(outbox, "add").mockImplementation(async (job) => {
    owed.push(job.jobId);
    return add(job);
  });

  // the next holder takes over
  await sandbox.ensureRunning(f.ctx, signal());
  // the record is forgotten only once the revocation is owed
  expect(await redis.hexists(`capk:sandbox-holders:${f.deviceId}`, dead)).toBe(0);

  await waitFor(
    async () => {
      const row = await db()
        .selectFrom("sandbox_operation_intents")
        .select(["state", "revoke_acknowledged"])
        .where("operation_id", "=", operationId)
        .executeTakeFirstOrThrow();
      return row.state === "revoked" && row.revoke_acknowledged;
    },
    30_000,
    "the dead holder's admitted Bash revoked and acknowledged",
  );
  expect(calls.length).toBeGreaterThanOrEqual(2);
  for (const c of calls) expect(c).toEqual([dead]);
  const revokes = f.frames.filter((x) => x.op === "revokeOperation");
  expect(revokes.length).toBeGreaterThanOrEqual(1);
  for (const r of revokes)
    expect(r.args).toEqual({ ref: { operationId, admitBeforeMs: expect.any(Number) } });
  // no broad kill ever reaches the device
  expect(f.frames.filter((x) => x.op === "killAll" || x.op === "killTagged")).toEqual([]);
  // the owed job was written under its deterministic id, and so was the operation revoke
  expect(owed).toContain(`${HOLDER_REVOKE}-${f.deviceId}-${dead}`);
  expect(owed).toContain(`sandbox-operation-revoke-${operationId}`);
}
