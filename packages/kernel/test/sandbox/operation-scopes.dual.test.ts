import { readFile } from "node:fs/promises";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { XactLock } from "../../src/infra/database/xact-lock.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import { createLogger } from "../../src/log.js";
import type { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { intersectPermissionScope } from "../../src/sandbox/operation-authority.js";
import {
  type OperationInvocation,
  operationIdFor,
  SandboxOperationIntents,
} from "../../src/sandbox/operation-intents.js";
import { OperationPayloads } from "../../src/sandbox/operation-payloads.js";
import { PermissionAuthorityEpochStore } from "../../src/sandbox/permission-authority-epochs.js";
import { PermissionAuthorityLock } from "../../src/sandbox/permission-authority-lock.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { permissionScopeHash } from "../../src/sandbox/permission-facts.js";
import { PermissionTransitions } from "../../src/sandbox/permission-transitions.js";

let pg: TestContainer;
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const required = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) throw new Error("Missing test fixture");
  return value;
};
const pools: ReturnType<typeof createDb>[] = [];
const replicas: ReturnType<typeof replica>[] = [];
const subject = { orgId: "org", deviceId: "device", rootConversationId: "root" };
const ctx = {
  orgId: "org",
  deviceId: "device",
  holderConversationId: "root",
  actor: { accountId: "owner", conversationId: "root", runId: "run" },
};
const instance = { provider: "fake", providerVersion: "1", generation: "1" };
const invocation = (): OperationInvocation => ({
  claim: {
    orgId: "org",
    conversationId: "root",
    rootId: "root",
    runId: "run",
    executionId: "execution-1",
  },
  callId: "call",
  ordinal: 0,
  deadlineMs: Date.now() + 60000,
});
function replica(pool: ReturnType<typeof createDb>) {
  const log = createLogger("error"),
    host = new TransactionHost(pool, log),
    db = new KernelDb(pool, host);
  const lock = new PermissionAuthorityLock(db, host, new XactLock(db, host));
  const epochs = new PermissionAuthorityEpochStore(db, host, lock);
  // This boundary test isolates durable admission. Live fact resolution is covered by permission-wiring.
  const authority = {
    resolve: async () => {
      await lock.acquire(subject, { kind: "admit" });
      const vector = await epochs.readLocked(subject);
      return intersectPermissionScope({
        operationId: "shape-only",
        admitBeforeMs: Date.now() + 60000,
        deviceId: "device",
        rootConversationId: "root",
        profileRevision: required(vector.root),
        ceilingRevision: permissionScopeHash(vector),
        profile: "approve-for-me",
        actor: ctx.actor,
        tag: "shape-only",
        workingRoot: "/work",
        readRoots: ["/work"],
        writeRoots: ["/work"],
        allowedHosts: [],
        network: "none",
        boundary: "operation",
        outsideSandboxCeiling: false,
      });
    },
  } as unknown as SandboxOperationAuthority;
  authority.resolveInvocation = async (ctx, operation, _call, signal) => ({
    scope: await authority.resolve(ctx, operation, signal),
    permissionGrantId: null,
    grantedHosts: [],
    executionGrants: null,
  });
  const outbox = new OutboxService(host, db, async () => {});
  const transitions = new PermissionTransitions(
    db,
    host,
    lock,
    new EventLog(db, { publish: async () => {} }, log, outbox, host),
    outbox,
  );
  return {
    host,
    db,
    lock,
    epochs,
    ceilings: new PermissionCeilingWrites(transitions, db, host, lock, epochs, outbox),
    intents: new SandboxOperationIntents(
      db,
      host,
      lock,
      epochs,
      authority,
      outbox,
      new OperationPayloads(db, host),
    ),
  };
}
beforeAll(async () => {
  pg = await startTestPostgres();
  pools.push(createDb(pg.url, 5), createDb(pg.url, 5));
  const pool = required(pools[0]);
  await sql`create schema capybara`.execute(pool);
  await sql`create table capybara.orgs(id text primary key, settings jsonb); create table capybara.deployment_settings(key text primary key,value jsonb); create table capybara.devices(id text primary key,org_id text,source text,mode text,owner_full_access boolean,outer_network jsonb,network_mode text,network_hosts jsonb not null default '[]',deleted_at timestamptz); create table capybara.device_instances(device_id text primary key, provider text,created_at timestamptz); create table capybara.device_machines(device_id text,org_id text,roots jsonb,revoked_at timestamptz); create table capybara.conversations(id text primary key,org_id text,device_id text,permission_profile text,permission_consent jsonb,permission_revision integer default 0,parent_conversation_id text); create table capybara.runs(id text primary key,conversation_id text,execution_id text,trigger_account_id text,status text); create table capybara.conversation_events(conversation_id text,run_id text,type text,payload jsonb,seq bigint); create table capybara.permission_authority_epochs(kind text,id text,revision integer default 0,primary key(kind,id)); create table capybara.outbox(id bigserial,queue text,job_name text,job_id text,data jsonb,run_at timestamptz,org_id text,dead_at timestamptz); create unique index outbox_pending on capybara.outbox(queue,job_id) where dead_at is null`.execute(
    pool,
  );
  await sql`insert into capybara.orgs(id) values ('org'); insert into capybara.devices(id,org_id) values ('device','org'); insert into capybara.conversations(id,org_id) values ('root','org'); insert into capybara.runs values ('run','root','execution-1','owner','running'); insert into capybara.conversation_events values ('root','run','tool_call_started','{"callId":"call"}',1)`.execute(
    pool,
  );
  await sql
    .raw(
      `set search_path to capybara,public;${await readFile(new URL("../../src/migrations/0149_sandbox_operation_intents.sql", import.meta.url), "utf8")}`,
    )
    .execute(pool);
  await sql`alter table capybara.sandbox_operation_intents add column permission_grant_id uuid`.execute(
    pool,
  );
  await sql
    .raw(
      `set search_path to capybara,public;${await readFile(new URL("../../src/migrations/0151_starting_execution_grants.sql", import.meta.url), "utf8")}`,
    )
    .execute(pool);
  replicas.push(...pools.map(replica));
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.destroy()));
  await pg?.stop();
});
beforeEach(async () => {
  await sql`truncate capybara.sandbox_operation_payload_chunks,capybara.sandbox_operation_intents,capybara.permission_authority_epochs,capybara.outbox; update capybara.runs set execution_id='execution-1',status='running'`.execute(
    required(pools[0]),
  );
});
const a = () => required(replicas[0]),
  b = () => required(replicas[1]);
