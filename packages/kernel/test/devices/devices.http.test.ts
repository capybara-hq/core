import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { DeviceList, DeviceView } from "../../src/devices/devices.service.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { ApiError } from "../../src/errors.js";
import { TransactionHost, withOrderedLocks } from "../../src/infra/database/transaction-host.js";
import { deviceDestroyJobId } from "../../src/sandbox/jobs.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { fakeFileSystems, removeFakeFileSystem } from "../fixtures/plugins/device-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { drainOutbox } from "../helpers/outbox.js";
import {
  createOrg,
  enableDeviceProviders,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * The devices API (spec 2026-11-07-environments-design §4.2 items 7, 12, 13; §9): personal
 * cloud devices, visible and usable only by their owner, on one kernel (api + worker) with
 * the fake sandbox.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

const MAX = 4;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
/** `device-fake-b`'s directory. */
let rootB: string;
let sandbox: SandboxService;
let ownerId: string;
let owner: Req;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-device-http-"));
  rootB = await mkdtemp(join(tmpdir(), "cap-device-http-b-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [fixture("device-fake"), fixture("device-fake-b")],
        extensionConfig: { "device-fake": { root }, "device-fake-b": { root: rootB } },
        devices: { maxPersonal: MAX },
      },
    ),
  );
  sandbox = k.app.get(SandboxService);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  // both providers on in the org, device-fake its default
  await enableDeviceProviders(k, orgId);
  await setDefaultProvider("device-fake");
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  for (const r of [root, rootB]) if (r) await rm(r, { recursive: true, force: true });
});

/** Sets (or with null clears) the org's default device provider. */
const setDefaultProvider = (plugin: string | null) =>
  plugin === null
    ? sql`UPDATE capybara.orgs SET settings = settings - 'deviceDefaultProvider'
        WHERE id = ${orgId}`.execute(raw)
    : sql`UPDATE capybara.orgs
        SET settings = COALESCE(settings, '{}'::jsonb)
          || jsonb_build_object('deviceDefaultProvider', ${plugin}::text)
        WHERE id = ${orgId}`.execute(raw);

/** Switches `plugin` on or off in the org (its row of the org's own switch). */
const setEnabled = (plugin: string, enabled: boolean) =>
  sql`UPDATE capybara.extension_org_configs SET enabled = ${enabled}
    WHERE plugin = ${plugin} AND org_id = ${orgId}`.execute(raw);

const base = () => `/api/v1/orgs/${orgId}/devices`;
const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

/** A new member of the org with a session. */
async function member(): Promise<{ id: string; req: Req }> {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
  await testMembers(db).add(orgId, id, "member", ownerId);
  return { id, req: await session(k, login) };
}

type List = DeviceList;

async function list(req: Req): Promise<List> {
  const res = await req({ method: "GET", url: base() });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as List;
}

