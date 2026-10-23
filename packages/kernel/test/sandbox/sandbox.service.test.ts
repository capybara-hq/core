import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSandboxGoneError,
  type SandboxHandle,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { ConversationLock } from "../../src/runtime/conversation-lock.js";
import {
  SANDBOX_BUSY_PREFIX,
  SandboxLockLostError,
  SandboxService,
  type SandboxServiceDeps,
} from "../../src/sandbox/sandbox.service.js";
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

const service = (
  p: () => SandboxProvider | undefined = () => provider,
  plugin = "sandbox-fake",
  extra: Partial<SandboxServiceDeps> = {},
) =>
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
/** 等假沙箱登记下正在跑的命令（`instances/<id>/procs/<pid>`），代替固定的等待。 */
async function waitForProc(id: string, timeoutMs = 10_000): Promise<void> {
  const dir = join(root, "instances", id, "procs");
  const until = Date.now() + timeoutMs;
  while ((await readdir(dir).catch(() => [])).length === 0) {
    if (Date.now() > until) throw new Error(`no running command registered for ${id}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

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

describe("组织出站设置（Ruling M19）", () => {
  const setEgress = (value: unknown, org = orgId) =>
    sql`UPDATE capybara.orgs SET settings = ${JSON.stringify({ sandboxEgress: value })}::jsonb
      WHERE id = ${org}`.execute(raw);
  const limitsOf = async (s: SandboxService, id = conversationId) =>
    (await fakeSandboxMeta(root, (await use(s, id)).h.id))?.limits;

  it("组织 none → 创建时 egress none；allowlist + 主机 → 替换部署白名单；省略主机 → 沿用部署的", async () => {
    const s = service();
    await setEgress({ mode: "none" });
    expect(await limitsOf(s)).toMatchObject({ egress: "none", allowHosts: [] });

    await setEgress({ mode: "allowlist", allowHosts: ["example.com", "*.corp.example.org"] });
    expect(await limitsOf(s, await newConversation())).toMatchObject({
      egress: "allowlist",
      allowHosts: ["example.com", "*.corp.example.org"],
    });

    await setEgress({ mode: "allowlist" });
    expect(await limitsOf(s, await newConversation())).toMatchObject({
      egress: "allowlist",
      allowHosts: config.sandbox.limits.allowHosts,
    });
  });

  it("部署为 none 时组织的 allowlist 不放宽；部署 open 时组织 allowlist 收窄；非法存量按 none", async () => {
    const s = service();
    await setEgress({ mode: "allowlist", allowHosts: ["example.com"] });
    config.sandbox.limits.egress = "none";
    expect(await limitsOf(s)).toMatchObject({ egress: "none", allowHosts: [] });
    config.sandbox.limits.egress = "open";
    expect(await limitsOf(s, await newConversation())).toMatchObject({
      egress: "allowlist",
      allowHosts: ["example.com"],
    });
    await setEgress({ mode: "open" });
    expect(await limitsOf(s, await newConversation())).toMatchObject({
      egress: "none",
      allowHosts: [],
    });
  });

  it("改设置只影响之后新建的沙箱：已有的沿用创建时的出站", async () => {
    const s = service();
    const first = await use(s);
    await setEgress({ mode: "none" });
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect((await fakeSandboxMeta(root, again.h.id))?.limits.egress).toBe("allowlist");
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
    let entered!: () => void;
    const inside = new Promise<void>((r) => {
      entered = r;
    });
    const holder = s.withSandbox(
      { orgId, conversationId },
      async () => {
        entered();
        await gate;
      },
      signal(),
    );
    await inside;
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

const lockKey = () => `capk:sandbox:${conversationId}`;
const waitAborted = (sig: AbortSignal) =>
  new Promise<void>((r) => {
    if (sig.aborted) r();
    else sig.addEventListener("abort", () => r(), { once: true });
  });

describe("锁的防护（fix round 1）", () => {
  it("锁丢失：传给 fn 的 signal 被中止", async () => {
    const s = service(undefined, undefined, { lockTtlMs: 300 });
    const reason = await s.withSandbox(
      { orgId, conversationId },
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
    await sql`UPDATE capybara.sandboxes SET status = 'destroyed', generation = generation + 1`.execute(
      raw,
    );
    await expect(pending).rejects.toThrow(/changed|lost/);
    expect((await row())?.status).toBe("destroyed");
  });

  it("旧持有者的锁丢失后，新持有者的 fn 运行期间扫描不会休眠", async () => {
    const s = service(undefined, undefined, { lockTtlMs: 300 });
    await use(s);
    const a = s.withSandbox(
      { orgId, conversationId },
      async (_h, _p, _info, sig) => {
        await redis.del(lockKey()); // 锁过期
        await waitAborted(sig);
      },
      signal(),
    );
    await a;
    const b = gates();
    const holderB = s.withSandbox(
      { orgId, conversationId },
      async () => {
        b.entered();
        await b.gate;
      },
      signal(),
    );
    await b.inside;
    await sql`UPDATE capybara.sandboxes SET running_since = now() - interval '3 hours',
      last_used_at = now() - interval '1 hour'`.execute(raw);
    expect(await s.suspendIdle(new Date())).toBe(0);
    expect((await row())?.status).toBe("running");
    b.release();
    await holderB;
  });

  it("锁等待超过 lockWaitSeconds：sandbox.busy（409）", async () => {
    config = { ...config, sandbox: { ...config.sandbox, lockWaitSeconds: 0.2 } };
    const s = service();
    const g = gates();
    const holder = s.withSandbox(
      { orgId, conversationId },
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

  it("记录属于别的组织：ApiError", async () => {
    const s = service();
    await use(s);
    const err = await use(s, conversationId, await newOrg()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
  });
});

describe("recreated 粘性（fix round 1）", () => {
  it("销毁后重建失败，再下一次使用仍报 recreated", async () => {
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
    await use(s);
    await s.destroyFor(conversationId);
    fail = true;
    await expect(use(s)).rejects.toThrow("docker down");
    fail = false;
    expect((await use(s)).info).toEqual({ fresh: true, recreated: true });
  });
});

describe("执行中发现实例已不在（SandboxGoneError，fix round 1）", () => {
  it("运行中的沙箱实例消失：fn 抛 SandboxGoneError 后原地重建重试一次，recreated 为 true", async () => {
    const s = service();
    const a = await use(s);
    await removeFakeSandbox(root, a.h.id);
    const infos: unknown[] = [];
    const out = await s.withSandbox(
      { orgId, conversationId },
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
      { fresh: false, recreated: false },
      { fresh: true, recreated: true },
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
        { orgId, conversationId },
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

describe("清理遗留实例（fix round 1）", () => {
  it("创建中途崩溃（handle 为空）：销毁时按名字 destroyByName", async () => {
    const s = service();
    // 提供方那边已经建好了，但记录还停在 creating（内核在写 handle 前退出）
    const h = await (provider as SandboxProvider).create({
      name: `cap-${conversationId}`,
      image: "i",
      limits: { cpu: 1, memoryMb: 1, diskMb: 1, egress: "none", allowHosts: [] },
      signal: signal(),
    });
    await sql`INSERT INTO capybara.sandboxes (conversation_id, org_id, provider, status, last_used_at)
      VALUES (${conversationId}, ${orgId}, 'sandbox-fake', 'creating', now() - interval '30 days')`.execute(
      raw,
    );
    expect(await s.destroyInactive(new Date())).toBe(1);
    expect(await fakeSandboxState(root, h.id)).toBeNull();
    expect((await ops("destroy-by-name")).map((o) => o[1])).toEqual([`cap-${conversationId}`]);
  });

  it("换了提供方：旧提供方仍加载时用它销毁旧实例；否则记下 prev_provider / prev_handle 并 warn", async () => {
    const oldRoot = await mkdtemp(join(tmpdir(), "cap-sandbox-old-"));
    const old = createFakeSandbox(oldRoot);
    const a = await use(service(() => old, "sandbox-old"));
    // 旧提供方还在：新服务能按名字找到它
    const s = service(undefined, undefined, {
      lookup: (name) => (name === "sandbox-old" ? old : undefined),
    });
    expect((await use(s)).info.recreated).toBe(true);
    expect(await fakeSandboxState(oldRoot, a.h.id)).toBeNull();
    expect(await row()).toMatchObject({ prev_provider: null, prev_handle: null });

    // 旧提供方不在了：记下来、warn
    const c2 = await newConversation();
    const b = await use(
      service(() => old, "sandbox-old"),
      c2,
    );
    warned.length = 0;
    await use(service(), c2);
    expect(await row(c2)).toMatchObject({ prev_provider: "sandbox-old", prev_handle: b.h });
    expect(warned.some((w) => /another provider/.test(w))).toBe(true);
    expect(await fakeSandboxState(oldRoot, b.h.id)).toBe("running");
    await rm(oldRoot, { recursive: true, force: true });
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
    // 扫描方的锁永远「没丢」：续租总成功、从不报告丢失——只剩 generation 能挡住它
    const real = new ConversationLock(redis, log, "capk:sandbox:");
    const blind = {
      acquire: async (id: string, token: string, ttl: number) => {
        const lease = await real.acquire(id, token, ttl);
        if (!lease) return null;
        return {
          conversationId: id,
          runId: token,
          lost: false,
          renew: async () => true,
          release: () => lease.release(),
          abandon: () => lease.abandon(),
          onLost: () => {},
        };
      },
    };
    const failures: unknown[] = [];
    const sweeper = service(() => slow, undefined, {
      lockTtlMs: 300,
      lock: blind,
      log: {
        info() {},
        warn: (m: string, f?: Record<string, unknown>) => {
          if (m === "sandbox maintenance failed; will retry") failures.push(f?.err);
        },
      },
    });
    const sweep = sweeper.suspendIdle(later(11 * MIN));
    await started.inside;
    // 扫描方的锁过期，B 拿到锁、走运行中的路径用完
    await redis.del(lockKey());
    const b = await use(s);
    expect(b.info).toEqual({ fresh: false, recreated: false });
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
    const real = new ConversationLock(redis, log, "capk:sandbox:");
    const throwing = {
      acquire: async (id: string, token: string, ttl: number) => {
        const lease = await real.acquire(id, token, ttl);
        if (!lease) return null;
        return Object.assign(Object.create(lease), {
          renew: async () => {
            throw new Error("redis timeout");
          },
          release: () => lease.release(),
          onLost: (cb: () => void) => lease.onLost(cb),
        });
      },
    };
    const s = service(undefined, undefined, { lockTtlMs: 300, lock: throwing });
    const reason = await s.withSandbox(
      { orgId, conversationId },
      async (_h, _p, _info, sig) => {
        await waitAborted(sig);
        return sig.reason;
      },
      signal(),
    );
    expect((reason as Error).name).toBe("SandboxLockLostError");
  });

  it("续租一直报错：在 TTL 的 2/3 之后、键过期之前就中止 fn 的 signal", async () => {
    const real = new ConversationLock(redis, log, "capk:sandbox:");
    const throwing = {
      acquire: async (id: string, token: string, ttl: number) => {
        const lease = await real.acquire(id, token, ttl);
        if (!lease) return null;
        return Object.assign(Object.create(lease), {
          renew: async () => {
            throw new Error("redis timeout");
          },
          release: () => lease.release(),
          onLost: (cb: () => void) => lease.onLost(cb),
        });
      },
    };
    const ttl = 1500;
    const s = service(undefined, undefined, { lockTtlMs: ttl, lock: throwing });
    const elapsed = await s.withSandbox(
      { orgId, conversationId },
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
    const err = (await use(s, conversationId, other).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("forbidden");
    expect(err.message).not.toContain(orgId);
  });
});

describe("被内核之外的原因停掉（fix wave S2 I1）", () => {
  it("记录是 running、实例却停了：下一次调用由提供方自动启动接上，文件还在，不重建", async () => {
    const s = service();
    const { h } = await use(s);
    await s.withSandbox(
      { orgId, conversationId },
      (hh, p, _i, sig) => p.writeFile(hh, "/workspace/a.txt", new TextEncoder().encode("a"), sig),
      signal(),
    );
    // 例如休眠扫描停了实例、却在写 suspended 之前丢了锁
    await provider?.suspend(h, signal());
    expect((await row())?.status).toBe("running");
    const out = await s.withSandbox(
      { orgId, conversationId },
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
    expect(out.info).toEqual({ fresh: false, recreated: false });
    expect(out.r.stdout).toBe("a");
    expect(await ops("autostart")).toHaveLength(1);
    expect(await ops("create")).toHaveLength(1);
  });
});

describe("接手崩溃的前任（fix wave S2 I2）", () => {
  const busyKey = () => `${SANDBOX_BUSY_PREFIX}${conversationId}`;

  it("执行期间写下 capk:sandbox-busy:<对话>（带 TTL），结束后删掉；正常交接不调 killAll", async () => {
    const s = service();
    let seen: { v: string | null; ttl: number } = { v: null, ttl: 0 };
    await s.withSandbox(
      { orgId, conversationId },
      async () => {
        seen = { v: await redis.get(busyKey()), ttl: await redis.pttl(busyKey()) };
      },
      signal(),
    );
    expect(seen.v).not.toBeNull();
    expect(seen.ttl).toBeGreaterThan(config.sandbox.limits.maxCommandSeconds * 1000);
    expect(await redis.get(busyKey())).toBeNull();
    await use(s);
    expect(await ops("kill-all")).toHaveLength(0);
  });

  it("拿到锁时前任的标记还在：先 killAll 杀掉前任遗留的命令，再执行 fn", async () => {
    const s = service();
    const { h } = await use(s);
    // 前任（已崩溃的副本）启动的命令：没有人再按超时杀它，也没有删标记
    const left = provider?.exec(h, {
      command: "sleep 30",
      timeoutMs: 60_000,
      maxOutputBytes: 100,
      signal: signal(),
    });
    await redis.set(busyKey(), "dead-holder", "PX", 60_000);
    await waitForProc(h.id);
    const started = Date.now();
    const order: string[] = [];
    await s.withSandbox(
      { orgId, conversationId },
      async () => {
        order.push(`fn after ${(await ops("kill-all")).length} kill-all`);
      },
      signal(),
    );
    expect(order).toEqual(["fn after 1 kill-all"]);
    expect(await left).toMatchObject({ exitCode: null, timedOut: false });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await redis.get(busyKey())).toBeNull();
  });

  it("前任的标记还在、但这次是新建的沙箱：不调 killAll", async () => {
    const s = service();
    await redis.set(busyKey(), "dead-holder", "PX", 60_000);
    const { info } = await use(s);
    expect(info.fresh).toBe(true);
    expect(await ops("kill-all")).toHaveLength(0);
  });

  it("killAll 失败只记 warn，照常执行 fn", async () => {
    const base = createFakeSandbox(root);
    const failing: SandboxProvider = {
      ...base,
      killAll: async () => {
        throw new Error("kill failed");
      },
    };
    const s = service(() => failing);
    await use(s);
    await redis.set(busyKey(), "dead-holder", "PX", 60_000);
    const r = await s.withSandbox({ orgId, conversationId }, async () => "ran", signal());
    expect(r).toBe("ran");
    expect(warned).toContain("cannot kill leftover sandbox commands");
  });
});

describe("恢复休眠的沙箱时清掉遗留命令（fix round 2）", () => {
  it("从 suspended 恢复：即使标记已过期，也先 killAll（暂停保留内存的提供方，前任的命令随恢复回来）", async () => {
    const s = service();
    const { h } = await use(s);
    // 前任留下的命令（假沙箱的 suspend 与 E2B 暂停一样不结束进程），标记已按墙钟过期（不存在）
    const left = provider?.exec(h, {
      command: "sleep 30",
      timeoutMs: 60_000,
      maxOutputBytes: 100,
      signal: signal(),
    });
    await waitForProc(h.id);
    expect(await s.suspendIdle(later(DAY))).toBe(1);
    expect(await redis.get(`${SANDBOX_BUSY_PREFIX}${conversationId}`)).toBeNull();
    const order: string[] = [];
    await s.withSandbox(
      { orgId, conversationId },
      async () => {
        order.push(`fn after ${(await ops("kill-all")).length} kill-all`);
      },
      signal(),
    );
    expect(order).toEqual(["fn after 1 kill-all"]);
    expect(await left).toMatchObject({ exitCode: null, timedOut: false });
    // 之后正常使用（运行中、没有标记）不再 killAll
    await use(s);
    expect(await ops("kill-all")).toHaveLength(1);
  });
});
