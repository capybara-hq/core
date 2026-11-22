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
import { DeviceAccess } from "../../src/devices/access.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import type { DeviceProviderSelection } from "../../src/devices/device-provider-selection.js";
import {
  type DeviceList,
  DevicesService,
  type DeviceView,
} from "../../src/devices/devices.service.js";
import { deviceLeaseKey } from "../../src/dial-in/keys.js";
import type { ApiError } from "../../src/errors.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { REDIS } from "../../src/infra/tokens.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import {
  type DeviceProviderEntry,
  DeviceProviders,
  LOCAL_PROVIDER,
} from "../../src/sandbox/providers.js";
import { createFakeSandbox } from "../fixtures/plugins/device-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrgWithProviders,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Who may use a device ({@link DeviceAccess}: the owner, while the device's own provider is on in
 * its org) and the default device ({@link DevicesService.ensureDefault}: never demoted), on a
 * kernel with the fake device provider on in the org as its default provider.
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
  root = await mkdtemp(join(tmpdir(), "cap-device-access-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api"],
        extensions: [fixture("device-fake")],
        extensionConfig: { "device-fake": { root } },
      },
    ),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

const setEnabled = (plugin: string, enabled: boolean) =>
  sql`UPDATE capybara.extension_org_configs SET enabled = ${enabled}
    WHERE plugin = ${plugin} AND org_id = ${orgId}`.execute(raw);

/** A member of the org with a fresh login. */
async function newMember(prefix: string): Promise<{ id: string; req: Req }> {
  const login = `${prefix}-${randomUUID().slice(0, 8)}`;
  const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
  await testMembers(db).add(orgId, id, "member", ownerId);
  return { id, req: await session(k, login) };
}

/** A DeviceProviderSelection stub: `on` lists the providers on in every org. */
const selectionOf = (
  on: string[],
  defaultProvider?: string,
): Pick<DeviceProviderSelection, "onInOrg" | "isOnInOrg" | "defaultFor"> => {
  const entry = (plugin: string) => ({ plugin, version: "1.0.0", impl: {} as never });
  return {
    onInOrg: async () => on.filter((p) => p !== LOCAL_PROVIDER).map(entry),
    isOnInOrg: async (_org, plugin) => on.includes(plugin),
    defaultFor: async () =>
      defaultProvider !== undefined && on.includes(defaultProvider)
        ? entry(defaultProvider)
        : undefined,
  };
};

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => (e as ApiError).code,
  );

