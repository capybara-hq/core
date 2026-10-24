import { fileURLToPath } from "node:url";
import {
  type FakeChannelServer,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  waitFor,
} from "../helpers/runs.js";

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const SECRET = "app-secret-9f3c2a7e51d4";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let im: FakeChannelServer;
let owner: Req;
let member: Req;
let orgId: string;
let agentId: string;

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, CHAN_MINI],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 2000, retryBaseMs: 200 },
      },
    ),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const accounts = new AccountsService(db);
  const o = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  const m = await accounts.createLocal({ login: "member", password: PW, displayName: "M" });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  agentId = await createAgent(owner, orgId);
  await testMembers(db).add(orgId, m.id, "member", o.id);
  member = await session(k, "member");
}, 120_000);

afterAll(async () => {
  await k?.stop();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const base = () => `/api/v1/orgs/${orgId}/channels`;
const body = (over: Record<string, unknown> = {}) => ({
  plugin: "chan-mini",
  name: "Lark bot",
  agentId,
  config: { platformUrl: im.url, appId: "cli_1", appSecret: SECRET },
  ...over,
});
const enable = async (enabled: boolean) => {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
    payload: { enabled },
  });
  expect(res.statusCode).toBe(200);
};
const count = async () =>
  (
    await db
      .selectFrom("channel_connections" as never)
      .select("id" as never)
      .execute()
  ).length;

