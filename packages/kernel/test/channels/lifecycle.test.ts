import { fileURLToPath } from "node:url";
import {
  fakeCardAction as cardAction,
  fakeDm as dm,
  type FakeChannelSent,
  type FakeChannelServer,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { channelBackoffKey } from "../../src/channels/connections.service.js";
import { CHANNEL_QUEUE_NAME, inboundJobId } from "../../src/channels/outbound.js";
import { channelLeaseKey } from "../../src/channels/supervisor.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Kernel } from "../../src/kernel.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  sleep,
  startKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * 连接生命周期（修复波 W2）：组织软删除、组织停用插件、滚动升级时没有插件的副本、插件停用时轮换凭据。
 * 扫描周期故意放长（5s）：断开必须来自 `channel.changed` 广播（远早于下一轮扫描复核），
 * 「之后不再连上」则由扫描时的过滤保证。
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const SCAN = 5000;
const TTL = 15_000;
/** 广播触发的断开应在这么久内发生（远小于扫描周期）。 */
const FAST = 1500;

let pgc: TestContainer;
let rd: TestContainer;
let im: FakeChannelServer;
let a: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let owner: Req;
let ownerId: string;
let queue: Queue;

const cfg = (plugins: string[], scanIntervalMs = SCAN, leaseTtlMs = TTL) =>
  runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      extensions: plugins,
      http: { port: 0, publicUrl: "https://cap.example" },
      auth: { cookieSecure: false },
      channels: { leaseTtlMs, scanIntervalMs, retryBaseMs: 100, deliveryIdleMs: 500 },
    },
  );

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer();
  a = await startKernel(cfg([MODEL_FAKE, CHAN_MINI]));
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  queue = new Queue(CHANNEL_QUEUE_NAME, { connection: new Redis(rd.url) });
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(a, "owner");
}, 120_000);

