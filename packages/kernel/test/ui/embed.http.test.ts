import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
import {
  createAgent,
  createConv,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
} from "../helpers/runs.js";

/**
 * 嵌入令牌接口（单副本，插件 ui-probe + example-board；审查重点 3）：
 * - `POST /api/v1/orgs/:orgId/ui/embeds/:plugin/:id/token`：只给人用、插件须在组织启用、贡献须是 embed；
 *   对话嵌入要求能访问该对话（否则 404），组织页面不收 conversationId；
 * - 令牌不能当 Bearer 调内核 `/api`（401）；
 * - 插件路由用 `ctx.ui.verifyEmbedToken` 校验：缺失 / 伪造 / 签给别的插件的令牌 → 401；未声明的路由 404。
 */

const UI_PROBE = fileURLToPath(new URL("../fixtures/plugins/ui-probe/index.ts", import.meta.url));
const BOARD = fileURLToPath(
  new URL("../../../../plugins/example-board/src/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let k: Kernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  const base = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] });
  k = await createKernel(
    { ...base, plugins: [...base.plugins, UI_PROBE, BOARD] },
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
}, 120_000);
afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

async function account(name: string): Promise<string> {
  return (
    await new AccountsService(db).createLocal({ login: name, password: PW, displayName: name })
  ).id;
}

const enable = async (req: Req, orgId: string, plugin: string) => {
  const r = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/plugins/${plugin}`,
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
      url: `/plugins/example-board${path}`,
      headers: {
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
        ...(payload !== undefined && { "content-type": "application/json" }),
      },
      ...(payload !== undefined && { payload: JSON.stringify(payload) }),
    });

  beforeEach(async () => {
    await truncateTables(
      raw,
      "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.deployment_settings, plugin_example_board.cards",
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
    await enable(owner, orgId, "example-board");
    const r = await owner({ method: "GET", url: `${ui}/contributions` });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { items: unknown[] }).items).toEqual([
      {
        plugin: "example-board",
        id: "board",
        title: { zh: "看板", en: "Board" },
        place: "page",
        kind: "embed",
        path: "/ui/board",
      },
      {
        plugin: "example-board",
        id: "board-conv",
        title: { zh: "看板", en: "Board" },
        place: "conversation",
        kind: "embed",
        path: "/ui/board-conv",
      },
    ]);
  });

  it("签发：未登录 401；服务令牌 403；插件未启用 404；不是 embed 的贡献 / 不存在 404", async () => {
    const url = `${ui}/embeds/example-board/board/token`;
    expect((await k.http.inject({ method: "POST", url, payload: {} })).statusCode).toBe(401);

    const { token: svc } = await new ApiTokenService(db).createService(orgId, {
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

    const disabled = await issue(owner, "example-board", "board");
    expect(disabled.statusCode).toBe(404);
    expect(errCode(disabled)).toBe("ui.not_found");

    await enable(owner, orgId, "example-board");
    await enable(owner, orgId, "ui-probe");
    for (const [plugin, id] of [
      ["ui-probe", "orgpage"],
      ["ui-probe", "panel"],
      ["example-board", "nope"],
      ["nope", "board"],
    ] as const) {
      const r = await issue(owner, plugin, id);
      expect(r.statusCode, `${plugin}/${id}`).toBe(404);
      expect(errCode(r)).toBe("ui.not_found");
    }
  });

  it("签发组织页面嵌入：返回令牌、同源 src 与过期时间；带 conversationId 400", async () => {
    await enable(owner, orgId, "example-board");
    const r = await issue(owner, "example-board", "board");
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as Issued;
    expect(body.src).toBe("/plugin-ui/example-board/board");
    expect(body.expiresIn).toBe(300);
    const ttl = Date.parse(body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(290_000);
    expect(ttl).toBeLessThanOrEqual(300_000);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const withConv = await issue(owner, "example-board", "board", { conversationId: convId });
    expect(withConv.statusCode).toBe(400);
  });

  it("签发对话嵌入：缺 conversationId 400；别人的对话 / 不存在的对话 404；自己的对话 200", async () => {
    await enable(owner, orgId, "example-board");
    expect((await issue(owner, "example-board", "board-conv")).statusCode).toBe(400);
    for (const c of [otherConv, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const r = await issue(owner, "example-board", "board-conv", { conversationId: c });
      expect(r.statusCode, c).toBe(404);
      expect(errCode(r)).toBe("ui.not_found");
    }
    const ok = await issue(owner, "example-board", "board-conv", { conversationId: convId });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as Issued).src).toBe("/plugin-ui/example-board/board-conv");
  });

  it("令牌不能当 Bearer 调内核 /api（401）", async () => {
    await enable(owner, orgId, "example-board");
    const { token } = (await issue(owner, "example-board", "board")).json() as Issued;
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

  it("插件路由：缺令牌 / 伪造 / 签给别的插件 → 401；有效令牌可读写本组织的卡片；未声明的路由 404", async () => {
    await enable(owner, orgId, "example-board");
    await enable(owner, orgId, "ui-probe");
    const { token } = (await issue(owner, "example-board", "board")).json() as Issued;
    const { token: probeToken } = (await issue(owner, "ui-probe", "board")).json() as Issued;

    expect((await asPlugin("GET", "/ui/cards")).statusCode).toBe(401);
    expect((await asPlugin("GET", "/ui/cards", "garbage")).statusCode).toBe(401);
    expect((await asPlugin("GET", "/ui/cards", `${token}x`)).statusCode).toBe(401);
    // 签给 ui-probe 的令牌：example-board 的 verifyEmbedToken 返回 null
    expect((await asPlugin("GET", "/ui/cards", probeToken)).statusCode).toBe(401);
    expect((await asPlugin("GET", "/ui/events", probeToken)).statusCode).toBe(401);
    expect((await asPlugin("POST", "/ui/cards", probeToken, { title: "x" })).statusCode).toBe(401);

    const created = await asPlugin("POST", "/ui/cards", token, { title: "Write spec" });
    expect(created.statusCode, created.body).toBe(201);
    const card = (created.json() as { card: { id: string; status: string } }).card;
    expect(card.status).toBe("todo");
    const moved = await asPlugin("POST", `/ui/cards/${card.id}`, token, { status: "doing" });
    expect(moved.statusCode, moved.body).toBe(200);
    const list = await asPlugin("GET", "/ui/cards", token);
    expect(list.statusCode).toBe(200);
    expect((list.json() as { cards: unknown[] }).cards).toEqual([
      expect.objectContaining({ id: card.id, title: "Write spec", status: "doing" }),
    ]);
    expect(
      (await asPlugin("POST", `/ui/cards/${card.id}`, token, { status: "bad" })).statusCode,
    ).toBe(400);

    // 另一个组织的令牌看不到也改不了这张卡
    const org2 = await createOrg(owner, "Other");
    await enable(owner, org2, "example-board");
    const { token: t2 } = (
      await owner({
        method: "POST",
        url: `/api/v1/orgs/${org2}/ui/embeds/example-board/board/token`,
        payload: {},
      })
    ).json() as Issued;
    expect(((await asPlugin("GET", "/ui/cards", t2)).json() as { cards: unknown[] }).cards).toEqual(
      [],
    );
    expect(
      (await asPlugin("POST", `/ui/cards/${card.id}`, t2, { status: "done" })).statusCode,
    ).toBe(404);

    // 未声明的路由、非 /ui/ 路径
    expect((await asPlugin("GET", "/ui/nope", token)).statusCode).toBe(404);
    expect((await asPlugin("GET", "/cards", token)).statusCode).toBe(404);
    // 静态页面与脚本不含数据，不要求令牌（iframe 导航带不了 Authorization 头）
    const page = await asPlugin("GET", "/ui/board");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    const js = await asPlugin("GET", "/ui/board.js");
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
  });

  it("对话嵌入的令牌只看得到、只改得了这个对话的卡片；组织页面看不到、改不了对话里的卡片", async () => {
    await enable(owner, orgId, "example-board");
    const { token: orgToken } = (await issue(owner, "example-board", "board")).json() as Issued;
    const { token: convToken } = (
      await issue(owner, "example-board", "board-conv", { conversationId: convId })
    ).json() as Issued;
    const a = await asPlugin("POST", "/ui/cards", convToken, { title: "In conversation" });
    expect(a.statusCode).toBe(201);
    const b = await asPlugin("POST", "/ui/cards", orgToken, { title: "Org wide" });
    const orgCard = (b.json() as { card: { id: string } }).card.id;
    const conv = (await asPlugin("GET", "/ui/cards", convToken)).json() as {
      cards: { title: string }[];
    };
    expect(conv.cards.map((c) => c.title)).toEqual(["In conversation"]);
    const all = (await asPlugin("GET", "/ui/cards", orgToken)).json() as {
      cards: { title: string }[];
    };
    expect(all.cards.map((c) => c.title)).toEqual(["Org wide"]);
    expect(
      (await asPlugin("POST", `/ui/cards/${orgCard}`, convToken, { status: "done" })).statusCode,
    ).toBe(404);
    const convCard = (a.json() as { card: { id: string } }).card.id;
    expect(
      (await asPlugin("POST", `/ui/cards/${convCard}`, orgToken, { status: "done" })).statusCode,
    ).toBe(404);
  });

  it("插件在组织停用后，已签出的令牌立即失效（verifyEmbedToken 每次查启用状态）", async () => {
    await enable(owner, orgId, "example-board");
    const { token } = (await issue(owner, "example-board", "board")).json() as Issued;
    expect((await asPlugin("GET", "/ui/cards", token)).statusCode).toBe(200);
    const off = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/plugins/example-board`,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect((await asPlugin("GET", "/ui/cards", token)).statusCode).toBe(401);
    expect((await asPlugin("GET", "/ui/events", token)).statusCode).toBe(401);
    await enable(owner, orgId, "example-board");
    expect((await asPlugin("GET", "/ui/cards", token)).statusCode).toBe(200);
  });
});
