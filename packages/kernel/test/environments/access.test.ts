import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { deviceLeaseKey } from "../../src/devices/keys.js";
import { EnvironmentAccess } from "../../src/environments/access.js";
import { ConversationEnvironments } from "../../src/environments/conversation-environments.js";
import {
  EnvironmentsService,
  type EnvironmentView,
} from "../../src/environments/environments.service.js";
import type { ApiError } from "../../src/errors.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { REDIS } from "../../src/infra/tokens.js";
import {
  DEVICE_PROVIDER,
  type SandboxProviderEntry,
  SandboxProviders,
} from "../../src/sandbox/providers.js";
import { createFakeSandbox } from "../fixtures/plugins/sandbox-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Who may use an environment ({@link EnvironmentAccess}) and the default environment
 * ({@link EnvironmentsService.ensureDefault}), on a kernel with the fake sandbox.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let ownerId: string;
let owner: Req;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-env-access-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api"],
        extensions: [fixture("sandbox-fake")],
        extensionConfig: { "sandbox-fake": { root } },
      },
    ),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => (e as ApiError).code,
  );

describe("environment access", () => {
  it("ensureDefault is idempotent under concurrency", async () => {
    const service = k.app.get(EnvironmentsService);
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => service.ensureDefault(orgId, ownerId)),
    );
    expect(new Set(ids).size).toBe(1);
    const rows = await db
      .selectFrom("environments")
      .select(["id", "name", "provider"])
      .where("org_id", "=", orgId)
      .where("owner_account_id", "=", ownerId)
      .where("is_default", "=", true)
      .execute();
    expect(rows).toEqual([{ id: ids[0], name: null, provider: "sandbox-fake" }]);
    // a deleted default is replaced by a new one
    await sql`UPDATE capybara.environments SET deleted_at = now() WHERE id = ${ids[0]}`.execute(
      raw,
    );
    const next = await service.ensureDefault(orgId, ownerId);
    expect(next).not.toBe(ids[0]);
  });

  it("ensureDefault makes no default for someone who is not a member (any more)", async () => {
    const service = k.app.get(EnvironmentsService);
    const left = (
      await accountsFor(db).createLocal({
        login: `left-${randomUUID().slice(0, 8)}`,
        password: PW,
        displayName: "L",
      })
    ).id;
    expect(await codeOf(service.ensureDefault(orgId, left))).toBe("org.not_found");
    const rows = await db
      .selectFrom("environments")
      .select("id")
      .where("owner_account_id", "=", left)
      .execute();
    expect(rows).toEqual([]);
  });

  it("usable only by the owner in the environment's org", async () => {
    const access = k.app.get(EnvironmentAccess);
    const id = await k.app.get(EnvironmentsService).ensureDefault(orgId, ownerId);
    expect(await access.usable(orgId, ownerId, id)).toEqual({ id, provider: "sandbox-fake" });
    expect(await codeOf(access.usable(orgId, randomUUID(), id))).toBe("environment.not_found");
    expect(await codeOf(access.usable(randomUUID(), ownerId, id))).toBe("environment.not_found");
    expect(await codeOf(access.usable(orgId, ownerId, randomUUID()))).toBe("environment.not_found");
    await sql`UPDATE capybara.environments SET deleted_at = now() WHERE id = ${id}`.execute(raw);
    expect(await codeOf(access.usable(orgId, ownerId, id))).toBe("environment.not_found");
  });

  it("unavailable when the provider changed", async () => {
    const access = k.app.get(EnvironmentAccess);
    const id = await k.app.get(EnvironmentsService).ensureDefault(orgId, ownerId);
    // created under another provider, never used: the current provider takes it over
    await sql`UPDATE capybara.environments SET provider = 'sandbox-old' WHERE id = ${id}`.execute(
      raw,
    );
    expect(await access.usable(orgId, ownerId, id)).toEqual({ id, provider: "sandbox-fake" });
    // files kept by the old provider: unusable until it is back
    await sql`INSERT INTO capybara.environment_instances
        (environment_id, org_id, provider, fs_handle, fs_status)
      VALUES (${id}, ${orgId}, 'sandbox-old', '{"id":"fs-old"}'::jsonb, 'ready')`.execute(raw);
    const err = await access.usable(orgId, ownerId, id).catch((e: unknown) => e as ApiError);
    expect(err).toMatchObject({ code: "environment.unavailable", status: 503 });
    expect((err as ApiError).message).toContain("sandbox-old");

    const res = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/environments/${id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { environment: EnvironmentView }).environment).toMatchObject({
      provider: "sandbox-old",
      available: false,
    });
    const reset = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/environments/${id}/files/reset`,
    });
    expect(reset.statusCode).toBe(503);
    expect((reset.json() as { error: { code: string } }).error.code).toBe(
      "environment.unavailable",
    );
  });

  it("a default stranded by a provider switch is demoted and replaced", async () => {
    const service = k.app.get(EnvironmentsService);
    const login = `sw-${randomUUID().slice(0, 8)}`;
    const me = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
    await testMembers(db).add(orgId, me, "member", ownerId);
    const req = await session(k, login);
    const oldId = await service.ensureDefault(orgId, me);
    // its files are kept by the old provider; the deployment now runs sandbox-fake
    await sql`INSERT INTO capybara.environment_instances
        (environment_id, org_id, provider, fs_handle, fs_status)
      VALUES (${oldId}, ${orgId}, 'sandbox-old', '{"id":"fs-old"}'::jsonb, 'ready')`.execute(raw);
    // the name the demoted one would get is taken: it gets the next free one
    await sql`INSERT INTO capybara.environments
        (id, org_id, owner_kind, owner_account_id, name, source, provider)
      VALUES (${randomUUID()}, ${orgId}, 'personal', ${me}, 'personal (SANDBOX-OLD)', 'cloud',
        'sandbox-fake')`.execute(raw);

    const ids = await Promise.all(
      Array.from({ length: 8 }, () => service.ensureDefault(orgId, me)),
    );
    expect(new Set(ids).size).toBe(1);
    const freshId = ids[0] as string;
    expect(freshId).not.toBe(oldId);

    const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/environments` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: EnvironmentView[]; defaultId: string };
    expect(body.defaultId).toBe(freshId);
    expect(body.items.find((e) => e.id === freshId)).toMatchObject({
      isDefault: true,
      name: null,
      available: true,
    });
    expect(body.items.find((e) => e.id === oldId)).toMatchObject({
      isDefault: false,
      name: "Personal (sandbox-old) 2",
      provider: "sandbox-old",
      available: false,
    });
    // a new conversation without a choice gets the fresh default
    expect(await k.app.get(ConversationEnvironments).forNew(orgId, me)).toBe(freshId);
    // the demoted one can still be deleted
    const del = await req({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/environments/${oldId}`,
    });
    expect(del.statusCode, del.body).toBe(202);
  });

  it("a default that never got resources is not stranded", async () => {
    const service = k.app.get(EnvironmentsService);
    const login = `nr-${randomUUID().slice(0, 8)}`;
    const me = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
    await testMembers(db).add(orgId, me, "member", ownerId);
    const id = await service.ensureDefault(orgId, me);
    await sql`UPDATE capybara.environments SET provider = 'sandbox-old' WHERE id = ${id}`.execute(
      raw,
    );
    expect(await service.ensureDefault(orgId, me)).toBe(id);
  });
});

describe("device environments", () => {
  /** A member of the org with a fresh login (their own environments only). */
  async function member(): Promise<{ id: string; req: Req }> {
    const login = `dv-${randomUUID().slice(0, 8)}`;
    const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
    await testMembers(db).add(orgId, id, "member", ownerId);
    return { id, req: await session(k, login) };
  }
  const deviceEntry = (): SandboxProviderEntry => ({
    plugin: DEVICE_PROVIDER,
    impl: createFakeSandbox(join(root, "device")),
  });
  // the kernel serves @device for every test here (DevicesModule does this on init, Task 4)
  beforeAll(() => {
    k.app.get(SandboxProviders).register(deviceEntry());
  });

  it("createDevice records source device on @device, counted against maxPersonal", async () => {
    const service = k.app.get(EnvironmentsService);
    const me = await member();
    const { id } = await service.createDevice(orgId, me.id, "laptop");
    const row = await db
      .selectFrom("environments")
      .select(["source", "provider", "is_default", "name"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      source: "device",
      provider: "@device",
      is_default: false,
      name: "laptop",
    });
    expect(await codeOf(service.createDevice(orgId, me.id, "LAPTOP"))).toBe(
      "environment.name_taken",
    );
    const max = k.app.get(KernelConfigService).get().environments.maxPersonal;
    for (let i = 1; i < max; i++) await service.createDevice(orgId, me.id, `m${i}`);
    expect(await codeOf(service.createDevice(orgId, me.id, "one-too-many"))).toBe(
      "environment.limit_reached",
    );
  });

  it("usable while @device is registered, whatever the cloud provider; never someone else's", async () => {
    const service = k.app.get(EnvironmentsService);
    const access = k.app.get(EnvironmentAccess);
    const me = await member();
    const { id } = await service.createDevice(orgId, me.id, "box");
    // a kernel that does not serve @device (the cloud provider is still there)
    const unserved = new EnvironmentAccess(k.app.get(KernelDb), {
      cloud: () => k.app.get(SandboxProviders).cloud(),
      forName: () => undefined,
    });
    const err = await unserved.usable(orgId, me.id, id).catch((e: unknown) => e as ApiError);
    expect(err).toMatchObject({ code: "environment.unavailable" });
    expect((err as ApiError).message).toContain("connected machine");
    expect(await access.usable(orgId, me.id, id)).toEqual({ id, provider: "@device" });
    expect(await codeOf(access.usable(orgId, ownerId, id))).toBe("environment.not_found");
  });

  it("list shows source, online null for cloud; a device environment's online and machine", async () => {
    const service = k.app.get(EnvironmentsService);
    const me = await member();
    const { id } = await service.createDevice(orgId, me.id, "workstation");
    const list = async () => {
      const res = await me.req({ method: "GET", url: `/api/v1/orgs/${orgId}/environments` });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { items: EnvironmentView[]; defaultId: string; cloudAvailable: boolean };
    };
    let body = await list();
    expect(body.cloudAvailable).toBe(true);
    expect(body.items.find((e) => e.id === body.defaultId)).toMatchObject({
      source: "cloud",
      online: null,
      sessionIsolation: false,
      machine: null,
      available: true,
    });
    expect(body.items.find((e) => e.id === id)).toMatchObject({
      source: "device",
      provider: "@device",
      available: true,
      online: false,
      sessionIsolation: false,
      machine: null,
    });
    const seen = new Date("2026-11-08T10:00:00.000Z");
    const machineId = randomUUID();
    await sql`INSERT INTO capybara.environment_machines
        (id, org_id, environment_id, account_id, credential_hash, name, os, arch, program_version,
         mode, last_seen_at, session_isolation)
      VALUES (${machineId}, ${orgId}, ${id}, ${me.id}, 'h', 'grant-mbp', 'darwin', 'arm64', '0.1.0',
        'os', ${seen}, true)`.execute(raw);
    // a revoked machine of the same environment is not shown
    await sql`INSERT INTO capybara.environment_machines
        (org_id, environment_id, account_id, credential_hash, name, os, arch, revoked_at)
      VALUES (${orgId}, ${id}, ${me.id}, 'h2', 'old', 'linux', 'x64', now())`.execute(raw);
    await (k.app.get(REDIS) as Redis).set(deviceLeaseKey(id), "replica-1", "PX", 60_000);
    body = await list();
    expect(body.items.find((e) => e.id === id)).toMatchObject({
      online: true,
      sessionIsolation: true,
      machine: {
        id: machineId,
        name: "grant-mbp",
        os: "darwin",
        mode: "os",
        programVersion: "0.1.0",
        lastSeenAt: seen.toISOString(),
      },
    });
    await (k.app.get(REDIS) as Redis).del(deviceLeaseKey(id));
    expect((await list()).items.find((e) => e.id === id)?.online).toBe(false);
  });

  it("a conversation bound to a device environment needs no cloud provider", async () => {
    const me = await member();
    const { id } = await k.app.get(EnvironmentsService).createDevice(orgId, me.id, "rig");
    const kdb = k.app.get(KernelDb);
    const noCloud = { cloud: () => undefined };
    const entry = deviceEntry();
    const access = new EnvironmentAccess(kdb, {
      ...noCloud,
      forName: (n: string) => (n === DEVICE_PROVIDER ? entry : undefined),
    });
    const conversations = new ConversationEnvironments(
      kdb,
      k.app.get(TransactionHost),
      noCloud,
      access,
      k.app.get(EnvironmentsService),
    );
    const agentId = randomUUID();
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${agentId}, ${orgId}, ${me.id}, 'org', 1)`.execute(raw);
    const bound = randomUUID();
    const unbound = randomUUID();
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id, environment_id)
      VALUES (${bound}, ${orgId}, ${agentId}, ${me.id}, ${id}),
        (${unbound}, ${orgId}, ${agentId}, ${me.id}, NULL)`.execute(raw);
    expect(await conversations.forTool(orgId, bound)).toBe(id);
    expect(await codeOf(conversations.forTool(orgId, unbound))).toBe("sandbox.unavailable");
    expect(await conversations.forNew(orgId, me.id, { environmentId: id })).toBe(id);
    expect(await conversations.forNew(orgId, me.id)).toBeNull();
    // an IM default on the device environment still applies without a cloud provider
    await sql`INSERT INTO capybara.environment_defaults (org_id, account_id, environment_id)
      VALUES (${orgId}, ${me.id}, ${id})`.execute(raw);
    expect(await conversations.forNew(orgId, me.id, { im: true })).toBe(id);
  });
});
