import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type Harness,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, waitFor } from "../helpers/runs.js";
import { openSse, type SseClient } from "../helpers/sse.js";

/**
 * 嵌入应用跨副本（双副本，独立进程，共享 PG / Redis / 主密钥）：
 * - 副本 0 签发的嵌入令牌，副本 1 上的插件能校验；
 * - example-board：副本 1 上打开 `/ui/events`（按请求订阅 ctx.bus），副本 0 上改卡片状态，副本 1 的流收到推送；
 *   客户端断开后插件退订（Redis 上不再有该组织的 cards 频道订阅）。
 */

const BOARD = fileURLToPath(
  new URL("../../../../plugins/example-board/src/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rdc: TestContainer;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
}, 120_000);
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});
afterAll(async () => {
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

type Json = Record<string, unknown>;

describe("嵌入应用（双副本）", () => {
  it("副本 0 签发的令牌在副本 1 校验通过；副本 0 改卡片，副本 1 的 /ui/events 收到推送", async () => {
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE, BOARD],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      config: { auth: { cookieSecure: false } },
    });
    const harness = h;
    const raw = createDb(harness.dbUrl, 3);
    cleanups.push(() => raw.destroy());
    const db: KernelDb = kernelDb(raw);

    let cookie = "";
    const at = async (
      i: 0 | 1,
      method: string,
      path: string,
      body?: unknown,
      auth?: { bearer: string },
    ) => {
      const res = await fetch(`http://127.0.0.1:${harness.replicas[i].port}${path}`, {
        method,
        headers: {
          ...(auth === undefined
            ? { "x-capybara-csrf": "1", ...(cookie !== "" && { cookie }) }
            : { authorization: `Bearer ${auth.bearer}` }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      expect(replicaOf(res)).toBe(i);
      const text = await res.text();
      return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
    };

    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "o" });
    const login = await harness.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "x-capybara-csrf": "1", "content-type": "application/json" },
      body: JSON.stringify({ login: "owner", password: PW }),
    });
    expect(login.status).toBe(200);
    await login.body?.cancel();
    cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const org = await at(0, "POST", "/api/v1/orgs", { name: "Acme" });
    const orgId = (org.json.org as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}`;
    const en = await at(1, "PUT", `${base}/extensions/example-board`, { enabled: true });
    expect(en.status, JSON.stringify(en.json)).toBe(200);

    // 副本 0 签发
    const issued = await at(0, "POST", `${base}/ui/embeds/example-board/board/token`, {});
    expect(issued.status, JSON.stringify(issued.json)).toBe(200);
    const token = issued.json.token as string;

    // 副本 1 校验（插件路由）
    const created = await at(
      1,
      "POST",
      "/plugins/example-board/ui/cards",
      { title: "Ship" },
      {
        bearer: token,
      },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const cardId = (created.json.card as { id: string }).id;

    // 副本 1 打开事件流
    const sse = async (i: 0 | 1, bearer: string): Promise<SseClient> => {
      const s = await openSse(
        `http://127.0.0.1:${harness.replicas[i].port}/plugins/example-board/ui/events`,
        { authorization: `Bearer ${bearer}` },
      );
      cleanups.push(() => s.close());
      return s;
    };
    const denied = await sse(1, "nope");
    expect(denied.status).toBe(401);
    const stream = await sse(1, token);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toMatch(/^text\/event-stream/);
    await stream.until((m) => m.some((x) => x.event === "ready"), 10_000, "ready frame");

    // 对话里的卡片变化不推给组织页面的流（组织页面不含对话卡片）
    const ag = await at(0, "POST", `${base}/agents`, {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [],
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const conv = await at(1, "POST", `${base}/conversations`, {
      agentId: (ag.json.agent as { id: string }).id,
    });
    const convId = (conv.json.conversation as { id: string }).id;
    const convIssued = await at(1, "POST", `${base}/ui/embeds/example-board/board-conv/token`, {
      conversationId: convId,
    });
    expect(convIssued.status, JSON.stringify(convIssued.json)).toBe(200);
    const convToken = convIssued.json.token as string;
    const convCard = await at(
      0,
      "POST",
      "/plugins/example-board/ui/cards",
      { title: "Conv" },
      {
        bearer: convToken,
      },
    );
    expect(convCard.status).toBe(201);
    const convCardId = (convCard.json.card as { id: string }).id;
    const convStream = await sse(0, convToken);
    await convStream.until((m) => m.some((x) => x.event === "ready"), 10_000, "conv ready");
    const convMoved = await at(
      1,
      "POST",
      `/plugins/example-board/ui/cards/${convCardId}`,
      {
        status: "doing",
      },
      { bearer: convToken },
    );
    expect(convMoved.status).toBe(200);
    await convStream.until(
      (m) => m.some((x) => x.event === "cards" && (x.data ?? "").includes(convCardId)),
      10_000,
      "conv cards frame",
    );

    // 副本 0 改状态 → 副本 1 的流收到 cards 帧
    const moved = await at(
      0,
      "POST",
      `/plugins/example-board/ui/cards/${cardId}`,
      { status: "done" },
      {
        bearer: token,
      },
    );
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    await stream.until(
      (m) => m.some((x) => x.event === "cards" && (x.data ?? "").includes(cardId)),
      10_000,
      "cards frame",
    );
    const frames = stream.messages.filter((x) => x.event === "cards");
    expect(frames.map((f) => JSON.parse(f.data ?? "{}"))).toEqual([{ cardId, status: "done" }]);
    // 对话流也看不到组织卡片的变化
    expect(
      convStream.messages.filter((x) => x.event === "cards").map((f) => JSON.parse(f.data ?? "{}")),
    ).toEqual([{ cardId: convCardId, status: "doing" }]);
    convStream.close();

    // 客户端断开 → 插件退订（按请求订阅，不留共享状态）
    const redis = new Redis(rdc.url);
    cleanups.push(() => redis.quit());
    const subscribed = async () =>
      ((await redis.pubsub("CHANNELS", `*cards.${orgId}*`)) as string[]).length;
    expect(await subscribed()).toBeGreaterThan(0);
    stream.close();
    await waitFor(async () => ((await subscribed()) === 0 ? true : undefined), 10_000);
  }, 120_000);
});
