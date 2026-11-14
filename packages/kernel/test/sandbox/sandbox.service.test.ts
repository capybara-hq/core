import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SANDBOX_ROOTS,
  isSandboxGoneError,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { SandboxLeases } from "../../src/sandbox/leases.js";
import { SandboxLockLostError, type SandboxService } from "../../src/sandbox/sandbox.service.js";
import {
  createFakeSandbox,
  fakeFileSystems,
  fakeSandboxMeta,
  fakeSandboxState,
  readFakeSandboxOps,
  removeFakeFileSystem,
  removeFakeSandbox,
  setFakeFileSystemIdsByName,
  setFakeSandboxDelays,
} from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import {
  type SandboxServiceDeps,
  sandboxLeasesFor,
  sandboxServiceFor,
  seedDevice,
} from "../helpers/sandbox.js";

/**
 * The kernel sandbox service keyed by device (spec 2026-11-07-environments-design §4.2, §5.1):
 * a lazily created file system plus instance per device, leases, idle suspension, forced
 * suspension, destruction of the instance after inactivity (files kept), rebuild on `gone`, lost
 * files, file reset and device deletion.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let config: KernelConfig;
let root: string;
let provider: SandboxProvider | undefined;
const warned: string[] = [];
const log = { info() {}, warn: (m: string) => void warned.push(m), error() {} };

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const later = (ms: number) => new Date(Date.now() + ms);
const signal = () => AbortSignal.timeout(30_000);

const service = (
  p: () => SandboxProvider | undefined = () => provider,
  plugin = "sandbox-fake",
  extra: Partial<SandboxServiceDeps> = {},
) =>
  sandboxServiceFor({
    db,
    redis,
    provider: () => {
      const impl = p();
      return impl ? { plugin, impl } : undefined;
    },
    config: () => config,
    log,
    lockPollMs: 20,
    ...extra,
  });

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rdc.url);
});

afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

let orgId: string;
/** The org creator: owner of the devices and of the holder conversation. */
let accountId: string;
let envId: string;
/** The agent conversation holding the sandbox (the actor of its commands). */
let conversationId: string;

async function newConversation(org = orgId): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    SELECT ${id}, o.id, (SELECT a.id FROM capybara.agents a WHERE a.org_id = o.id LIMIT 1), o.created_by
    FROM capybara.orgs o WHERE o.id = ${org}`.execute(raw);
  return id;
}

const newDevice = (org = orgId) => seedDevice(raw, org);

async function newOrg(): Promise<string> {
  const owner = randomUUID();
  const id = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${owner}, 'U')`.execute(raw);
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${id}, ${`o-${id.slice(0, 8)}`}, 'O', ${owner})`.execute(raw);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${randomUUID()}, ${id}, ${owner}, 'org', 1)`.execute(raw);
  return id;
}

beforeEach(async () => {
  warned.length = 0;
  await redis.flushdb();
  await truncateTables(
    raw,
    "capybara.device_instances, capybara.devices, capybara.accounts, capybara.orgs",
  );
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-"));
  provider = createFakeSandbox(root);
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  orgId = await newOrg();
  accountId = (
    await sql<{
      created_by: string;
    }>`SELECT created_by FROM capybara.orgs WHERE id = ${orgId}`.execute(raw)
  ).rows[0]?.created_by as string;
  envId = await newDevice();
  conversationId = await newConversation();
});

/** The `withSandbox` context of the holder conversation in a device. */
const at = (env = envId, org = orgId, holder = conversationId) => ({
  orgId: org,
  deviceId: env,
  holderConversationId: holder,
  actor: { accountId, conversationId: holder },
});

const row = (id = envId) =>
  db.selectFrom("device_instances").selectAll().where("device_id", "=", id).executeTakeFirst();
/** Waits until the fake records a running command (`instances/<id>/procs/<pid>`), instead of a fixed wait. */
async function waitForProc(id: string, timeoutMs = 10_000): Promise<void> {
  const dir = join(root, "instances", id, "procs");
  await vi.waitFor(
    async () => {
      if ((await readdir(dir).catch(() => [])).length === 0) {
        throw new Error(`no running command registered for ${id} yet`);
      }
    },
    { timeout: timeoutMs },
  );
}

/** Commands run one at a time (the behavior before phase C). */
const oneAtATime = () => {
  config = { ...config, sandbox: { ...config.sandbox, maxConcurrentCommands: 1 } };
};

const ops = async (op?: string) =>
  (await readFakeSandboxOps(root)).filter((o) => op === undefined || o[0] === op);

/** Uses the sandbox once: returns the handle and the use info. */
const use = (s: SandboxService, env = envId, org = orgId) =>
  s.withSandbox(at(env, org), async (h, _p, info) => ({ h, info }), signal());

const text = (s: string) => new TextEncoder().encode(s);
/** Writes `/workspace/<name>` through the sandbox. */
const writeIn = (s: SandboxService, name: string, body: string, env = envId) =>
  s.withSandbox(
    at(env),
    (h, p, _i, sig) => p.writeFile(h, `/workspace/${name}`, text(body), sig),
    signal(),
  );
/** Reads `/workspace/<name>` through the sandbox (null when missing) with the use info. */
const readIn = (s: SandboxService, name: string, env = envId) =>
  s.withSandbox(
    at(env),
    async (h, p, info, sig) => {
      const r = await p.readFile(h, `/workspace/${name}`, { maxBytes: 1000, signal: sig });
      return { info, h, body: r === null ? null : new TextDecoder().decode(r.data) };
    },
    signal(),
  );

