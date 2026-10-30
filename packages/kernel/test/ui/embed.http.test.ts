import { fileURLToPath } from "node:url";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createAgent,
  createConv,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * 嵌入令牌接口（单副本，插件 ui-probe + 假扩展 fake-embed；审查重点 3）：
 * - `POST /api/v1/orgs/:orgId/ui/embeds/:plugin/:id/token`：只给人用、插件须在组织启用、贡献须是 embed；
 *   对话嵌入要求能访问该对话（否则 404），组织页面不收 conversationId；
 * - 令牌不能当 Bearer 调内核 `/api`（401）；
 * - 插件路由用 `ctx.ui.verifyEmbedToken` 校验：缺失 / 伪造 / 签给别的插件的令牌 → 401；未声明的路由 404；
 *   校验结果（claims）带签发时的组织与对话，插件按它划定范围。
 * example-board's own card behaviour is tested in that plugin's own tests.
 */

const UI_PROBE = fileURLToPath(new URL("../fixtures/plugins/ui-probe/index.ts", import.meta.url));
const EMBED = fakeExtensionEntry("fake-embed");

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  const base = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] });
  k = await startKernel(
    { ...base, extensions: [...base.extensions, UI_PROBE, EMBED] },
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
}, 120_000);
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

async function account(name: string): Promise<string> {
  return (await accountsFor(db).createLocal({ login: name, password: PW, displayName: name })).id;
}

const enable = async (req: Req, orgId: string, plugin: string) => {
  const r = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
    payload: { enabled: true },
  });
  expect(r.statusCode, r.body).toBe(200);
};

type Issued = { token: string; src: string; expiresAt: string; expiresIn: number };