afterAll(async () => {
  await queue?.close();
  await a?.stop();
  await im?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** 新组织（启用 chan-mini）+ agent + 一个连接，等长连接连上。 */
async function setup(name: string): Promise<{ orgId: string; agentId: string; connId: string }> {
  const orgId = await createOrg(owner, name);
  const agentId = await createAgent(owner, orgId);
  const en = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
    payload: { enabled: true },
  });
  expect(en.statusCode, en.body).toBe(200);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/channels`,
    payload: {
      plugin: "chan-mini",
      name,
      agentId,
      config: { platformUrl: im.url, appId: `app-${name}`, appSecret: "app-secret-123456" },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const connId = (res.json() as { channel: { id: string } }).channel.id;
  await waitFor(async () => im.active(connId).length === 1, SCAN * 3, `connection ${name}`);
  return { orgId, agentId, connId };
}

const threadsOf = async (connId: string) =>
  (await sql`SELECT 1 FROM capybara.channel_threads WHERE connection_id = ${connId}`.execute(raw))
    .rows.length;

describe("迁移 0020", () => {
  it("卡片操作按 (连接, 类型, 卡片 id) 查找有唯一索引；通讯录排除的外键列有索引", async () => {
    const r = await sql<{ indexname: string; indexdef: string }>`SELECT indexname, indexdef
      FROM pg_indexes WHERE schemaname = 'capybara'
        AND tablename IN ('channel_card_messages', 'directory_exclusions')`.execute(raw);
    const def = (name: string) => r.rows.find((x) => x.indexname === name)?.indexdef ?? "";
    expect(def("channel_card_messages_lookup_uq")).toMatch(
      /UNIQUE INDEX .* \(connection_id, card_kind, card_id\)/,
    );
    expect(def("directory_exclusions_account_idx")).toMatch(/\(account_id\)/);
    expect(def("directory_exclusions_created_by_idx")).toMatch(/\(created_by\)/);
  });
});

describe("渠道连接生命周期", () => {
  it("组织软删除 → 长连接立即断开、之后不再连上；入站消息什么都不建", async () => {
    const { orgId, connId } = await setup("doomed");
    await sql`INSERT INTO capybara.identities (source, external_id, account_id, linked_via)
      VALUES ('chan-mini:t1', 'u-doomed', ${ownerId}, 'sso')`.execute(raw);
    const del = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}` });
    expect(del.statusCode, del.body).toBe(204);
    const t0 = Date.now();
    await waitFor(async () => im.active(connId).length === 0, FAST, "closed after org deleted");
    expect(Date.now() - t0).toBeLessThan(FAST);
    await sleep(SCAN * 1.5);
    expect(im.active(connId)).toHaveLength(0);
    // 入站（已排进队列的消息由 worker 处理）：组织已删除 → 不建话题、不写消息、不回复
    const before = im.sent.length;
    await a.channels.inbound.handle(connId, dm("after-delete", "u-doomed", "hello"));
    expect(await threadsOf(connId)).toBe(0);
    expect(im.sent.length).toBe(before);
    await expect(a.channels.connections.row(connId)).resolves.toBeUndefined();
  }, 60_000);

  it("组织停用插件 → 广播 channel.changed，长连接立即断开（不等扫描复核）", async () => {
    const { orgId, connId } = await setup("toggle");
    const off = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
      payload: { enabled: false, force: true },
    });
    expect(off.statusCode, off.body).toBe(200);
    const t0 = Date.now();
    await waitFor(async () => im.active(connId).length === 0, FAST, "closed after plugin disabled");
    expect(Date.now() - t0).toBeLessThan(FAST);
    // 停用之后才处理到的入站消息与卡片操作（广播与断开之间到达、已排进队列的）：实时复核启用状态，什么都不做
    await sql`INSERT INTO capybara.identities (source, external_id, account_id, linked_via)
      VALUES ('chan-mini:t1', 'u-toggle', ${ownerId}, 'sso')`.execute(raw);
    const before = im.sent.length;
    await a.channels.inbound.handle(connId, dm("late-1", "u-toggle", "hello"));
    await a.channels.inbound.handle(
      connId,
      cardAction(
        "card-msg",
        "u-toggle",
        { cardKind: "approval", cardId: "ap-1", action: "approve" },
        { chatId: "dm-u-toggle", chatType: "dm" },
      ),
    );
    expect(await threadsOf(connId)).toBe(0);
    expect(im.sent.length).toBe(before);
  }, 60_000);

  it("插件在组织停用时仍可轮换凭据：跳过 verify 并在响应里说明；重新启用后按新凭据连上", async () => {
    const { orgId, connId } = await setup("rotate");
    const off = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
      payload: { enabled: false, force: true },
    });
    expect(off.statusCode, off.body).toBe(200);
    await waitFor(async () => im.active(connId).length === 0, SCAN * 2, "closed");
    const res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/channels/${connId}`,
      payload: {
        config: { platformUrl: im.url, appId: "app-rotated", webhookToken: "new-token-123" },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      channel: { secrets: { path: string; set: boolean }[]; config: Record<string, unknown> };
      verifySkipped?: boolean;
    };
    expect(body.verifySkipped).toBe(true);
    expect(body.channel.config.appId).toBe("app-rotated");
    expect(body.channel.secrets).toEqual(
      expect.arrayContaining([
        { path: "appSecret", set: true },
        { path: "webhookToken", set: true },
      ]),
    );
    // 插件启用时轮换照常 verify
    const on = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    await waitFor(
      async () =>
        im.streams.some(
          (s) => s.connectionId === connId && s.appId === "app-rotated" && !s.closedAt,
        ),
      SCAN * 3,
      "reconnected with rotated credentials",
    );
    const again = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/channels/${connId}`,
      payload: { config: { platformUrl: im.url, appId: "app-rotated", appSecret: "bad-secret" } },
    });
    expect(again.statusCode).toBe(502);
    expect((again.json() as { error: { code: string } }).error.code).toBe("channel.verify_failed");
  }, 60_000);

  it("重新启用连接 → 补投停用期间落下的会话（不必等下一条消息）", async () => {
    const { orgId, connId } = await setup("resume");
    await sql`INSERT INTO capybara.identities (source, external_id, account_id, linked_via)
      VALUES ('chan-mini:t1', 'u-resume', ${ownerId}, 'sso')`.execute(raw);
    const toChat = () => im.sent.filter((s) => s.target.chatId === "dm-u-resume");
    im.push(connId, dm("res-1", "u-resume", "hello"));
    await waitFor(async () => toChat().length >= 1, 15_000, "first reply");
    const conv = (
      await sql<{ conversation_id: string }>`SELECT conversation_id FROM capybara.channel_threads
        WHERE connection_id = ${connId}`.execute(raw)
    ).rows[0]?.conversation_id as string;
    const patch = (payload: Record<string, unknown>) =>
      owner({ method: "PATCH", url: `/api/v1/orgs/${orgId}/channels/${connId}`, payload });
    expect((await patch({ status: "disabled" })).statusCode).toBe(200);
    // 进行中的投递任务（停用前开始的）空闲后结束；之后的任务看到连接已停用就不投递
    await waitFor(
      async () => (await redis.get(`capk:channel-deliver:${conv}`)) === null,
      10_000,
      "delivery job exited",
    );
    const before = toChat().length;
    await postMessage(owner, orgId, conv, "while disabled");
    await waitFor(
      async () => (await eventsOf(db, conv)).filter((e) => e.type === "run_finished").length >= 2,
      15_000,
      "second run finished",
    );
    await sleep(1000);
    expect(toChat().length).toBe(before);
    expect((await patch({ status: "active" })).statusCode).toBe(200);
    await waitFor(async () => toChat().length > before, 10_000, "backlog delivered");
  }, 60_000);

  it("投递中轮换凭据 → 进行中的投递任务结束并由新任务接着投，之后的发送 / 编辑都用新凭据", async () => {
    const { orgId, connId } = await setup("midrot");
    await sql`INSERT INTO capybara.identities (source, external_id, account_id, linked_via)
      VALUES ('chan-mini:t1', 'u-midrot', ${ownerId}, 'sso')`.execute(raw);
    const text = "Rotating credentials while this long reply is still streaming to IM. ".repeat(2);
    const ofChat = (xs: FakeChannelSent[]) => xs.filter((x) => x.target.chatId === "dm-u-midrot");
    im.push(connId, dm("mr-1", "u-midrot", `slow:300:${text}`));
    await waitFor(async () => ofChat(im.sent).length >= 1, 15_000, "draft");
    const res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/channels/${connId}`,
      payload: { config: { platformUrl: im.url, appId: "app-midrot-new" } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const rotatedAt = Date.now();
    await waitFor(
      async () => [...ofChat(im.sent), ...ofChat(im.updated)].some((x) => x.message.text === text),
      30_000,
      "final text",
    );
    // 轮换后留一个轮询周期给进行中的那次调用
    const after = [...ofChat(im.sent), ...ofChat(im.updated)].filter((x) => x.at > rotatedAt + 700);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((x) => x.appId === "app-midrot-new")).toBe(true);
  }, 60_000);

  it("投递中停用连接 → 进行中的投递任务不再发送 / 编辑", async () => {
    const { orgId, connId } = await setup("middis");
    await sql`INSERT INTO capybara.identities (source, external_id, account_id, linked_via)
      VALUES ('chan-mini:t1', 'u-middis', ${ownerId}, 'sso')`.execute(raw);
    const text = "Disabling the connection while this long reply is still streaming. ".repeat(2);
    const count = () =>
      [...im.sent, ...im.updated].filter((x) => x.target.chatId === "dm-u-middis").length;
    im.push(connId, dm("md-1", "u-middis", `slow:300:${text}`));
    await waitFor(async () => count() >= 1, 15_000, "draft");
    const res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/channels/${connId}`,
      payload: { status: "disabled" },
    });
    expect(res.statusCode).toBe(200);
    // 留一个轮询周期给进行中的那次调用，之后不应再有任何发送 / 编辑
    await sleep(1000);
    const snapshot = count();
    await sleep(4000);
    expect(count()).toBe(snapshot);
  }, 60_000);

  it("滚动升级：没有加载该插件的副本不取租约、不写 last_error / 退避，出站任务推迟重试；有插件的副本接管并补投", async () => {
    const { orgId, connId } = await setup("rolling");
    await sql`INSERT INTO capybara.identities (source, external_id, account_id, linked_via)
      VALUES ('chan-mini:t1', 'u-roll', ${ownerId}, 'sso')`.execute(raw);
    // 先经 IM 建好会话（有投递目标），等模型回复投到 IM
    const toRoll = () => im.sent.filter((s) => s.target.chatId === "dm-u-roll");
    im.push(connId, dm("roll-1", "u-roll", "hello"));
    await waitFor(async () => toRoll().length >= 1, 15_000, "first reply");
    const conv = (
      await sql<{ conversation_id: string }>`SELECT conversation_id FROM capybara.channel_threads
        WHERE connection_id = ${connId}`.execute(raw)
    ).rows[0]?.conversation_id as string;
    // a 停机（交还租约）；只启动没有 chan-mini 的 b
    await a.stop();
    await waitFor(async () => im.active(connId).length === 0, 10_000, "closed on stop");
    expect(await redis.exists(channelLeaseKey(connId))).toBe(0);
    const b = await startKernel(cfg([MODEL_FAKE], 100, 2000));
    try {
      await sleep(1500);
      expect(await redis.exists(channelLeaseKey(connId))).toBe(0);
      expect(await redis.exists(channelBackoffKey(connId))).toBe(0);
      const row = await db
        .selectFrom("channel_connections")
        .select("last_error")
        .where("id", "=", connId)
        .executeTakeFirstOrThrow();
      expect(row.last_error).toBeNull();
      // b 上经网页发消息：运行在 b 上完成，出站任务在 b 上找不到插件 → 推迟重试（不当作完成丢掉）
      const before = toRoll().length;
      const ob = await session(b, "owner");
      await postMessage(ob, orgId, conv, "from the web");
      await waitFor(
        async () =>
          (await eventsOf(db, conv)).filter((e) => e.type === "assistant_message").length >= 2,
        15_000,
        "second reply in the log",
      );
      await sleep(1000);
      expect(toRoll().length).toBe(before);
      // b 上处理需要回复的入站任务：插件不在本副本 → 推迟重试，不消耗重试次数
      await b.channels.inbound.onEvent(connId, dm("roll-bind", "u-roll-new", "hi"));
      // Wait for the state instead of reading it once after a fixed sleep: under load the job can
      // still be waiting or active at any fixed moment.
      const job = await waitFor(
        async () => {
          const j = await queue.getJob(inboundJobId(connId, "roll-bind"));
          return (await j?.getState()) === "delayed" ? j : undefined;
        },
        15_000,
        "inbound job delayed",
      );
      expect(job.attemptsMade).toBe(0);
      // 有插件的副本回来：照常接管长连接，并补投 b 上没投出去的回复
      a = await startKernel(cfg([MODEL_FAKE, CHAN_MINI], 100, 2000));
      owner = await session(a, "owner");
      await b.stop();
      await waitFor(async () => im.active(connId).length === 1, 10_000, "taken over by a");
      await waitFor(async () => toRoll().length > before, 20_000, "pending reply delivered");
      await waitFor(
        async () => im.sent.some((x) => x.target.chatId === "dm-u-roll-new"),
        20_000,
        "pending inbound reply delivered",
      );
    } finally {
      await b.stop();
    }
  }, 90_000);
});