const pending = (i = invocation()) =>
  a().intents.pending(
    ctx,
    i,
    instance,
    "stat",
    { path: "/work/file" },
    "holder",
    new AbortController().signal,
  );
it("profile narrowing invalidates pending admission across replicas", async () => {
  const i = invocation();
  await pending(i);
  await b().host.run(async () => {
    await b().lock.acquire(subject, { kind: "write", level: "root" });
    await b().epochs.bumpLocked("root", "root", 0);
  });
  await expect(a().intents.admit(ctx, i)).rejects.toThrow("Authority changed");
  expect((await a().intents.read(operationIdFor(i))).state).toBe("pending");
  const resumed = await pending(i);
  expect(resumed.operation_id).toBe(operationIdFor(i));
  expect("profileRevision" in resumed.scope && resumed.scope.profileRevision).toBe(1);
  await a().intents.admit(ctx, i);
  expect((await a().intents.claimDispatch(ctx, i, "resumed-holder")).state).toBe("dispatching");
});
it("admitted grants survive profile changes; ceiling revocation covers dispatch before acknowledgement", async () => {
  const i = invocation();
  await pending(i);
  await a().intents.admit(ctx, i);
  await b().host.run(async () => {
    await b().lock.acquire(subject, { kind: "write", level: "root" });
    await b().epochs.bumpLocked("root", "root", 0);
  });
  const dispatched = await a().intents.claimDispatch(ctx, i, "holder");
  expect("profileRevision" in dispatched.scope && dispatched.scope.profileRevision).toBe(0);
  await b().host.run(async () => {
    await b().lock.acquire(
      { orgId: "org", deviceId: "device" },
      { kind: "write", level: "device" },
    );
    await b().ceilings.publishLocked({ orgId: "org", deviceId: "device" }, "device");
  });
  await a().intents.complete(dispatched.operation_id, i.claim.executionId, {
    size: 1,
    isDir: false,
  });
  expect((await a().intents.read(dispatched.operation_id)).state).toBe("revoked");
  const jobs = await a().db.selectFrom("outbox").select(["job_name", "job_id"]).execute();
  expect(jobs.map((j) => j.job_name).sort()).toEqual([
    "sandbox-operation-reconcile",
    "sandbox-operation-reconcile",
    "sandbox-operation-revoke",
  ]);
  expect(jobs.every((j) => !j.job_id.includes(":"))).toBe(true);
});
it("completed duplicates reuse bounded results and diverging inputs cannot get a new identity", async () => {
  const i = invocation();
  await pending(i);
  await a().intents.admit(ctx, i);
  await a().intents.claimDispatch(ctx, i, "holder");
  await a().intents.complete(operationIdFor(i), i.claim.executionId, { size: 9, isDir: false });
  expect((await b().intents.claimDispatch(ctx, i, "holder")).result).toEqual({
    size: 9,
    isDir: false,
  });
  await expect(
    b().intents.pending(
      ctx,
      i,
      instance,
      "stat",
      { path: "/other" },
      "holder",
      new AbortController().signal,
    ),
  ).rejects.toThrow("different input");
});
it("unknown effects require the current new run claim and preserve operation identity", async () => {
  const i = invocation();
  await pending(i);
  await a().intents.admit(ctx, i);
  await a().intents.claimDispatch(ctx, i, "holder");
  await a().intents.unknown(operationIdFor(i));
  await expect(b().intents.claimDispatch(ctx, i, "holder")).rejects.toThrow("already dispatched");
  await expect(
    b().intents.claimReconciliation(ctx, i, instance, "stat", { path: "/work/file" }, "new-holder"),
  ).rejects.toThrow("newly claimed");
  await sql`update capybara.runs set execution_id='execution-2'`.execute(required(pools[1]));
  const next = { ...i, claim: { ...i.claim, executionId: "execution-2" } };
  await expect(a().intents.claimDispatch(ctx, i, "holder")).rejects.toThrow("no longer current");
  const recovered = await b().intents.claimReconciliation(
    ctx,
    next,
    instance,
    "stat",
    {
      path: "/work/file",
    },
    "new-holder",
  );
  expect(recovered.operation_id).toBe(operationIdFor(i));
  expect(recovered.outcome_unknown).toBe(true);
});
it("a forged call or failed run cannot obtain or recover dispatch authority", async () => {
  const i = invocation();
  await expect(pending({ ...i, callId: "model-supplied" })).rejects.toThrow(
    "no recorded tool invocation",
  );
  await pending(i);
  await a().intents.admit(ctx, i);
  await a().intents.claimDispatch(ctx, i, "holder");
  await sql`update capybara.runs set status='failed'`.execute(required(pools[1]));
  await expect(
    b().intents.claimReconciliation(
      ctx,
      { ...i, claim: { ...i.claim, executionId: "execution-2" } },
      instance,
      "stat",
      { path: "/work/file" },
      "new-holder",
    ),
  ).rejects.toThrow("no longer current");
});