async function create(req: Req, name: string, provider?: string): Promise<DeviceView> {
  const res = await req({
    method: "POST",
    url: base(),
    payload: { name, ...(provider !== undefined && { provider }) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { device: DeviceView }).device;
}

/** The person's live devices in the org, counted in PG. */
async function countDevices(accountId: string): Promise<number> {
  const { n } = await db
    .selectFrom("devices")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("org_id", "=", orgId)
    .where("owner_account_id", "=", accountId)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(n);
}

const ctl = () => AbortSignal.timeout(30_000);

describe("devices API", () => {
  it("create, list, rename, delete a personal device", async () => {
    const m = await member();
    const env = await create(m.req, "  Repo  ");
    expect(env).toMatchObject({
      name: "Repo",
      isDefault: false,
      ownerKind: "personal",
      provider: "device-fake",
      dialIn: false,
      available: true,
      online: null,
      machine: null,
      filesLost: false,
      instance: null,
      limits: { network: { kind: expect.any(String), hosts: expect.any(Array) } },
      sandbox: {
        network: "open",
        networkCeiling: "open",
        hosts: [],
        ownNetwork: null,
        allowedDomains: [],
        outsideSandbox: false,
        layer: { network: null, outsideSandbox: "provider" },
        recent: [],
      },
    });
    // the kernel-internal tier is not part of the view
    expect(env.limits).not.toHaveProperty("mode");
    expect(env).not.toHaveProperty("mode");
    expect(typeof env.createdAt).toBe("string");

    const l = await list(m.req);
    // the default is made on first need and listed first
    expect(l.items.map((e) => [e.name, e.isDefault])).toEqual([
      [null, true],
      ["Repo", false],
    ]);
    expect(l.defaultId).toBe(l.items[0]?.id);

    const got = await m.req({ method: "GET", url: `${base()}/${env.id}` });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { device: DeviceView }).device.id).toBe(env.id);

    const renamed = await m.req({
      method: "PATCH",
      url: `${base()}/${env.id}`,
      payload: { name: "Repo 2" },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((renamed.json() as { device: DeviceView }).device.name).toBe("Repo 2");

    const del = await m.req({ method: "DELETE", url: `${base()}/${env.id}` });
    expect(del.statusCode, del.body).toBe(202);
    const after = await m.req({ method: "GET", url: `${base()}/${env.id}` });
    expect(after.statusCode).toBe(404);
    expect(errCode(after)).toBe("device.not_found");
    expect((await list(m.req)).items.map((e) => e.id)).not.toContain(env.id);
    const audits = await db
      .selectFrom("audit_events")
      .select("action")
      .where("target", "=", env.id)
      .orderBy("id")
      .execute();
    expect(audits.map((a) => a.action)).toEqual([
      "device.created",
      "device.renamed",
      "device.deleted",
    ]);
  });

  it("validation, auth and service tokens", async () => {
    for (const name of ["", "   ", "x".repeat(65)]) {
      const res = await owner({ method: "POST", url: base(), payload: { name } });
      expect(res.statusCode).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
    const extra = await owner({ method: "POST", url: base(), payload: { name: "a", x: 1 } });
    expect(extra.statusCode).toBe(400);

    const anon = await k.http.inject({ method: "GET", url: base() });
    expect(anon.statusCode).toBe(401);

    const outsider = `out-${randomUUID().slice(0, 8)}`;
    await accountsFor(db).createLocal({ login: outsider, password: PW, displayName: "X" });
    const notMember = await (await session(k, outsider))({ method: "GET", url: base() });
    expect(notMember.statusCode).toBe(404);
    expect(errCode(notMember)).toBe("org.not_found");

    const { token } = await apiTokensFor(db).createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: ownerId,
    });
    for (const [method, payload] of [
      ["GET", undefined],
      ["POST", { name: "Bot" }],
    ] as const) {
      const res = await k.http.inject({
        method,
        url: base(),
        headers: { authorization: `Bearer ${token}` },
        ...(payload && { payload }),
      });
      expect(res.statusCode).toBe(403);
      expect(errCode(res)).toBe("forbidden");
    }
  });

  it("another member gets not_found for my device", async () => {
    const me = await member();
    const other = await member();
    const env = await create(me.req, "Mine");
    for (const [method, url, payload] of [
      ["GET", `${base()}/${env.id}`, undefined],
      ["PATCH", `${base()}/${env.id}`, { name: "Theirs" }],
      ["DELETE", `${base()}/${env.id}`, undefined],
      ["POST", `${base()}/${env.id}/files/reset`, undefined],
    ] as const) {
      const res = await other.req({ method, url, ...(payload && { payload }) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(errCode(res)).toBe("device.not_found");
    }
    expect((await list(other.req)).items.map((e) => e.id)).not.toContain(env.id);
    // untouched
    const mine = await me.req({ method: "GET", url: `${base()}/${env.id}` });
    expect((mine.json() as { device: DeviceView }).device.name).toBe("Mine");
    // and not usable by them through the sandbox either
    const err = await sandbox
      .withSandbox(
        {
          orgId: randomUUID(),
          deviceId: env.id,
          holderConversationId: randomUUID(),
          actor: { accountId: other.id, conversationId: randomUUID() },
        },
        async () => "ran",
        ctl(),
      )
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("device.not_found");
  });

  it("my device is not_found through another org I am a member of", async () => {
    const env = await create(owner, "Org A only");
    const otherOrg = await createOrg(owner, "Other");
    const elsewhere = `/api/v1/orgs/${otherOrg}/devices`;
    for (const [method, url, payload] of [
      ["GET", `${elsewhere}/${env.id}`, undefined],
      ["PATCH", `${elsewhere}/${env.id}`, { name: "Moved" }],
      ["DELETE", `${elsewhere}/${env.id}`, undefined],
      ["POST", `${elsewhere}/${env.id}/files/reset`, undefined],
    ] as const) {
      const res = await owner({ method, url, ...(payload && { payload }) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(errCode(res)).toBe("device.not_found");
    }
    const listed = await owner({ method: "GET", url: elsewhere });
    expect((listed.json() as List).items.map((e) => e.id)).not.toContain(env.id);
    // untouched in its own org
    const mine = await owner({ method: "GET", url: `${base()}/${env.id}` });
    expect((mine.json() as { device: DeviceView }).device.name).toBe("Org A only");
  });

  it("names are unique per person, case-insensitive", async () => {
    const me = await member();
    const other = await member();
    const a = await create(me.req, "Build");
    const clash = await me.req({ method: "POST", url: base(), payload: { name: "build" } });
    expect(clash.statusCode).toBe(409);
    expect(errCode(clash)).toBe("device.name_taken");
    // another person may use the same name
    await create(other.req, "BUILD");
    // renaming onto another of my names is refused; a case change of its own name is not
    const b = await create(me.req, "Test");
    const onto = await me.req({
      method: "PATCH",
      url: `${base()}/${b.id}`,
      payload: { name: "BUILD" },
    });
    expect(onto.statusCode).toBe(409);
    expect(errCode(onto)).toBe("device.name_taken");
    const recase = await me.req({
      method: "PATCH",
      url: `${base()}/${a.id}`,
      payload: { name: "BUILD" },
    });
    expect(recase.statusCode, recase.body).toBe(200);
    // a deleted device's name is free again
    expect((await me.req({ method: "DELETE", url: `${base()}/${b.id}` })).statusCode).toBe(202);
    await create(me.req, "test");
  });

  it("limit_reached at maxPersonal", async () => {
    const me = await member();
    await list(me.req); // makes the default, which counts
    for (let i = 1; i < MAX; i++) await create(me.req, `env-${i}`);
    const over = await me.req({ method: "POST", url: base(), payload: { name: "one more" } });
    expect(over.statusCode).toBe(409);
    expect(errCode(over)).toBe("device.limit_reached");
    const items = (await list(me.req)).items;
    expect(items).toHaveLength(MAX);
    // deleting one frees a place
    const last = items[items.length - 1] as DeviceView;
    expect((await me.req({ method: "DELETE", url: `${base()}/${last.id}` })).statusCode).toBe(202);
    await create(me.req, "one more");
  });

  it("list reports defaultId and lastUsedId", async () => {
    const me = await member();
    const first = await list(me.req);
    expect(first.lastUsedId).toBeNull();
    expect(first.defaultId).not.toBeNull();
    const again = await list(me.req);
    expect(again.defaultId).toBe(first.defaultId);
    expect(again.items.filter((e) => e.isDefault)).toHaveLength(1);

    const a = await create(me.req, "A");
    const b = await create(me.req, "B");
    const agentId = randomUUID();
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${agentId}, ${orgId}, ${me.id}, 'org', 1)`.execute(raw);
    const conv = async (deviceId: string | null, updatedAt: string, accountId = me.id) =>
      sql`INSERT INTO capybara.conversations
          (id, org_id, agent_id, account_id, device_id, updated_at)
        VALUES (${randomUUID()}, ${orgId}, ${agentId}, ${accountId}, ${deviceId},
          ${updatedAt}::timestamptz)`.execute(raw);
    await conv(a.id, "2026-01-01T00:00:00Z");
    await conv(b.id, "2026-02-01T00:00:00Z");
    // newer, but without a device
    await conv(null, "2026-03-01T00:00:00Z");
    // another person's newer conversation does not count
    const other = await member();
    const theirs = await create(other.req, "Theirs");
    await conv(theirs.id, "2026-04-01T00:00:00Z", other.id);
    expect((await list(me.req)).lastUsedId).toBe(b.id);
    // a deleted device is not the last used one
    expect((await me.req({ method: "DELETE", url: `${base()}/${b.id}` })).statusCode).toBe(202);
    expect((await list(me.req)).lastUsedId).toBe(a.id);
  });

  it("delete waits for running commands then destroys both", async () => {
    const me = await member();
    const env = await create(me.req, "Busy");
    const conversationId = randomUUID();
    const at = {
      orgId,
      deviceId: env.id,
      holderConversationId: conversationId,
      actor: { accountId: me.id, conversationId },
    };
    // a command holding a shared lease
    const running = sandbox.withSandbox(
      at,
      (h, p, _info, signal) =>
        p.exec(h, {
          command: "touch /workspace/started && sleep 1.5 && echo done",
          timeoutMs: 20_000,
          maxOutputBytes: 1000,
          signal,
        }),
      ctl(),
    );
    const started = await waitFor(
      async () => {
        for (const fs of await fakeFileSystems(root)) {
          if (existsSync(join(root, "filesystems", fs, "workspace", "started"))) return fs;
        }
        return null;
      },
      15_000,
      "the command to start",
    );
    const del = await me.req({ method: "DELETE", url: `${base()}/${env.id}` });
    expect(del.statusCode, del.body).toBe(202);
    // the command finishes: the destruction waited for it
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("done");
    await waitFor(
      async () =>
        !(await db
          .selectFrom("device_instances")
          .select("device_id")
          .where("device_id", "=", env.id)
          .executeTakeFirst()),
      20_000,
      "the instance row to go",
    );
    expect(await fakeFileSystems(root)).not.toContain(started);
    const instances = await readdir(join(root, "instances")).catch(() => [] as string[]);
    expect(instances).toEqual([]);
    // a later use in that conversation finds no device
    const err = await sandbox.withSandbox(at, async () => "ran", ctl()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("device.not_found");
  });

  it("a leftover device of a provider that no longer exists (@local) is deleted and cleaned up", async () => {
    const me = await member();
    // a local device from before local devices left the kernel: bound to `@local` for life, with
    // its signed-in machine (migration 0177 dropped its instance row: no provider can destroy it)
    const id = randomUUID();
    await sql`INSERT INTO capybara.devices (id, org_id, owner_kind, owner_account_id, name, provider)
      VALUES (${id}, ${orgId}, 'personal', ${me.id}, 'Old laptop', '@local')`.execute(raw);
    await sql`INSERT INTO capybara.device_machines
        (org_id, device_id, account_id, credential_hash, name, os, arch)
      VALUES (${orgId}, ${id}, ${me.id}, ${randomUUID()}, 'mbp', 'darwin', 'arm64')`.execute(raw);
    const list = await me.req({ method: "GET", url: base() });
    expect((list.json() as DeviceList).items.find((d) => d.id === id)).toMatchObject({
      provider: "@local",
      available: false,
    });
    const del = await me.req({ method: "DELETE", url: `${base()}/${id}` });
    expect(del.statusCode, del.body).toBe(202);
    const row = await db
      .selectFrom("devices")
      .select("deleted_at")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
    const machine = await db
      .selectFrom("device_machines")
      .select("revoked_at")
      .where("device_id", "=", id)
      .executeTakeFirstOrThrow();
    expect(machine.revoked_at).not.toBeNull();
    // the owed destruction finds nothing to destroy and settles (nothing dead, nothing left)
    await drainOutbox(k.app, { jobId: deviceDestroyJobId(id) });
    expect(
      await db
        .selectFrom("outbox")
        .select("id")
        .where("job_id", "=", deviceDestroyJobId(id))
        .execute(),
    ).toEqual([]);
  });

  it("reset files after files_lost", async () => {
    const me = await member();
    const env = await create(me.req, "Fragile");
    const conversationId = randomUUID();
    const at = {
      orgId,
      deviceId: env.id,
      holderConversationId: conversationId,
      actor: { accountId: me.id, conversationId },
    };
    const write = (body: string) =>
      sandbox.withSandbox(
        at,
        (h, p, _i, sig) => p.writeFile(h, "/workspace/f.txt", new TextEncoder().encode(body), sig),
        ctl(),
      );
    const before = new Set(await fakeFileSystems(root));
    await write("one");
    const fsId = (await fakeFileSystems(root)).find((f) => !before.has(f)) as string;
    expect(fsId).toBeDefined();
    // the instance goes away (inactivity) and the files are lost at the provider
    await sql`UPDATE capybara.device_instances SET status = 'destroyed', handle = NULL
      WHERE device_id = ${env.id}`.execute(raw);
    await removeFakeFileSystem(root, fsId);
    const lost = await write("two").catch((e: unknown) => e);
    expect((lost as ApiError).code).toBe("device.files_lost");
    const view = await me.req({ method: "GET", url: `${base()}/${env.id}` });
    expect((view.json() as { device: DeviceView }).device.filesLost).toBe(true);

    const reset = await me.req({ method: "POST", url: `${base()}/${env.id}/files/reset` });
    expect(reset.statusCode, reset.body).toBe(202);
    // the reset is a maintenance job: the worker drops the lost file system after the response
    await waitFor(
      async () => {
        const fresh = await me.req({ method: "GET", url: `${base()}/${env.id}` });
        return !(fresh.json() as { device: DeviceView }).device.filesLost;
      },
      20_000,
      "the reset job",
    );
    await write("three");
    const read = await sandbox.withSandbox(
      at,
      (h, p, _i, sig) => p.readFile(h, "/workspace/f.txt", { maxBytes: 100, signal: sig }),
      ctl(),
    );
    expect(new TextDecoder().decode(read?.data)).toBe("three");
    const running = await me.req({ method: "GET", url: `${base()}/${env.id}` });
    expect((running.json() as { device: DeviceView }).device.instance).toMatchObject({
      status: "running",
      lastUsedAt: expect.any(String),
    });
  });
});

describe("device providers (device-provider spec §6.1)", () => {
  it("POST /devices with provider binds the device to it for life", async () => {
    const m = await member();
    const before = new Set(await fakeFileSystems(root));
    const onB = await create(m.req, "On B", "device-fake-b");
    expect(onB).toMatchObject({ provider: "device-fake-b", available: true, dialIn: false });
    const created = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("target", "=", onB.id)
      .where("action", "=", "device.created")
      .executeTakeFirstOrThrow();
    expect(created.detail).toMatchObject({ name: "On B", provider: "device-fake-b" });
    // its files are made at its own provider, never at the org's default one
    const conversationId = randomUUID();
    await sandbox.withSandbox(
      {
        orgId,
        deviceId: onB.id,
        holderConversationId: conversationId,
        actor: { accountId: m.id, conversationId },
      },
      (h, p, _i, sig) => p.writeFile(h, "/workspace/b.txt", new TextEncoder().encode("b"), sig),
      ctl(),
    );
    expect(await fakeFileSystems(rootB)).toHaveLength(1);
    expect(new Set(await fakeFileSystems(root))).toEqual(before);
    // a later change of the org's default leaves it where it is
    await setDefaultProvider("device-fake-b");
    try {
      const onA = await create(m.req, "On A", "device-fake");
      const got = await m.req({ method: "GET", url: `${base()}/${onA.id}` });
      expect((got.json() as { device: DeviceView }).device.provider).toBe("device-fake");
    } finally {
      await setDefaultProvider("device-fake");
    }
    const again = await m.req({ method: "GET", url: `${base()}/${onB.id}` });
    expect((again.json() as { device: DeviceView }).device.provider).toBe("device-fake-b");
  });

  it("POST /devices without provider uses the org default; with none answers device.provider_required", async () => {
    const m = await member();
    expect((await create(m.req, "Default one")).provider).toBe("device-fake");
    const created = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("actor_account_id", "=", m.id)
      .where("action", "=", "device.created")
      .executeTakeFirstOrThrow();
    expect(created.detail).toMatchObject({ provider: "device-fake" });
    const service = k.app.get(DevicesService);
    for (const stale of [null, "nope"]) {
      // no default, or one naming no provider on in the org: never bound to another provider
      await setDefaultProvider(stale);
      try {
        const count = await countDevices(m.id);
        const res = await m.req({ method: "POST", url: base(), payload: { name: "No default" } });
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json()).toMatchObject({
          error: {
            code: "device.provider_required",
            message: "Choose a device provider: device-fake, device-fake-b",
          },
        });
        expect(await countDevices(m.id)).toBe(count);
        // the precheck answers the same, and naming one still works
        expect(
          await service.checkCreate(orgId, m.id, "No default").catch((e: ApiError) => e.code),
        ).toBe("device.provider_required");
        expect((await create(m.req, `Named ${stale}`, "device-fake-b")).provider).toBe(
          "device-fake-b",
        );
      } finally {
        await setDefaultProvider("device-fake");
      }
    }
  });

  it("POST /devices naming a provider off in the org, @local or an unknown name is refused and creates nothing", async () => {
    const m = await member();
    await list(m.req); // makes the default
    const before = await countDevices(m.id);
    const service = k.app.get(DevicesService);
    await setEnabled("device-fake-b", false);
    try {
      for (const provider of [
        "device-fake-b",
        "@in-process",
        "nope",
        "Device-Fake",
        "a".repeat(60),
      ]) {
        const res = await m.req({ method: "POST", url: base(), payload: { name: "x", provider } });
        expect(res.statusCode, provider).toBe(400);
        const error = (res.json() as { error: { code: string; details?: { path: string }[] } })
          .error;
        expect(error.code, provider).toBe("validation_failed");
        expect(error.details?.map((d) => d.path)).toEqual(["provider"]);
        expect(
          await service.checkCreate(orgId, m.id, "x", provider).catch((e: ApiError) => e.code),
        ).toBe("validation_failed");
      }
      expect(await countDevices(m.id)).toBe(before);
    } finally {
      await setEnabled("device-fake-b", true);
    }
    expect((await create(m.req, "x", "device-fake-b")).provider).toBe("device-fake-b");
  });

  it("GET /devices lists the providers on in the org and the default provider; no cloudAvailable", async () => {
    const m = await member();
    const l = await list(m.req);
    expect(l).not.toHaveProperty("cloudAvailable");
    expect(l.providers.map((p) => p.plugin)).toEqual(["device-fake", "device-fake-b"]);
    for (const p of l.providers) expect(p).toHaveProperty("displayName");
    expect(l.defaultProvider).toBe("device-fake");
    await setEnabled("device-fake", false);
    try {
      // the default switched off reads as none, never as another provider
      const off = await list(m.req);
      expect(off.providers.map((p) => p.plugin)).toEqual(["device-fake-b"]);
      expect(off.defaultProvider).toBeNull();
    } finally {
      await setEnabled("device-fake", true);
    }
    // another org of the person's sees its own providers only (none switched on there)
    const otherOrg = await createOrg(owner, `Providers ${randomUUID().slice(0, 6)}`);
    const there = await owner({ method: "GET", url: `/api/v1/orgs/${otherOrg}/devices` });
    expect(there.statusCode, there.body).toBe(200);
    expect(there.json()).toMatchObject({ providers: [], defaultProvider: null, defaultId: null });
  });

  it("a device whose provider is switched off lists as available false with its stored report", async () => {
    const m = await member();
    const onB = await create(m.req, "Report", "device-fake-b");
    const conversationId = randomUUID();
    await sandbox.withSandbox(
      {
        orgId,
        deviceId: onB.id,
        holderConversationId: conversationId,
        actor: { accountId: m.id, conversationId },
      },
      async () => "ran",
      ctl(),
    );
    const stored = await waitFor(
      async () => {
        const res = await m.req({ method: "GET", url: `${base()}/${onB.id}` });
        return (res.json() as { device: DeviceView }).device.report;
      },
      15_000,
      "the device report to be stored",
    );
    expect(stored).toMatchObject({ description: { en: "Second test device" }, reset: true });
    await setEnabled("device-fake-b", false);
    try {
      const l = await list(m.req);
      expect(l.items.find((e) => e.id === onB.id)).toMatchObject({
        provider: "device-fake-b",
        available: false,
        report: stored,
      });
      expect(l.items.find((e) => e.id === onB.id)).not.toHaveProperty("demotedFrom");
      // the person's default on device-fake is untouched
      expect(l.items.find((e) => e.isDefault)).toMatchObject({
        provider: "device-fake",
        available: true,
      });
    } finally {
      await setEnabled("device-fake-b", true);
    }
  });
});

describe("a cloud device's sandbox network (approval-only profiles design)", () => {
  const patch = (req: Req, id: string, payload: Record<string, unknown>) =>
    req({ method: "PATCH", url: `${base()}/${id}`, payload });
  const networkAudits = (id: string) =>
    db
      .selectFrom("audit_events")
      .select(["actor_account_id", "detail"])
      .where("target", "=", id)
      .where("action", "=", "device.network_changed")
      .orderBy("at")
      .orderBy("id")
      .execute();
  const setOrgNetwork = async (deviceNetwork: unknown) => {
    const res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { deviceNetwork },
    });
    expect(res.statusCode, res.body).toBe(200);
  };
  const viewOf = (res: { json(): unknown }) => (res.json() as { device: DeviceView }).device;

  /** A Full access conversation on the device and an admitted open-network operation in it. */
  async function fullAccessWork(accountId: string, deviceId: string) {
    const agentId = randomUUID();
    const conversationId = randomUUID();
    await db
      .insertInto("agents")
      .values({
        id: agentId,
        org_id: orgId,
        owner_account_id: accountId,
        visibility: "org",
        current_version: 1,
      })
      .execute();
    await db
      .insertInto("conversations")
      .values({
        id: conversationId,
        org_id: orgId,
        account_id: accountId,
        agent_id: agentId,
        title: null,
        source: "web",
        device_id: deviceId,
        permission_profile: "full-access",
        permission_consent: JSON.stringify({ deviceId, scopeRevision: "test" }),
      })
      .execute();
    const intent = async (network: Record<string, unknown>) => {
      const operationId = randomUUID();
      const scope = {
        operationId,
        deviceId,
        rootConversationId: conversationId,
        profileRevision: 0,
        ceilingRevision: "test",
        profile: "full-access",
        actor: { accountId, conversationId },
        tag: "test",
        filesystem: { kind: "scoped", projectRoot: "/w", writeRoots: ["/w"] },
        network,
      };
      await db
        .insertInto("sandbox_operation_intents")
        .values({
          operation_id: operationId,
          org_id: orgId,
          account_id: accountId,
          device_id: deviceId,
          root_conversation_id: conversationId,
          conversation_id: conversationId,
          run_id: null,
          call_id: null,
          ordinal: 0,
          method: "exec",
          input_hash: "a".repeat(64),
          admission_hash: "b".repeat(64),
          input: "{}",
          scope: JSON.stringify(scope),
          epochs: JSON.stringify({ platform: 0, org: 0, device: 0, root: 0 }),
          provider: "device-fake",
          provider_version: "test",
          instance_generation: "test",
          deadline: new Date(Date.now() + 30_000),
          retain_until: new Date(Date.now() + 60_000),
          state: "admitted",
          execution_id: randomUUID(),
        })
        .execute();
      return operationId;
    };
    const stateOf = async (operationId: string) =>
      (
        await db
          .selectFrom("sandbox_operation_intents")
          .select("state")
          .where("operation_id", "=", operationId)
          .executeTakeFirstOrThrow()
      ).state;
    const profile = async () =>
      (
        await db
          .selectFrom("conversations")
          .select("permission_profile")
          .where("id", "=", conversationId)
          .executeTakeFirstOrThrow()
      ).permission_profile;
    return { conversationId, intent, stateOf, profile };
  }

  it("follows the org by default; the owner narrows it to the allowlist, audited and listed", async () => {
    await setOrgNetwork(null);
    const me = await member();
    const env = await create(me.req, "Net");
    expect(env.sandbox).toMatchObject({ network: "open", ownNetwork: null });
    expect(env.limits.network).toEqual({ kind: "open-public", hosts: [] });

    const set = await patch(me.req, env.id, { network: { mode: "allowlist" } });
    expect(set.statusCode, set.body).toBe(200);
    const view = viewOf(set);
    // an allowlist with no hosts of its own follows the org's hosts
    expect(view.sandbox).toMatchObject({
      network: "allowlist",
      ownNetwork: "allowlist",
      allowedDomains: [],
      hosts: expect.arrayContaining(["registry.npmjs.org"]),
    });
    expect(view.limits.network).toMatchObject({ kind: "allowlist" });
    expect(view.sandbox.recent[0]).toMatchObject({
      kind: "network",
      network: { from: { mode: null, hosts: [] }, to: { mode: "allowlist", hosts: [] } },
      via: "web",
    });
    expect(view.sandbox.recent[0]).not.toHaveProperty("outcome");
    expect(await networkAudits(env.id)).toEqual([
      {
        actor_account_id: me.id,
        detail: {
          from: { mode: null, hosts: [] },
          to: { mode: "allowlist", hosts: [] },
          by: me.id,
          via: "web",
        },
      },
    ]);
    // the same setting again changes nothing; a rename and the network in one request
    const both = await patch(me.req, env.id, { name: "Net 2", network: { mode: "allowlist" } });
    expect(both.statusCode, both.body).toBe(200);
    expect(viewOf(both).name).toBe("Net 2");
    expect(await networkAudits(env.id)).toHaveLength(1);

    // its own hosts only narrow the org's; closed; then back to following the org
    const narrowed = await patch(me.req, env.id, {
      network: { mode: "allowlist", hosts: ["registry.npmjs.org"] },
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(viewOf(narrowed).sandbox).toMatchObject({
      hosts: ["registry.npmjs.org"],
      allowedDomains: ["registry.npmjs.org"],
    });
    const closed = await patch(me.req, env.id, { network: { mode: "none" } });
    expect(viewOf(closed).sandbox).toMatchObject({ network: "none", hosts: [] });
    const back = await patch(me.req, env.id, { network: { mode: null } });
    expect(viewOf(back).sandbox).toMatchObject({ network: "open", ownNetwork: null });
    expect(viewOf(back).sandbox.recent.map((r) => r.network?.to.mode)).toEqual([
      null,
      "none",
      "allowlist",
      "allowlist",
    ]);
  });

  it("above the org's ceiling, or a host outside the org's list → 400 device.network_not_allowed", async () => {
    await setOrgNetwork({ ceiling: "allowlist" });
    try {
      const me = await member();
      const env = await create(me.req, "Capped");
      expect(env.sandbox).toMatchObject({
        network: "allowlist",
        networkCeiling: "allowlist",
        layer: { network: "org" },
      });
      const open = await patch(me.req, env.id, { network: { mode: "open" } });
      expect(open.statusCode, open.body).toBe(400);
      expect(errCode(open)).toBe("device.network_not_allowed");
      const host = await patch(me.req, env.id, {
        network: { mode: "allowlist", hosts: ["evil.example.org"] },
      });
      expect(host.statusCode, host.body).toBe(400);
      expect(errCode(host)).toBe("device.network_not_allowed");
      expect(JSON.stringify(host.json())).toContain("an organization admin adds evil.example.org");
      // nothing was written
      const row = await db
        .selectFrom("devices")
        .select(["network_mode", "network_hosts"])
        .where("id", "=", env.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ network_mode: null, network_hosts: [] });
      expect(await networkAudits(env.id)).toEqual([]);
    } finally {
      await setOrgNetwork(null);
    }
  });

  it("addNetworkHostsIn adds within the org's hosts, like PATCH; refuses outside them or with no own list", async () => {
    await setOrgNetwork({ extraHosts: ["a.dev", "b.dev"] });
    try {
      const me = await member();
      const env = await create(me.req, "Adds");
      const svc = k.app.get(DevicesService);
      const refused = async (hosts: string[]) => {
        const err = await svc.addNetworkHostsIn(orgId, me.id, env.id, hosts, "web").then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(ApiError);
        expect(err).toMatchObject({ code: "device.network_not_allowed" });
        return (err as ApiError).message;
      };
      // following its org (mode null) or the org's whole allowlist: every addable host is in
      expect(await refused(["b.dev"])).toContain("follows its organization's hosts");
      expect((await patch(me.req, env.id, { network: { mode: "allowlist" } })).statusCode).toBe(
        200,
      );
      await refused(["b.dev"]);

      const own = await patch(me.req, env.id, { network: { mode: "allowlist", hosts: ["a.dev"] } });
      expect(own.statusCode, own.body).toBe(200);
      const audits = (await networkAudits(env.id)).length;
      const epoch = async () =>
        (
          await db
            .selectFrom("permission_authority_epochs")
            .select("revision")
            .where("kind", "=", "device")
            .where("id", "=", env.id)
            .executeTakeFirst()
        )?.revision ?? 0;
      const before = await epoch();
      await svc.addNetworkHostsIn(orgId, me.id, env.id, ["B.dev"], "im");
      const view = viewOf(await me.req({ method: "GET", url: `${base()}/${env.id}` }));
      expect(view.sandbox.allowedDomains).toEqual(["a.dev", "b.dev"]);
      expect(view.sandbox.hosts).toEqual(["a.dev", "b.dev"]);
      expect(view.sandbox.recent[0]).toMatchObject({
        kind: "network",
        network: {
          from: { mode: "allowlist", hosts: ["a.dev"] },
          to: { mode: "allowlist", hosts: ["a.dev", "b.dev"] },
        },
        via: "im",
      });
      const rows = await networkAudits(env.id);
      expect(rows).toHaveLength(audits + 1);
      expect(rows.at(-1)).toEqual({
        actor_account_id: me.id,
        detail: {
          from: { mode: "allowlist", hosts: ["a.dev"] },
          to: { mode: "allowlist", hosts: ["a.dev", "b.dev"] },
          by: me.id,
          via: "im",
        },
      });
      expect(await epoch()).toBeGreaterThan(before);
      // a host already listed changes nothing
      await svc.addNetworkHostsIn(orgId, me.id, env.id, ["a.dev"], "web");
      expect(await networkAudits(env.id)).toHaveLength(audits + 1);

      // a host outside the org's list, even next to an addable one: nothing is written
      expect(await refused(["x.dev"])).toContain("an organization admin adds x.dev");
      await setOrgNetwork({ extraHosts: ["a.dev", "b.dev", "c.dev"], excludedHosts: ["pypi.org"] });
      await refused(["c.dev", "x.dev"]);
      // a platform host the org excludes
      await refused(["pypi.org"]);
      expect(await networkAudits(env.id)).toHaveLength(audits + 1);

      const tx = k.app.get(TransactionHost);
      const ownHosts = async () =>
        (
          await db
            .selectFrom("devices")
            .select(["network_hosts"])
            .where("id", "=", env.id)
            .executeTakeFirstOrThrow()
        ).network_hosts;
      // in a caller's transaction without the prelude's device write lock: refused, nothing written
      await expect(
        tx.run(() => svc.addNetworkHostsIn(orgId, me.id, env.id, ["c.dev"], "web")),
      ).rejects.toThrow("The matching authority lock is required");
      expect(await ownHosts()).toEqual(["a.dev", "b.dev"]);
      // it joins the caller's transaction after the caller's prelude: a rollback there takes the
      // addition with it
      const inCaller = (fn: () => Promise<void>) =>
        withOrderedLocks(
          () => svc.lockNetworkAddSubject(orgId, me.id, env.id),
          () => tx.run(fn),
        );
      await expect(
        inCaller(async () => {
          await svc.addNetworkHostsIn(orgId, me.id, env.id, ["c.dev"], "web");
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");
      expect(await ownHosts()).toEqual(["a.dev", "b.dev"]);
      expect(await networkAudits(env.id)).toHaveLength(audits + 1);
      // and commits with it
      await inCaller(() => svc.addNetworkHostsIn(orgId, me.id, env.id, ["c.dev"], "web"));
      expect(await ownHosts()).toEqual(["a.dev", "b.dev", "c.dev"]);
      expect(await networkAudits(env.id)).toHaveLength(audits + 2);
      // the prelude needs a transaction and the person's own device
      await expect(svc.lockNetworkAddSubject(orgId, me.id, env.id)).rejects.toThrow();

      // a host an own wildcard already covers changes nothing (no audit row, no epoch bump)
      await setOrgNetwork({ extraHosts: ["a.dev", "b.dev", "c.dev", "*.w.dev"] });
      await patch(me.req, env.id, { network: { mode: "allowlist", hosts: ["a.dev", "*.w.dev"] } });
      const wildAudits = (await networkAudits(env.id)).length;
      const wildEpoch = await epoch();
      await svc.addNetworkHostsIn(orgId, me.id, env.id, ["x.w.dev"], "web");
      expect(await networkAudits(env.id)).toHaveLength(wildAudits);
      expect(await epoch()).toBe(wildEpoch);
      // an own host the org dropped since leaves the list with the next addition
      await setOrgNetwork({ extraHosts: ["b.dev", "c.dev", "*.w.dev"] });
      await svc.addNetworkHostsIn(orgId, me.id, env.id, ["b.dev"], "web");
      expect(await ownHosts()).toEqual(["*.w.dev", "b.dev"]);

      // closed: refused; another member's device: not found
      const other = await member();
      await expect(
        svc.addNetworkHostsIn(orgId, other.id, env.id, ["c.dev"], "web"),
      ).rejects.toMatchObject({ code: "device.not_found" });
      expect((await patch(me.req, env.id, { network: { mode: "none" } })).statusCode).toBe(200);
      await refused(["c.dev"]);
    } finally {
      await setOrgNetwork(null);
    }
  });

  it("a narrowing revokes open-network work and keeps Full consent; a widening resets it", async () => {
    await setOrgNetwork(null);
    const me = await member();
    const env = await create(me.req, "Revoke");
    const w = await fullAccessWork(me.id, env.id);
    const openWork = await w.intent({ kind: "open-public" });
    const listed = await w.intent({ kind: "allowlist", hosts: ["registry.npmjs.org"] });

    const narrowed = await patch(me.req, env.id, { network: { mode: "allowlist" } });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(await w.stateOf(openWork)).toBe("revoked");
    expect(await w.stateOf(listed)).toBe("admitted");
    expect(await w.profile()).toBe("full-access");

    const widened = await patch(me.req, env.id, { network: { mode: "open" } });
    expect(widened.statusCode, widened.body).toBe(200);
    expect(await w.profile()).toBe("approve-for-me");
    const changed = await db
      .selectFrom("conversation_events")
      .select("type")
      .where("conversation_id", "=", w.conversationId)
      .where("type", "=", "permission_profile_changed")
      .execute();
    expect(changed).toHaveLength(1);
  });

  it("an API token may only narrow it (a rename still works); a dial-in device's network is set the same way", async () => {
    await setOrgNetwork(null);
    const me = await member();
    const env = await create(me.req, "Tokened");
    const { token } = await apiTokensFor(db).createPersonal(me.id, { name: "cli" });
    const viaPat = (payload: Record<string, unknown>) =>
      k.http.inject({
        method: "PATCH",
        url: `${base()}/${env.id}`,
        headers: { authorization: `Bearer ${token}`, "x-capybara-csrf": "1" },
        payload,
      });
    const narrowed = await viaPat({ network: { mode: "allowlist" } });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    for (const network of [{ mode: "open" }, { mode: null }]) {
      const res = await viaPat({ network });
      expect(res.statusCode, res.body).toBe(400);
      expect(errCode(res)).toBe("device.network_not_allowed");
    }
    const renamed = await viaPat({ name: "By token" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    // an API token's change is recorded and listed as the token's
    expect((await networkAudits(env.id)).map((a) => a.detail)).toEqual([
      expect.objectContaining({ to: { mode: "allowlist", hosts: [] }, via: "token" }),
    ]);
    expect(viewOf(renamed).sandbox.recent[0]).toMatchObject({ kind: "network", via: "token" });

    for (const payload of [
      {},
      { network: { mode: "max" } },
      { network: { mode: "open", hosts: ["a.example.com"] } },
      { network: { mode: "allowlist", hosts: ["http://x"] } },
      // the old auto/sandbox switch and the cloud Full ceiling are gone
      { mode: "sandbox" },
      { ownerCeiling: { fullAccess: false } },
    ]) {
      const res = await patch(me.req, env.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
  });

  it("another member or the org's owner changing my device gets not_found", async () => {
    const me = await member();
    const other = await member();
    const env = await create(me.req, "Not yours");
    for (const req of [other.req, owner]) {
      const res = await patch(req, env.id, { network: { mode: "none" } });
      expect(res.statusCode, res.body).toBe(404);
      expect(errCode(res)).toBe("device.not_found");
    }
    expect(await networkAudits(env.id)).toEqual([]);
  });

  it("a used instance is pending until its next use", async () => {
    await setOrgNetwork(null);
    const me = await member();
    const env = await create(me.req, "Used");
    const conversationId = randomUUID();
    await sandbox.withSandbox(
      {
        orgId,
        deviceId: env.id,
        holderConversationId: conversationId,
        actor: { accountId: me.id, conversationId },
      },
      async () => null,
      ctl(),
    );
    const set = await patch(me.req, env.id, { network: { mode: "allowlist" } });
    expect(set.statusCode, set.body).toBe(200);
    expect(viewOf(set).sandbox).toMatchObject({ pendingNextUse: true });
  });
});
