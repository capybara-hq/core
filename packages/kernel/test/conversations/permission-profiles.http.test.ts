import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import type { ApiTokenService } from "../../src/identity/api-tokens.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { RunControl as RunControlService } from "../../src/runtime/run-control.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { PermissionAuthorityLock } from "../../src/sandbox/permission-authority-lock.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
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
let tokens: ApiTokenService;
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
  tokens = apiTokensFor(db);
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

describe("Conversation permission profiles", () => {
  it.each(["null-to-device", "device-switch", "project-switch"] as const)(
    "rejects a %s committed after the initial read without changing permission state",
    async (change) => {
      const req = await session("owner");
      const orgId = await createOrg(req);
      const agentId = await createAgent(req, orgId);
      const conv = await createConv(req, orgId, agentId);
      const db = kernelDb(raw);
      const firstDevice = change === "null-to-device" ? null : await localDevice(orgId);
      const nextDevice =
        change === "project-switch" ? firstDevice : await localDevice(orgId, "Next laptop");
      // Fixture setup intentionally writes the otherwise immutable project binding.
      await sql`UPDATE capybara.conversations SET device_id = ${firstDevice},
        project_name = ${change === "project-switch" ? "before" : null},
        project_path = ${change === "project-switch" ? "/work/before" : null}
        WHERE id = ${conv.id}`.execute(raw);
      const permissionState = () =>
        Promise.all([
          db
            .selectFrom("conversations")
            .select(["permission_profile", "permission_revision", "permission_consent"])
            .where("id", "=", conv.id)
            .executeTakeFirstOrThrow(),
          db
            .selectFrom("permission_authority_epochs")
            .selectAll()
            .orderBy("kind")
            .orderBy("id")
            .execute(),
          db
            .selectFrom("audit_events")
            .selectAll()
            .where("target", "=", conv.id)
            .orderBy("id")
            .execute(),
          db
            .selectFrom("conversation_events")
            .selectAll()
            .where("conversation_id", "=", conv.id)
            .orderBy("seq")
            .execute(),
        ]);
      const before = await permissionState();
      const locks = k.app.get(PermissionAuthorityLock);
      const acquire = locks.acquire.bind(locks);
      const reached = deferred<Parameters<PermissionAuthorityLock["acquire"]>[0]>();
      const resume = deferred<void>();
      const gate = vi.spyOn(locks, "acquire").mockImplementationOnce(async (subject, intent) => {
        // The service has read the binding, but has not acquired any authority lock yet.
        reached.resolve(subject);
        await resume.promise;
        return acquire(subject, intent);
      });
      const pending = req({
        method: "PATCH",
        url: `/api/v1/orgs/${orgId}/conversations/${conv.id}/permissions`,
        payload: { profile: "request-approval", expectedRevision: 0 },
      });
      const selected = await reached.promise;
      try {
        // A separate connection commits the binding writer before the PATCH takes root-write.
        await sql`UPDATE capybara.conversations SET device_id = ${nextDevice},
          project_name = CASE WHEN ${change === "project-switch"} THEN 'after' ELSE project_name END,
          project_path = CASE WHEN ${change === "project-switch"} THEN '/work/after' ELSE project_path END
          WHERE id = ${conv.id}`.execute(raw);
      } finally {
        resume.resolve();
      }
      const response = await pending;
      const calls = gate.mock.calls.length;
      gate.mockRestore();
      expect(selected.deviceId ?? null).toBe(firstDevice);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe("conflict");
      expect(calls).toBe(1);
      expect(await permissionState()).toEqual(before);
    },
  );
  it("a known missing factory is unsupported rather than unprobed and cannot receive Full consent", async () => {
    const req = await session("owner"),
      orgId = await createOrg(req),
      agentId = await createAgent(req, orgId),
      deviceId = await localDevice(orgId);
    await kernelDb(raw)
      .updateTable("devices")
      .set({ provider: "@local" })
      .where("id", "=", deviceId)
      .execute();
    const preview = await req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversation-permission-preview?deviceId=${deviceId}`,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().availability.state).toBe("unsupported");
    const first = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/first-message`,
      payload: {
        agentId,
        deviceId,
        message: { text: "hello", clientMessageId: "unsupported" },
        permission: { profile: "full-access", consentScopeRevision: preview.json().scopeRevision },
      },
    });
    expect(first.statusCode, first.body).toBe(409);
  });
  it("a semantic Full ceiling change invalidates displayed Full consent even when policy values return to their old values", async () => {
    const req = await session("owner"),
      orgId = await createOrg(req),
      agentId = await createAgent(req, orgId),
      deviceId = await localDevice(orgId);
    const preview = (
      await req({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/conversation-permission-preview?deviceId=${deviceId}`,
      })
    ).json();
    await k.app.get(TransactionHost).run(async () => {
      await k.app
        .get(PermissionAuthorityLock)
        .acquire({ orgId, deviceId }, { kind: "write", level: "device" });
      await k.app
        .get(PermissionCeilingWrites)
        .publishLocked({ orgId, deviceId }, "device", false, true);
    });
    const first = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/first-message`,
      payload: {
        agentId,
        deviceId,
        message: { text: "hello", clientMessageId: "epoch" },
        permission: { profile: "full-access", consentScopeRevision: preview.scopeRevision },
      },
    });
    expect(first.statusCode, first.body).toBe(409);
  });
  it("device removal invalidates the effective Full view and fresh authority", async () => {
    const req = await session("owner"),
      orgId = await createOrg(req),
      agentId = await createAgent(req, orgId),
      deviceId = await localDevice(orgId);
    const preview = (
      await req({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/conversation-permission-preview?deviceId=${deviceId}`,
      })
    ).json();
    const first = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/first-message`,
      payload: {
        agentId,
        deviceId,
        message: { text: "hello", clientMessageId: "remove" },
        permission: { profile: "full-access", consentScopeRevision: preview.scopeRevision },
      },
    });
    expect(first.statusCode, first.body).toBe(201);
    const id = first.json().conversation.id;
    await kernelDb(raw)
      .updateTable("devices")
      .set({ deleted_at: new Date() })
      .where("id", "=", deviceId)
      .execute();
    const view = await req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${id}/permissions`,
    });
    expect(view.json()).toMatchObject({
      profile: "approve-for-me",
      fullAccessCeiling: false,
      availability: { state: "unsupported" },
    });
    await expect(
      k.app.get(SandboxOperationAuthority).resolve(
        {
          orgId,
          deviceId,
          holderConversationId: id,
          actor: { accountId: owner.id, conversationId: id },
        },
        "readFile",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  it("profile migrations are idempotent and never widen existing device ceilings", async () => {
    const req = await session("owner"),
      orgId = await createOrg(req),
      agentId = await createAgent(req, orgId),
      conv = await createConv(req, orgId, agentId),
      deviceId = await localDevice(orgId);
    await kernelDb(raw)
      .updateTable("device_machines")
      .set({ local_policy: JSON.stringify({ mode: "sandbox", allowedDomains: [] }) })
      .where("device_id", "=", deviceId)
      .execute();
    for (const migration of [
      "0145_permission_authority_epochs.sql",
      "0146_conversation_permission_profiles.sql",
      "0147_first_message_request_hash.sql",
    ]) {
      const source = await readFile(
        new URL(`../../src/migrations/${migration}`, import.meta.url),
        "utf8",
      );
      for (let n = 0; n < 2; n++)
        await raw.transaction().execute(async (tx) => {
          await sql`set local search_path to capybara,public`.execute(tx);
          await sql.raw(source).execute(tx);
        });
    }
    expect(
      await kernelDb(raw)
        .selectFrom("conversations")
        .select(["permission_profile", "permission_revision", "permission_consent"])
        .where("id", "=", conv.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      permission_profile: "approve-for-me",
      permission_revision: 0,
      permission_consent: null,
    });
    expect(
      (
        await req({
          method: "GET",
          url: `/api/v1/orgs/${orgId}/conversation-permission-preview?deviceId=${deviceId}`,
        })
      ).json().fullAccessCeiling,
    ).toBe(false);
  });
  it("racing profile changes use revision CAS and one atomic audit/event", async () => {
    const req = await session("owner"),
      orgId = await createOrg(req),
      agentId = await createAgent(req, orgId),
      conv = await createConv(req, orgId, agentId);
    const url = `/api/v1/orgs/${orgId}/conversations/${conv.id}/permissions`;
    const replies = await Promise.all(
      ["request-approval", "approve-for-me"].map((profile) =>
        req({ method: "PATCH", url, payload: { profile, expectedRevision: 0 } }),
      ),
    );
    expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(
      await kernelDb(raw)
        .selectFrom("audit_events")
        .select("id")
        .where("target", "=", conv.id)
        .where("action", "=", "conversation.permission_profile_changed")
        .execute(),
    ).toHaveLength(1);
    expect(
      await kernelDb(raw)
        .selectFrom("conversation_events")
        .select("seq")
        .where("conversation_id", "=", conv.id)
        .where("type", "=", "permission_profile_changed")
        .execute(),
    ).toHaveLength(1);
  });
  it("preview and permission reads never provision empty or suspended devices; rename and restart preserve consent", async () => {
    const req = await session("owner"),
      orgId = await createOrg(req),
      agentId = await createAgent(req, orgId),
      deviceId = await localDevice(orgId);
    const sandbox = k.app.get(SandboxService);
    const provision = vi.spyOn(sandbox, "withSandbox");
    const previewUrl = `/api/v1/orgs/${orgId}/conversation-permission-preview?deviceId=${deviceId}`;
    const preview = await req({ method: "GET", url: previewUrl });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      fullAccessCeiling: true,
      availability: { state: "unprobed" },
    });
    expect(
      await kernelDb(raw).selectFrom("device_instances").select("device_id").execute(),
    ).toEqual([]);
    const payload = {
      agentId,
      deviceId,
      message: { text: "hello", clientMessageId: "full-device" },
      permission: { profile: "full-access", consentScopeRevision: preview.json().scopeRevision },
    };
    const created = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/first-message`,
      payload,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().conversation.id,
      url = `/api/v1/orgs/${orgId}/conversations/${id}/permissions`;
    expect((await req({ method: "GET", url })).json().profile).toBe("full-access");
    await kernelDb(raw)
      .updateTable("devices")
      .set({ name: "Renamed" })
      .where("id", "=", deviceId)
      .execute();
    await kernelDb(raw)
      .insertInto("device_instances")
      .values({
        device_id: deviceId,
        org_id: orgId,
        provider: "@local",
        status: "suspended",
        generation: 42,
        handle: JSON.stringify({ id: "restarted" }),
      })
      .execute();
    expect((await req({ method: "GET", url: previewUrl })).json().scopeRevision).toBe(
      preview.json().scopeRevision,
    );
    expect((await req({ method: "GET", url })).json().profile).toBe("full-access");
    expect(provision).not.toHaveBeenCalled();
    provision.mockRestore();
    const authority = k.app.get(SandboxOperationAuthority);
    const scope = await authority.resolve(
      {
        orgId,
        deviceId,
        holderConversationId: id,
        actor: { accountId: owner.id, conversationId: id },
      },
      "readFile",
      new AbortController().signal,
    );
    expect(scope).toMatchObject({
      profile: "full-access",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    });
    await kernelDb(raw)
      .updateTable("device_machines")
      .set({ local_policy: JSON.stringify({ mode: "sandbox", allowedDomains: [] }) })
      .where("device_id", "=", deviceId)
      .execute();
    expect((await req({ method: "GET", url })).json()).toMatchObject({
      profile: "approve-for-me",
      fullAccessCeiling: false,
    });
    expect(
      (
        await authority.resolve(
          {
            orgId,
            deviceId,
            holderConversationId: id,
            actor: { accountId: owner.id, conversationId: id },
          },
          "stat",
          new AbortController().signal,
        )
      ).filesystem.kind,
    ).toBe("scoped");
  });
  it("stale displayed Full consent rolls back creation and its run obligation", async () => {
    const req = await session("owner"),
      orgId = await createOrg(req),
      agentId = await createAgent(req, orgId),
      deviceId = await localDevice(orgId);
    const preview = await req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversation-permission-preview?deviceId=${deviceId}`,
    });
    await kernelDb(raw)
      .updateTable("device_machines")
      .set({ local_policy: JSON.stringify({ mode: "sandbox", allowedDomains: [] }) })
      .where("device_id", "=", deviceId)
      .execute();
    const first = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/first-message`,
      payload: {
        agentId,
        deviceId,
        message: { text: "hello", clientMessageId: "stale" },
        permission: { profile: "full-access", consentScopeRevision: preview.json().scopeRevision },
      },
    });
    expect(first.statusCode, first.body).toBe(409);
    expect(
      await kernelDb(raw)
        .selectFrom("conversations")
        .select("id")
        .where("create_request_id", "=", "stale")
        .execute(),
    ).toEqual([]);
    expect(
      await kernelDb(raw)
        .selectFrom("outbox")
        .select("id")
        .where("job_name", "=", "ensure-run")
        .where("org_id", "=", orgId)
        .execute(),
    ).toEqual([]);
  });
  it("rejects PAT permissions, PAT first-message and permission fields on legacy create", async () => {
    const req = await session("owner"),
      orgId = await createOrg(req),
      agentId = await createAgent(req, orgId),
      conv = await createConv(req, orgId, agentId);
    const { token } = await tokens.createPersonal(owner.id, { name: "test" });
    const headers = { authorization: `Bearer ${token}` };
    const url = `/api/v1/orgs/${orgId}/conversations`;
    for (const method of ["GET", "PATCH"] as const)
      expect(
        (
          await k.http.inject({
            method,
            url: `${url}/${conv.id}/permissions`,
            headers,
            ...(method === "PATCH"
              ? { payload: { profile: "full-access", expectedRevision: 0 } }
              : {}),
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (
        await k.http.inject({
          method: "POST",
          url: `${url}/first-message`,
          headers,
          payload: {
            agentId,
            message: { text: "hello", clientMessageId: "pat" },
            permission: { profile: "approve-for-me" },
          },
        })
      ).statusCode,
    ).toBe(403);
    for (const extra of [
      { permission: { profile: "full-access" } },
      { profile: "full-access" },
      { consentScopeRevision: "forged" },
    ]) {
      expect(
        (await k.http.inject({ method: "POST", url, headers, payload: { agentId, ...extra } }))
          .statusCode,
      ).toBe(400);
    }
    const ops = k.app.get(PlatformOperations);
    expect(ops.get("conversations.create")).toBeNull();
    expect(ops.get("conversations.first-message")).toBeNull();
    expect(ops.get("conversations.permissions.set")).toBeNull();
    const rename = ops.get("conversations.rename");
    expect(rename).not.toBeNull();
    expect(
      rename?.input.safeParse({
        conversationId: conv.id,
        title: "Name",
        profile: "full-access",
        consentScopeRevision: "forged",
      }).success,
    ).toBe(false);
    const otherOrg = await createOrg(req);
    expect(
      (
        await req({
          method: "GET",
          url: `/api/v1/orgs/${otherOrg}/conversations/${conv.id}/permissions`,
        })
      ).statusCode,
    ).toBe(404);
  });
  it("children read root changes live but cannot set them; scheduled roots cannot select chat profiles", async () => {
    const req = await session("owner"),
      orgId = await createOrg(req),
      agentId = await createAgent(req, orgId),
      conv = await createConv(req, orgId, agentId);
    const db = kernelDb(raw),
      child = randomUUID();
    await db
      .insertInto("conversations")
      .values({
        id: child,
        org_id: orgId,
        agent_id: agentId,
        account_id: owner.id,
        kind: "subagent",
        parent_conversation_id: conv.id,
        source: "web",
      })
      .execute();
    const rootUrl = `/api/v1/orgs/${orgId}/conversations/${conv.id}/permissions`,
      childUrl = `/api/v1/orgs/${orgId}/conversations/${child}/permissions`;
    expect(
      (
        await req({
          method: "PATCH",
          url: childUrl,
          payload: { profile: "request-approval", expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await req({
          method: "PATCH",
          url: rootUrl,
          payload: { profile: "request-approval", expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(200);
    expect((await req({ method: "GET", url: childUrl })).json()).toMatchObject({
      profile: "request-approval",
      revision: 1,
      rootConversationId: conv.id,
    });
    const taskId = randomUUID();
    await db
      .insertInto("scheduled_tasks")
      .values({
        id: taskId,
        org_id: orgId,
        account_id: owner.id,
        agent_id: agentId,
        name: "Scheduled",
        prompt: "hello",
        trigger: JSON.stringify({ kind: "once", at: "2030-01-01T00:00:00Z" }),
        mode: "new",
      })
      .execute();
    await db
      .updateTable("conversations")
      .set({ scheduled_task_id: taskId })
      .where("id", "=", conv.id)
      .execute();
    expect(
      (
        await req({
          method: "PATCH",
          url: rootUrl,
          payload: { profile: "full-access", expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("initializes only the winning root epoch on concurrent first-send and rolls back failed creation", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const profiles = k.app.get(PermissionProfilesService);
    const lock = profiles.lockInitial.bind(profiles);
    const candidates: string[] = [];
    const both = deferred<void>();
    const spy = vi.spyOn(profiles, "lockInitial").mockImplementation(async (...args) => {
      candidates.push(args[1]);
      if (candidates.length === 2) both.resolve();
      await both.promise;
      await lock(...args);
    });
    const url = `/api/v1/orgs/${orgId}/conversations/first-message`;
    const payload = {
      agentId,
      message: { text: "hello", clientMessageId: "concurrent" },
      permission: { profile: "approve-for-me" },
    };
    let answers: Awaited<ReturnType<Req>>[];
    try {
      answers = await Promise.all([
        req({ method: "POST", url, payload }),
        req({ method: "POST", url, payload }),
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(answers.map((a) => a.statusCode).sort()).toEqual([200, 201]);
    const winner = answers[0]?.json().conversation.id;
    expect(answers[1]?.json().conversation.id).toBe(winner);
    expect(candidates).toHaveLength(2);
    const db = kernelDb(raw);
    expect(
      await db
        .selectFrom("permission_authority_epochs")
        .select("id")
        .where("kind", "=", "root")
        .where("id", "in", candidates)
        .execute(),
    ).toEqual([{ id: winner }]);
    const rollbackIds: string[] = [];
    const init = profiles.initialize.bind(profiles);
    const fail = vi.spyOn(profiles, "initialize").mockImplementation(async (...args) => {
      rollbackIds.push(args[1]);
      await init(...args);
      throw new Error("Injected failure after epoch initialization");
    });
    try {
      const failed = await req({
        method: "POST",
        url,
        payload: { ...payload, message: { ...payload.message, clientMessageId: "rollback" } },
      });
      expect(failed.statusCode).toBe(500);
    } finally {
      fail.mockRestore();
    }
    expect(rollbackIds).toHaveLength(1);
    expect(
      await db
        .selectFrom("permission_authority_epochs")
        .select("id")
        .where("kind", "=", "root")
        .where("id", "in", rollbackIds)
        .execute(),
    ).toEqual([]);
    expect(
      await db.selectFrom("conversations").select("id").where("id", "in", rollbackIds).execute(),
    ).toEqual([]);
  });
  it("persists both restricted initial selections without a device and rejects changed-body retries", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    for (const profile of ["request-approval", "approve-for-me"]) {
      const url = `/api/v1/orgs/${orgId}/conversations/first-message`;
      const payload = {
        agentId,
        message: { text: "hello", clientMessageId: profile },
        permission: { profile },
      };
      const runs = k.app.get(RunControlService),
        owe = runs.oweEnsureRun.bind(runs);
      const beforeEnqueue = vi.spyOn(runs, "oweEnsureRun").mockImplementation(async (...args) => {
        const row = await k.app
          .get(KernelDb)
          .selectFrom("conversations")
          .select(["permission_profile", "device_id"])
          .where("id", "=", args[0])
          .executeTakeFirstOrThrow();
        expect(row).toEqual({ permission_profile: profile, device_id: null });
        return owe(...args);
      });
      const first = await req({ method: "POST", url, payload });
      expect(first.statusCode, first.body).toBe(201);
      expect(beforeEnqueue).toHaveBeenCalledOnce();
      beforeEnqueue.mockRestore();
      expect(first.json().events[0]).toMatchObject({
        type: "permission_profile_changed",
        payload: { newProfile: profile, revision: 0 },
      });
      const id = first.json().conversation.id;
      const view = await req({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/conversations/${id}/permissions`,
      });
      expect(view.statusCode, view.body).toBe(200);
      expect(view.json()).toMatchObject({ profile, revision: 0, deviceId: null });
      const again = await req({ method: "POST", url, payload });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().conversation.id).toBe(id);
      const changed = await req({
        method: "POST",
        url,
        payload: { ...payload, message: { ...payload.message, text: "different" } },
      });
      expect(changed.statusCode, changed.body).toBe(409);
    }
  });
  it("defaults existing create to approve-for-me; owner session PATCH is versioned and Full requires a device", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const conv = await createConv(req, orgId, agentId);
    const url = `/api/v1/orgs/${orgId}/conversations/${conv.id}/permissions`;
    const view = await req({ method: "GET", url });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({ profile: "approve-for-me", revision: 0 });
    const patch = await req({
      method: "PATCH",
      url,
      payload: { profile: "request-approval", expectedRevision: 0 },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().revision).toBe(1);
    expect(
      (
        await req({
          method: "PATCH",
          url,
          payload: { profile: "approve-for-me", expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(409);
    const other = await memberSession(orgId, "other", "admin");
    expect((await other.req({ method: "GET", url })).statusCode).toBe(404);
    expect(
      (
        await other.req({
          method: "PATCH",
          url,
          payload: { profile: "full-access", expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(404);
    const full = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/first-message`,
      payload: {
        agentId,
        message: { text: "hello", clientMessageId: "full" },
        permission: { profile: "full-access" },
      },
    });
    expect(full.statusCode, full.body).toBe(409);
    expect(
      await kernelDb(raw)
        .selectFrom("conversations")
        .select("id")
        .where("create_request_id", "=", "full")
        .execute(),
    ).toEqual([]);
  });
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
