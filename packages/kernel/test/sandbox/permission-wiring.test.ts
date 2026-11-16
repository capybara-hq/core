import { randomUUID } from "node:crypto";
import { DEFAULT_SANDBOX_ROOTS } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { ModulesContainer } from "@nestjs/core";
import { Redis } from "ioredis";
import { sql } from "kysely";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { ConversationsModule } from "../../src/conversations/conversations.module.js";
import { PermissionProfileStore } from "../../src/conversations/permission-profile-store.js";
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import { DevicesModule } from "../../src/devices/devices.module.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { NetworkGrants } from "../../src/local-devices/network-grants.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { OperationAuthorityModule } from "../../src/sandbox/operation-authority.module.js";
import { PermissionAuthorityEpochStore } from "../../src/sandbox/permission-authority-epochs.js";
import { PermissionAuthorityLock } from "../../src/sandbox/permission-authority-lock.js";
import { PermissionFacts, permissionScopeHash } from "../../src/sandbox/permission-facts.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { SandboxModule } from "../../src/sandbox/sandbox.module.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let redis: Redis;
let accounts: AccountsService;
let members: MembersService;
let owner: Account;

const PW = "correct horse battery";

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      // API-only app: worker execution must not race the HTTP assertions.
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  const db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
  members = testMembers(db);
});
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await redis.flushdb();
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
});

type Req = ReturnType<typeof asUser>;

