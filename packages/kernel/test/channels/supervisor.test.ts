import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { channelLeaseKey } from "../../src/channels/supervisor.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { type FakeIm, startFakeIm } from "../helpers/fake-im.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  sleep,
  startKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * 长连接选主的单进程测试（两个内核实例共用 PG / Redis）：续租失败即断开、优雅停机交还租约、
 * 续租不被卡住的交还拖慢、组织停用插件即断开、扫描周期与 TTL 的约束。
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const TTL = 2000;
const SCAN = 100;

let pgc: TestContainer;
let rd: TestContainer;
let im: FakeIm;
let a: Kernel;
let b: Kernel | undefined;
let raw: ReturnType<typeof createDb>;
let redis: Redis;
let owner: Req;
let orgId: string;
let agentId: string;

const cfg = (leaseTtlMs = TTL, scanIntervalMs = SCAN) =>
  runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      plugins: [MODEL_FAKE, CHAN_MINI],
      http: { port: 0, publicUrl: "https://cap.example" },
      auth: { cookieSecure: false },
      channels: { leaseTtlMs, scanIntervalMs, retryBaseMs: 100 },
    },
  );

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeIm();
  a = await startKernel(cfg());
  raw = createDb(pgc.url, 3);
  redis = new Redis(rd.url);
  await new AccountsService(kernelDb(raw)).createLocal({
    login: "owner",
    password: PW,
    displayName: "O",
  });
  owner = await session(a, "owner");
  orgId = await createOrg(owner);
  agentId = await createAgent(owner, orgId);
  const en = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/plugins/chan-mini`,
    payload: { enabled: true },
  });
  expect(en.statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await b?.stop();
  await a?.stop();
  await im?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function newConnection(appId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/channels`,
    payload: {
      plugin: "chan-mini",
      name: appId,
      agentId,
      config: { platformUrl: im.url, appId, appSecret: "app-secret-123456", ...extra },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = (res.json() as { channel: { id: string } }).channel.id;
  await waitFor(async () => im.active(id).length === 1, 10_000, `connection ${appId}`);
  return id;
}

const streamsOf = (id: string) => im.streams.filter((s) => s.connectionId === id);

describe("渠道长连接选主（单进程）", () => {
  it("续租失败（租约被改写）→ 中止 connect、长连接断开；租约空出后重新连上", async () => {
    const id = await newConnection("renew-fail");
    await redis.set(channelLeaseKey(id), "someone-else", "PX", 60_000);
    await waitFor(async () => im.active(id).length === 0, 5_000, "stream closed after lease loss");
    // 别人持有期间不会重连
    await sleep(SCAN * 5);
    expect(im.active(id)).toHaveLength(0);
    await redis.del(channelLeaseKey(id));
    await waitFor(async () => im.active(id).length === 1, 5_000, "reconnected");
    expect(im.maxConcurrent(id)).toBe(1);
  }, 30_000);

  it("续租不被卡住的交还拖慢：一个连接的 connect 迟迟不退出，其他连接照常续租", async () => {
    const steady = await newConnection("steady");
    const stuck = await newConnection("stuck", { lingerMs: 8000 });
    // 直接改库（不经 bus 广播），由每轮复核发现并交还
    await sql`UPDATE capybara.channel_connections SET status = 'disabled' WHERE id = ${stuck}`.execute(
      raw,
    );
    await waitFor(async () => im.active(stuck).length === 0, 5_000, "stuck stream closed");
    // 交还要等 connect 返回（至多 5s）：这期间 steady 的租约必须照常续上，长连接不断
    await sleep(TTL * 3);
    expect(streamsOf(steady)).toHaveLength(1);
    expect(im.active(steady)).toHaveLength(1);
  }, 30_000);

  it("交还等待 connect 退出期间照常续租：租约不会在别的副本眼里提前过期", async () => {
    const id = await newConnection("settle", { lingerMs: 4000 });
    const off = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/channels/${id}`,
      payload: { status: "disabled" },
    });
    expect(off.statusCode).toBe(200);
    await waitFor(async () => im.active(id).length === 0, 5_000, "stream closed");
    // 插件还要 ~4s 才返回：超过一个 TTL 之后租约仍在（被续着），返回后才释放
    await sleep(TTL * 1.5);
    expect(await redis.exists(channelLeaseKey(id))).toBe(1);
    await waitFor(async () => (await redis.exists(channelLeaseKey(id))) === 0, 10_000, "released");
  }, 30_000);

  it("组织停用插件 → 长连接断开；重新启用后连上", async () => {
    const id = await newConnection("plugin-toggle");
    const off = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/plugins/chan-mini`,
      payload: { enabled: false, force: true },
    });
    expect(off.statusCode, off.body).toBe(200);
    await waitFor(async () => im.active(id).length === 0, 5_000, "closed after plugin disabled");
    await sleep(SCAN * 5);
    expect(im.active(id)).toHaveLength(0);
    const on = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/plugins/chan-mini`,
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    await waitFor(async () => im.active(id).length === 1, 5_000, "reconnected after re-enable");
  }, 30_000);

  it("优雅停机释放租约：另一实例远早于 TTL 接管", async () => {
    // 换成长 TTL 的一对实例：a 持有全部连接，b 后启动
    await a.stop();
    for (const id of await activeIds()) {
      await waitFor(async () => im.active(id).length === 0, 10_000, "closed on stop");
    }
    const longTtl = 20_000;
    a = await startKernel(cfg(longTtl, SCAN));
    owner = await session(a, "owner");
    const id = await newConnection("graceful");
    b = await startKernel(cfg(longTtl, SCAN));
    await sleep(SCAN * 5);
    expect(im.active(id)).toHaveLength(1);
    const before = streamsOf(id).length;
    const stoppedAt = Date.now();
    await a.stop();
    await waitFor(
      async () => streamsOf(id).length > before && im.active(id).length === 1,
      5_000,
      "takeover",
    );
    expect(Date.now() - stoppedAt).toBeLessThan(longTtl / 4);
    expect(im.maxConcurrent(id)).toBe(1);
  }, 60_000);

  it("配置：scanIntervalMs 不得超过 leaseTtlMs 的一半", () => {
    const base = {
      db: { url: "postgres://x" },
      redis: { url: "redis://x" },
      masterKey: Buffer.alloc(32).toString("base64"),
    };
    expect(() =>
      KernelConfigSchema.parse({
        ...base,
        channels: { leaseTtlMs: 10_000, scanIntervalMs: 6_000 },
      }),
    ).toThrow();
    expect(() =>
      KernelConfigSchema.parse({
        ...base,
        channels: { leaseTtlMs: 10_000, scanIntervalMs: 5_000 },
      }),
    ).not.toThrow();
  });
});

async function activeIds(): Promise<string[]> {
  return [
    ...new Set(im.streams.filter((s) => s.closedAt === undefined).map((s) => s.connectionId)),
  ];
}
