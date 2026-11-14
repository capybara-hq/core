import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setupGuideHash } from "@capybara-hq/plugin-sdk";
import {
  type FakeChannelServer,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelConnections } from "../../src/channels/connections.service.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { accountsFor } from "../helpers/identity.js";
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
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { channelGuideDoc, seedGuideFiles } from "../helpers/setup-guides.js";

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const SECRET = "app-secret-9f3c2a7e51d4";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
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
        // one replica, no takeover: a lease long enough that a stalled event loop does not
        // lose it and drop the long connection (2 s did under load)
        channels: { scanIntervalMs: 100, leaseTtlMs: 10_000, retryBaseMs: 200 },
      },
    ),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const accounts = accountsFor(db);
  const o = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  const m = await accounts.createLocal({ login: "member", password: PW, displayName: "M" });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  agentId = await createAgent(owner, orgId);
  await testMembers(db).add(orgId, m.id, "member", o.id);
  member = await session(k, "member");
});

afterAll(async () => {
  await k?.close();
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
    // config UI hints pass through
    expect(schema.properties.appId?.["x-ui"]).toEqual({ label: { zh: "应用 ID", en: "App ID" } });
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
      // the plugin's name and icon for the pages: a config-declared fixture without a display
      // name or a catalog item has neither
      pluginDisplayName: null,
      pluginIcon: null,
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
    const listed = (
      (await owner({ method: "GET", url: base() })).json() as {
        channels: Record<string, unknown>[];
      }
    ).channels;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ pluginDisplayName: null, pluginIcon: null });

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
  });

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
  });

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
    const rt = await k.app.get(ChannelConnections).runtime(id);
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
    expect((await k.app.get(ChannelConnections).runtime(id)).config).toMatchObject({
      appSecret: SECRET,
    });
    expect((await owner({ method: "DELETE", url: `${base()}/${id}` })).statusCode).toBe(204);
  });

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