describe("没有提供方", () => {
  it("cloudAvailable 为 false；withSandbox 以 sandbox.unavailable（503）失败；扫描什么也不做", async () => {
    const s = service(() => undefined);
    expect(s.cloudAvailable).toBe(false);
    const err = await use(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("sandbox.unavailable");
    expect((err as ApiError).status).toBe(503);
    expect(await s.suspendIdle(later(DAY))).toBe(0);
    expect(await s.destroyInactive(later(30 * DAY))).toBe(0);
    expect(await row()).toBeUndefined();
  });
});

describe("组织云网络设置（auto mode spec §4.3）", () => {
  const setOrg = (value: unknown, org = orgId) =>
    sql`UPDATE capybara.orgs SET settings = ${JSON.stringify(value)}::jsonb
      WHERE id = ${org}`.execute(raw);
  const limitsOf = async (s: SandboxService, id = envId) =>
    (await fakeSandboxMeta(root, (await use(s, id)).h.id))?.limits;

  it("an org allowlist replaces the deployment's hosts; a changed host list reaches only later instances", async () => {
    const s = service();
    await setOrg({
      autoMode: "off",
      cloudNetwork: { mode: "allowlist", allowHosts: ["example.com"] },
    });
    expect(await limitsOf(s, await newDevice())).toMatchObject({
      mode: "sandbox",
      network: { kind: "allowlist", hosts: ["example.com"] },
    });
    await setOrg({ autoMode: "off", cloudNetwork: { mode: "allowlist" } });
    expect(await limitsOf(s, await newDevice())).toMatchObject({
      network: { kind: "allowlist", hosts: config.sandbox.limits.allowHosts },
    });
  });

  it("auto mode ignores the org's network; sandbox mode applies it; a kind change recreates", async () => {
    const s = service();
    // auto mode ignores the org's allowlist: the cloud device's network is open
    await setOrg({
      autoMode: "allowed",
      cloudNetwork: { mode: "allowlist", allowHosts: ["example.com"] },
    });
    const first = await use(s);
    expect((await fakeSandboxMeta(root, first.h.id))?.limits).toMatchObject({
      mode: "auto",
      network: { kind: "open-public" },
    });
    // a host change under the same (ignored) network changes nothing
    await setOrg({
      autoMode: "allowed",
      cloudNetwork: { mode: "allowlist", allowHosts: ["other.example.com"] },
    });
    const same = await use(s);
    expect(same.h).toEqual(first.h);
    // switching to sandbox mode applies the org's allowlist: the instance is recreated
    await setOrg({
      autoMode: "off",
      cloudNetwork: { mode: "allowlist", allowHosts: ["other.example.com"] },
    });
    const again = await use(s);
    expect(again.h).not.toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: true, restarted: true });
    expect((await fakeSandboxMeta(root, again.h.id))?.limits).toMatchObject({
      mode: "sandbox",
      network: { kind: "allowlist", hosts: ["other.example.com"] },
    });
  });
});

describe("lazy creation", () => {
  it("the first use creates the file system, then the instance on it (name cap-device-<device>, no image by default, limits from config); later uses reuse them", async () => {
    const s = service();
    expect(s.cloudAvailable).toBe(true);
    expect(await ops()).toEqual([]);
    const a = await use(s);
    expect(a.info).toEqual({ fresh: true, restarted: false, roots: DEFAULT_SANDBOX_ROOTS });
    // the default mode is auto: the open public network
    const limits = {
      cpu: 1,
      memoryMb: 2048,
      diskMb: 5120,
      mode: "auto",
      network: { kind: "open-public", hosts: [] },
    };
    const meta = await fakeSandboxMeta(root, a.h.id);
    expect(meta).toEqual({
      name: `cap-device-${envId}`,
      image: null,
      fileSystem: expect.any(String),
      limits,
    });
    expect(await ops("create-fs")).toEqual([
      ["create-fs", meta?.fileSystem, `cap-device-${envId}`],
    ]);
    const r = await row();
    expect(r).toMatchObject({
      org_id: orgId,
      provider: "sandbox-fake",
      status: "running",
      fs_status: "ready",
      fs_handle: { id: meta?.fileSystem },
    });
    expect(r?.handle).toEqual(a.h);

    const b = await use(s);
    expect(b.info).toEqual({ fresh: false, restarted: false, roots: DEFAULT_SANDBOX_ROOTS });
    expect(b.h).toEqual(a.h);
    expect(await ops("create")).toHaveLength(1);
    expect(await ops("create-fs")).toHaveLength(1);
  });

  it("passes sandbox.image to the provider when it is set", async () => {
    config = { ...config, sandbox: { ...config.sandbox, image: "custom:1" } };
    const a = await use(service());
    expect((await fakeSandboxMeta(root, a.h.id))?.image).toBe("custom:1");
  });

  it("devices are separate: each gets its own file system and instance", async () => {
    const s = service();
    const other = await newDevice();
    const a = await use(s);
    const b = await use(s, other);
    expect(b.h).not.toEqual(a.h);
    expect((await fakeFileSystems(root)).length).toBe(2);
  });

  it("with maxConcurrentCommands 1, concurrent calls of one conversation queue: one create, no overlap", async () => {
    oneAtATime();
    await setFakeSandboxDelays(root, { create: 200 });
    const s = service();
    let active = 0;
    let overlap = false;
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        s.withSandbox(
          at(),
          async (h, _p, info) => {
            active++;
            if (active > 1) overlap = true;
            await new Promise((r) => setTimeout(r, 30));
            active--;
            return { h, info };
          },
          signal(),
        ),
      ),
    );
    expect(overlap).toBe(false);
    expect(await ops("create")).toHaveLength(1);
    expect(new Set(results.map((r) => r.h.id)).size).toBe(1);
    expect(results.filter((r) => r.info.fresh)).toHaveLength(1);
  });

  it("执行完更新 last_used_at（fn 抛错也更新），fn 的错误原样抛出", async () => {
    const s = service();
    await use(s);
    await sql`UPDATE capybara.device_instances SET last_used_at = now() - interval '1 hour'`.execute(
      raw,
    );
    const err = await s
      .withSandbox(
        at(),
        async () => {
          throw new Error("boom");
        },
        signal(),
      )
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("boom");
    const r = await row();
    expect(Date.now() - (r as { last_used_at: Date }).last_used_at.getTime()).toBeLessThan(MIN);
  });

  it("a failed create is thrown to the caller; the next call creates the instance on the file system already made", async () => {
    let fail = true;
    const base = createFakeSandbox(root);
    const flaky: SandboxProvider = {
      ...base,
      create: async (a) => {
        if (fail) throw new Error("docker down");
        return base.create(a);
      },
    };
    const s = service(() => flaky);
    // sandbox mode: the deployment allowlist, so a failure is not attributed to the open network
    await sql`UPDATE capybara.orgs SET settings =
      '{"autoMode":"off","cloudNetwork":{"mode":"allowlist"}}'::jsonb
      WHERE id = ${orgId}`.execute(raw);
    // the provider's own message stays in the log
    await expect(use(s)).rejects.toMatchObject({ code: "sandbox.create_failed" });
    fail = false;
    const a = await use(s);
    expect(a.info).toEqual({ fresh: true, restarted: false, roots: DEFAULT_SANDBOX_ROOTS });
    expect((await row())?.status).toBe("running");
    expect(await ops("create-fs")).toHaveLength(1);
  });

  it("a caller aborted while waiting fails with the abort reason and creates nothing", async () => {
    oneAtATime();
    const s = service();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const inside = new Promise<void>((r) => {
      entered = r;
    });
    const holder = s.withSandbox(
      at(),
      async () => {
        entered();
        await gate;
      },
      signal(),
    );
    await inside;
    const ac = new AbortController();
    const waiting = s.withSandbox(at(), async () => "x", ac.signal);
    ac.abort(new Error("run aborted"));
    await expect(waiting).rejects.toThrow("run aborted");
    release();
    await holder;
    expect(await ops("create")).toHaveLength(1);
  });
});

