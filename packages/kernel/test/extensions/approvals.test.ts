import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionApprovals } from "../../src/extensions/approvals.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const hosts: ExtensionHost[] = [];
const warned: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
const log = {
  info() {},
  warn: (msg: string, fields?: Record<string, unknown>) => warned.push({ msg, fields }),
  error() {},
};

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const host = (opts: { autoApprove?: boolean } = {}) => {
  const h = new ExtensionHost(deps, {}, { registry: new ExtensionRegistry(), ...opts });
  hosts.push(h);
  return h;
};
const approvals = () => new ExtensionApprovals(kernelDb(deps.db));
const snapshot = async (plugin: string) =>
  kernelDb(deps.db)
    .selectFrom("extension_permission_snapshots")
    .selectAll()
    .where("plugin", "=", plugin)
    .executeTakeFirst();
const schemaExists = async (schema: string) =>
  (
    await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = ${schema}`.execute(deps.db)
  ).rows[0]?.n === 1;

/** 用 inspect 计算的权限集合直接批准各插件（模拟 `capybara extensions approve`）。 */
async function approve(...specs: string[]): Promise<void> {
  for (const p of await ExtensionHost.inspect(specs)) {
    await approvals().approve(p.manifest.name, p.manifest.version, p.permissions, {
      source: "cli",
    });
  }
}

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
}, 120_000);
afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await deps?.db.destroy();
  await Promise.all([pg?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  warned.length = 0;
  await sql`TRUNCATE capybara.extension_permission_snapshots, capybara.audit_events`.execute(
    deps.db,
  );
  await sql`DROP SCHEMA IF EXISTS plugin_perm_a CASCADE`.execute(deps.db);
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

describe("the permission snapshot gate of ExtensionHost.load", () => {
  it("无快照 → 待批准、不迁移不加载，warn 日志点名插件与新增项", async () => {
    const h = host();
    await h.load([fx("perm-a")]);
    expect(h.manifests()).toEqual([]);
    expect(h.pending()).toEqual([
      {
        plugin: "perm-a",
        version: "0.1.0",
        reason: "new",
        added: ["permissions.network:a.example.com", "provides:counter@1", "table:perm_items"],
        removed: [],
      },
    ]);
    expect(await schemaExists("plugin_perm_a")).toBe(false);
    expect(warned.some((w) => w.fields?.plugin === "perm-a" && /approv/i.test(w.msg))).toBe(true);
    expect(await snapshot("perm-a")).toBeUndefined();
  });

  it("批准后加载（迁移照常执行）", async () => {
    await approve(fx("perm-a"));
    const h = host();
    await h.load([fx("perm-a")]);
    expect(h.manifests().map((m) => m.name)).toEqual(["perm-a"]);
    expect(h.pending()).toEqual([]);
    expect(await schemaExists("plugin_perm_a")).toBe(true);
  });

  it("升级后多一项权限 → 待批准；requires 它的插件不加载并写明原因；optional 它的照常加载", async () => {
    await approve(fx("perm-a"), fx("perm-dep"), fx("perm-opt"));
    const h = host();
    await h.load([fx("perm-a-more"), fx("perm-dep"), fx("perm-opt")]);
    expect(h.manifests().map((m) => m.name)).toEqual(["perm-opt"]);
    expect(h.pending()).toEqual([
      {
        plugin: "perm-a",
        version: "0.2.0",
        reason: "added",
        added: ["permissions.network:b.example.com"],
        removed: [],
      },
      {
        plugin: "perm-dep",
        version: "0.1.0",
        reason: "dependency",
        added: [],
        removed: [],
        blockedBy: [{ extensionPoint: "counter@1", providers: ["perm-a"] }],
      },
    ]);
    expect(
      warned.some((w) => w.fields?.plugin === "perm-dep" && JSON.stringify(w).includes("perm-a")),
    ).toBe(true);
    // 快照不变
    expect((await snapshot("perm-a"))?.version).toBe("0.1.0");
  });

  it("升级后权限变少 → 直接加载并更新快照（批准来源保持）", async () => {
    await approve(fx("perm-a"));
    const h = host();
    await h.load([fx("perm-a-less")]);
    expect(h.manifests().map((m) => m.name)).toEqual(["perm-a"]);
    expect(h.pending()).toEqual([]);
    const snap = await snapshot("perm-a");
    expect(snap?.version).toBe("0.3.0");
    expect(snap?.source).toBe("cli");
    expect(JSON.stringify(snap?.permissions)).not.toContain("a.example.com");
  });

  it("升级版本、权限完全相同 → 不需批准直接加载，快照版本跟上", async () => {
    await approve(fx("perm-a"));
    const h = host();
    await h.load([fx("perm-a-same")]);
    expect(h.manifests().map((m) => m.version)).toEqual(["0.1.1"]);
    expect(h.pending()).toEqual([]);
    const snap = await snapshot("perm-a");
    expect(snap?.version).toBe("0.1.1");
    expect(snap?.source).toBe("cli");
  });

  it("滚动升级中旧版本副本重启（权限是快照子集）→ 照常加载但不缩减快照，新版本之后仍直接加载", async () => {
    await approve(fx("perm-a-more"));
    const old = host();
    await old.load([fx("perm-a")]);
    expect(old.manifests().map((m) => m.version)).toEqual(["0.1.0"]);
    expect(old.pending()).toEqual([]);
    const snap = await snapshot("perm-a");
    expect(snap?.version).toBe("0.2.0");
    expect(JSON.stringify(snap?.permissions)).toContain("b.example.com");
    // 并发场景下的兜底：直接调用 refresh 也不会用旧版本覆盖
    const [v1] = await ExtensionHost.inspect([fx("perm-a")]);
    expect(await approvals().refresh("perm-a", "0.1.0", v1?.permissions as never)).toBe(false);
    expect((await snapshot("perm-a"))?.version).toBe("0.2.0");
    const next = host();
    await next.load([fx("perm-a-more")]);
    expect(next.manifests().map((m) => m.version)).toEqual(["0.2.0"]);
    expect(next.pending()).toEqual([]);
  });

  it("autoApprove：自动写快照（source auto）并加载，启动日志醒目提示", async () => {
    const h = host({ autoApprove: true });
    await h.load([fx("perm-a"), fx("perm-dep")]);
    expect(h.manifests().map((m) => m.name)).toEqual(["perm-a", "perm-dep"]);
    expect(h.pending()).toEqual([]);
    expect((await snapshot("perm-a"))?.source).toBe("auto");
    expect((await snapshot("perm-dep"))?.approved_by).toBeNull();
    expect(warned.some((w) => /autoApprove/.test(w.msg))).toBe(true);
    // 再次启动：已有快照，不再重写
    const before = (await snapshot("perm-a"))?.approved_at;
    const h2 = host({ autoApprove: true });
    await h2.load([fx("perm-a")]);
    expect((await snapshot("perm-a"))?.approved_at).toEqual(before);
  });
});

describe("the permission snapshot gate of ExtensionHost.migrateOnly", () => {
  it("待批准的插件不迁移，经 onPending 报告；autoApprove 时照常迁移", async () => {
    const seen: string[] = [];
    const r = await ExtensionHost.migrateOnly([fx("perm-a")], {
      dbUrl: deps.dbUrl,
      onPending: (p) => seen.push(...p.map((x) => x.plugin)),
    });
    expect(r).toEqual([]);
    expect(seen).toEqual(["perm-a"]);
    expect(await schemaExists("plugin_perm_a")).toBe(false);
    const r2 = await ExtensionHost.migrateOnly([fx("perm-a")], {
      dbUrl: deps.dbUrl,
      autoApprove: true,
    });
    expect(r2.map((x) => x.plugin)).toEqual(["perm-a"]);
    expect(await snapshot("perm-a")).toBeUndefined();
  });
});

describe("ExtensionHost.inspect", () => {
  it("不调用 setup、不需要 Redis：返回拓扑序的清单、目录与权限集合", async () => {
    const r = await ExtensionHost.inspect([fx("perm-dep"), fx("perm-a"), fx("throws")]);
    expect(r.map((x) => x.manifest.name)).toEqual(["perm-a", "perm-dep", "thrower"]);
    expect(r[0]?.permissions.tables).toEqual(["perm_items"]);
  });
});
