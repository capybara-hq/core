import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { definePlugin, OBJECT_STORE_CAPABILITY, type PluginStorage } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { planApprovals } from "../../src/plugins/approvals.js";
import { PluginHost } from "../../src/plugins/host.js";
import { computePermissionSet, type PermissionSet } from "../../src/plugins/permission-set.js";
import { resolvePlugins } from "../../src/plugins/resolve.js";
import { purgeDeletedOrgStorage } from "../../src/storage/purge.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { MemoryObjectStore } from "./memory-store.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const hosts: PluginHost[] = [];
const warned: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
const log = {
  info() {},
  warn: (msg: string, fields?: Record<string, unknown>) => warned.push({ msg, fields }),
  error() {},
};

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const host = () => {
  const h = new PluginHost(deps, {}, { autoApprove: true });
  hosts.push(h);
  return h;
};

beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  deps = {
    db: createDb(pg.url, 5),
    dbUrl: pg.url,
    redis,
    busSubscriber: sub,
    redisUrl: rd.url,
    keyring: createKeyring(Buffer.alloc(32, 1), []),
    runWorkers: false,
    log,
  };
});
afterAll(async () => {
  await Promise.all(hosts.map((h) => h.close()));
  await sub?.close();
  redis?.disconnect();
  await deps?.db.destroy();
  await Promise.all([pg?.stop(), rd?.stop()]);
});
beforeEach(() => {
  warned.length = 0;
});

describe("没有对象存储提供方", () => {
  it("声明了 permissions.storage 的插件不加载，进入 pending（dependency，缺 object-store@1）", async () => {
    const h = host();
    await h.load([fx("storage-user")]);
    expect(h.manifests().map((m) => m.name)).toEqual([]);
    expect(h.pending()).toEqual([
      expect.objectContaining({
        plugin: "storage-user",
        reason: "dependency",
        blockedBy: [{ capability: OBJECT_STORE_CAPABILITY, providers: [] }],
      }),
    ]);
    expect(warned.some((w) => w.fields?.plugin === "storage-user")).toBe(true);
  });

  it("提供方本身待批准时，声明存储的插件同样进入 pending", async () => {
    const store = definePlugin({
      name: "s3",
      version: "0.1.0",
      sdk: "^0.1.0",
      provides: [OBJECT_STORE_CAPABILITY],
      setup() {},
    });
    const user = definePlugin({
      name: "uu",
      version: "0.1.0",
      sdk: "^0.1.0",
      provides: [],
      permissions: { storage: true },
      setup() {},
    });
    const sets = new Map([
      ["s3", await computePermissionSet(store, "/")],
      ["uu", await computePermissionSet(user, "/")],
    ]);
    // u 已批准、提供方 s3 待批准（没有快照）
    const snap = {
      plugin: "uu",
      version: "0.1.0",
      permissions: sets.get("uu") as PermissionSet,
      approvedBy: null,
      approvedAt: new Date(),
      source: "cli" as const,
    };
    const d = planApprovals([store, user], sets, new Map([["uu", snap]]));
    expect(d.find((x) => x.plugin === "uu")).toMatchObject({
      action: "pending",
      pending: {
        reason: "dependency",
        blockedBy: [{ capability: OBJECT_STORE_CAPABILITY, providers: ["s3"] }],
      },
    });
  });
});

describe("有提供方", () => {
  it("依赖排序把提供方排在声明存储的插件之前", () => {
    const user = definePlugin({
      name: "uu",
      version: "0.1.0",
      sdk: "^0.1.0",
      provides: [],
      permissions: { storage: true },
      setup() {},
    });
    const store = definePlugin({
      name: "s3",
      version: "0.1.0",
      sdk: "^0.1.0",
      provides: [OBJECT_STORE_CAPABILITY],
      setup() {},
    });
    expect(resolvePlugins([user, store], "0.1.0").map((m) => m.name)).toEqual(["s3", "uu"]);
  });

  it("插件的 ctx.storage 经提供方读写，键加前缀 plugins/<插件>/<orgId>/", async () => {
    const h = host();
    await h.load([fx("storage-user"), fx("mem-store")]);
    expect(h.manifests().map((m) => m.name)).toEqual(["mem-store", "storage-user"]);
    expect(h.pending()).toEqual([]);
    const s = h.get<PluginStorage>("counter@1", "storage-user");
    const mem = h.get<MemoryObjectStore>(OBJECT_STORE_CAPABILITY);
    const org = randomUUID();
    await s.put(org, "a.txt", new TextEncoder().encode("hi"), { contentType: "text/plain" });
    expect([...mem.objects.keys()]).toEqual([`plugins/storage-user/${org}/a.txt`]);
    expect((await s.list(org, "")).items.map((i) => i.key)).toEqual(["a.txt"]);
    await expect(s.get(org, "../mem-store/x")).rejects.toThrow(/invalid storage key/);
  });
});

describe("已删除组织的存储清理", () => {
  const k = () => kernelDb(deps.db);
  const org = async (deletedDaysAgo: number | null) => {
    const id = randomUUID();
    await k()
      .insertInto("orgs")
      .values({
        id,
        slug: `o-${id.slice(0, 8)}`,
        name: "o",
        deleted_at:
          deletedDaysAgo === null
            ? null
            : (sql<Date>`now() - make_interval(days => ${deletedDaysAgo})` as unknown as Date),
      })
      .execute();
    return id;
  };

  it("只删软删除超过 N 天的组织；标记已清理，之后不再重复", async () => {
    const mem = new MemoryObjectStore();
    const storage = new StorageService({ provider: () => mem, plugins: async () => ["pp"] });
    const old = await org(40);
    const recent = await org(1);
    const live = await org(null);
    for (const id of [old, recent, live]) {
      await storage.kernel(id).put("x", new Uint8Array([1]), { contentType: "text/plain" });
      await storage
        .forPlugin("pp")
        .put(id, "y", new Uint8Array([1]), { contentType: "text/plain" });
    }
    expect(await purgeDeletedOrgStorage({ db: k(), storage, afterDays: 30, log })).toBe(1);
    const keys = [...mem.objects.keys()];
    expect(keys.some((x) => x.includes(old))).toBe(false);
    expect(keys.filter((x) => x.includes(recent))).toHaveLength(2);
    expect(keys.filter((x) => x.includes(live))).toHaveLength(2);
    const row = await k()
      .selectFrom("orgs")
      .select("storage_purged_at")
      .where("id", "=", old)
      .executeTakeFirstOrThrow();
    expect(row.storage_purged_at).not.toBeNull();
    mem.calls.length = 0;
    expect(await purgeDeletedOrgStorage({ db: k(), storage, afterDays: 30, log })).toBe(0);
    expect(mem.calls).toEqual([]);
  });

  it("没有提供方时跳过（不标记）", async () => {
    const storage = new StorageService({ provider: () => undefined, plugins: async () => [] });
    const id = await org(40);
    expect(await purgeDeletedOrgStorage({ db: k(), storage, afterDays: 30, log })).toBe(0);
    const row = await k()
      .selectFrom("orgs")
      .select("storage_purged_at")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.storage_purged_at).toBeNull();
  });
});
