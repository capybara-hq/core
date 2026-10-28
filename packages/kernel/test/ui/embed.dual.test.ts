import {
  createDualReplicaHarness,
  fakeExtensionEntry,
  type Harness,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, waitFor } from "../helpers/runs.js";
import { openSse, type SseClient } from "../helpers/sse.js";

/**
 * 嵌入应用跨副本（双副本，独立进程，共享 PG / Redis / 主密钥）：
 * - 副本 0 签发的嵌入令牌，副本 1 上的插件能校验；
 * - fake-embed：副本 1 上打开 `/ui/events`（按请求订阅 ctx.bus），副本 0 上发布消息，副本 1 的流收到推送；
 *   客户端断开后插件退订（Redis 上不再有该组织的 events 频道订阅）。
 */

const EMBED = fakeExtensionEntry("fake-embed");

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
  it("副本 0 签发的令牌在副本 1 校验通过；副本 0 发布，副本 1 的 /ui/events 收到推送", async () => {
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE, EMBED],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      config: { auth: { cookieSecure: false } },
    });
    const harness = h;
    const raw = createDb(harness.dbUrl, 3);
    cleanups.push(() => raw.destroy());
    const db: KernelSchemaDb = kernelDb(raw);

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
    const en = await at(1, "PUT", `${base}/extensions/fake-embed`, { enabled: true });
    expect(en.status, JSON.stringify(en.json)).toBe(200);

    // 副本 0 签发
    const issued = await at(0, "POST", `${base}/ui/embeds/fake-embed/panel/token`, {});
    expect(issued.status, JSON.stringify(issued.json)).toBe(200);
    const token = issued.json.token as string;

    // 副本 1 校验（插件路由）
    const claims = await at(1, "GET", "/plugins/fake-embed/ui/claims", undefined, {
      bearer: token,
    });
    expect(claims.status, JSON.stringify(claims.json)).toBe(200);
    expect(claims.json).toMatchObject({ orgId, plugin: "fake-embed", contribution: "panel" });
    expect(claims.json).not.toHaveProperty("conversationId");

    // 副本 1 打开事件流
    const sse = async (i: 0 | 1, bearer: string): Promise<SseClient> => {
      const s = await openSse(
        `http://127.0.0.1:${harness.replicas[i].port}/plugins/fake-embed/ui/events`,
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

    // 对话嵌入的消息不推给组织页面的流（令牌的范围来自 claims）
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
    const convIssued = await at(1, "POST", `${base}/ui/embeds/fake-embed/panel-conv/token`, {
      conversationId: convId,
    });
    expect(convIssued.status, JSON.stringify(convIssued.json)).toBe(200);
    const convToken = convIssued.json.token as string;
    const convClaims = await at(0, "GET", "/plugins/fake-embed/ui/claims", undefined, {
      bearer: convToken,
    });
    expect(convClaims.json).toMatchObject({ orgId, conversationId: convId });
    const convStream = await sse(0, convToken);
    await convStream.until((m) => m.some((x) => x.event === "ready"), 10_000, "conv ready");
    const convSent = await at(
      1,
      "POST",
      "/plugins/fake-embed/ui/events",
      { text: "conv" },
      {
        bearer: convToken,
      },
    );
    expect(convSent.status).toBe(202);
    await convStream.until(
      (m) => m.some((x) => x.event === "event" && (x.data ?? "").includes("conv")),
      10_000,
      "conv event frame",
    );

    // 副本 0 发布 → 副本 1 的流收到 event 帧
    const sent = await at(
      0,
      "POST",
      "/plugins/fake-embed/ui/events",
      { text: "org" },
      {
        bearer: token,
      },
    );
    expect(sent.status, JSON.stringify(sent.json)).toBe(202);
    await stream.until(
      (m) => m.some((x) => x.event === "event" && (x.data ?? "").includes("org")),
      10_000,
      "event frame",
    );
    const frames = stream.messages.filter((x) => x.event === "event");
    expect(frames.map((f) => JSON.parse(f.data ?? "{}"))).toEqual([{ text: "org" }]);
    // 对话流也看不到组织范围的消息
    expect(
      convStream.messages.filter((x) => x.event === "event").map((f) => JSON.parse(f.data ?? "{}")),
    ).toEqual([{ text: "conv" }]);
    convStream.close();

    // 客户端断开 → 插件退订（按请求订阅，不留共享状态）
    const redis = new Redis(rdc.url);
    cleanups.push(() => redis.quit());
    const subscribed = async () =>
      ((await redis.pubsub("CHANNELS", `*events.${orgId}*`)) as string[]).length;
    expect(await subscribed()).toBeGreaterThan(0);
    stream.close();
    await waitFor(async () => ((await subscribed()) === 0 ? true : undefined), 10_000);
  }, 120_000);
});
