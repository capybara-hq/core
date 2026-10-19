import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  fakeDm as dm,
  type FakeChannelServer,
  type Harness,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, PW, sleep, waitFor } from "../helpers/runs.js";

/**
 * Review Focus 1（双副本 + 杀副本）：两个独立进程的内核副本（都含 worker 角色）都想接管同一个渠道连接——
 * 任一时刻只有一个副本持有长连接；持有者被 SIGKILL 后，另一副本在租约过期后接管；
 * 同一条 IM 消息即使被平台重投（含接管前后各投一次）也只写入一次。
 * 租约与扫描周期经配置缩短（默认 30s / 10s）：TTL 3s、每 300ms 扫描与续租。
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const LEASE_TTL_MS = 3000;
const SCAN_MS = 300;

let pgc: TestContainer;
let rdc: TestContainer;
let im: FakeChannelServer;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer();
}, 120_000);

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

afterAll(async () => {
  await im?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

type Json = Record<string, unknown>;

describe("渠道长连接选主（双副本）", () => {
  it("只有一个副本持有长连接；杀掉持有者后另一副本在租约过期后接管；重投消息只写一次", async () => {
    const redis = new Redis(rdc.url);
    cleanups.push(() => redis.disconnect());
    await redis.flushdb();
    h = await createDualReplicaHarness({
      plugins: [MODEL_FAKE, CHAN_MINI],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      config: {
        auth: { cookieSecure: false },
        http: { publicUrl: "https://cap.example" },
        channels: { leaseTtlMs: LEASE_TTL_MS, scanIntervalMs: SCAN_MS },
      },
    });
    const harness = h;
    const raw = createDb(harness.dbUrl, 3);
    cleanups.push(() => raw.destroy());
    const db: KernelDb = kernelDb(raw);

    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await harness.request(path, {
        method,
        headers: {
          "x-capybara-csrf": "1",
          ...(cookie !== "" && { cookie }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (path === "/api/v1/auth/login") {
        cookie = res.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ");
      }
      return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
    };

    const ownerId = (
      await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" })
    ).id;
    expect(
      (await call("POST", "/api/v1/auth/login", { login: "owner", password: PW })).status,
    ).toBe(200);
    const org = await call("POST", "/api/v1/orgs", { name: "Acme" });
    expect(org.status).toBe(201);
    const orgId = (org.json.org as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}`;
    const ag = await call("POST", `${base}/agents`, {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [],
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const agentId = (ag.json.agent as { id: string }).id;
    await sql`INSERT INTO capybara.identities (source, external_id, account_id)
      VALUES ('chan-mini:t1', 'u-owner', ${ownerId})`.execute(raw);
    expect((await call("PUT", `${base}/plugins/chan-mini`, { enabled: true })).status).toBe(200);
    const ch = await call("POST", `${base}/channels`, {
      plugin: "chan-mini",
      name: "Bot",
      agentId,
      config: { platformUrl: im.url, appId: "cli_dual", appSecret: "dual-secret-0a1b2c3d" },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    const connId = (ch.json.channel as { id: string }).id;

    // ---- 只有一个副本连上 ----
    const first = await waitFor(async () => im.active(connId)[0], 15_000, "first long connection");
    // 观察若干个扫描 / 续租周期：另一副本一直拿不到租约
    await sleep(LEASE_TTL_MS * 2);
    expect(im.active(connId)).toHaveLength(1);
    expect(im.maxConcurrent(connId)).toBe(1);
    expect(im.streams.filter((s) => s.connectionId === connId)).toHaveLength(1);
    const pids = harness.replicas.map((r) => r.pid);
    expect(pids).toContain(first.pid);
    const holder = harness.replicas.find((r) => r.pid === first.pid);
    const survivor = harness.replicas.find((r) => r.pid !== first.pid);
    if (!holder || !survivor) throw new Error("cannot identify replicas");

    // ---- 第一条消息由持有者写入 ----
    expect(im.push(connId, dm("m1", "u-owner", "before crash"))).toBe(1);
    const convId = await waitFor(
      async () => {
        const r = await sql<{ conversation_id: string }>`SELECT conversation_id
        FROM capybara.channel_threads WHERE connection_id = ${connId}`.execute(raw);
        return r.rows[0]?.conversation_id;
      },
      15_000,
      "conversation",
    );
    const userMsgs = async () =>
      (await eventsOf(db, convId))
        .filter((e) => e.type === "user_message")
        .map((e) => (e.payload as { clientMessageId?: string }).clientMessageId);
    await waitFor(async () => (await userMsgs()).length === 1, 15_000, "m1 written");

    // ---- 杀掉持有者：另一副本在租约过期后接管 ----
    const killedAt = Date.now();
    await harness.kill(holder.index);
    const second = await waitFor(
      async () => im.active(connId).find((s) => s.pid === survivor.pid),
      LEASE_TTL_MS + 15_000,
      "takeover by the surviving replica",
    );
    // 租约没有被提前释放（硬崩溃不走停机流程）：接管发生在租约过期之后
    expect(second.openedAt - killedAt).toBeGreaterThanOrEqual(LEASE_TTL_MS - 1000);
    expect(im.active(connId)).toHaveLength(1);
    expect(im.maxConcurrent(connId)).toBe(1);

    // ---- 平台重投 m1（崩溃前已处理过）并投递 m2；再重投一次 m2 ----
    expect(im.push(connId, dm("m1", "u-owner", "before crash"))).toBe(1);
    expect(im.push(connId, dm("m2", "u-owner", "after takeover"))).toBe(1);
    expect(im.push(connId, dm("m2", "u-owner", "after takeover"))).toBe(1);
    await waitFor(async () => (await userMsgs()).length >= 2, 15_000, "m2 written");
    await sleep(500);
    expect(await userMsgs()).toEqual([`${connId}:m1`, `${connId}:m2`]);
    const threadRows = await sql`SELECT 1 FROM capybara.channel_threads
      WHERE connection_id = ${connId}`.execute(raw);
    expect(threadRows.rows).toHaveLength(1);
  }, 120_000);
});