// Plugin setup guides (spec 2026-11-09-setup-guides-v2-design.md §11): a connection records the
// guide it was set up with; a plugin upgrade that changes the code blocks or checks of its mode is
// drift.
describe("channel setup guide drift", () => {
  const GUIDE = { id: "app", place: "channel-connection" as const };
  /** The admin drift hash of {@link channelGuideDoc}`(socket, webhook)` for a mode. */
  const hashOf = (socket: string, webhook: string, mode: string) =>
    setupGuideHash(channelGuideDoc(socket, webhook), {
      place: "channel-connection",
      guideId: "app",
      mode,
      audience: "admin",
    });
  /** The chan-mini catalog item (the extension itself comes from the startup config). */
  const seedVersion = async (itemId: string, version: string, socket: string, webhook: string) => {
    const files = await seedGuideFiles(db, { "guides/app.md": channelGuideDoc(socket, webhook) });
    await db
      .insertInto("catalog_item_versions")
      .values({
        item_id: itemId,
        version,
        manifest: JSON.stringify({
          schemaVersion: 1,
          name: "chan-mini",
          version,
          publisher: "Acme",
          description: "IM",
          setupGuides: [GUIDE],
        }),
        source: "file",
        source_ref: "upload",
        object_prefix: null,
        files: JSON.stringify(files),
        size: 1000,
      })
      .execute();
    await db
      .updateTable("catalog_items")
      .set({ latest_version: version })
      .where("id", "=", itemId)
      .execute();
  };
  type Page = {
    id: string;
    guideAck: { guideId: string; version: string; hash: string; mode: string | null } | null;
    setupGuide: { itemId: string; guideId: string; version: string } | null;
    guideDrift: { from: string; to: string } | null;
  };
  const get = async (id: string): Promise<Page> => {
    const r = await owner({ method: "GET", url: `${base()}/${id}` });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { channel: Page }).channel;
  };

  it("records the guide on create, flags a changed code block of its mode, clears on ack", async () => {
    await enable(true);
    const itemId = randomUUID();
    await db
      .insertInto("catalog_items")
      .values({
        id: itemId,
        name: "chan-mini",
        package_name: "@acme/plugin-chan-mini",
        publisher: "Acme",
        description: "IM",
        latest_version: "1.0.0",
        policy: "allow",
        disabled: false,
      })
      .execute();
    await seedVersion(itemId, "1.0.0", "a", "b");
    // 新建渠道 finds the guide through the schema route
    const schema = await owner({ method: "GET", url: `${base()}/schema/chan-mini` });
    expect(schema.json().guide).toEqual({ itemId, guideId: "app" });

    const created = await owner({
      method: "POST",
      url: base(),
      payload: body({ name: "Guide bot" }),
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { channel: Page }).channel.id;
    const v1 = hashOf("a", "b", "long_connection");
    let page = await get(id);
    expect(page.guideAck).toEqual({
      guideId: "app",
      version: "1.0.0",
      hash: v1,
      mode: "long_connection",
    });
    expect(page.setupGuide).toEqual({ itemId, guideId: "app", version: "1.0.0" });
    expect(page.guideDrift).toBeNull();

    // 1.1.0 changes only the webhook manifest: not drift for a long-connection connection
    await seedVersion(itemId, "1.1.0", "a", "c");
    expect((await get(id)).guideDrift).toBeNull();
    // 1.2.0 changes the socket manifest: drift, with the versions
    await seedVersion(itemId, "1.2.0", "d", "c");
    page = await get(id);
    expect(page.guideDrift).toEqual({ from: "1.0.0", to: "1.2.0" });
    const listed = (await owner({ method: "GET", url: base() })).json() as { channels: Page[] };
    expect(listed.channels.find((c) => c.id === id)?.guideDrift).toEqual({
      from: "1.0.0",
      to: "1.2.0",
    });

    // 「我已更新应用」: the hash shown must be the current one
    const stale = await owner({
      method: "POST",
      url: `${base()}/${id}/guide-ack`,
      payload: { hash: v1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(errCode(stale)).toBe("channel.guide_changed");
    const denied = await member({
      method: "POST",
      url: `${base()}/${id}/guide-ack`,
      payload: { hash: v1 },
    });
    expect(denied.statusCode).toBe(403);
    const v3 = hashOf("d", "c", "long_connection");
    const ack = await owner({
      method: "POST",
      url: `${base()}/${id}/guide-ack`,
      payload: { hash: v3 },
    });
    expect(ack.statusCode, ack.body).toBe(200);
    expect((ack.json() as { channel: Page }).channel.guideDrift).toBeNull();
    expect((await get(id)).guideAck).toMatchObject({ version: "1.2.0", hash: v3 });
    const audits = await db
      .selectFrom("audit_events")
      .select("action")
      .where("target", "=", id)
      .execute();
    expect(audits.map((a) => a.action)).toContain("channel.guide_confirmed");

    // a connection without an ack (made before 0099) never shows a notice
    await db
      .updateTable("channel_connections")
      .set({ guide_ack: null })
      .where("id", "=", id)
      .execute();
    await seedVersion(itemId, "1.3.0", "e", "c");
    expect((await get(id)).guideDrift).toBeNull();
    // the item hidden from the org: no guide, no notice
    await db
      .updateTable("catalog_items")
      .set({ disabled: true })
      .where("id", "=", itemId)
      .execute();
    expect((await get(id)).setupGuide).not.toBeNull(); // org admins still see disabled items
    // a named item this org is not listed for (and not requestable): no guide, and its ack is
    // refused like the read
    await db
      .updateTable("catalog_items")
      .set({ disabled: false, scope: "named", shown_to_others: false })
      .where("id", "=", itemId)
      .execute();
    expect((await get(id)).setupGuide).toBeNull();
    const hidden = await owner({
      method: "POST",
      url: `${base()}/${id}/guide-ack`,
      payload: { hash: hashOf("e", "c", "long_connection") },
    });
    expect(hidden.statusCode).toBe(404);
    expect(errCode(hidden)).toBe("catalog.guide_not_found");
    await db.updateTable("catalog_items").set({ scope: "all" }).where("id", "=", itemId).execute();
    await db
      .updateTable("catalog_items")
      .set({ disabled: false, deleted_at: new Date() })
      .where("id", "=", itemId)
      .execute();
    expect((await get(id)).setupGuide).toBeNull();
    const none = await owner({
      method: "POST",
      url: `${base()}/${id}/guide-ack`,
      payload: { hash: v3 },
    });
    expect(none.statusCode).toBe(404);
    expect(errCode(none)).toBe("catalog.guide_not_found");
    expect((await owner({ method: "DELETE", url: `${base()}/${id}` })).statusCode).toBe(204);
  });
});
