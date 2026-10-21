import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxHandle, SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import {
  createFakeSandbox,
  fakeSandboxMeta,
  fakeSandboxState,
  readFakeSandboxOps,
  removeFakeSandbox,
  setFakeSandboxDelays,
} from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";

/**
 * 内核沙箱服务（M5 T7）：按对话懒创建、Redis 锁下串行、空闲休眠 / 超时强制休眠、不活跃销毁、
 * 提供方返回 gone 时重建（审查重点 2、3）。
 */

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
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

const service = (p: () => SandboxProvider | undefined = () => provider, plugin = "sandbox-fake") =>
  new SandboxService({
    db,
    redis,
    provider: () => {
      const impl = p();
      return impl ? { plugin, impl } : undefined;
    },
    config: () => config,
    log,
    lockPollMs: 20,
  });

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rdc.url);
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

let orgId: string;
let conversationId: string;

async function newConversation(org = orgId): Promise<string> {
  const id = randomUUID();
  const { account_id, agent_id } = await sql<{ account_id: string; agent_id: string }>`
    SELECT created_by AS account_id, (SELECT id FROM capybara.agents WHERE org_id = ${org} LIMIT 1) AS agent_id
    FROM capybara.orgs WHERE id = ${org}`
    .execute(raw)
    .then((r) => r.rows[0] as { account_id: string; agent_id: string });
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${id}, ${org}, ${agent_id}, ${account_id})`.execute(raw);
  return id;
}

async function newOrg(): Promise<string> {
  const accountId = randomUUID();
  const id = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${id}, ${`o-${id.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${randomUUID()}, ${id}, ${accountId}, 'org', 1)`.execute(raw);
  return id;
}

beforeEach(async () => {
  warned.length = 0;
  await redis.flushdb();
  await truncateTables(raw, "capybara.sandboxes, capybara.accounts, capybara.orgs");
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-"));
  provider = createFakeSandbox(root);
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  orgId = await newOrg();
  conversationId = await newConversation();
});

const row = (id = conversationId) =>
  db.selectFrom("sandboxes").selectAll().where("conversation_id", "=", id).executeTakeFirst();
const ops = async (op?: string) =>
  (await readFakeSandboxOps(root)).filter((o) => op === undefined || o[0] === op);

/** 用一次沙箱：返回句柄与 info。 */
const use = (s: SandboxService, id = conversationId, org = orgId) =>
  s.withSandbox({ orgId: org, conversationId: id }, async (h, _p, info) => ({ h, info }), signal());

describe("没有提供方", () => {
  it("available 为 false；withSandbox 以 sandbox.unavailable（503）失败；扫描什么也不做", async () => {
    const s = service(() => undefined);
    expect(s.available).toBe(false);
    const err = await use(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("sandbox.unavailable");
    expect((err as ApiError).status).toBe(503);
    expect(await s.suspendIdle(later(DAY))).toBe(0);
    expect(await s.destroyInactive(later(30 * DAY))).toBe(0);
    expect(await row()).toBeUndefined();
  });
});

describe("懒创建", () => {
  it("首次使用才创建（名字 cap-<对话>、镜像与限制取配置）；之后复用同一个", async () => {
    const s = service();
    expect(s.available).toBe(true);
    expect(await ops()).toEqual([]);
    const a = await use(s);
    expect(a.info).toEqual({ fresh: true, recreated: false });
    const meta = await fakeSandboxMeta(root, a.h.id);
    expect(meta).toEqual({
      name: `cap-${conversationId}`,
      image: config.sandbox.image,
      limits: {
        cpu: 1,
        memoryMb: 2048,
        diskMb: 5120,
        egress: "allowlist",
        allowHosts: config.sandbox.limits.allowHosts,
      },
    });
    const r = await row();
    expect(r).toMatchObject({ org_id: orgId, provider: "sandbox-fake", status: "running" });
    expect(r?.handle).toEqual(a.h);

    const b = await use(s);
    expect(b.info).toEqual({ fresh: false, recreated: false });
    expect(b.h).toEqual(a.h);
    expect(await ops("create")).toHaveLength(1);
  });

  it("同一对话的并发调用在锁上排队：只创建一次，执行不重叠", async () => {
    await setFakeSandboxDelays(root, { create: 200 });
    const s = service();
    let active = 0;
    let overlap = false;
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        s.withSandbox(
          { orgId, conversationId },
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
    await sql`UPDATE capybara.sandboxes SET last_used_at = now() - interval '1 hour'`.execute(raw);
    const err = await s
      .withSandbox(
        { orgId, conversationId },
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

  it("create 失败：错误抛给调用方，下一次调用重新创建", async () => {
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
    await expect(use(s)).rejects.toThrow("docker down");
    fail = false;
    const a = await use(s);
    expect(a.info).toEqual({ fresh: true, recreated: false });
    expect((await row())?.status).toBe("running");
  });

  it("等锁时调用方中止：以中止原因失败，不创建", async () => {
    const s = service();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const holder = s.withSandbox({ orgId, conversationId }, () => gate, signal());
    await new Promise((r) => setTimeout(r, 100));
    const ac = new AbortController();
    const waiting = s.withSandbox({ orgId, conversationId }, async () => "x", ac.signal);
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
    expect(b.info).toEqual({ fresh: false, recreated: false });
    expect(b.h).toEqual(a.h);
    expect(await ops("resume")).toEqual([["resume", a.h.id]]);
    expect((await row())?.status).toBe("running");
    expect(await fakeSandboxState(root, a.h.id)).toBe("running");
  });

  it("休眠后文件保留", async () => {
    const s = service();
    await s.withSandbox(
      { orgId, conversationId },
      (h, p) => p.writeFile(h, "/workspace/a.txt", new TextEncoder().encode("hi"), signal()),
      signal(),
    );
    await s.suspendIdle(later(11 * MIN));
    const text = await s.withSandbox(
      { orgId, conversationId },
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
    await sql`UPDATE capybara.sandboxes SET running_since = now() - interval '3 hours'`.execute(
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
      { orgId, conversationId },
      async () => {
        entered();
        await gate;
      },
      signal(),
    );
    await inside;
    await sql`UPDATE capybara.sandboxes SET running_since = now() - interval '3 hours',
      last_used_at = now() - interval '1 hour'`.execute(raw);
    expect(await s.suspendIdle(new Date())).toBe(0);
    expect(await s.destroyInactive(later(30 * DAY))).toBe(0);
    expect((await row())?.status).toBe("running");
    release();
    await running;
  });
});

describe("提供方返回 gone（审查重点 3）", () => {
  it("休眠后实例不在了：重建一个空沙箱，recreated 为 true", async () => {
    const s = service();
    const a = await s.withSandbox(
      { orgId, conversationId },
      async (h, p) => {
        await p.writeFile(h, "/workspace/a.txt", new TextEncoder().encode("hi"), signal());
        return h;
      },
      signal(),
    );
    await s.suspendIdle(later(11 * MIN));
    await removeFakeSandbox(root, a.id);

    const b = await s.withSandbox(
      { orgId, conversationId },
      async (h, p, info) => ({
        h,
        info,
        file: await p.stat(h, "/workspace/a.txt", signal()),
      }),
      signal(),
    );
    expect(b.info).toEqual({ fresh: true, recreated: true });
    expect(b.h.id).not.toBe(a.id);
    expect(b.file).toBeNull();
    expect((await ops("resume-gone")).map((o) => o[1])).toEqual([a.id]);
    expect(await ops("create")).toHaveLength(2);
    expect(await row()).toMatchObject({ status: "running", handle: b.h });
  });

  it("记录的提供方不是当前提供方：当作已不在，重建（recreated）", async () => {
    await use(service(() => provider, "sandbox-old"));
    const b = await use(service());
    expect(b.info).toEqual({ fresh: true, recreated: true });
    expect((await row())?.provider).toBe("sandbox-fake");
  });
});

describe("不活跃销毁（审查重点 3）", () => {
  it("超过 destroyAfterInactiveDays 后被销毁；下次调用得到全新沙箱（recreated）", async () => {
    const s = service();
    const a = await use(s);
    await s.suspendIdle(later(11 * MIN));
    expect(await s.destroyInactive(later(6 * DAY))).toBe(0);
    expect(await s.destroyInactive(later(8 * DAY))).toBe(1);
    expect(await row()).toMatchObject({ status: "destroyed" });
    expect((await row())?.destroyed_at).not.toBeNull();
    expect(await fakeSandboxState(root, a.h.id)).toBeNull();
    expect((await ops("destroy")).map((o) => o[1])).toEqual([a.h.id]);

    const b = await use(s);
    expect(b.info).toEqual({ fresh: true, recreated: true });
    expect(b.h.id).not.toBe(a.h.id);
    expect((await row())?.status).toBe("running");
  });

  it("组织已删除、对话已删除：不论多久没用都销毁；对话已删除的记录一并删掉", async () => {
    const s = service();
    const deletedOrg = await newOrg();
    const c1 = await newConversation(deletedOrg);
    const c2 = await newConversation();
    const a = await use(s, c1, deletedOrg);
    const b = await use(s, c2);
    const keep = await use(s);
    await sql`UPDATE capybara.orgs SET deleted_at = now() WHERE id = ${deletedOrg}`.execute(raw);
    await sql`DELETE FROM capybara.conversations WHERE id = ${c2}`.execute(raw);

    expect(await s.destroyInactive(new Date())).toBe(2);
    expect((await row(c1))?.status).toBe("destroyed");
    expect(await row(c2)).toBeUndefined();
    expect((await row())?.status).toBe("running");
    expect(new Set((await ops("destroy")).map((o) => o[1]))).toEqual(new Set([a.h.id, b.h.id]));
    expect(await fakeSandboxState(root, keep.h.id)).toBe("running");
  });

  it("destroyFor：立即销毁该对话的沙箱；没有沙箱时什么也不做", async () => {
    const s = service();
    const a = await use(s);
    await s.destroyFor(conversationId);
    expect((await row())?.status).toBe("destroyed");
    expect(await fakeSandboxState(root, a.h.id)).toBeNull();
    await s.destroyFor(randomUUID());
    expect(await ops("destroy")).toHaveLength(1);
  });

  it("两个实例（副本）同时扫描：每个沙箱只休眠 / 销毁一次", async () => {
    const s1 = service();
    const s2 = service();
    const ids = [conversationId, await newConversation(), await newConversation()];
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

describe("锁", () => {
  it("锁键是 capk:sandbox:<对话>，执行期间持有、结束后释放", async () => {
    const s = service();
    let seen: string | null = null;
    await s.withSandbox(
      { orgId, conversationId },
      async (_h: SandboxHandle) => {
        seen = await redis.get(`capk:sandbox:${conversationId}`);
      },
      signal(),
    );
    expect(seen).not.toBeNull();
    expect(await redis.get(`capk:sandbox:${conversationId}`)).toBeNull();
  });
});