import { KernelConfigSchema } from "../../src/config/schema.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { PermissionConfigPublication } from "../../src/sandbox/permission-config-publication.js";

it("publishes config by CAS and rejects stale replicas and stale publication order", async () => {
  const config = KernelConfigSchema.parse({
    db: { url: "postgres://unused/test" },
    redis: { url: "redis://unused" },
    masterKey: Buffer.alloc(32, 1).toString("base64"),
  });
  const c1 = new KernelConfigService({ config, env: {} }, createLogger("error")),
    c2 = new KernelConfigService({ config, env: {} }, createLogger("error"));
  const p1 = new PermissionConfigPublication(a().db, a().host, c1, a().ceilings),
    p2 = new PermissionConfigPublication(b().db, b().host, c2, b().ceilings);
  await p1.initialize();
  await p2.initialize();
  const active = await a()
    .db.selectFrom("permission_config_publication")
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(active).toHaveProperty("projection", {
    version: 3,
    outsideSandbox: { kind: "deployment-setting" },
    network: { default: { kind: "deployment-setting" }, ceiling: { kind: "deployment-setting" } },
    egress: config.sandbox.limits.egress,
    orgHosts: config.sandbox.limits.orgHosts,
    allowHosts: [...new Set(config.sandbox.limits.allowHosts)].sort(),
  });
  expect(JSON.stringify(active)).not.toContain(config.masterKey);
  const next = structuredClone(config);
  next.devices.outsideSandbox = "off";
  const i = invocation();
  await pending(i);
  const ready = barrier(),
    release = barrier(),
    attempt = barrier();
  const writer = a().ceilings.lock.bind(a().ceilings),
    reader = b().lock.acquire.bind(b().lock);
  const writerSpy = vi.spyOn(a().ceilings, "lock").mockImplementation(async (subject, level) => {
    await writer(subject, level);
    ready.resolve();
    await release.promise;
  });
  const readerSpy = vi.spyOn(b().lock, "acquire").mockImplementation(async (subject, intent) => {
    attempt.resolve();
    return reader(subject, intent);
  });
  const publishing = p1.publish(config, next);
  await ready.promise;
  const admission = b().intents.admit(ctx, i);
  const rejected = expect(admission).rejects.toThrow("Authority changed");
  try {
    await attempt.promise;
    release.resolve();
    await Promise.all([publishing, rejected]);
  } finally {
    release.resolve();
    writerSpy.mockRestore();
    readerSpy.mockRestore();
  }

  await p2.publish(config, next);
  await expect(p2.assertCurrent()).rejects.toThrow("has not applied");
  const stale = structuredClone(config);
  stale.devices.outsideSandbox = "allowed";
  await expect(p2.publish(config, stale)).rejects.toThrow("changed on another replica");
  const row = await a()
    .db.selectFrom("permission_authority_epochs")
    .select("revision")
    .where("kind", "=", "platform")
    .executeTakeFirstOrThrow();
  expect(row.revision).toBe(1);
});
it("ceiling widening preserves admitted grants and still invalidates pending authority", async () => {
  const i = invocation();
  await pending(i);
  await a().intents.admit(ctx, i);
  await b().host.run(async () => {
    await b().ceilings.lock({ orgId: "org", deviceId: "device" }, "device");
    await b().ceilings.publishLocked({ orgId: "org", deviceId: "device" }, "device", false);
  });
  expect((await a().intents.claimDispatch(ctx, i, "holder")).state).toBe("dispatching");
});