describe("渠道连接 HTTP", () => {
  it("extension not enabled in the org -> 409 extension.not_enabled, nothing stored", async () => {
    const res = await owner({ method: "POST", url: base(), payload: body() });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("extension.not_enabled");
    expect(await count()).toBe(0);
  });

  it("verify 失败 → 502 channel.verify_failed，不落库", async () => {
    await enable(true);
    const res = await owner({
      method: "POST",
      url: base(),
      payload: body({ config: { platformUrl: im.url, appId: "cli_1", appSecret: "bad-secret" } }),
    });
    expect(res.statusCode).toBe(502);
    expect(errCode(res)).toBe("channel.verify_failed");
    expect(res.body).not.toContain("bad-secret");
    expect(await count()).toBe(0);
  });

  it("配置不满足 connectionSchema → 400；成员 → 403；未知插件 → 404", async () => {
    const bad = await owner({
      method: "POST",
      url: base(),
      payload: body({ config: { platformUrl: "nope", appId: "x" } }),
    });
    expect(bad.statusCode).toBe(400);
    const denied = await member({ method: "POST", url: base(), payload: body() });
    expect(denied.statusCode).toBe(403);
    const unknown = await owner({ method: "POST", url: base(), payload: body({ plugin: "nope" }) });
    expect(unknown.statusCode).toBe(404);
    expect(errCode(unknown)).toBe("extension.not_found");
    expect(await count()).toBe(0);
  });

  it("schema 端点返回 connectionSchema 的 JSON Schema（密钥字段带 x-secret）", async () => {
    const res = await owner({ method: "GET", url: `${base()}/schema/chan-mini` });
    expect(res.statusCode).toBe(200);
    const schema = (
      res.json() as { schema: { properties: Record<string, Record<string, unknown>> } }
    ).schema;
    expect(schema.properties.appSecret?.["x-secret"]).toBe(true);
    expect(schema.properties.appId?.["x-secret"]).toBeUndefined();
  });

  it("新建 → 密钥进密钥存储、GET 不回显；修改、停用、删除", async () => {
    const res = await owner({ method: "POST", url: base(), payload: body() });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.body).not.toContain(SECRET);
    const ch = (res.json() as { channel: Record<string, unknown> }).channel;
    expect(ch).toMatchObject({
      plugin: "chan-mini",
      name: "Lark bot",
      agentId,
      unboundPolicy: "bind",
      status: "active",
      botUserId: "bot-cli_1",
      tenantId: "t1",
      config: { platformUrl: im.url, appId: "cli_1", tenant: "t1", lingerMs: 0 },
      secrets: [
        { path: "appSecret", set: true },
        { path: "webhookToken", set: false },
      ],
    });
    const id = ch.id as string;
    // 非密钥列不含密钥；密钥在 secrets（命名空间 kernel）
    const row = await db
      .selectFrom("channel_connections" as never)
      .select("config" as never)
      .where("id" as never, "=", id as never)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(SECRET);
    const keys = await db.selectFrom("secrets").select(["namespace", "key"]).execute();
    expect(keys).toContainEqual({ namespace: "kernel", key: `channels:${id}:config` });

    for (const r of [
      await owner({ method: "GET", url: base() }),
      await owner({ method: "GET", url: `${base()}/${id}` }),
    ]) {
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain(SECRET);
    }
    expect(
      ((await owner({ method: "GET", url: base() })).json() as { channels: unknown[] }).channels,
    ).toHaveLength(1);

    // 长连接由 worker 建立
    await waitFor(async () => im.active(id).length === 1, 10_000, "long connection");

    // 改名 + 匿名策略；密钥字段缺省 = 保留
    const patched = await owner({
      method: "PATCH",
      url: `${base()}/${id}`,
      payload: { name: "Renamed", unboundPolicy: "anonymous" },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({
      channel: { name: "Renamed", unboundPolicy: "anonymous" },
    });

    // 轮换凭据：新密钥也要先 verify
    const rotateBad = await owner({
      method: "PATCH",
      url: `${base()}/${id}`,
      payload: { config: { platformUrl: im.url, appId: "cli_1", appSecret: "bad-secret" } },
    });
    expect(rotateBad.statusCode).toBe(502);
    const rotated = await owner({
      method: "PATCH",
      url: `${base()}/${id}`,
      payload: { config: { platformUrl: im.url, appId: "cli_1", appSecret: "new-secret-77aa0c" } },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.body).not.toContain("new-secret-77aa0c");

    // 停用 → 长连接断开（经内核 bus 广播 channel.changed）
    const off = await owner({
      method: "PATCH",
      url: `${base()}/${id}`,
      payload: { status: "disabled" },
    });
    expect(off.statusCode).toBe(200);
    await waitFor(async () => im.active(id).length === 0, 10_000, "connection closed");
    const on = await owner({
      method: "PATCH",
      url: `${base()}/${id}`,
      payload: { status: "active" },
    });
    expect(on.statusCode).toBe(200);
    await waitFor(async () => im.active(id).length === 1, 10_000, "reconnected");
    expect(im.maxConcurrent(id)).toBe(1);

    const del = await owner({ method: "DELETE", url: `${base()}/${id}` });
    expect(del.statusCode).toBe(204);
    await waitFor(async () => im.active(id).length === 0, 10_000, "closed after delete");
    expect((await owner({ method: "GET", url: `${base()}/${id}` })).statusCode).toBe(404);
    const left = await db
      .selectFrom("secrets")
      .select("key")
      .where("key", "=", `channels:${id}:config`)
      .execute();
    expect(left).toEqual([]);
  }, 30_000);

  it("connect 失败 → 记 last_error 并退避重试；平台恢复后连上", async () => {
    im.failConnect(503);
    const res = await owner({
      method: "POST",
      url: base(),
      payload: body({
        name: "Flaky",
        config: { platformUrl: im.url, appId: "cli_2", appSecret: SECRET },
      }),
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { channel: { id: string } }).channel.id;
    const err = await waitFor(
      async () =>
        (
          (await owner({ method: "GET", url: `${base()}/${id}` })).json() as {
            channel: { lastError: string | null };
          }
        ).channel.lastError,
      10_000,
      "last_error",
    );
    expect(err).toContain("503");
    expect(err).not.toContain(SECRET);
    im.failConnect(null);
    await waitFor(async () => im.active(id).length === 1, 10_000, "reconnected after backoff");
    expect(im.maxConcurrent(id)).toBe(1);
    expect((await owner({ method: "DELETE", url: `${base()}/${id}` })).statusCode).toBe(204);
  }, 30_000);

  it("PATCH 的密钥字段：缺省 = 保留原值，null = 清除（必填密钥清除 → 400）", async () => {
    const res = await owner({
      method: "POST",
      url: base(),
      payload: body({
        name: "Secrets",
        config: {
          platformUrl: im.url,
          appId: "cli_3",
          appSecret: SECRET,
          webhookToken: "hook-token-5566aa",
        },
      }),
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { channel: { id: string } }).channel.id;
    const secretsOf = async () =>
      (
        (await owner({ method: "GET", url: `${base()}/${id}` })).json() as {
          channel: { secrets: { path: string; set: boolean }[] };
        }
      ).channel.secrets;
    // 只改非密钥字段：两个密钥都保留
    const keep = await owner({
      method: "PATCH",
      url: `${base()}/${id}`,
      payload: { config: { platformUrl: im.url, appId: "cli_3b" } },
    });
    expect(keep.statusCode, keep.body).toBe(200);
    expect(await secretsOf()).toEqual([
      { path: "appSecret", set: true },
      { path: "webhookToken", set: true },
    ]);
    const rt = await k.channels.connections.runtime(id);
    expect(rt.config).toMatchObject({
      appId: "cli_3b",
      appSecret: SECRET,
      webhookToken: "hook-token-5566aa",
    });
    // null 清除可选密钥
    const clear = await owner({
      method: "PATCH",
      url: `${base()}/${id}`,
      payload: { config: { platformUrl: im.url, appId: "cli_3b", webhookToken: null } },
    });
    expect(clear.statusCode, clear.body).toBe(200);
    expect(await secretsOf()).toEqual([
      { path: "appSecret", set: true },
      { path: "webhookToken", set: false },
    ]);
    // 必填密钥不能清除
    const bad = await owner({
      method: "PATCH",
      url: `${base()}/${id}`,
      payload: { config: { platformUrl: im.url, appId: "cli_3b", appSecret: null } },
    });
    expect(bad.statusCode).toBe(400);
    expect(errCode(bad)).toBe("extension.config_invalid");
    expect((await k.channels.connections.runtime(id)).config).toMatchObject({ appSecret: SECRET });
    expect((await owner({ method: "DELETE", url: `${base()}/${id}` })).statusCode).toBe(204);
  }, 30_000);

  it("组织设置带 locale（默认 en，可改为 zh）", async () => {
    const get = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/settings` });
    expect(get.json()).toMatchObject({ settings: { locale: "en" } });
    const res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { locale: "zh" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ settings: { locale: "zh" } });
    const bad = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { locale: "fr" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