async function session(login: string): Promise<Req> {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

async function createOrg(req: Req): Promise<string> {
  const res = await req({
    method: "POST",
    url: "/api/v1/orgs",
    payload: { name: `Acme-${randomUUID()}` },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { org: { id: string } }).org.id;
}

async function memberSession(orgId: string, login: string, role: "admin" | "member" | "guest") {
  const a = await accounts.createLocal({ login, password: PW, displayName: login });
  await members.add(orgId, a.id, role, owner.id);
  return { account: a, req: await session(login) };
}

const definition = {
  name: "Helper",
  instructions: "Be helpful.",
  model: { provider: "model-fake", model: "fake-1" },
};

async function createAgent(req: Req, orgId: string, visibility = "org"): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: { definition, visibility },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

type ConvJson = { id: string; agentId: string; accountId: string; lastSeq: number };

async function createConv(req: Req, orgId: string, agentId: string): Promise<ConvJson> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations`,
    payload: { agentId },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { conversation: ConvJson }).conversation;
}

async function localDevice(orgId: string, name = "Laptop") {
  const providers = k.app.get(SandboxProviders),
    local = providers.forName("@local");
  if (!local) throw new Error("Local provider was not registered");
  const impl = Object.create(local.impl);
  const neverProbe = async () => {
    throw new Error("Read-only permission API attempted a provider operation");
  };
  Object.assign(impl, {
    operation: neverProbe,
    revokeOperation: neverProbe,
    permissionSupport: neverProbe,
  });
  providers.register({ plugin: "@permission-test", impl });
  const db = kernelDb(raw);
  const id = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: owner.id,
      source: "local",
      provider: "@permission-test",
      name,
    })
    .execute();
  await db
    .insertInto("device_machines")
    .values({
      org_id: orgId,
      device_id: id,
      account_id: owner.id,
      credential_hash: randomUUID(),
      name: "Laptop",
      os: "darwin",
      arch: "arm64",
      features: ["mode", "projects"],
      roots: JSON.stringify({ workspace: "/work" }),
      home: "/home/owner",
      local_policy: JSON.stringify({ mode: "auto", allowedDomains: [] }),
    })
    .execute();
  return id;
}

describe("permission reader behavior", () => {
  it("resolves one registry, grant store and authority from an acyclic lower module graph", () => {
    const modules = k.app.get(ModulesContainer);
    for (const token of [
      SandboxProviders,
      NetworkGrants,
      SandboxOperationAuthority,
      PermissionFacts,
      PermissionProfileStore,
      PermissionAuthorityLock,
      PermissionAuthorityEpochStore,
    ]) {
      const instances = [...modules.values()].flatMap((m) => {
        const provider = m.providers.get(token);
        return provider ? [provider.instance] : [];
      });
      expect(instances).toHaveLength(1);
      expect(instances[0]).toBe(k.app.get(token));
    }
    const visited = new Set<unknown>();
    const walk = (module: object) => {
      if (visited.has(module)) return;
      visited.add(module);
      expect([SandboxModule, DevicesModule, ConversationsModule]).not.toContain(module);
      for (const child of Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) ?? []) walk(child);
    };
    walk(OperationAuthorityModule);
    expect(k.app.get(SandboxProviders).forName("@local")).toBeDefined();
  });
  it("keeps profile views, authority roots and hashes aligned without lifecycle calls", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const root = await createConv(req, orgId, agentId);
    const child = await createConv(req, orgId, agentId);
    const deviceId = await localDevice(orgId);
    const db = kernelDb(raw);
    await db
      .updateTable("conversations")
      .set({ device_id: deviceId })
      .where("id", "=", root.id)
      .execute();
    await db
      .updateTable("conversations")
      .set({ kind: "subagent", parent_conversation_id: root.id })
      .where("id", "=", child.id)
      .execute();
    await db
      .insertInto("conversation_events")
      .values([
        {
          conversation_id: root.id,
          seq: 1,
          type: "device_paths",
          payload: JSON.stringify({ roots: { workspace: "/root-recorded" } }),
        },
        {
          conversation_id: child.id,
          seq: 1,
          type: "device_paths",
          payload: JSON.stringify({ roots: { workspace: "/child-recorded" } }),
        },
      ])
      .execute();
    const sandbox = k.app.get(SandboxService);
    const spies: MockInstance[] = [
      vi.spyOn(sandbox, "withSandbox"),
      vi.spyOn(sandbox, "ifRunning"),
    ];
    const impl = k.app.get(SandboxProviders).forName("@permission-test")?.impl;
    if (!impl) throw new Error("Missing registered provider");
    if (!impl) throw new Error("Permission fixture provider is not registered");
    for (const name of [
      "create",
      "createFileSystem",
      "resume",
      "suspend",
      "destroy",
      "operation",
      "permissionSupport",
      "revokeOperation",
    ] as const)
      spies.push(vi.spyOn(impl, name));
    try {
      const facts = k.app.get(PermissionFacts);
      const store = k.app.get(PermissionProfileStore);
      const profiles = k.app.get(PermissionProfilesService);
      const authority = k.app.get(SandboxOperationAuthority);
      const ctx = {
        orgId,
        deviceId,
        holderConversationId: child.id,
        actor: { accountId: owner.id, conversationId: child.id },
      };
      const view = await profiles.get(orgId, child.id, owner.id);
      expect(
        await facts.view(orgId, owner.id, await store.readOwnedRoot(orgId, child.id, owner.id)),
      ).toEqual(view);
      expect((await store.readRoot(orgId, child.id)).id).toBe(root.id);
      const scope = await authority.resolve(ctx, "readFile", new AbortController().signal);
      expect(scope).toMatchObject({
        rootConversationId: root.id,
        profile: "approve-for-me",
        filesystem: {
          kind: "scoped",
          readRoots: ["/child-recorded"],
          writeRoots: ["/child-recorded"],
        },
      });
      expect(scope.ceilingRevision).toBe(
        permissionScopeHash({
          scopeRevision: view.scopeRevision,
          vector: { platform: 0, org: 0, device: 0, root: 0 },
        }),
      );
      await db.deleteFrom("conversation_events").where("conversation_id", "=", child.id).execute();
      expect(
        (await authority.resolve(ctx, "readFile", new AbortController().signal)).filesystem,
      ).toMatchObject({ readRoots: ["/root-recorded"] });
      await expect(
        authority.resolve(
          { ...ctx, actor: { ...ctx.actor, conversationId: root.id } },
          "readFile",
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "Operation actor does not match its conversation",
      });
      const other = await memberSession(orgId, "other", "member");
      await expect(
        authority.resolve(
          { ...ctx, actor: { ...ctx.actor, accountId: other.account.id } },
          "readFile",
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "conversation.not_found" });
      await db
        .updateTable("devices")
        .set({ deleted_at: new Date() })
        .where("id", "=", deviceId)
        .execute();
      await expect(
        authority.resolve(ctx, "readFile", new AbortController().signal),
      ).rejects.toMatchObject({
        code: "device.not_found",
        message: "This device does not exist or was deleted.",
      });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
  it("prefers the holder's latest device paths, then the root's, and ignores working directories", async () => {
    const f = await workingFixture();
    await f.event(f.root.id, 2, "device_paths", { roots: { workspace: "/home/root/work" } });
    await f.event(f.root.id, 1, "device_paths", { roots: { workspace: "/wrong-old-root" } });
    expect((await f.read()).workspace).toBe("/home/root/work");
    await f.event(f.child.id, 4, "device_paths", { roots: { workspace: "/Users/child/work" } });
    await f.event(f.child.id, 3, "device_paths", { roots: { workspace: "/wrong-old-child" } });
    await f.event(f.child.id, 5, "working_directory", { path: "/not-a-device-workspace" });
    expect((await f.read()).workspace).toBe("/Users/child/work");
    expect(
      await k.app.get(PermissionFacts).readWorkingFacts({
        orgId: f.orgId,
        rootConversationId: f.root.id,
        holderConversationId: f.child.id,
        deviceId: f.deviceId,
      }),
    ).toEqual(await f.read());
  });
  it("reads active machine roots without events and falls back to defaults after revocation", async () => {
    const f = await workingFixture();
    expect(await f.read()).toEqual({ workspace: "/work", home: "/home/owner", project: null });
    await f.db
      .updateTable("device_machines")
      .set({ revoked_at: new Date() })
      .where("device_id", "=", f.deviceId)
      .execute();
    expect((await f.read()).workspace).toBe(DEFAULT_SANDBOX_ROOTS.workspace);
    await f.event(f.root.id, 1, "device_paths", { roots: { workspace: "/home/root/work" } });
    expect((await f.read()).workspace).toBe("/home/root/work");
  });
  it("uses the absolute reported home, otherwise the resolved workspace home, never the project's", async () => {
    const f = await workingFixture();
    await f.event(f.child.id, 1, "device_paths", { roots: { workspace: "/Users/child/work" } });
    // Fixture setup intentionally writes the otherwise immutable project binding.
    await sql`UPDATE capybara.conversations SET project_name = 'project',
      project_path = ${"/home/project/code"} WHERE id = ${f.root.id}`.execute(raw);
    await f.event(f.root.id, 1, "project_root", { root: "/home/project/code" });
    expect((await f.read()).home).toBe("/home/owner");
    await f.db
      .updateTable("device_machines")
      .set({ home: "relative-home" })
      .where("device_id", "=", f.deviceId)
      .execute();
    expect((await f.read()).home).toBe("/Users/child");
    await f.db
      .deleteFrom("conversation_events")
      .where("conversation_id", "=", f.child.id)
      .execute();
    expect((await f.read()).home).toBeNull();
  });
  it("uses only bound root project snapshots and preserves absent, invalid and unavailable states", async () => {
    const f = await workingFixture();
    await f.event(f.root.id, 1, "project_root", { root: "/project" });
    expect((await f.read()).project).toBeNull();
    // Fixture setup intentionally writes the otherwise immutable project binding.
    await sql`UPDATE capybara.conversations SET project_name = 'project',
      project_path = ${"/project"} WHERE id = ${f.root.id}`.execute(raw);
    expect((await f.read()).project).toEqual({ root: "/project", unavailable: false });
    await f.event(f.root.id, 2, "project_root", { root: "/project", unavailable: "missing" });
    expect((await f.read()).project).toEqual({ root: "/project", unavailable: true });
    await f.event(f.root.id, 3, "project_root", { unavailable: "missing" });
    expect((await f.read()).project).toBeNull();
    await f.db.deleteFrom("conversation_events").where("conversation_id", "=", f.root.id).execute();
    expect((await f.read()).project).toBeNull();
    expect(await k.app.get(PermissionFacts).workingProject(randomUUID(), f.root.id)).toBeNull();
  });
});

async function workingFixture() {
  const req = await session("owner");
  const orgId = await createOrg(req);
  const agentId = await createAgent(req, orgId);
  const root = await createConv(req, orgId, agentId);
  const child = await createConv(req, orgId, agentId);
  const deviceId = await localDevice(orgId);
  const db = kernelDb(raw);
  const read = () =>
    k.app.get(ConversationDevices).workingFacts(orgId, root.id, child.id, deviceId);
  const event = async (id: string, seq: number, type: string, payload: object) => {
    await db
      .insertInto("conversation_events")
      .values({ conversation_id: id, seq, type, payload: JSON.stringify(payload) })
      .execute();
  };
  return { orgId, root, child, deviceId, db, read, event };
}

it("owner browsing resolves bounded authority without a conversation and denies another owner or org", async () => {
  const req = await session("owner"),
    orgId = await createOrg(req),
    deviceId = await localDevice(orgId);
  const service = k.app.get(SandboxOperationAuthority);
  const before = await kernelDb(raw).selectFrom("conversations").select("id").execute();
  const scope = await service.resolveBrowse(
    { orgId, deviceId, accountId: owner.id },
    new AbortController().signal,
  );
  expect(scope.accountId).toBe(owner.id);
  expect(scope.readRoots.length).toBeGreaterThan(0);
  const other = await accounts.createLocal({
    login: "other-browse",
    password: PW,
    displayName: "Other",
  });
  await members.add(orgId, other.id, "member", owner.id);
  await expect(
    service.resolveBrowse({ orgId, deviceId, accountId: other.id }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "device.not_found" });
  const otherOrg = await createOrg(req);
  await expect(
    service.resolveBrowse(
      { orgId: otherOrg, deviceId, accountId: owner.id },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "device.not_found" });
  expect(await kernelDb(raw).selectFrom("conversations").select("id").execute()).toEqual(before);
});

import {
  type SandboxOperationScope,
  type SandboxProvider,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { type ExecutionClaim, RunExecution } from "../../src/runtime/run-execution.js";
import { SandboxLeases } from "../../src/sandbox/leases.js";
import { SandboxOperationIntents } from "../../src/sandbox/operation-intents.js";
import { SandboxOperationReconcileJob } from "../../src/sandbox/operation-reconcile.job.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import {
  PermissionRuntimeReports,
  readRuntimeReport,
} from "../../src/sandbox/permission-runtime-reports.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function operationFixture(impl: Partial<SandboxProvider> = {}) {
  const f = await workingFixture(),
    runId = randomUUID(),
    executionId = randomUUID(),
    callId = randomUUID();
  await f.db
    .updateTable("conversations")
    .set({ device_id: f.deviceId })
    .where("id", "=", f.root.id)
    .execute();
  await f.db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: f.root.id,
      execution_id: executionId,
      trigger_account_id: owner.id,
      status: "running",
      agent_version: 1,
      trigger_seq: 0,
    })
    .execute();
  await f.db
    .insertInto("conversation_events")
    .values({
      conversation_id: f.root.id,
      run_id: runId,
      seq: 1,
      type: "tool_started",
      payload: JSON.stringify({ callId, toolKey: "Read" }),
    })
    .execute();
  await f.db
    .updateTable("conversations")
    .set({ last_seq: 1 })
    .where("id", "=", f.root.id)
    .execute();
  const roots = { ...DEFAULT_SANDBOX_ROOTS, workspace: "/work" };
  await f.db
    .insertInto("device_instances")
    .values({
      device_id: f.deviceId,
      org_id: f.orgId,
      provider: "@permission-test",
      status: "running",
      handle: JSON.stringify({ id: f.deviceId, roots }),
      created_at: new Date(1700000000000),
      fs_status: "ready",
      had_instance: true,
      instance_limits: JSON.stringify({
        mode: "auto",
        network: { kind: "open-public", hosts: [] },
      }),
    })
    .execute();
  const scopes: SandboxOperationScope[] = [];
  const provider = {
    async permissionSupport() {
      return {
        version: 1,
        restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
        fullAccess: true,
        background: false,
      };
    },
    async revokeOperation() {},
    async operation(_h: unknown, scope: SandboxOperationScope, signal: AbortSignal) {
      scopes.push(scope);
      return {
        async stat() {
          signal.throwIfAborted();
          return { size: 1, isDir: false };
        },
      };
    },
    ...impl,
  } as unknown as SandboxProvider;
  k.app
    .get(SandboxProviders)
    .register({ plugin: "@permission-test", version: "test-1", impl: provider });
  const claim: ExecutionClaim = {
    orgId: f.orgId,
    conversationId: f.root.id,
    rootId: f.root.id,
    runId,
    executionId,
  };
  const ctx = {
    orgId: f.orgId,
    deviceId: f.deviceId,
    holderConversationId: f.root.id,
    actor: { accountId: owner.id, conversationId: f.root.id, runId },
  };
  return {
    ...f,
    roots,
    claim,
    ctx,
    scopes,
    invocation: { claim, callId, deadlineMs: Date.now() + 30000 },
  };
}
it("retains the caller lease and signal, and refreshes scope inside the same held callback", async () => {
  const f = await operationFixture(),
    controller = new AbortController();
  await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () =>
      k.app.get(SandboxService).withOperations(
        f.ctx,
        f.invocation,
        async (h, p, _info, signal) => {
          expect(await k.app.get(SandboxLeases).tryExclusive(f.deviceId)).toBeNull();
          await p.stat(h, "/work/a", signal);
          await k.app.get(TransactionHost).run(async () => {
            await k.app
              .get(PermissionAuthorityLock)
              .acquire(
                { orgId: f.orgId, deviceId: f.deviceId, rootConversationId: f.root.id },
                { kind: "write", level: "root" },
              );
            await k.app.get(PermissionAuthorityEpochStore).bumpLocked("root", f.root.id, 0);
            await k.app
              .get(KernelDb)
              .updateTable("conversations")
              .set({ permission_profile: "request-approval", permission_revision: 1 })
              .where("id", "=", f.root.id)
              .execute();
          });
          await p.stat(h, "/work/b", signal);
          controller.abort(new Error("caller ended"));
          expect(signal.aborted).toBe(true);
        },
        controller.signal,
      ),
  );
  expect(f.scopes.map((s) => s.profile)).toEqual(["approve-for-me", "request-approval"]);
  const jobs = await f.db
    .selectFrom("outbox")
    .select("job_name")
    .where("org_id", "=", f.orgId)
    .execute();
  expect(
    jobs.filter((j) => j.job_name.startsWith("sandbox-operation")).map((j) => j.job_name),
  ).toEqual(["sandbox-operation-reconcile", "sandbox-operation-reconcile"]);
});
it("revocation before launch acknowledgement keeps the effect cancelled and the ledger terminal", async () => {
  const entered = barrier(),
    release = barrier();
  let cancelled = false,
    effects = 0;
  const f = await operationFixture({
    async operation() {
      return {
        async stat() {
          entered.resolve();
          await release.promise;
          if (cancelled) throw new SandboxScopeDeniedError("revoked before launch");
          effects++;
          return { size: 1, isDir: false };
        },
      } as never;
    },
    async revokeOperation() {
      cancelled = true;
      release.resolve();
    },
  });
  const work = k.app
    .get(SandboxService)
    .withOperations(
      f.ctx,
      f.invocation,
      (h, p, _i, signal) => p.stat(h, "/work/a", signal),
      new AbortController().signal,
    );
  const verdict = work.then(
    () => null,
    (error) => error,
  );
  await Promise.race([
    entered.promise,
    verdict.then((error) => {
      throw error ?? new Error("Operation ended before launch readiness");
    }),
  ]);
  await k.app.get(TransactionHost).run(async () => {
    const ceiling = k.app.get(PermissionCeilingWrites);
    await ceiling.lock({ orgId: f.orgId, deviceId: f.deviceId }, "device");
    await ceiling.publishLocked({ orgId: f.orgId, deviceId: f.deviceId }, "device");
  });
  const row = await f.db
    .selectFrom("sandbox_operation_intents")
    .selectAll()
    .where("run_id", "=", f.claim.runId)
    .executeTakeFirstOrThrow();
  const job = new SandboxOperationReconcileJob(
    k.app.get(SandboxOperationIntents),
    k.app.get(KernelDb),
    k.app.get(SandboxProviders),
  );
  await job.revoke(row.operation_id);
  expect(await verdict).toBeInstanceOf(SandboxScopeDeniedError);
  expect(effects).toBe(0);
  expect((await k.app.get(SandboxOperationIntents).read(row.operation_id)).state).toBe("revoked");
});
it("runtime report reads never probe and invalidate every provenance dimension", async () => {
  const f = await operationFixture();
  const reports = k.app.get(PermissionRuntimeReports),
    tx = k.app.get(TransactionHost),
    ceilings = k.app.get(PermissionCeilingWrites);
  const identity = {
    runtimeHash: "a".repeat(64),
    helperHash: "b".repeat(64),
    imageFingerprint: "c".repeat(64),
    instanceGeneration: "1700000000000",
  };
  const support = {
    version: 1 as const,
    restricted: null,
    fullAccess: false,
    background: false,
    unavailableReason: "per-instance proof pending",
  };
  expect((await readRuntimeReport(f.db, f.deviceId, "@permission-test", "test-1")).state).toBe(
    "unprobed",
  );
  await expect(
    tx.run(() => reports.record(f.deviceId, "@permission-test", "test-1", identity, support)),
  ).rejects.toThrow("matching authority lock");
  await tx.run(async () => {
    await ceilings.lock({ orgId: f.orgId, deviceId: f.deviceId }, "device");
    await reports.record(f.deviceId, "@permission-test", "test-1", identity, support);
  });
  expect((await readRuntimeReport(f.db, f.deviceId, "@permission-test", "test-1")).state).toBe(
    "unsupported",
  );
  expect((await readRuntimeReport(f.db, f.deviceId, "@permission-test", "test-2")).state).toBe(
    "unprobed",
  );
  for (const key of ["runtimeHash", "helperHash", "imageFingerprint"] as const) {
    await f.db
      .updateTable("device_instances")
      .set({ permission_runtime_identity: JSON.stringify({ ...identity, [key]: "d".repeat(64) }) })
      .where("device_id", "=", f.deviceId)
      .execute();
    expect((await readRuntimeReport(f.db, f.deviceId, "@permission-test", "test-1")).state).toBe(
      "unprobed",
    );
  }
  await f.db
    .updateTable("device_instances")
    .set({
      permission_runtime_identity: JSON.stringify(identity),
      created_at: new Date(1700000000001),
    })
    .where("device_id", "=", f.deviceId)
    .execute();
  expect((await readRuntimeReport(f.db, f.deviceId, "@permission-test", "test-1")).state).toBe(
    "unprobed",
  );
});
it("operation admission avoids the inherited conversation-row fence while a profile writer holds authority", async () => {
  const f = await operationFixture(),
    writerReady = barrier(),
    admissionAttempt = barrier();
  const authority = k.app.get(PermissionAuthorityLock),
    acquire = authority.acquire.bind(authority);
  const writer = k.app.get(TransactionHost).run(async () => {
    await acquire(
      { orgId: f.orgId, deviceId: f.deviceId, rootConversationId: f.root.id },
      { kind: "write", level: "root" },
    );
    writerReady.resolve();
    await admissionAttempt.promise;
    await k.app
      .get(KernelDb)
      .updateTable("conversations")
      .set({ permission_profile: "request-approval", permission_revision: 1 })
      .where("id", "=", f.root.id)
      .execute();
    await k.app.get(PermissionAuthorityEpochStore).bumpLocked("root", f.root.id, 0);
  });
  await writerReady.promise;
  const spy = vi.spyOn(authority, "acquire").mockImplementation(async (subject, intent) => {
    if (intent.kind === "admit") admissionAttempt.resolve();
    return acquire(subject, intent);
  });
  try {
    const work = k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () =>
        k.app
          .get(SandboxService)
          .withOperations(
            f.ctx,
            f.invocation,
            (h, p, _i, signal) => p.stat(h, "/work/file", signal),
            new AbortController().signal,
          ),
    );
    await Promise.all([writer, work]);
    expect(f.scopes[0]?.profile).toBe("request-approval");
  } finally {
    spy.mockRestore();
    admissionAttempt.resolve();
  }
});
it("a stale execution claim cannot dispatch and disconnected revocation remains durably owed", async () => {
  const f = await operationFixture(),
    service = k.app.get(SandboxService);
  await f.db
    .updateTable("runs")
    .set({ execution_id: randomUUID() })
    .where("id", "=", f.claim.runId)
    .execute();
  await expect(
    service.withOperations(
      f.ctx,
      f.invocation,
      (h, p, _i, signal) => p.stat(h, "/work/file", signal),
      new AbortController().signal,
    ),
  ).rejects.toThrow("no longer current");
  expect(f.scopes).toHaveLength(0);
  await f.db
    .updateTable("runs")
    .set({ execution_id: f.claim.executionId })
    .where("id", "=", f.claim.runId)
    .execute();
  const intents = k.app.get(SandboxOperationIntents),
    i = { ...f.invocation, ordinal: 0 };
  const row = await intents.pending(
    f.ctx,
    i,
    { provider: "@permission-test", providerVersion: "test-1", generation: "1700000000000" },
    "stat",
    { path: "/work/file" },
    "old-holder",
    new AbortController().signal,
  );
  await intents.admit(f.ctx, i);
  await k.app.get(TransactionHost).run(async () => {
    const writes = k.app.get(PermissionCeilingWrites);
    await writes.lock({ orgId: f.orgId, deviceId: f.deviceId }, "device");
    await writes.publishLocked({ orgId: f.orgId, deviceId: f.deviceId }, "device");
  });
  k.app.get(SandboxProviders).register({
    plugin: "@permission-test",
    version: "test-1",
    impl: {
      async revokeOperation() {
        throw new Error("offline");
      },
    } as unknown as SandboxProvider,
  });
  await new SandboxOperationReconcileJob(
    intents,
    k.app.get(KernelDb),
    k.app.get(SandboxProviders),
  ).revoke(row.operation_id);
  const updated = await intents.read(row.operation_id);
  expect(updated.revoke_acknowledged).toBe(false);
  expect(updated.reconcile_attempt).toBe(1);
  const retry = await f.db
    .selectFrom("outbox")
    .select("job_id")
    .where("job_id", "=", `sandbox-operation-revoke-${row.operation_id}-1`)
    .executeTakeFirst();
  expect(retry).toBeDefined();
});
it("a newly acquired run claim and lease reconcile the same unknown ID without new effects", async () => {
  let effects = 0;
  const ids: string[] = [];
  const f = await operationFixture({
    async operation(_h, scope) {
      ids.push(scope.operationId);
      return {
        async stat() {
          if (effects === 0) {
            effects++;
            throw new Error("reply lost after effect");
          }
          throw new SandboxScopeDeniedError(
            "current authenticated grant no longer matches recorded hash",
          );
        },
      } as never;
    },
  });
  const service = k.app.get(SandboxService),
    call = (inv: typeof f.invocation) =>
      service.withOperations(
        f.ctx,
        inv,
        (h, p, _i, signal) => p.stat(h, "/work/file", signal),
        new AbortController().signal,
      );
  await expect(call(f.invocation)).rejects.toMatchObject({
    name: "SandboxOperationOutcomeUnknownError",
  });
  const claim = await k.app.get(RunExecution).claim(f.root.id, f.claim.runId, randomUUID());
  if (!claim) throw new Error("The replacement execution claim was not acquired");
  await expect(call({ ...f.invocation, claim })).rejects.toMatchObject({
    name: "SandboxOperationOutcomeUnknownError",
  });
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
  expect(effects).toBe(1);
  const row = await f.db
    .selectFrom("sandbox_operation_intents")
    .select("state")
    .where("run_id", "=", f.claim.runId)
    .executeTakeFirstOrThrow();
  expect(row.state).toBe("started-or-unknown");
});
it("trusted marker read, recheck and write use narrow preparation before the first native operation", async () => {
  const sequence: string[] = [],
    preparationIds: string[] = [];
  const f = await operationFixture({
    async prepare(_h, scope) {
      preparationIds.push(scope.operationId);
      expect(scope.purpose).toBe("skills");
      return {
        async readFile() {
          sequence.push("prepare-read");
          return null;
        },
        async writeFile() {
          sequence.push("prepare-write");
        },
        async stat() {
          return null;
        },
      };
    },
    async operation() {
      sequence.push("user");
      return {
        async stat() {
          return null;
        },
      } as never;
    },
  });
  await k.app.get(SandboxService).withOperations(
    f.ctx,
    {
      ...f.invocation,
      beforeUser: async (staging, info, signal) => {
        await staging.prepare("skills", [info.roots.skills], async (p, sig) => {
          expect(Object.keys(p).sort()).toEqual(["readFile", "stat", "writeFile"]);
          const path = `${info.roots.skills}/marker`;
          await p.readFile(path, { maxBytes: 100, signal: sig });
          const lease = await k.app.get(SandboxService).pathLease(f.deviceId, path, signal);
          try {
            await p.readFile(path, { maxBytes: 100, signal: sig });
            await p.writeFile(path, new Uint8Array([1]), sig);
          } finally {
            await lease.release();
          }
        });
      },
    },
    (h, p, _i, signal) => p.stat(h, "/work/file", signal),
    new AbortController().signal,
  );
  expect(sequence).toEqual(["prepare-read", "prepare-read", "prepare-write", "user"]);
  expect(new Set(preparationIds).size).toBe(3);
});
it("authority is read after waiting for the shared lease and gone after dispatch never gets a new ID retry", async () => {
  const f = await operationFixture(),
    leases = k.app.get(SandboxLeases),
    blocked = barrier();
  const exclusive = await leases.tryExclusive(f.deviceId);
  expect(exclusive).not.toBeNull();
  const shared = leases.tryShared.bind(leases),
    spy = vi.spyOn(leases, "tryShared").mockImplementation(async (...args) => {
      const r = await shared(...args);
      if (!r) blocked.resolve();
      return r;
    });
  const service = k.app.get(SandboxService),
    work = service.withOperations(
      f.ctx,
      f.invocation,
      (h, p, _i, signal) => p.stat(h, "/work/file", signal),
      new AbortController().signal,
    );
  try {
    await blocked.promise;
    await k.app.get(TransactionHost).run(async () => {
      const lock = k.app.get(PermissionAuthorityLock);
      await lock.acquire(
        { orgId: f.orgId, deviceId: f.deviceId, rootConversationId: f.root.id },
        { kind: "write", level: "root" },
      );
      await k.app
        .get(KernelDb)
        .updateTable("conversations")
        .set({ permission_profile: "request-approval", permission_revision: 1 })
        .where("id", "=", f.root.id)
        .execute();
      await k.app.get(PermissionAuthorityEpochStore).bumpLocked("root", f.root.id, 0);
    });
  } finally {
    spy.mockRestore();
    await exclusive?.release();
  }
  await work;
  expect(f.scopes[0]?.profile).toBe("request-approval");
  const sdk = await import("@capybara-hq/plugin-sdk");
  let calls = 0;
  const impl = k.app.get(SandboxProviders).forName("@permission-test")?.impl;
  if (!impl) throw new Error("Missing registered provider");
  k.app.get(SandboxProviders).register({
    plugin: "@permission-test",
    version: "test-1",
    impl: {
      ...impl,
      async operation() {
        return {
          async stat() {
            calls++;
            throw new sdk.SandboxGoneError("lost after dispatch");
          },
        } as never;
      },
    },
  });
  const next = { ...f.invocation, callId: randomUUID() };
  await f.db
    .insertInto("conversation_events")
    .values({
      conversation_id: f.root.id,
      run_id: f.claim.runId,
      seq: 2,
      type: "tool_started",
      payload: JSON.stringify({ callId: next.callId }),
    })
    .execute();
  await expect(
    service.withOperations(
      f.ctx,
      next,
      (h, p, _i, signal) => p.stat(h, "/work/file", signal),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ name: "SandboxOperationOutcomeUnknownError" });
  expect(calls).toBe(1);
});

it("expired payloads keep their consumed identity and cannot repeat an effect", async () => {
  const f = await operationFixture(),
    service = k.app.get(SandboxService),
    intents = k.app.get(SandboxOperationIntents);
  const read = () =>
    service.withOperations(
      f.ctx,
      f.invocation,
      (h, p, _i, signal) => p.stat(h, "/work/file", signal),
      new AbortController().signal,
    );
  await read();
  const row = await f.db
    .selectFrom("sandbox_operation_intents")
    .selectAll()
    .where("run_id", "=", f.claim.runId)
    .executeTakeFirstOrThrow();
  const job = new SandboxOperationReconcileJob(
    intents,
    k.app.get(KernelDb),
    k.app.get(SandboxProviders),
  );
  await job.reconcile(row.operation_id);
  expect((await intents.read(row.operation_id)).result).toEqual(row.result);
  await f.db
    .updateTable("sandbox_operation_intents")
    .set({ retain_until: new Date(0) })
    .where("operation_id", "=", row.operation_id)
    .execute();
  await job.reconcile(row.operation_id);
  const expired = await intents.read(row.operation_id);
  expect(expired.input).toBeNull();
  expect(expired.input_hash).toBe(row.input_hash);
  await expect(read()).rejects.toMatchObject({ name: "SandboxOperationOutcomeUnknownError" });
  expect(f.scopes).toHaveLength(1);
});
it("instance recreation preserves consent for the same roots and resets it before changed roots are usable", async () => {
  let workspace = "/work";
  const f = await operationFixture({
    resume: async () => "gone",
    createFileSystem: async () => ({ id: "fs" }),
    create: async () => ({ id: "replacement", roots: { ...DEFAULT_SANDBOX_ROOTS, workspace } }),
    killAll: async () => {},
    killTagged: async () => {},
  });
  for (const changed of [false, true]) {
    workspace = changed ? "/changed" : "/work";
    await f.db
      .updateTable("conversations")
      .set({
        permission_profile: "full-access",
        permission_revision: 4,
        permission_consent: JSON.stringify({ deviceId: f.deviceId, scopeRevision: "retained" }),
      })
      .where("id", "=", f.root.id)
      .execute();
    await f.db
      .updateTable("device_instances")
      .set({ status: "suspended" })
      .where("device_id", "=", f.deviceId)
      .execute();
    await k.app.get(SandboxService).withOperations(
      f.ctx,
      f.invocation,
      async (_h, _p, info) => {
        expect(info.roots.workspace).toBe(workspace);
        const root = await f.db
          .selectFrom("conversations")
          .select(["permission_profile", "permission_revision", "permission_consent"])
          .where("id", "=", f.root.id)
          .executeTakeFirstOrThrow();
        expect(root.permission_profile).toBe(changed ? "approve-for-me" : "full-access");
        expect(root.permission_revision).toBe(changed ? 5 : 4);
        if (changed) expect(root.permission_consent).toBeNull();
      },
      new AbortController().signal,
    );
  }
});
it("sandbox egress changes preserve local Full while revoking cloud Full at its outer ceiling", async () => {
  const local = await operationFixture(),
    cloud = await operationFixture();
  await cloud.db
    .updateTable("devices")
    .set({ source: "cloud" })
    .where("id", "=", cloud.deviceId)
    .execute();
  const facts = k.app.get(PermissionFacts),
    intents = k.app.get(SandboxOperationIntents);
  const { KernelConfigService } = await import("../../src/infra/config/kernel-config.service.js");
  const { PermissionConfigPublication } = await import(
    "../../src/sandbox/permission-config-publication.js"
  );
  const config = k.app.get(KernelConfigService),
    publisher = k.app.get(PermissionConfigPublication),
    before = config.get(),
    next = structuredClone(before);
  next.sandbox.limits.egress = "none";
  const initial = new Map<string, string>();
  for (const f of [local, cloud]) {
    const preview = await facts.preview(f.orgId, owner.id, f.deviceId);
    initial.set(f.deviceId, preview.scopeRevision);
    await f.db
      .updateTable("conversations")
      .set({
        permission_profile: "full-access",
        permission_consent: JSON.stringify({
          deviceId: f.deviceId,
          scopeRevision: preview.scopeRevision,
        }),
      })
      .where("id", "=", f.root.id)
      .execute();
    const invocation = { ...f.invocation, ordinal: 0 };
    await intents.pending(
      f.ctx,
      invocation,
      { provider: "@permission-test", providerVersion: "test-1", generation: "1700000000000" },
      "stat",
      { path: "/work/file" },
      "holder",
      new AbortController().signal,
    );
    await intents.admit(f.ctx, invocation);
  }
  await publisher.publish(before, next);
  const spy = vi.spyOn(config, "get").mockReturnValue(next);
  try {
    for (const f of [local, cloud]) {
      const preview = await facts.preview(f.orgId, owner.id, f.deviceId);
      if (f === local) {
        expect(preview.fullAccessCeiling).toBe(true);
        expect(preview.scopeRevision).toBe(initial.get(f.deviceId));
      }
      const row = await f.db
        .selectFrom("sandbox_operation_intents")
        .select("state")
        .where("run_id", "=", f.claim.runId)
        .executeTakeFirstOrThrow();
      expect(row.state).toBe(f === local ? "admitted" : "revoked");
      const scope = await k.app
        .get(SandboxOperationAuthority)
        .resolve(f.ctx, "exec", new AbortController().signal);
      expect(scope.profile).toBe(f === local ? "full-access" : "approve-for-me");
      if (f === local) expect(scope.network).toEqual({ kind: "environment" });
      else expect(scope.network).toEqual({ kind: "none" });
    }
  } finally {
    await publisher.publish(next, before);
    spy.mockRestore();
  }
});
it("first-use forTool binding orders authority before the real run fence against Profiles.set", async () => {
  const f = await operationFixture();
  await f.db
    .updateTable("conversations")
    .set({ device_id: null })
    .where("id", "=", f.root.id)
    .execute();
  await f.db
    .updateTable("devices")
    .set({ source: "cloud", is_default: true })
    .where("id", "=", f.deviceId)
    .execute();
  const providers = k.app.get(SandboxProviders),
    entry = providers.forName("@permission-test");
  const providerSpy = vi.spyOn(providers, "cloud").mockReturnValue(entry);
  const ready = barrier(),
    attempt = barrier(),
    locks = k.app.get(PermissionAuthorityLock),
    acquire = locks.acquire.bind(locks);
  let calls = 0;
  const spy = vi.spyOn(locks, "acquire").mockImplementation(async (subject, intent) => {
    if (subject.rootConversationId === f.root.id && intent.kind === "write") {
      if (++calls === 1) {
        await acquire(subject, intent);
        ready.resolve();
        await attempt.promise;
        return;
      }
      attempt.resolve();
    }
    return acquire(subject, intent);
  });
  const profile = k.app
    .get(PermissionProfilesService)
    .set(f.orgId, f.root.id, owner.id, { profile: "request-approval", expectedRevision: 0 });
  try {
    await ready.promise;
    const binding = k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ConversationDevices).forTool(f.orgId, f.root.id),
    );
    const result = await Promise.all([profile, binding]);
    expect(result[1]).toBe(f.deviceId);
    expect(
      (
        await f.db
          .selectFrom("conversations")
          .select("device_id")
          .where("id", "=", f.root.id)
          .executeTakeFirstOrThrow()
      ).device_id,
    ).toBe(f.deviceId);
  } finally {
    attempt.resolve();
    spy.mockRestore();
    providerSpy.mockRestore();
  }
});

it.each(["replaced", "cancelled"] as const)(
  "lazy binding still rejects a %s real execution after ordered authority",
  async (kind) => {
    const f = await operationFixture();
    await f.db
      .updateTable("conversations")
      .set({ device_id: null })
      .where("id", "=", f.root.id)
      .execute();
    await f.db
      .updateTable("devices")
      .set({ source: "cloud", is_default: true })
      .where("id", "=", f.deviceId)
      .execute();
    const { runOutsideTransaction } = await import("../../src/infra/database/transaction-host.js");
    const providers = k.app.get(SandboxProviders),
      providerSpy = vi
        .spyOn(providers, "cloud")
        .mockReturnValue(providers.forName("@permission-test"));
    const ceilings = k.app.get(PermissionCeilingWrites),
      lock = ceilings.lock.bind(ceilings);
    let live = true;
    const spy = vi.spyOn(ceilings, "lock").mockImplementationOnce(async (subject, level) => {
      await lock(subject, level);
      if (kind === "cancelled") live = false;
      else
        await runOutsideTransaction(() =>
          k.app.get(RunExecution).claim(f.root.id, f.claim.runId, randomUUID()),
        );
    });
    try {
      await expect(
        k.app.get(RunExecution).withClaim(
          f.claim,
          () => live,
          () => k.app.get(ConversationDevices).forTool(f.orgId, f.root.id),
        ),
      ).rejects.toMatchObject({ message: "execution revoked" });
      expect(
        (
          await f.db
            .selectFrom("conversations")
            .select("device_id")
            .where("id", "=", f.root.id)
            .executeTakeFirstOrThrow()
        ).device_id,
      ).toBeNull();
    } finally {
      spy.mockRestore();
      providerSpy.mockRestore();
    }
  },
);
it("native binary write/read above the old inline cap survives duplicate lookup", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024 + 37).fill(173);
  let writes = 0,
    reads = 0;
  const f = await operationFixture({
    operation: async () =>
      ({
        writeFile: async (_path: string, data: Uint8Array) => {
          writes++;
          expect(data.byteLength).toBe(bytes.byteLength);
          expect(data[bytes.length - 1]).toBe(173);
        },
        readFile: async () => {
          reads++;
          return { data: bytes, truncated: false };
        },
      }) as never,
  });
  const call = () =>
    k.app.get(SandboxService).withOperations(
      f.ctx,
      f.invocation,
      async (h, p, _info, signal) => {
        await p.writeFile(h, "/work/file", bytes, signal);
        return p.readFile(h, "/work/file", { maxBytes: 10 * 1024 * 1024, signal });
      },
      new AbortController().signal,
    );
  for (let n = 0; n < 2; n++) {
    const result = await call();
    expect(result?.data.byteLength).toBe(bytes.length);
    expect(result?.data[0]).toBe(173);
  }
  expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
  bytes[0] = 174;
  await expect(call()).rejects.toThrow("different input");
  bytes[0] = 173;
  const readIntent = await f.db
    .selectFrom("sandbox_operation_intents")
    .selectAll()
    .where("run_id", "=", f.claim.runId)
    .where("method", "=", "readFile")
    .executeTakeFirstOrThrow();
  const chunk = await f.db
    .selectFrom("sandbox_operation_payload_chunks")
    .selectAll()
    .where("operation_id", "=", readIntent.operation_id)
    .where("slot", "=", "result")
    .orderBy("sequence", "desc")
    .executeTakeFirstOrThrow();
  expect(chunk.data.length).toBeLessThanOrEqual(65536);
  const corrupt = Buffer.from(chunk.data);
  corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1;
  await f.db
    .updateTable("sandbox_operation_payload_chunks")
    .set({ data: corrupt })
    .where("operation_id", "=", chunk.operation_id)
    .where("slot", "=", "result")
    .where("sequence", "=", chunk.sequence)
    .execute();
  await expect(call()).rejects.toMatchObject({ name: "SandboxOperationOutcomeUnknownError" });
  expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
  await f.db
    .deleteFrom("sandbox_operation_payload_chunks")
    .where("operation_id", "=", readIntent.operation_id)
    .where("slot", "=", "result")
    .where("sequence", "=", chunk.sequence)
    .execute();
  await expect(call()).rejects.toMatchObject({ name: "SandboxOperationOutcomeUnknownError" });
  expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
  const records = await f.db
    .selectFrom("sandbox_operation_intents")
    .select("operation_id")
    .where("run_id", "=", f.claim.runId)
    .execute();
  await f.db
    .updateTable("sandbox_operation_intents")
    .set({ retain_until: new Date(0) })
    .where("run_id", "=", f.claim.runId)
    .execute();
  const job = new SandboxOperationReconcileJob(
    k.app.get(SandboxOperationIntents),
    k.app.get(KernelDb),
    k.app.get(SandboxProviders),
  );
  for (const record of records) await job.reconcile(record.operation_id);
  expect(
    await f.db
      .selectFrom("sandbox_operation_payload_chunks")
      .select("sequence")
      .where(
        "operation_id",
        "in",
        records.map((r) => r.operation_id),
      )
      .execute(),
  ).toEqual([]);
  await expect(call()).rejects.toMatchObject({ name: "SandboxOperationOutcomeUnknownError" });
  expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
});
it("Deliver-sized native data is retained without a whole-payload JSON allocation", async () => {
  const bytes = new Uint8Array(100 * 1024 * 1024).fill(39);
  let effects = 0;
  const f = await operationFixture({
    operation: async () =>
      ({
        readFile: async () => {
          effects++;
          return { data: bytes, truncated: false };
        },
      }) as never,
  });
  const call = () =>
    k.app
      .get(SandboxService)
      .withOperations(
        f.ctx,
        f.invocation,
        (h, p, _info, signal) =>
          p.readFile(h, "/work/delivery", { maxBytes: bytes.length, signal }),
        new AbortController().signal,
      );
  for (let n = 0; n < 2; n++) {
    const result = await call();
    expect(result?.data.byteLength).toBe(bytes.length);
    expect(result?.data[bytes.length - 1]).toBe(39);
  }
  expect(effects).toBe(1);
});
it("post-effect storage denial stays unknown, then reconciles oversized exec output with its stable ID", async () => {
  const result = {
    stdout: "x".repeat(2 * 1024 * 1024),
    stderr: "",
    exitCode: 0,
    truncated: false,
    timedOut: false,
  };
  let effects = 0;
  const recorded = new Map<string, typeof result>();
  const f = await operationFixture({
    operation: async (_h, scope) =>
      ({
        exec: async () => {
          if (!recorded.has(scope.operationId)) {
            effects++;
            recorded.set(scope.operationId, result);
          }
          return recorded.get(scope.operationId);
        },
      }) as never,
  });
  const intents = k.app.get(SandboxOperationIntents),
    fault = vi
      .spyOn(intents, "complete")
      .mockRejectedValueOnce(new SandboxScopeDeniedError("Injected storage serialization failure"));
  const call = (invocation = f.invocation) =>
    k.app.get(SandboxService).withOperations(
      f.ctx,
      invocation,
      (h, p, _i, signal) =>
        p.exec(h, {
          command: "side effect",
          timeoutMs: 1000,
          maxOutputBytes: 3 * 1024 * 1024,
          signal,
        }),
      new AbortController().signal,
    );
  try {
    await expect(call()).rejects.toMatchObject({ name: "SandboxOperationOutcomeUnknownError" });
  } finally {
    fault.mockRestore();
  }
  const row = await f.db
    .selectFrom("sandbox_operation_intents")
    .selectAll()
    .where("run_id", "=", f.claim.runId)
    .executeTakeFirstOrThrow();
  expect(row.state).toBe("started-or-unknown");
  expect(row.result).toBeNull();
  await expect(call()).rejects.toMatchObject({ name: "SandboxOperationOutcomeUnknownError" });
  expect(effects).toBe(1);
  const claim = await k.app.get(RunExecution).claim(f.root.id, f.claim.runId, randomUUID());
  if (!claim) throw Error("Missing fresh claim");
  const next = { ...f.invocation, claim };
  for (let n = 0; n < 2; n++) {
    const value = await call(next);
    expect(value.stdout.length).toBe(result.stdout.length);
  }
  expect(effects).toBe(1);
  expect((await intents.read(row.operation_id)).state).toBe("completed");
});