describe("空闲休眠（审查重点 3）", () => {
  it("空闲超过 suspendAfterIdleMinutes 后被休眠；下次调用透明恢复（不是新沙箱）", async () => {
    const s = service();
    const a = await use(s);
    expect(await s.suspendIdle(later(5 * MIN))).toBe(0);
    expect(await s.suspendIdle(later(11 * MIN))).toBe(1);
    expect((await row())?.status).toBe("suspended");
    expect(await fakeSandboxState(root, a.h.id)).toBe("suspended");

    const b = await use(s);
    expect(b.info).toEqual({ fresh: false, restarted: false, roots: DEFAULT_SANDBOX_ROOTS });
    expect(b.h).toEqual(a.h);
    expect(await ops("resume")).toEqual([["resume", a.h.id]]);
    expect((await row())?.status).toBe("running");
    expect(await fakeSandboxState(root, a.h.id)).toBe("running");
  });

  it("休眠后文件保留", async () => {
    const s = service();
    await s.withSandbox(
      at(),
      (h, p) => p.writeFile(h, "/workspace/a.txt", new TextEncoder().encode("hi"), signal()),
      signal(),
    );
    await s.suspendIdle(later(11 * MIN));
    const text = await s.withSandbox(
      at(),
      async (h, p) => {
        const r = await p.readFile(h, "/workspace/a.txt", { maxBytes: 100, signal: signal() });
        return new TextDecoder().decode(r?.data);
      },
      signal(),
    );
    expect(text).toBe("hi");
  });

  it("持续运行超过 maxRunningMinutes 的沙箱即使一直在用也被强制休眠", async () => {
    const s = service();
    await use(s);
    // 一直在用（last_used_at 刚更新），但已连续运行 3 小时
    await sql`UPDATE capybara.device_instances SET running_since = now() - interval '3 hours'`.execute(
      raw,
    );
    expect(await s.suspendIdle(new Date())).toBe(1);
    expect((await row())?.status).toBe("suspended");
  });

  it("命令正在执行（锁被持有）时不休眠，跳过", async () => {
    const s = service();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const inside = new Promise<void>((r) => {
      entered = r;
    });
    const running = s.withSandbox(
      at(),
      async () => {
        entered();
        await gate;
      },
      signal(),
    );
    await inside;
    await sql`UPDATE capybara.device_instances SET running_since = now() - interval '3 hours',
      last_used_at = now() - interval '1 hour'`.execute(raw);
    expect(await s.suspendIdle(new Date())).toBe(0);
    expect(await s.destroyInactive(later(30 * DAY))).toBe(0);
    expect((await row())?.status).toBe("running");
    release();
    await running;
  });
});

