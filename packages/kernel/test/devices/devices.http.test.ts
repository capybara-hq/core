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
import type { DeviceView } from "../../src/devices/devices.service.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { ApiError } from "../../src/errors.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { fakeFileSystems, removeFakeFileSystem } from "../fixtures/plugins/sandbox-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
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
let sandbox: SandboxService;
let ownerId: string;
let owner: Req;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-device-http-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [fixture("sandbox-fake")],
        extensionConfig: { "sandbox-fake": { root } },
        devices: { maxPersonal: MAX },
      },
    ),
  );
  sandbox = k.app.get(SandboxService);
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

type List = {
  items: DeviceView[];
  defaultId: string | null;
  lastUsedId: string | null;
  cloudAvailable: boolean;
};

async function list(req: Req): Promise<List> {
  const res = await req({ method: "GET", url: base() });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as List;
}

async function create(req: Req, name: string): Promise<DeviceView> {
  const res = await req({ method: "POST", url: base(), payload: { name } });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { device: DeviceView }).device;
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
      source: "cloud",
      provider: "sandbox-fake",
      available: true,
      sessionIsolation: false,
      filesLost: false,
      instance: null,
      limits: {
        mode: expect.any(String),
        network: { kind: expect.any(String), hosts: expect.any(Array) },
      },
    });
    expect(typeof env.createdAt).toBe("string");

    const l = await list(m.req);
    expect(l.cloudAvailable).toBe(true);
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

  it("delete waits for running commands then destroys both", { timeout: 60_000 }, async () => {
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

  it("reset files after files_lost", { timeout: 60_000 }, async () => {
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

describe("a cloud device's narrowing mode switch (auto mode spec §4.3)", () => {
  const patch = (req: Req, id: string, payload: Record<string, unknown>) =>
    req({ method: "PATCH", url: `${base()}/${id}`, payload });
  const modeAudits = (id: string) =>
    db
      .selectFrom("audit_events")
      .select(["actor_account_id", "detail"])
      .where("target", "=", id)
      .where("action", "=", "device.mode_changed")
      .orderBy("at")
      .orderBy("id")
      .execute();
  const setOrgNetwork = async (cloudNetwork: unknown) => {
    const res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { cloudNetwork },
    });
    expect(res.statusCode, res.body).toBe(200);
  };

  it("defaults to auto; the owner narrows it to sandbox, which applies the org's allowlist", async () => {
    await setOrgNetwork({ mode: "allowlist" });
    const me = await member();
    const env = await create(me.req, "Mode");
    expect(env.mode).toMatchObject({
      mode: "auto",
      allowedMode: "auto",
      allowedBy: "platform",
    });
    expect(env.limits).toMatchObject({ mode: "auto", network: { kind: "open-public" } });

    const set = await patch(me.req, env.id, { mode: "sandbox" });
    expect(set.statusCode, set.body).toBe(200);
    const view = (set.json() as { device: DeviceView }).device;
    expect(view.mode).toMatchObject({ mode: "sandbox", allowedMode: "auto" });
    expect(view.limits).toMatchObject({
      mode: "sandbox",
      network: { kind: "allowlist" },
    });
    expect(view.mode.recent[0]).toMatchObject({
      kind: "mode",
      mode: { from: "auto", to: "sandbox" },
      via: "web",
      outcome: "applied",
    });
    expect(await modeAudits(env.id)).toEqual([
      {
        actor_account_id: me.id,
        detail: { from: "auto", to: "sandbox", by: me.id, via: "web" },
      },
    ]);

    // the same narrow mode again changes nothing; a rename and the mode in one request
    expect((await patch(me.req, env.id, { mode: "sandbox" })).statusCode).toBe(200);
    const both = await patch(me.req, env.id, { name: "Mode 2", mode: "sandbox" });
    expect(both.statusCode, both.body).toBe(200);
    expect((both.json() as { device: DeviceView }).device).toMatchObject({
      name: "Mode 2",
      mode: { mode: "sandbox" },
    });
    expect(await modeAudits(env.id)).toHaveLength(1);
    // a cloud device can never be switched back to auto from the web
    expect((await patch(me.req, env.id, { mode: "auto" })).statusCode).toBe(400);
  });

  it("a used instance is pending until its next use", { timeout: 60_000 }, async () => {
    await setOrgNetwork({ mode: "allowlist" });
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
    const set = await patch(me.req, env.id, { mode: "sandbox" });
    expect(set.statusCode, set.body).toBe(200);
    expect((set.json() as { device: DeviceView }).device.mode).toMatchObject({
      pendingNextUse: true,
    });
  });

  it("another member or the org's owner switching my device gets not_found", async () => {
    const me = await member();
    const other = await member();
    const env = await create(me.req, "Not yours");
    for (const req of [other.req, owner]) {
      const res = await patch(req, env.id, { mode: "sandbox" });
      expect(res.statusCode, res.body).toBe(404);
      expect(errCode(res)).toBe("device.not_found");
    }
    const mine = await me.req({ method: "GET", url: `${base()}/${env.id}` });
    expect((mine.json() as { device: DeviceView }).device.mode.mode).toBe("auto");
    expect(await modeAudits(env.id)).toEqual([]);
  });

  it("an API token cannot set it (a rename still works); a local device's mode is its machine's", async () => {
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
    const narrowed = await viaPat({ mode: "sandbox" });
    expect(narrowed.statusCode, narrowed.body).toBe(403);
    expect(errCode(narrowed)).toBe("auth.session_required");
    const renamed = await viaPat({ name: "By token" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(await modeAudits(env.id)).toEqual([]);

    for (const payload of [{}, { mode: "max" }, { mode: "sandbox", x: 1 }]) {
      const res = await patch(me.req, env.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }

    const local = await k.app
      .get(TransactionHost)
      .run(() => k.app.get(DevicesService).createLocal(orgId, me.id, "Laptop"));
    const res = await patch(me.req, local.id, { mode: "sandbox" });
    expect(res.statusCode, res.body).toBe(409);
    expect(errCode(res)).toBe("device.mode_on_device");
  });
});