describe("device access", () => {
  it("ensureDefault is idempotent under concurrency", async () => {
    const service = k.app.get(DevicesService);
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => service.ensureDefault(orgId, ownerId)),
    );
    expect(new Set(ids).size).toBe(1);
    const rows = await db
      .selectFrom("devices")
      .select(["id", "name", "provider"])
      .where("org_id", "=", orgId)
      .where("owner_account_id", "=", ownerId)
      .where("is_default", "=", true)
      .execute();
    expect(rows).toEqual([{ id: ids[0], name: null, provider: "device-fake" }]);
    // a deleted default is replaced by a new one
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${ids[0]}`.execute(raw);
    const next = await service.ensureDefault(orgId, ownerId);
    expect(next).not.toBe(ids[0]);
  });

  it("ensureDefault makes no default for someone who is not a member (any more)", async () => {
    const service = k.app.get(DevicesService);
    const left = (
      await accountsFor(db).createLocal({
        login: `left-${randomUUID().slice(0, 8)}`,
        password: PW,
        displayName: "L",
      })
    ).id;
    expect(await codeOf(service.ensureDefault(orgId, left))).toBe("org.not_found");
    const rows = await db
      .selectFrom("devices")
      .select("id")
      .where("owner_account_id", "=", left)
      .execute();
    expect(rows).toEqual([]);
  });

  it("usable only by the owner in the device's org", async () => {
    const access = k.app.get(DeviceAccess);
    const id = (await k.app.get(DevicesService).ensureDefault(orgId, ownerId)) as string;
    expect(await access.usable(orgId, ownerId, id)).toEqual({ id, provider: "device-fake" });
    expect(await codeOf(access.usable(orgId, randomUUID(), id))).toBe("device.not_found");
    expect(await codeOf(access.usable(randomUUID(), ownerId, id))).toBe("device.not_found");
    expect(await codeOf(access.usable(orgId, ownerId, randomUUID()))).toBe("device.not_found");
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${id}`.execute(raw);
    expect(await codeOf(access.usable(orgId, ownerId, id))).toBe("device.not_found");
  });

  it("ensureDefault never demotes: a default whose provider is off stays the default", async () => {
    const access = k.app.get(DeviceAccess);
    const service = k.app.get(DevicesService);
    const me = await newMember("off");
    const id = (await service.ensureDefault(orgId, me.id)) as string;
    await sql`INSERT INTO capybara.device_instances
        (device_id, org_id, provider, fs_handle, fs_status)
      VALUES (${id}, ${orgId}, 'device-fake', '{"id":"fs-off"}'::jsonb, 'ready')`.execute(raw);
    await setEnabled("device-fake", false);
    try {
      const err = await access.usable(orgId, me.id, id).catch((e: unknown) => e as ApiError);
      expect(err).toMatchObject({
        code: "device.unavailable",
        status: 503,
        message:
          "This device's provider device-fake is off in this organization or not installed; its files are kept, and the device works again once an org admin switches the provider back on",
      });
      // the default stays the default (never demoted or replaced), shown unavailable
      expect(await service.ensureDefault(orgId, me.id)).toBe(id);
      const res = await me.req({ method: "GET", url: `/api/v1/orgs/${orgId}/devices` });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { items: DeviceView[]; defaultId: string };
      expect(body.defaultId).toBe(id);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        id,
        isDefault: true,
        provider: "device-fake",
        available: false,
      });
      expect(body.items[0]).not.toHaveProperty("demotedFrom");
      const reset = await me.req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/devices/${id}/files/reset`,
      });
      expect(reset.statusCode).toBe(503);
      expect((reset.json() as { error: { code: string } }).error.code).toBe("device.unavailable");
      // its files and instance row are kept as they were
      const kept = await db
        .selectFrom("device_instances")
        .select(["provider", "fs_status"])
        .where("device_id", "=", id)
        .executeTakeFirstOrThrow();
      expect(kept).toEqual({ provider: "device-fake", fs_status: "ready" });
    } finally {
      await setEnabled("device-fake", true);
    }
    // switched back on: usable again, the same device
    expect(await access.usable(orgId, me.id, id)).toEqual({ id, provider: "device-fake" });
  });

  it("a device of a provider that is not installed is unavailable, never taken over by a loaded one", async () => {
    const access = k.app.get(DeviceAccess);
    const me = await newMember("gone");
    const id = (await k.app.get(DevicesService).ensureDefault(orgId, me.id)) as string;
    // never used: still bound to its own provider, not moved to device-fake
    await sql`UPDATE capybara.devices SET provider = 'sandbox-old' WHERE id = ${id}`.execute(raw);
    const err = await access.usable(orgId, me.id, id).catch((e: unknown) => e as ApiError);
    expect(err).toMatchObject({ code: "device.unavailable", status: 503 });
    expect((err as ApiError).message).toContain("sandbox-old");
    expect((await k.app.get(DevicesService).get(orgId, me.id, id)).available).toBe(false);
    expect(await k.app.get(DevicesService).ensureDefault(orgId, me.id)).toBe(id);
  });

  it("an instance row of another provider, or no provider, reads as unavailable", async () => {
    const access = k.app.get(DeviceAccess);
    const me = await newMember("odd");
    const id = (await k.app.get(DevicesService).ensureDefault(orgId, me.id)) as string;
    await sql`INSERT INTO capybara.device_instances
        (device_id, org_id, provider, fs_handle, fs_status)
      VALUES (${id}, ${orgId}, 'sandbox-old', '{"id":"fs-old"}'::jsonb, 'ready')`.execute(raw);
    expect(await codeOf(access.usable(orgId, me.id, id))).toBe("device.unavailable");
    expect((await k.app.get(DevicesService).get(orgId, me.id, id)).available).toBe(false);
    await sql`DELETE FROM capybara.device_instances WHERE device_id = ${id}`.execute(raw);
    await sql`UPDATE capybara.devices SET provider = NULL WHERE id = ${id}`.execute(raw);
    const err = await access.usable(orgId, me.id, id).catch((e: unknown) => e as ApiError);
    expect(err).toMatchObject({
      code: "device.unavailable",
      message: "This device has no provider; delete it and create a new one",
    });
  });

  it("ensureDefault makes no default when defaultFor is undefined", async () => {
    const me = await newMember("nodef");
    await sql`UPDATE capybara.orgs SET settings = settings - 'deviceDefaultProvider'
      WHERE id = ${orgId}`.execute(raw);
    try {
      expect(await k.app.get(DevicesService).ensureDefault(orgId, me.id)).toBeNull();
      const res = await me.req({ method: "GET", url: `/api/v1/orgs/${orgId}/devices` });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        items: [],
        defaultId: null,
        providers: [{ plugin: "device-fake" }],
        defaultProvider: null,
      });
      expect(await k.app.get(ConversationDevices).forNew(orgId, me.id)).toBeNull();
    } finally {
      await sql`UPDATE capybara.orgs
        SET settings = settings || '{"deviceDefaultProvider":"device-fake"}'::jsonb
        WHERE id = ${orgId}`.execute(raw);
    }
  });
});

describe("local devices", () => {
  /** A member of the org with a fresh login (their own devices only). */
  const member = () => newMember("dv");
  // keeps the kernel's own dial-in handler: a device sign-in needs @local to take machines
  const deviceEntry = (): DeviceProviderEntry => ({
    plugin: LOCAL_PROVIDER,
    version: "1.0.0",
    impl: Object.assign(createFakeSandbox(join(root, "device")), {
      dialIn: k.app.get(DeviceProviders).forDevice(LOCAL_PROVIDER)?.impl.dialIn,
    }),
  });
  // the kernel serves @local for every test here (LocalDevicesModule does this on init, Task 4)
  beforeAll(() => {
    k.app.get(DeviceProviders).register(deviceEntry());
  });

  it("createDialIn on @local records a local source device, counted against maxPersonal", async () => {
    const service = k.app.get(DevicesService);
    const me = await member();
    const { id } = await service.createDialIn(orgId, me.id, "@local", "laptop");
    const row = await db
      .selectFrom("devices")
      .select(["source", "provider", "is_default", "name"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      source: "local",
      provider: "@local",
      is_default: false,
      name: "laptop",
    });
    expect(await codeOf(service.createDialIn(orgId, me.id, "@local", "LAPTOP"))).toBe(
      "device.name_taken",
    );
    // device-fake is on in the org but takes no machines (no permissions.dialIn); unknown is none
    for (const provider of ["device-fake", "no-such-provider"]) {
      expect(await codeOf(service.createDialIn(orgId, me.id, provider, "other"))).toBe(
        "device.provider_unavailable",
      );
    }
    const max = k.app.get(KernelConfigService).get().devices.maxPersonal;
    for (let i = 1; i < max; i++) await service.createDialIn(orgId, me.id, "@local", `m${i}`);
    expect(await codeOf(service.createDialIn(orgId, me.id, "@local", "one-too-many"))).toBe(
      "device.limit_reached",
    );
  });

  it("usable while @local is registered, whatever extension providers are on; never someone else's", async () => {
    const service = k.app.get(DevicesService);
    const access = k.app.get(DeviceAccess);
    const me = await member();
    const { id } = await service.createDialIn(orgId, me.id, "@local", "box");
    // a kernel that does not serve @local (device-fake is still on)
    const unserved = new DeviceAccess(k.app.get(KernelDb), selectionOf(["device-fake"]));
    const err = await unserved.usable(orgId, me.id, id).catch((e: unknown) => e as ApiError);
    expect(err).toMatchObject({ code: "device.unavailable" });
    expect((err as ApiError).message).toContain("@local");
    // device-fake switched off in the org changes nothing for it
    await setEnabled("device-fake", false);
    try {
      expect(await access.usable(orgId, me.id, id)).toEqual({ id, provider: "@local" });
    } finally {
      await setEnabled("device-fake", true);
    }
    expect(await access.usable(orgId, me.id, id)).toEqual({ id, provider: "@local" });
    expect(await codeOf(access.usable(orgId, ownerId, id))).toBe("device.not_found");
  });

  it("list shows source, online null for cloud; a local device's online and machine", async () => {
    const service = k.app.get(DevicesService);
    const me = await member();
    const { id } = await service.createDialIn(orgId, me.id, "@local", "workstation");
    const list = async () => {
      const res = await me.req({ method: "GET", url: `/api/v1/orgs/${orgId}/devices` });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as DeviceList;
    };
    let body = await list();
    expect(body.defaultProvider).toBe("device-fake");
    expect(body.items.find((e) => e.id === body.defaultId)).toMatchObject({
      source: "cloud",
      online: null,
      sessionIsolation: false,
      machine: null,
      available: true,
    });
    expect(body.items.find((e) => e.id === id)).toMatchObject({
      source: "local",
      provider: "@local",
      available: true,
      online: false,
      sessionIsolation: false,
      machine: null,
    });
    const seen = new Date("2026-11-08T10:00:00.000Z");
    const machineId = randomUUID();
    await sql`INSERT INTO capybara.device_machines
        (id, org_id, device_id, account_id, credential_hash, name, os, arch, program_version,
         mode, last_seen_at, session_isolation)
      VALUES (${machineId}, ${orgId}, ${id}, ${me.id}, 'h', 'grant-mbp', 'darwin', 'arm64', '0.1.0',
        'os', ${seen}, true)`.execute(raw);
    // a revoked machine of the same device is not shown
    await sql`INSERT INTO capybara.device_machines
        (org_id, device_id, account_id, credential_hash, name, os, arch, revoked_at)
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

  it("a conversation bound to a local device needs no extension provider on", async () => {
    const me = await member();
    const { id } = await k.app.get(DevicesService).createDialIn(orgId, me.id, "@local", "rig");
    const kdb = k.app.get(KernelDb);
    const localOnly = selectionOf([LOCAL_PROVIDER]);
    const access = new DeviceAccess(kdb, localOnly);
    const real = k.app.get(DevicesService);
    const conversations = new ConversationDevices(
      kdb,
      k.app.get(TransactionHost),
      localOnly,
      access,
      // no default provider: no default device can be made
      {
        ensureDefault: async () => null,
        modeLevel: real.modeLevel.bind(real),
        projectReach: real.projectReach.bind(real),
      },
      k.app.get(PermissionFacts),
      k.app.get(PermissionCeilingWrites),
    );
    const agentId = randomUUID();
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${agentId}, ${orgId}, ${me.id}, 'org', 1)`.execute(raw);
    const bound = randomUUID();
    const unbound = randomUUID();
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id, device_id)
      VALUES (${bound}, ${orgId}, ${agentId}, ${me.id}, ${id}),
        (${unbound}, ${orgId}, ${agentId}, ${me.id}, NULL)`.execute(raw);
    expect(await conversations.forTool(orgId, bound)).toBe(id);
    expect(await codeOf(conversations.forTool(orgId, unbound))).toBe("sandbox.unavailable");
    expect(await conversations.forNew(orgId, me.id, { deviceId: id })).toBe(id);
    expect(await conversations.forNew(orgId, me.id)).toBeNull();
    // an IM default on the local device still applies without any extension provider
    await sql`INSERT INTO capybara.device_defaults (org_id, account_id, device_id)
      VALUES (${orgId}, ${me.id}, ${id})`.execute(raw);
    expect(await conversations.forNew(orgId, me.id, { im: true })).toBe(id);
  });

  it("usableNow: the listing gate follows the conversation's device (ruling R8)", async () => {
    const me = await member();
    const { id } = await k.app.get(DevicesService).createDialIn(orgId, me.id, "@local", "rig-2");
    const kdb = k.app.get(KernelDb);
    const make = (selection: ReturnType<typeof selectionOf>) =>
      new ConversationDevices(
        kdb,
        k.app.get(TransactionHost),
        selection,
        new DeviceAccess(kdb, selection),
        k.app.get(DevicesService),
        k.app.get(PermissionFacts),
        k.app.get(PermissionCeilingWrites),
      );
    const registered = make(selectionOf([LOCAL_PROVIDER]));
    const unregistered = make(selectionOf([]));
    const cloud = make(selectionOf([LOCAL_PROVIDER, "device-fake"], "device-fake"));
    const agentId = randomUUID();
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${agentId}, ${orgId}, ${me.id}, 'org', 1)`.execute(raw);
    const [bound, unbound, imThread] = [randomUUID(), randomUUID(), randomUUID()];
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id, device_id)
      VALUES (${bound}, ${orgId}, ${agentId}, ${me.id}, ${id}),
        (${unbound}, ${orgId}, ${agentId}, ${me.id}, NULL),
        (${imThread}, ${orgId}, ${agentId}, ${me.id}, NULL)`.execute(raw);
    const connId = randomUUID();
    await sql`INSERT INTO capybara.channel_connections (id, org_id, plugin, name, agent_id, created_by)
      VALUES (${connId}, ${orgId}, 'fake-im', 'bot', ${agentId}, ${me.id})`.execute(raw);
    await sql`INSERT INTO capybara.channel_threads
        (id, connection_id, chat_id, thread_key, account_id, conversation_id)
      VALUES (${randomUUID()}, ${connId}, 'chat-1', 't1', ${me.id}, ${imThread})`.execute(raw);

    expect(await registered.usableNow(orgId, bound)).toBe(true);
    expect(await unregistered.usableNow(orgId, bound)).toBe(false);
    expect(await registered.usableNow(orgId, unbound)).toBe(false);
    // an unbound IM thread: its owner's IM default, when there is one
    await sql`DELETE FROM capybara.device_defaults
      WHERE org_id = ${orgId} AND account_id = ${me.id}`.execute(raw);
    expect(await registered.usableNow(orgId, imThread)).toBe(false);
    await sql`INSERT INTO capybara.device_defaults (org_id, account_id, device_id)
      VALUES (${orgId}, ${me.id}, ${id})`.execute(raw);
    expect(await registered.usableNow(orgId, imThread)).toBe(true);
    expect(await registered.usableNow(orgId, unbound)).toBe(false);
    // another org's id reads as nothing; an unbound conversation with no default device counts
    // the default provider that would make it
    expect(await registered.usableNow(randomUUID(), bound)).toBe(false);
    expect(await cloud.usableNow(orgId, unbound)).toBe(true);
    // its existing default device counts, by its own provider
    const def = randomUUID();
    await sql`INSERT INTO capybara.devices
        (id, org_id, owner_kind, owner_account_id, name, is_default, source, provider)
      VALUES (${def}, ${orgId}, 'personal', ${me.id}, NULL, true, 'cloud', 'device-fake')`.execute(
      raw,
    );
    expect(await cloud.usableNow(orgId, unbound)).toBe(true);
    expect(await make(selectionOf([LOCAL_PROVIDER], "device-fake")).usableNow(orgId, unbound)).toBe(
      false,
    );
    // without a conversation: any extension provider on in the org
    expect(await registered.usableNow(orgId)).toBe(false);
    expect(await cloud.usableNow(orgId)).toBe(true);
  });
});