describe("the provider reports the instance gone", () => {
  it("an instance gone while suspended is rebuilt on the same files: restarted is true", async () => {
    const s = service();
    await writeIn(s, "a.txt", "hi");
    const a = (await use(s)).h;
    await s.suspendIdle(later(11 * MIN));
    await removeFakeSandbox(root, a.id);

    const b = await readIn(s, "a.txt");
    expect(b.info).toEqual({ fresh: true, restarted: true, roots: DEFAULT_SANDBOX_ROOTS });
    expect(b.h.id).not.toBe(a.id);
    expect(b.body).toBe("hi");
    expect((await ops("resume-gone")).map((o) => o[1])).toEqual([a.id]);
    expect(await ops("create")).toHaveLength(2);
    expect(await ops("create-fs")).toHaveLength(1);
    expect(await row()).toMatchObject({ status: "running", handle: b.h, fs_status: "ready" });
  });

  it("files kept by another provider than the current one: device.unavailable, nothing changes", async () => {
    await use(service(() => provider, "sandbox-old"));
    const before = await row();
    const err = await use(service()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("device.unavailable");
    expect((err as ApiError).message).toContain("sandbox-old");
    expect(await row()).toMatchObject({
      provider: "sandbox-old",
      status: "running",
      handle: before?.handle,
      fs_handle: before?.fs_handle,
    });
    expect(await ops("create")).toHaveLength(1);
  });
});

describe("destruction after inactivity", () => {
  it("destroys only the instance after destroyAfterInactiveDays; the file system is kept", async () => {
    const s = service();
    const a = await use(s);
    await s.suspendIdle(later(11 * MIN));
    expect(await s.destroyInactive(later(6 * DAY))).toBe(0);
    expect(await s.destroyInactive(later(8 * DAY))).toBe(1);
    const r = await row();
    expect(r).toMatchObject({ status: "destroyed", fs_status: "ready" });
    expect(r?.destroyed_at).not.toBeNull();
    expect(r?.fs_handle).not.toBeNull();
    expect(await fakeSandboxState(root, a.h.id)).toBeNull();
    expect((await ops("destroy")).map((o) => o[1])).toEqual([a.h.id]);
    expect(await ops("destroy-fs")).toEqual([]);
    expect(await fakeFileSystems(root)).toEqual([r?.fs_handle?.id]);
    // nothing left to destroy: a later sweep does nothing
    expect(await s.destroyInactive(later(30 * DAY))).toBe(0);
  });

  it("inactive device keeps files across rebuild", async () => {
    const s = service();
    await writeIn(s, "notes.txt", "kept");
    const first = (await use(s)).h;
    expect(await s.destroyInactive(later(8 * DAY))).toBe(1);
    const next = await readIn(s, "notes.txt");
    expect(next.body).toBe("kept");
    expect(next.info).toEqual({ fresh: true, restarted: true, roots: DEFAULT_SANDBOX_ROOTS });
    expect(next.h.id).not.toBe(first.id);
    expect((await row())?.status).toBe("running");
    expect(await ops("create-fs")).toHaveLength(1);
  });

  it("a device that was deleted, or whose org was deleted, is destroyed with its files whenever it was last used; its row is deleted", async () => {
    const s = service();
    const deletedOrg = await newOrg();
    const e1 = await newDevice(deletedOrg);
    const e2 = await newDevice();
    const a = await use(s, e1, deletedOrg);
    const b = await use(s, e2);
    const keep = await use(s);
    await sql`UPDATE capybara.orgs SET deleted_at = now() WHERE id = ${deletedOrg}`.execute(raw);
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${e2}`.execute(raw);
    const fsOf = async (h: { id: string }) => (await fakeSandboxMeta(root, h.id))?.fileSystem;
    const doomedFs = [await fsOf(a.h), await fsOf(b.h)];
    const keptFs = await fsOf(keep.h);

    expect(await s.destroyInactive(new Date())).toBe(2);
    expect(await row(e1)).toBeUndefined();
    expect(await row(e2)).toBeUndefined();
    expect((await row())?.status).toBe("running");
    expect(new Set((await ops("destroy")).map((o) => o[1]))).toEqual(new Set([a.h.id, b.h.id]));
    expect(new Set((await ops("destroy-fs")).map((o) => o[1]))).toEqual(new Set(doomedFs));
    expect(await fakeFileSystems(root)).toEqual([keptFs]);
    expect(await fakeSandboxState(root, keep.h.id)).toBe("running");
  });

  it("a deleted device whose instance was already destroyed still loses its files", async () => {
    const s = service();
    await use(s);
    expect(await s.destroyInactive(later(8 * DAY))).toBe(1);
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${envId}`.execute(raw);
    expect(await s.destroyInactive(new Date())).toBe(1);
    expect(await row()).toBeUndefined();
    expect(await fakeFileSystems(root)).toEqual([]);
  });

  it("destroyDevice removes instance and file system; without a row it does nothing", async () => {
    const s = service();
    await writeIn(s, "a.txt", "x");
    const a = await use(s);
    await s.destroyDevice(envId);
    expect(await row()).toBeUndefined();
    expect(await fakeSandboxState(root, a.h.id)).toBeNull();
    expect(await fakeFileSystems(root)).toEqual([]);
    expect(await ops("destroy")).toHaveLength(1);
    expect(await ops("destroy-fs")).toHaveLength(1);
    await s.destroyDevice(randomUUID());
    expect(await ops("destroy")).toHaveLength(1);
  });

  it("a use waiting behind destroyDevice does not resurrect the device", async () => {
    const s = service();
    await use(s);
    const g = gates();
    const holder = s.withSandbox(
      at(),
      async () => {
        g.entered();
        await g.gate;
      },
      signal(),
    );
    await g.inside;
    // the devices service soft-deletes, then the job destroys
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${envId}`.execute(raw);
    const destroying = s.destroyDevice(envId);
    await new Promise((r) => setTimeout(r, 100));
    // a late use waits behind the destroyer's intent
    const late = use(s).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 100));
    g.release();
    await holder;
    await destroying;
    const err = await late;
    expect((err as ApiError).code).toBe("device.not_found");
    expect(await row()).toBeUndefined();
    expect(await fakeFileSystems(root)).toEqual([]);
    expect(await ops("create-fs")).toHaveLength(1);
    expect(await ops("create")).toHaveLength(1);
  });

  it("destroyDevice waits for a running command to finish", async () => {
    const s = service();
    await use(s);
    const g = gates();
    let finished = false;
    const holder = s.withSandbox(
      at(),
      async () => {
        g.entered();
        await g.gate;
        finished = true;
      },
      signal(),
    );
    await g.inside;
    const destroying = s.destroyDevice(envId);
    await new Promise((r) => setTimeout(r, 150));
    expect(await ops("destroy")).toHaveLength(0);
    g.release();
    await holder;
    await destroying;
    expect(finished).toBe(true);
    expect(await row()).toBeUndefined();
  });

  it("two replicas sweeping at once suspend / destroy each instance once", async () => {
    const s1 = service();
    const s2 = service();
    const ids = [envId, await newDevice(), await newDevice()];
    for (const id of ids) await use(s1, id);
    await setFakeSandboxDelays(root, { suspend: 50, destroy: 50 });
    const [x, y] = await Promise.all([
      s1.suspendIdle(later(11 * MIN)),
      s2.suspendIdle(later(11 * MIN)),
    ]);
    expect(x + y).toBe(3);
    expect(await ops("suspend")).toHaveLength(3);
    const [p, q] = await Promise.all([
      s1.destroyInactive(later(8 * DAY)),
      s2.destroyInactive(later(8 * DAY)),
    ]);
    expect(p + q).toBe(3);
    expect(await ops("destroy")).toHaveLength(3);
  });
});

describe("lost files", () => {
  it("missing file system raises files_lost", async () => {
    const s = service();
    const a = await use(s);
    await removeFakeFileSystem(root, (await fakeSandboxMeta(root, a.h.id))?.fileSystem as string);
    expect(await s.destroyInactive(later(8 * DAY))).toBe(1);
    const err = await use(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("device.files_lost");
    expect((err as ApiError).status).toBe(409);
    expect((await row())?.fs_status).toBe("lost");
    // no silent empty workspace: no new file system was made
    expect(await ops("create-fs")).toHaveLength(1);
    // later uses fail the same way without calling the provider
    const before = (await ops()).length;
    const again = await use(s).catch((e: unknown) => e);
    expect((again as ApiError).code).toBe("device.files_lost");
    expect(await ops()).toHaveLength(before);
  });

  it("resetFileSystem starts an empty workspace", async () => {
    const s = service();
    await writeIn(s, "a.txt", "old");
    const a = await use(s);
    const oldFs = (await fakeSandboxMeta(root, a.h.id))?.fileSystem;
    await s.resetFileSystem(envId);
    expect(await row()).toMatchObject({
      fs_status: "none",
      fs_handle: null,
      handle: null,
      status: "none",
    });
    expect(await fakeSandboxState(root, a.h.id)).toBeNull();
    expect(await fakeFileSystems(root)).toEqual([]);
    expect((await ops("destroy-fs")).map((o) => o[1])).toEqual([oldFs]);
    const next = await readIn(s, "a.txt");
    expect(next.body).toBeNull();
    // a fresh start on new files, not a restart on kept ones
    expect(next.info).toEqual({
      fresh: true,
      restarted: false,
      filesReset: true,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
    expect(await ops("create-fs")).toHaveLength(2);
    expect((await row())?.fs_status).toBe("ready");
  });

  it("after a reset every holder is told once, also when the provider reuses the file system id", async () => {
    // sandbox-docker names a file system's volumes after the device: the id comes back
    await setFakeFileSystemIdsByName(root, true);
    const s = service();
    const other = await newConversation();
    const useAs = (holder: string) =>
      s.withSandbox(at(envId, orgId, holder), async (h, _p, info) => ({ h, info }), signal());
    const a = await useAs(conversationId);
    expect((await useAs(other)).info).toEqual({
      fresh: false,
      restarted: false,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
    const fsBefore = (await fakeSandboxMeta(root, a.h.id))?.fileSystem;
    await s.resetFileSystem(envId);
    const next = await useAs(conversationId);
    expect((await fakeSandboxMeta(root, next.h.id))?.fileSystem).toBe(fsBefore);
    // empty files, not an instance restarted on kept ones
    expect(next.info).toEqual({
      fresh: true,
      restarted: false,
      filesReset: true,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
    expect((await useAs(other)).info).toEqual({
      fresh: false,
      restarted: false,
      filesReset: true,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
    expect((await useAs(conversationId)).info).toEqual({
      fresh: false,
      restarted: false,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
    expect((await useAs(other)).info).toEqual({
      fresh: false,
      restarted: false,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
    // a holder that never used the device just starts
    expect((await useAs(await newConversation())).info).toEqual({
      fresh: false,
      restarted: false,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
  });

  it("an instance destroyed after inactivity on kept files is still a restart, not a reset", async () => {
    await setFakeFileSystemIdsByName(root, true);
    const s = service();
    await use(s);
    await s.suspendIdle(later(11 * MIN));
    expect(await s.destroyInactive(later(8 * DAY))).toBe(1);
    expect((await use(s)).info).toEqual({
      fresh: true,
      restarted: true,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
  });

  it("resetFileSystem after files_lost makes the device usable again", async () => {
    const s = service();
    const a = await use(s);
    await removeFakeFileSystem(root, (await fakeSandboxMeta(root, a.h.id))?.fileSystem as string);
    await s.destroyInactive(later(8 * DAY));
    await expect(use(s)).rejects.toMatchObject({ code: "device.files_lost" });
    await s.resetFileSystem(envId);
    const next = await use(s);
    expect(next.info).toEqual({
      fresh: true,
      restarted: false,
      filesReset: true,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
    expect(await row()).toMatchObject({ status: "running", fs_status: "ready" });
  });
});

describe("actor", () => {
  it("exec carries the actor", async () => {
    const s = service();
    await s.withSandbox(
      at(),
      (h, p, _i, sig) =>
        p.exec(h, { command: "true", timeoutMs: 5000, maxOutputBytes: 100, signal: sig }),
      signal(),
    );
    const last = (await ops("exec")).at(-1);
    expect(last?.[2]).not.toBe("-");
    expect(last?.slice(5)).toEqual([accountId, conversationId]);
  });
});

describe("锁", () => {
  it("the lock key is capk:sandbox:<device>, held while running and released after", async () => {
    const s = service();
    let seen: string | null = null;
    await s.withSandbox(
      at(),
      async (_h: SandboxHandle) => {
        seen = await redis.get(`capk:sandbox:${envId}`);
      },
      signal(),
    );
    expect(seen).not.toBeNull();
    expect(await redis.get(`capk:sandbox:${envId}`)).toBeNull();
  });
});

/** 一个只在测试放行后才 resolve 的 promise 与「已进入」通知。 */
function gates() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered!: () => void;
  const inside = new Promise<void>((r) => {
    entered = r;
  });
  return { gate, release, inside, entered };
}

const lockKey = () => `capk:sandbox:${envId}`;
const waitAborted = (sig: AbortSignal) =>
  new Promise<void>((r) => {
    if (sig.aborted) r();
    else sig.addEventListener("abort", () => r(), { once: true });
  });

describe("锁的防护（fix round 1）", () => {
  it("锁丢失：传给 fn 的 signal 被中止", async () => {
    const s = service(undefined, undefined, { lockTtlMs: 300 });
    const reason = await s.withSandbox(
      at(),
      async (_h, _p, _info, sig) => {
        expect(sig.aborted).toBe(false);
        // 模拟锁过期后被别人拿走：下一次续租发现锁已不属于自己
        await redis.set(lockKey(), "someone-else");
        await waitAborted(sig);
        return (sig.reason as Error).message;
      },
      signal(),
    );
    expect(reason).toMatch(/lock/);
    // 只删自己持有的锁：别人的锁还在
    expect(await redis.get(lockKey())).toBe("someone-else");
  });

  it("generation 已经变了的过期写入不覆盖记录", async () => {
    const s = service();
    await use(s);
    await s.suspendIdle(later(11 * MIN));
    await setFakeSandboxDelays(root, { resume: 300 });
    const pending = use(s);
    await new Promise((r) => setTimeout(r, 100));
    // 恢复进行中，另一个持有者（锁丢失后）已经改了记录
    await sql`UPDATE capybara.device_instances SET status = 'destroyed', generation = generation + 1`.execute(
      raw,
    );
    await expect(pending).rejects.toThrow(/changed|lost/);
    expect((await row())?.status).toBe("destroyed");
  });

  it("after an old holder lost its lease, a sweep does not suspend while the new holder's fn runs", async () => {
    const s = service(undefined, undefined, { lockTtlMs: 300 });
    await use(s);
    const a = s.withSandbox(
      at(),
      async (_h, _p, _info, sig) => {
        // the lease expires: its lock and users keys are gone
        await redis.del(lockKey(), `capk:sandbox-users:${envId}`);
        await waitAborted(sig);
      },
      signal(),
    );
    await a;
    const b = gates();
    const holderB = s.withSandbox(
      at(),
      async () => {
        b.entered();
        await b.gate;
      },
      signal(),
    );
    await b.inside;
    await sql`UPDATE capybara.device_instances SET running_since = now() - interval '3 hours',
      last_used_at = now() - interval '1 hour'`.execute(raw);
    expect(await s.suspendIdle(new Date())).toBe(0);
    expect((await row())?.status).toBe("running");
    b.release();
    await holderB;
  });

  it("waiting longer than lockWaitSeconds: sandbox.busy (409)", async () => {
    config = {
      ...config,
      sandbox: { ...config.sandbox, lockWaitSeconds: 0.2, maxConcurrentCommands: 1 },
    };
    const s = service();
    const g = gates();
    const holder = s.withSandbox(
      at(),
      async () => {
        g.entered();
        await g.gate;
      },
      signal(),
    );
    await g.inside;
    const err = await use(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("sandbox.busy");
    expect((err as ApiError).status).toBe(409);
    g.release();
    await holder;
  });

  it("a device of another org: device.not_found", async () => {
    const s = service();
    await use(s);
    const err = await use(s, envId, await newOrg()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("device.not_found");
  });

  it("a mismatched org cannot create an instance row", async () => {
    const s = service();
    const other = await newOrg();
    const err = await use(s, envId, other).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("device.not_found");
    expect((err as ApiError).status).toBe(404);
    expect(await row()).toBeUndefined();
    expect(await ops()).toEqual([]);
    // the owner's org still gets its device
    expect((await use(s)).info.fresh).toBe(true);
    expect((await row())?.org_id).toBe(orgId);
  });

  it("a deleted device is not created", async () => {
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${envId}`.execute(raw);
    const err = await use(service()).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("device.not_found");
    expect(await row()).toBeUndefined();
    expect(await ops()).toEqual([]);
  });
});

describe("restarted is sticky (fix round 1)", () => {
  it("after the instance was destroyed and its rebuild failed, the next use still reports restarted", async () => {
    let fail = false;
    const base = createFakeSandbox(root);
    const flaky: SandboxProvider = {
      ...base,
      create: async (a) => {
        if (fail) throw new Error("docker down");
        return base.create(a);
      },
    };
    const s = service(() => flaky);
    // sandbox mode: the deployment allowlist, so a failure is not attributed to the open network
    await sql`UPDATE capybara.orgs SET settings =
      '{"autoMode":"off","cloudNetwork":{"mode":"allowlist"}}'::jsonb
      WHERE id = ${orgId}`.execute(raw);
    await use(s);
    expect(await s.destroyInactive(later(8 * DAY))).toBe(1);
    fail = true;
    // the provider's own message stays in the log
    await expect(use(s)).rejects.toMatchObject({ code: "sandbox.create_failed" });
    fail = false;
    expect((await use(s)).info).toEqual({
      fresh: true,
      restarted: true,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
  });
});

describe("执行中发现实例已不在（SandboxGoneError，fix round 1）", () => {
  it("a running instance vanishes: after fn throws SandboxGoneError it is rebuilt in place and retried once, restarted is true", async () => {
    const s = service();
    const a = await use(s);
    await removeFakeSandbox(root, a.h.id);
    const infos: unknown[] = [];
    const out = await s.withSandbox(
      at(),
      async (h, p, info, sig) => {
        infos.push(info);
        const r = await p.exec(h, {
          command: "echo ok",
          timeoutMs: 5000,
          maxOutputBytes: 1000,
          signal: sig,
        });
        return { h, stdout: r.stdout };
      },
      signal(),
    );
    expect(infos).toEqual([
      { fresh: false, restarted: false, roots: DEFAULT_SANDBOX_ROOTS },
      { fresh: true, restarted: true, roots: DEFAULT_SANDBOX_ROOTS },
    ]);
    expect(out.stdout).toBe("ok\n");
    expect(out.h.id).not.toBe(a.h.id);
    expect(await row()).toMatchObject({ status: "running", handle: out.h });
  });

  it("重试后仍然 gone：错误抛给调用方", async () => {
    const s = service();
    await use(s);
    let calls = 0;
    const err = await s
      .withSandbox(
        at(),
        async (h, p, _info, sig) => {
          calls++;
          await removeFakeSandbox(root, h.id);
          return p.stat(h, "/workspace", sig);
        },
        signal(),
      )
      .catch((e: unknown) => e);
    expect(calls).toBe(2);
    expect(isSandboxGoneError(err)).toBe(true);
  });
});

describe("another holder rebuilt the sandbox (final review m5)", () => {
  it("a holder whose last instance was rebuilt by another holder gets restarted: true, once", async () => {
    const s = service();
    const child = randomUUID();
    const useAs = (holder?: string) =>
      s.withSandbox(
        at(envId, orgId, holder ?? conversationId),
        async (h, _p, info) => ({ h, info }),
        signal(),
      );
    const first = await useAs();
    expect(first.info).toEqual({ fresh: true, restarted: false, roots: DEFAULT_SANDBOX_ROOTS });
    // a sub-agent joins the running sandbox: nothing was lost for it
    expect((await useAs(child)).info).toEqual({
      fresh: false,
      restarted: false,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
    // the instance is gone during the sub-agent's command: it rebuilds and is told
    await removeFakeSandbox(root, first.h.id);
    const infos: unknown[] = [];
    await s.withSandbox(
      at(envId, orgId, child),
      async (h, p, info, sig) => {
        infos.push(info);
        return p.exec(h, { command: "true", timeoutMs: 5000, maxOutputBytes: 100, signal: sig });
      },
      signal(),
    );
    expect(infos.at(-1)).toEqual({ fresh: true, restarted: true, roots: DEFAULT_SANDBOX_ROOTS });
    // the parent's next use learns its processes are gone too, then not again
    expect((await useAs()).info).toEqual({
      fresh: false,
      restarted: true,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
    expect((await useAs()).info).toEqual({
      fresh: false,
      restarted: false,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
    expect((await useAs(child)).info).toEqual({
      fresh: false,
      restarted: false,
      roots: DEFAULT_SANDBOX_ROOTS,
    });
  });
});

describe("leftovers of interrupted creates and of other providers (fix round 1)", () => {
  const tiny: SandboxLimits = {
    cpu: 1,
    memoryMb: 1,
    diskMb: 1,
    mode: "sandbox",
    network: { kind: "allowlist", hosts: [] },
  };
  const name = () => `cap-device-${envId}`;

  it("a create that crashed before its handle was recorded is destroyed by name; the file system stays", async () => {
    const s = service();
    // the provider built the instance, but the row is still creating (the kernel exited first)
    const p = provider as SandboxProvider;
    const fs = await p.createFileSystem({
      name: name(),
      limits: tiny,
      signal: signal(),
    });
    const h = await p.create({
      name: name(),
      limits: tiny,
      fileSystem: fs,
      signal: signal(),
    });
    await sql`INSERT INTO capybara.device_instances (device_id, org_id, provider, status,
        fs_handle, fs_status, last_used_at)
      VALUES (${envId}, ${orgId}, 'sandbox-fake', 'creating', ${JSON.stringify(fs)}::jsonb, 'ready',
        now() - interval '30 days')`.execute(raw);
    expect(await s.destroyInactive(new Date())).toBe(1);
    expect(await fakeSandboxState(root, h.id)).toBeNull();
    expect((await ops("destroy-by-name")).map((o) => o[1])).toEqual([name()]);
    expect(await fakeFileSystems(root)).toEqual([fs.id]);
  });

  it("a file system whose handle was never recorded is destroyed by name when the device is deleted", async () => {
    const s = service();
    const p = provider as SandboxProvider;
    await p.createFileSystem({
      name: name(),
      limits: tiny,
      signal: signal(),
    });
    await sql`INSERT INTO capybara.device_instances (device_id, org_id, provider, status)
      VALUES (${envId}, ${orgId}, 'sandbox-fake', 'creating')`.execute(raw);
    await s.destroyDevice(envId);
    expect((await ops("destroy-fs-by-name")).map((o) => o[1])).toEqual([name()]);
    expect(await fakeFileSystems(root)).toEqual([]);
    expect(await row()).toBeUndefined();
  });

  it("a device of another provider is destroyed with that provider while it is loaded; otherwise the deletion fails and the row stays for a retry", async () => {
    const oldRoot = await mkdtemp(join(tmpdir(), "cap-sandbox-old-"));
    const old = createFakeSandbox(oldRoot);
    const a = await use(service(() => old, "sandbox-old"));
    const s = service(undefined, undefined, {
      lookup: (n) => (n === "sandbox-old" ? old : undefined),
    });
    await s.destroyDevice(envId);
    expect(await fakeSandboxState(oldRoot, a.h.id)).toBeNull();
    expect(await fakeFileSystems(oldRoot)).toEqual([]);
    expect(await row()).toBeUndefined();

    // the old provider is gone: its instance is recorded as leaked, the files cannot be deleted
    const e2 = await newDevice();
    const b = await use(
      service(() => old, "sandbox-old"),
      e2,
    );
    warned.length = 0;
    await expect(service().destroyDevice(e2)).rejects.toThrow(/sandbox-old/);
    expect(await row(e2)).toMatchObject({ provider: "sandbox-old" });
    expect(warned.some((w) => /another provider/.test(w))).toBe(true);
    expect(await fakeSandboxState(oldRoot, b.h.id)).toBe("running");
    await rm(oldRoot, { recursive: true, force: true });
  });
});

describe("provider switch during a create", () => {
  const tiny: SandboxLimits = {
    cpu: 1,
    memoryMb: 1,
    diskMb: 1,
    mode: "sandbox",
    network: { kind: "allowlist", hosts: [] },
  };
  const name = () => `cap-device-${envId}`;

  it("a file system the previous provider made by name before it was recorded is destroyed when the current provider takes the device over", async () => {
    const oldRoot = await mkdtemp(join(tmpdir(), "cap-sandbox-old-"));
    const old = createFakeSandbox(oldRoot);
    // the previous provider's create ended after createFileSystem, before the handle was written
    await old.createFileSystem({
      name: name(),
      limits: tiny,
      signal: signal(),
    });
    await sql`INSERT INTO capybara.device_instances (device_id, org_id, provider, status)
      VALUES (${envId}, ${orgId}, 'sandbox-old', 'creating')`.execute(raw);
    const s = service(undefined, undefined, {
      lookup: (n) => (n === "sandbox-old" ? old : undefined),
    });
    const { info } = await use(s);
    expect(info.fresh).toBe(true);
    expect(await fakeFileSystems(oldRoot)).toEqual([]);
    expect(await fakeFileSystems(root)).toHaveLength(1);
    expect(await row()).toMatchObject({ provider: "sandbox-fake", fs_status: "ready" });
    await rm(oldRoot, { recursive: true, force: true });
  });

  it("with the previous provider not loaded the takeover only warns that its file system may leak", async () => {
    await sql`INSERT INTO capybara.device_instances (device_id, org_id, provider, status)
      VALUES (${envId}, ${orgId}, 'sandbox-old', 'creating')`.execute(raw);
    const { info } = await use(service());
    expect(info.fresh).toBe(true);
    expect(warned.some((w) => /may leak/.test(w))).toBe(true);
    expect(await row()).toMatchObject({ provider: "sandbox-fake", fs_status: "ready" });
  });
});

describe("扫描失败的排在后面（fix round 1）", () => {
  it("休眠失败记 sweep_failed_at，成功后清空", async () => {
    let fail = true;
    const base = createFakeSandbox(root);
    const flaky: SandboxProvider = {
      ...base,
      suspend: async (h, sig) => {
        if (fail) throw new Error("daemon busy");
        return base.suspend(h, sig);
      },
    };
    const s = service(() => flaky);
    await use(s);
    expect(await s.suspendIdle(later(11 * MIN))).toBe(0);
    expect((await row())?.sweep_failed_at).not.toBeNull();
    fail = false;
    expect(await s.suspendIdle(later(11 * MIN))).toBe(1);
    expect(await row()).toMatchObject({ status: "suspended", sweep_failed_at: null });
  });
});

/** Leases whose renewals always fail with a Redis error (the renew script throws). */
const renewThrows = (ttlMs: number) =>
  sandboxLeasesFor({
    redis: new Proxy(redis, {
      get(t, k) {
        if (k === "eval") {
          return (script: string, ...args: unknown[]) =>
            script.includes("'XX'")
              ? Promise.reject(new Error("redis timeout"))
              : // biome-ignore lint/suspicious/noExplicitAny: forwards the call unchanged
                (t.eval as any)(script, ...args);
        }
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }),
    log,
    ttlMs,
    pollMs: 20,
  });

describe("锁的防护（fix round 2）", () => {
  it("每次拿到锁都防护地把 generation 加一（运行中的路径也是）", async () => {
    const s = service();
    await use(s);
    const g1 = (await row())?.generation as number;
    await use(s);
    expect((await row())?.generation).toBe(g1 + 1);
  });

  it("B 拿锁之前就开始的过期休眠扫描：只靠 generation 防护也写不进 suspended", async () => {
    const s = service(undefined, undefined, { lockTtlMs: 300 });
    await use(s);
    const started = gates();
    const base = createFakeSandbox(root);
    const slow: SandboxProvider = {
      ...base,
      suspend: async (h) => {
        started.entered();
        // 故意不理 signal：模拟中止不及时的提供方
        await started.gate;
        return base.suspend(h, AbortSignal.timeout(5000));
      },
    };
    // the sweeper's lease never looks lost (renewals always succeed, the signal never aborts):
    // only the generation fence can stop it
    class BlindLeases extends SandboxLeases {
      override async tryExclusive(conv: string, o?: { token?: string; intent?: boolean }) {
        const l = await super.tryExclusive(conv, o);
        if (!l) return null;
        return {
          ...l,
          signal: new AbortController().signal,
          renew: async () => true,
          release: () => l.release(),
          downgrade: () => l.downgrade(),
        };
      }
    }
    const blind = sandboxLeasesFor({ redis, log, ttlMs: 300, pollMs: 20 }, BlindLeases);
    const failures: unknown[] = [];
    const sweeper = service(() => slow, undefined, {
      lockTtlMs: 300,
      leases: blind,
      log: {
        info() {},
        warn: (m: string, f?: Record<string, unknown>) => {
          if (m === "sandbox maintenance failed; will retry") failures.push(f?.err);
        },
      },
    });
    const sweep = sweeper.suspendIdle(later(11 * MIN));
    await started.inside;
    // the sweeper's lease expires; B takes a lease and uses the running sandbox
    await redis.del(lockKey());
    const b = await use(s);
    expect(b.info).toEqual({ fresh: false, restarted: false, roots: DEFAULT_SANDBOX_ROOTS });
    started.release();
    expect(await sweep).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(SandboxLockLostError);
    expect((failures[0] as SandboxLockLostError).reason).toBe("generation");
    expect((await row())?.status).toBe("running");
  });

  it("休眠途中锁丢失：中止提供方调用的 signal", async () => {
    const s = service(undefined, undefined, { lockTtlMs: 300 });
    await use(s);
    const started = gates();
    let seen: AbortSignal | undefined;
    const base = createFakeSandbox(root);
    const slow: SandboxProvider = {
      ...base,
      suspend: async (_h, sig) => {
        seen = sig;
        started.entered();
        await waitAborted(sig);
        throw sig.reason;
      },
    };
    const sweeper = service(() => slow, undefined, { lockTtlMs: 300 });
    const sweep = sweeper.suspendIdle(later(11 * MIN));
    await started.inside;
    await redis.set(lockKey(), "someone-else");
    expect(await sweep).toBe(0);
    expect(seen?.aborted).toBe(true);
    expect((await row())?.status).toBe("running");
  });

  it("续租一直报错：超过 TTL 没有成功续租即视为锁丢失，中止 fn 的 signal", async () => {
    const s = service(undefined, undefined, { leases: renewThrows(300) });
    const reason = await s.withSandbox(
      at(),
      async (_h, _p, _info, sig) => {
        await waitAborted(sig);
        return sig.reason;
      },
      signal(),
    );
    expect((reason as Error).name).toBe("SandboxLockLostError");
  });

  it("续租一直报错：在 TTL 的 2/3 之后、键过期之前就中止 fn 的 signal", async () => {
    const ttl = 1500;
    const s = service(undefined, undefined, { leases: renewThrows(ttl) });
    const elapsed = await s.withSandbox(
      at(),
      async (_h, _p, _info, sig) => {
        const t0 = Date.now();
        await waitAborted(sig);
        return Date.now() - t0;
      },
      signal(),
    );
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(ttl);
  });

  it("组织不符的错误信息不带别的组织 id", async () => {
    const s = service();
    await use(s);
    const other = await newOrg();
    const err = (await use(s, envId, other).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("device.not_found");
    expect(err.message).not.toContain(orgId);
  });
});

describe("被内核之外的原因停掉（fix wave S2 I1）", () => {
  it("记录是 running、实例却停了：下一次调用由提供方自动启动接上，文件还在，不重建", async () => {
    const s = service();
    const { h } = await use(s);
    await s.withSandbox(
      at(),
      (hh, p, _i, sig) => p.writeFile(hh, "/workspace/a.txt", new TextEncoder().encode("a"), sig),
      signal(),
    );
    // 例如休眠扫描停了实例、却在写 suspended 之前丢了锁
    await provider?.suspend(h, signal());
    expect((await row())?.status).toBe("running");
    const out = await s.withSandbox(
      at(),
      async (hh, p, info, sig) => ({
        info,
        r: await p.exec(hh, {
          command: "cat /workspace/a.txt",
          timeoutMs: 5000,
          maxOutputBytes: 100,
          signal: sig,
        }),
      }),
      signal(),
    );
    expect(out.info).toEqual({ fresh: false, restarted: false, roots: DEFAULT_SANDBOX_ROOTS });
    expect(out.r.stdout).toBe("a");
    expect(await ops("autostart")).toHaveLength(1);
    expect(await ops("create")).toHaveLength(1);
  });
});

describe("taking over from a crashed holder", () => {
  /** A crashed holder's record: no lease, not expired. */
  const deadHolder = async (tag = "dead-holder") => {
    await redis.hset(`capk:sandbox-holders:${envId}`, tag, Date.now() + 600_000);
    await redis.pexpire(`capk:sandbox-holders:${envId}`, 600_000);
  };

  it("a holder records itself in capk:sandbox-holders:<conv> (with a TTL) while it runs and removes the record after; a normal handover kills nothing", async () => {
    const s = service();
    const holdersKey = `capk:sandbox-holders:${envId}`;
    let seen: { n: number; ttl: number } = { n: 0, ttl: 0 };
    await s.withSandbox(
      at(),
      async () => {
        seen = { n: await redis.hlen(holdersKey), ttl: await redis.pttl(holdersKey) };
      },
      signal(),
    );
    expect(seen.n).toBe(1);
    expect(seen.ttl).toBeGreaterThan(config.sandbox.limits.maxCommandSeconds * 1000);
    expect(await redis.hlen(holdersKey)).toBe(0);
    // there is no single "sandbox in use" marker
    expect(await redis.keys("capk:sandbox-busy:*")).toEqual([]);
    await use(s);
    expect(await ops("kill-all")).toHaveLength(0);
    expect(await ops("kill-tagged")).toHaveLength(0);
  });

  it("a crashed holder's record on a freshly created instance kills nothing and is claimed", async () => {
    const s = service();
    await deadHolder();
    const { info } = await use(s);
    expect(info.fresh).toBe(true);
    expect(await ops("kill-all")).toHaveLength(0);
    expect(await ops("kill-tagged")).toHaveLength(0);
    expect(await redis.exists(`capk:sandbox-holders:${envId}`)).toBe(0);
  });

  it("a failing killTagged is only warned; fn still runs", async () => {
    const base = createFakeSandbox(root);
    const failing: SandboxProvider = {
      ...base,
      killTagged: async () => {
        throw new Error("kill failed");
      },
    };
    const s = service(() => failing);
    await use(s);
    await deadHolder();
    const r = await s.withSandbox(at(), async () => "ran", signal());
    expect(r).toBe("ran");
    expect(warned).toContain("cannot kill leftover sandbox commands");
  });

  it("a failing killAll after a resume is only warned; fn still runs", async () => {
    const base = createFakeSandbox(root);
    const failing: SandboxProvider = {
      ...base,
      killAll: async () => {
        throw new Error("kill failed");
      },
    };
    const s = service(() => failing);
    await use(s);
    expect(await s.suspendIdle(later(DAY))).toBe(1);
    const r = await s.withSandbox(at(), async () => "ran", signal());
    expect(r).toBe("ran");
    expect(warned).toContain("cannot kill leftover sandbox commands");
  });
});

describe("a resume kills leftover commands", () => {
  it("resume from suspended runs killAll before fn (a provider that keeps memory across a pause brings old commands back)", async () => {
    const s = service();
    const { h } = await use(s);
    // a command an earlier holder left behind, with no holder record left
    const left = provider?.exec(h, {
      command: "sleep 30",
      timeoutMs: 60_000,
      maxOutputBytes: 100,
      signal: signal(),
      tag: "dead-holder",
      actor: at().actor,
    });
    await waitForProc(h.id);
    expect(await s.suspendIdle(later(DAY))).toBe(1);
    const order: string[] = [];
    await s.withSandbox(
      at(),
      async () => {
        order.push(`fn after ${(await ops("kill-all")).length} kill-all`);
      },
      signal(),
    );
    expect(order).toEqual(["fn after 1 kill-all"]);
    expect(await left).toMatchObject({ exitCode: null, timedOut: false });
    // later uses of the running instance do not killAll again
    await use(s);
    expect(await ops("kill-all")).toHaveLength(1);
  });
});