describe("嵌入令牌", () => {
  let owner: Req;
  let other: Req;
  let ownerId: string;
  let orgId: string;
  let convId: string;
  let otherConv: string;
  let ui: string;

  const issue = (req: Req, plugin: string, id: string, body: Record<string, unknown> = {}) =>
    req({ method: "POST", url: `${ui}/embeds/${plugin}/${id}/token`, payload: body });

  const asPlugin = (
    method: "GET" | "POST",
    path: string,
    token?: string,
    payload?: Record<string, unknown>,
  ) =>
    k.http.inject({
      method,
      url: `/plugins/fake-embed${path}`,
      headers: {
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
        ...(payload !== undefined && { "content-type": "application/json" }),
      },
      ...(payload !== undefined && { payload: JSON.stringify(payload) }),
    });

  beforeEach(async () => {
    await truncateTables(
      raw,
      "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.deployment_settings",
    );
    await redis.flushdb();
    ownerId = await account("owner");
    const otherId = await account("other");
    owner = await session(k, "owner");
    other = await session(k, "other");
    orgId = await createOrg(owner);
    await testMembers(db).add(orgId, otherId, "member", ownerId);
    const agentId = await createAgent(owner, orgId);
    convId = await createConv(owner, orgId, agentId);
    otherConv = await createConv(other, orgId, agentId);
    ui = `/api/v1/orgs/${orgId}/ui`;
  });

  it("贡献列表给出 embed 的 path", async () => {
    await enable(owner, orgId, "fake-embed");
    const r = await owner({ method: "GET", url: `${ui}/contributions` });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { items: unknown[] }).items).toEqual([
      {
        plugin: "fake-embed",
        id: "panel",
        title: { zh: "面板", en: "Panel" },
        place: "page",
        kind: "embed",
        path: "/ui/panel",
        icon: "puzzle",
      },
      {
        plugin: "fake-embed",
        id: "panel-conv",
        title: { zh: "面板", en: "Panel" },
        place: "panel",
        legacyPlace: "conversation",
        kind: "embed",
        path: "/ui/panel-conv",
        icon: "puzzle",
      },
    ]);
  });

  it("签发：未登录 401；服务令牌 403；插件未启用 404；不是 embed 的贡献 / 不存在 404", async () => {
    const url = `${ui}/embeds/fake-embed/panel/token`;
    expect((await k.http.inject({ method: "POST", url, payload: {} })).statusCode).toBe(401);

    const { token: svc } = await apiTokensFor(db).createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: ownerId,
    });
    const bySvc = await k.http.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${svc}` },
      payload: {},
    });
    expect(bySvc.statusCode).toBe(403);

    const disabled = await issue(owner, "fake-embed", "panel");
    expect(disabled.statusCode).toBe(404);
    expect(errCode(disabled)).toBe("ui.not_found");

    await enable(owner, orgId, "fake-embed");
    await enable(owner, orgId, "ui-probe");
    for (const [plugin, id] of [
      ["ui-probe", "orgpage"],
      ["ui-probe", "panel"],
      ["fake-embed", "nope"],
      ["nope", "panel"],
    ] as const) {
      const r = await issue(owner, plugin, id);
      expect(r.statusCode, `${plugin}/${id}`).toBe(404);
      expect(errCode(r)).toBe("ui.not_found");
    }
  });

  it("签发组织页面嵌入：返回令牌、同源 src 与过期时间；带 conversationId 400", async () => {
    await enable(owner, orgId, "fake-embed");
    const r = await issue(owner, "fake-embed", "panel");
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as Issued;
    expect(body.src).toBe("/plugin-ui/fake-embed/panel");
    expect(body.expiresIn).toBe(300);
    const ttl = Date.parse(body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(290_000);
    expect(ttl).toBeLessThanOrEqual(300_000);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const withConv = await issue(owner, "fake-embed", "panel", { conversationId: convId });
    expect(withConv.statusCode).toBe(400);
  });

  it("签发对话嵌入：缺 conversationId 400；别人的对话 / 不存在的对话 404；自己的对话 200", async () => {
    await enable(owner, orgId, "fake-embed");
    expect((await issue(owner, "fake-embed", "panel-conv")).statusCode).toBe(400);
    for (const c of [otherConv, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const r = await issue(owner, "fake-embed", "panel-conv", { conversationId: c });
      expect(r.statusCode, c).toBe(404);
      expect(errCode(r)).toBe("ui.not_found");
    }
    const ok = await issue(owner, "fake-embed", "panel-conv", { conversationId: convId });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as Issued).src).toBe("/plugin-ui/fake-embed/panel-conv");
  });

  it("令牌不能当 Bearer 调内核 /api（401）", async () => {
    await enable(owner, orgId, "fake-embed");
    const { token } = (await issue(owner, "fake-embed", "panel")).json() as Issued;
    for (const url of ["/api/v1/me", `${ui}/contributions`, `/api/v1/orgs/${orgId}/agents`]) {
      const r = await k.http.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.statusCode, url).toBe(401);
      expect(errCode(r)).toBe("auth.required");
    }
  });

  it("插件路由：缺令牌 / 伪造 / 签给别的插件 → 401；有效令牌给出本组织的 claims；未声明的路由 404", async () => {
    await enable(owner, orgId, "fake-embed");
    await enable(owner, orgId, "ui-probe");
    const { token } = (await issue(owner, "fake-embed", "panel")).json() as Issued;
    const { token: probeToken } = (await issue(owner, "ui-probe", "board")).json() as Issued;

    expect((await asPlugin("GET", "/ui/claims")).statusCode).toBe(401);
    expect((await asPlugin("GET", "/ui/claims", "garbage")).statusCode).toBe(401);
    expect((await asPlugin("GET", "/ui/claims", `${token}x`)).statusCode).toBe(401);
    // 签给 ui-probe 的令牌：fake-embed 的 verifyEmbedToken 返回 null
    expect((await asPlugin("GET", "/ui/claims", probeToken)).statusCode).toBe(401);
    expect((await asPlugin("GET", "/ui/events", probeToken)).statusCode).toBe(401);
    expect((await asPlugin("POST", "/ui/events", probeToken, { text: "x" })).statusCode).toBe(401);

    const claims = await asPlugin("GET", "/ui/claims", token);
    expect(claims.statusCode, claims.body).toBe(200);
    expect(claims.json()).toMatchObject({
      plugin: "fake-embed",
      orgId,
      accountId: ownerId,
      role: "owner",
      contribution: "panel",
    });
    expect(claims.json()).not.toHaveProperty("conversationId");
    const sent = await asPlugin("POST", "/ui/events", token, { text: "hello" });
    expect(sent.statusCode, sent.body).toBe(202);

    // 另一个组织签的令牌：claims 是那个组织的
    const org2 = await createOrg(owner, "Other");
    await enable(owner, org2, "fake-embed");
    const { token: t2 } = (
      await owner({
        method: "POST",
        url: `/api/v1/orgs/${org2}/ui/embeds/fake-embed/panel/token`,
        payload: {},
      })
    ).json() as Issued;
    expect((await asPlugin("GET", "/ui/claims", t2)).json()).toMatchObject({ orgId: org2 });

    // 未声明的路由、非 /ui/ 路径
    expect((await asPlugin("GET", "/ui/nope", token)).statusCode).toBe(404);
    expect((await asPlugin("GET", "/claims", token)).statusCode).toBe(404);
    // 静态页面与脚本不含数据，不要求令牌（iframe 导航带不了 Authorization 头）
    const page = await asPlugin("GET", "/ui/panel");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    const js = await asPlugin("GET", "/ui/panel.js");
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
  });

  it("对话嵌入的令牌带签发时的对话；组织页面的令牌不带对话", async () => {
    await enable(owner, orgId, "fake-embed");
    const { token: orgToken } = (await issue(owner, "fake-embed", "panel")).json() as Issued;
    const { token: convToken } = (
      await issue(owner, "fake-embed", "panel-conv", { conversationId: convId })
    ).json() as Issued;
    const conv = (await asPlugin("GET", "/ui/claims", convToken)).json() as Record<string, unknown>;
    expect(conv).toMatchObject({ orgId, conversationId: convId, contribution: "panel-conv" });
    const org = (await asPlugin("GET", "/ui/claims", orgToken)).json() as Record<string, unknown>;
    expect(org).toMatchObject({ orgId, contribution: "panel" });
    expect(org).not.toHaveProperty("conversationId");
  });

  it("插件在组织停用后，已签出的令牌立即失效（verifyEmbedToken 每次查启用状态）", async () => {
    await enable(owner, orgId, "fake-embed");
    const { token } = (await issue(owner, "fake-embed", "panel")).json() as Issued;
    expect((await asPlugin("GET", "/ui/claims", token)).statusCode).toBe(200);
    const off = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/fake-embed`,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect((await asPlugin("GET", "/ui/claims", token)).statusCode).toBe(401);
    expect((await asPlugin("GET", "/ui/events", token)).statusCode).toBe(401);
    await enable(owner, orgId, "fake-embed");
    expect((await asPlugin("GET", "/ui/claims", token)).statusCode).toBe(200);
  });
});
