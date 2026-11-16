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
