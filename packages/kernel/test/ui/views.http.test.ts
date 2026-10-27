import { fileURLToPath } from "node:url";
import { UI_LIMITS } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { compactionPlan } from "../../src/runtime/context/compaction.js";
import type { UiProbeState } from "../fixtures/plugins/ui-probe/index.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  waitForTerminal,
} from "../helpers/runs.js";
import { AGENT, MODEL } from "../runtime/context/fixtures.js";

/**
 * 插件视图接口（单副本 api+worker，测试内联插件 ui-probe + 假扩展 fake-tools-ui）：
 * 列出贡献、取视图（成功 / 抛错 502 / 超时 504 / 非法 502 + 告警且不写对话日志）、执行动作；
 * 他人的对话、未启用的插件一律 404（审查重点 1、2）；工具显示摘要写进 tool_result、不进模型请求。
 */

const UI_PROBE = fileURLToPath(new URL("../fixtures/plugins/ui-probe/index.ts", import.meta.url));
const TOOLS_UI = fakeExtensionEntry("fake-tools-ui");

const probe = (): UiProbeState => {
  const g = globalThis as { __uiProbe?: UiProbeState };
  g.__uiProbe ??= { aborted: 0 };
  return g.__uiProbe;
};

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let k: Kernel;
const lines: string[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  const base = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] });
  k = await createKernel(
    { ...base, extensions: [...base.extensions, UI_PROBE, TOOLS_UI] },
    { env: {}, logger: createLogger("warn", { write: (l) => lines.push(l) }) },
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

async function createToolAgent(req: Req, orgId: string): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [
          { kind: "plugin", plugin: "fake-tools-ui", name: "write" },
          { kind: "plugin", plugin: "ui-probe", name: "probe" },
        ],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

const enable = async (req: Req, orgId: string, plugin: string) => {
  const r = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
    payload: { enabled: true },
  });
  expect(r.statusCode, r.body).toBe(200);
};

describe("插件视图接口", () => {
  let owner: Req;
  let other: Req;
  let ownerId: string;
  let orgId: string;
  let agentId: string;
  let convId: string;
  let otherConv: string;
  let ui: string;

  beforeEach(async () => {
    await truncateTables(
      raw,
      "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.deployment_settings",
    );
    await redis.flushdb();
    lines.length = 0;
    ownerId = await account("owner");
    const otherId = await account("other");
    owner = await session(k, "owner");
    other = await session(k, "other");
    orgId = await createOrg(owner);
    await testMembers(db).add(orgId, otherId, "member", ownerId);
    agentId = await createToolAgent(owner, orgId);
    convId = await createConv(owner, orgId, agentId);
    otherConv = await createConv(other, orgId, agentId);
    ui = `/api/v1/orgs/${orgId}/ui`;
  });

  it("未登录 401；列出贡献：只含该组织已启用的插件，启用后出现 ui-probe 的全部贡献", async () => {
    expect((await k.http.inject({ method: "GET", url: `${ui}/contributions` })).statusCode).toBe(
      401,
    );
    const before = await owner({ method: "GET", url: `${ui}/contributions` });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ items: [] });

    await enable(owner, orgId, "ui-probe");
    const after = await owner({ method: "GET", url: `${ui}/contributions` });
    const items = (after.json() as { items: { plugin: string; id: string }[] }).items;
    // the old place "conversation" is listed as "panel" with legacyPlace; an alias is not listed
    expect(items).toEqual([
      {
        plugin: "ui-probe",
        id: "panel",
        title: { zh: "面板", en: "Panel" },
        place: "panel",
        legacyPlace: "conversation",
        kind: "view",
        icon: "puzzle",
      },
      {
        plugin: "ui-probe",
        id: "boom",
        title: { zh: "出错", en: "Boom" },
        place: "panel",
        legacyPlace: "conversation",
        kind: "view",
        icon: "puzzle",
      },
      {
        plugin: "ui-probe",
        id: "slow",
        title: { zh: "很慢", en: "Slow" },
        place: "panel",
        legacyPlace: "conversation",
        kind: "view",
        icon: "puzzle",
      },
      {
        plugin: "ui-probe",
        id: "bad",
        title: { zh: "非法", en: "Bad" },
        place: "panel",
        legacyPlace: "conversation",
        kind: "view",
        icon: "puzzle",
      },
      {
        plugin: "ui-probe",
        id: "orgpage",
        title: { zh: "组织页", en: "Org page" },
        place: "page",
        kind: "view",
        icon: "puzzle",
      },
      {
        plugin: "ui-probe",
        id: "side",
        title: { zh: "侧栏", en: "Side" },
        place: "section",
        kind: "view",
        icon: "chart",
      },
      {
        plugin: "ui-probe",
        id: "card",
        title: { zh: "卡片", en: "Card" },
        place: "inline",
        kind: "view",
        icon: "puzzle",
      },
      {
        plugin: "ui-probe",
        id: "board",
        title: { zh: "看板", en: "Board" },
        place: "page",
        kind: "embed",
        path: "/ui/board",
        icon: "puzzle",
      },
    ]);
    // 成员（guest 以上）都能列
    expect((await other({ method: "GET", url: `${ui}/contributions` })).statusCode).toBe(200);
  });

  it("取对话视图：成功，插件收到内核给的身份、对话与 locale（默认 en）", async () => {
    await enable(owner, orgId, "ui-probe");
    const r = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/panel?conversationId=${convId}&locale=zh`,
    });
    expect(r.statusCode, r.body).toBe(200);
    const view = (r.json() as { view: { badge: string; blocks: { type: string }[] } }).view;
    expect(view.badge).toBe("1/2");
    expect(view.blocks.map((b) => b.type)).toEqual(["heading", "code", "actions"]);
    expect(probe().lastRender).toEqual({
      orgId,
      accountId: ownerId,
      role: "owner",
      conversationId: convId,
      locale: "zh",
    });
    const en = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/panel?conversationId=${convId}`,
    });
    expect(en.statusCode).toBe(200);
    expect(probe().lastRender?.locale).toBe("en");
  });

  it("他人的对话、不存在的对话、别的组织的对话一律 404 ui.not_found（审查重点 2）；对话视图缺 conversationId 400", async () => {
    await enable(owner, orgId, "ui-probe");
    for (const conversationId of [otherConv, "00000000-0000-4000-8000-000000000000", "nope"]) {
      const r = await owner({
        method: "GET",
        url: `${ui}/views/ui-probe/panel?conversationId=${conversationId}`,
      });
      expect(r.statusCode).toBe(404);
      expect(errCode(r)).toBe("ui.not_found");
      const a = await owner({
        method: "POST",
        url: `${ui}/actions/ui-probe/panel`,
        payload: { actionId: "toast", conversationId },
      });
      expect(a.statusCode).toBe(404);
      expect(errCode(a)).toBe("ui.not_found");
    }
    // 别的组织里自己的对话：在本组织路径下取 → 404
    const org2 = await createOrg(owner, "Other");
    await enable(owner, org2, "ui-probe");
    const agent2 = await createToolAgent(owner, org2);
    const conv2 = await createConv(owner, org2, agent2);
    const cross = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/panel?conversationId=${conv2}`,
    });
    expect(cross.statusCode).toBe(404);
    expect(errCode(cross)).toBe("ui.not_found");
    const missing = await owner({ method: "GET", url: `${ui}/views/ui-probe/panel` });
    expect(missing.statusCode).toBe(400);
    expect(errCode(missing)).toBe("validation_failed");
  });

  it("插件未在组织启用、插件或贡献不存在、embed 当视图取 → 404 ui.not_found；非成员 404 org.not_found", async () => {
    const urls = [
      `${ui}/views/ui-probe/panel?conversationId=${convId}`,
      `${ui}/views/nope/panel?conversationId=${convId}`,
    ];
    for (const url of urls) {
      const r = await owner({ method: "GET", url });
      expect(r.statusCode).toBe(404);
      expect(errCode(r)).toBe("ui.not_found");
    }
    await enable(owner, orgId, "ui-probe");
    for (const url of [`${ui}/views/ui-probe/missing`, `${ui}/views/ui-probe/board`]) {
      const r = await owner({ method: "GET", url });
      expect(r.statusCode).toBe(404);
      expect(errCode(r)).toBe("ui.not_found");
    }
    await account("stranger");
    const stranger = await session(k, "stranger");
    const s = await stranger({ method: "GET", url: `${ui}/views/ui-probe/orgpage` });
    expect(s.statusCode).toBe(404);
    expect(errCode(s)).toBe("org.not_found");
  });

  it("render 抛错 → 502 ui.render_failed（不回显插件的异常信息）；超时 → 504 ui.timeout，插件收到中止信号", async () => {
    await enable(owner, orgId, "ui-probe");
    const boom = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/boom?conversationId=${convId}`,
    });
    expect(boom.statusCode).toBe(502);
    expect(errCode(boom)).toBe("ui.render_failed");
    expect(boom.body).not.toContain("secret detail");

    const aborted = probe().aborted;
    const t0 = Date.now();
    const slow = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/slow?conversationId=${convId}`,
    });
    expect(slow.statusCode).toBe(504);
    expect(errCode(slow)).toBe("ui.timeout");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4900);
    expect(probe().aborted).toBe(aborted + 1);
  }, 20_000);

  it("非法视图 → 502 ui.invalid_view，记一条告警，对话日志里没有新事件（审查重点 1）", async () => {
    await enable(owner, orgId, "ui-probe");
    const before = (await eventsOf(db, convId)).length;
    const r = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/bad?conversationId=${convId}`,
    });
    expect(r.statusCode).toBe(502);
    expect(errCode(r)).toBe("ui.invalid_view");
    expect(
      lines.some((l) => l.includes('"warn"') && l.includes("ui-probe") && l.includes("bad")),
    ).toBe(true);
    expect((await eventsOf(db, convId)).length).toBe(before);
    // 对话本身照常可用：其他视图仍然正常
    const ok = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/panel?conversationId=${convId}`,
    });
    expect(ok.statusCode).toBe(200);
  });

  it("组织页面视图：成员可取，不带对话；带 conversationId → 400 validation_failed", async () => {
    await enable(owner, orgId, "ui-probe");
    const r = await other({ method: "GET", url: `${ui}/views/ui-probe/orgpage` });
    expect(r.statusCode, r.body).toBe(200);
    expect(probe().lastRender).toEqual({
      orgId,
      accountId: expect.any(String),
      role: "member",
      locale: "en",
    });
    const withConv = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/orgpage?conversationId=${convId}`,
    });
    expect(withConv.statusCode).toBe(400);
    expect(errCode(withConv)).toBe("validation_failed");
  });

  it("动作请求体上限：payload 超过 UI_LIMITS.payloadBytes、answer 键过多或数组过长 → 400", async () => {
    await enable(owner, orgId, "ui-probe");
    const post = (payload: Record<string, unknown>) =>
      owner({
        method: "POST",
        url: `${ui}/actions/ui-probe/panel`,
        payload: { actionId: "toast", conversationId: convId, ...payload },
      });
    const big = await post({ payload: { s: "x".repeat(UI_LIMITS.payloadBytes) } });
    expect(big.statusCode).toBe(400);
    expect(errCode(big)).toBe("validation_failed");
    const fits = await post({ payload: { s: "x".repeat(UI_LIMITS.payloadBytes - 20) } });
    expect(fits.statusCode, fits.body).toBe(200);
    const manyKeys = Object.fromEntries(
      Array.from({ length: UI_LIMITS.tableRows + 1 }, (_, i) => [`k${i}`, "v"]),
    );
    expect((await post({ answer: manyKeys })).statusCode).toBe(400);
    const longArray = { q0: Array.from({ length: UI_LIMITS.tableRows + 1 }, (_, i) => `v${i}`) };
    expect((await post({ answer: longArray })).statusCode).toBe(400);
  });

  it("执行动作：toast / 新视图；非法结果 502 ui.invalid_view；抛错 502 ui.action_failed；插件收到身份与 payload / answer", async () => {
    await enable(owner, orgId, "ui-probe");
    const act = (actionId: string, extra: Record<string, unknown> = {}) =>
      owner({
        method: "POST",
        url: `${ui}/actions/ui-probe/panel`,
        payload: { actionId, conversationId: convId, ...extra },
      });
    const toast = await act("toast", { payload: { n: 1 }, answer: { q0: "yes" }, locale: "zh" });
    expect(toast.statusCode, toast.body).toBe(200);
    expect(toast.json()).toEqual({ toast: { zh: "好了", en: "Done" } });
    expect(probe().lastAction).toEqual({
      orgId,
      accountId: ownerId,
      role: "owner",
      conversationId: convId,
      locale: "zh",
      actionId: "toast",
      payload: { n: 1 },
      answer: { q0: "yes" },
    });
    const view = await act("view");
    expect(view.statusCode).toBe(200);
    expect(view.json()).toEqual({
      view: { badge: "2/2", blocks: [{ type: "heading", text: "after" }] },
    });
    const bad = await act("bad");
    expect(bad.statusCode).toBe(502);
    expect(errCode(bad)).toBe("ui.invalid_view");
    const boom = await act("boom");
    expect(boom.statusCode).toBe(502);
    expect(errCode(boom)).toBe("ui.action_failed");
    expect(boom.body).not.toContain("exploded");
    // 没有 action 处理函数的视图 → 404
    const none = await owner({
      method: "POST",
      url: `${ui}/actions/ui-probe/boom`,
      payload: { actionId: "x", conversationId: convId },
    });
    expect(none.statusCode).toBe(404);
    expect(errCode(none)).toBe("ui.not_found");
    const invalid = await owner({
      method: "POST",
      url: `${ui}/actions/ui-probe/panel`,
      payload: { conversationId: convId },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("a sub-agent's conversation shows views but takes no actions: 409 conversation.read_only (final review m3)", async () => {
    await enable(owner, orgId, "ui-probe");
    const child = await createConv(owner, orgId, agentId);
    await db
      .updateTable("conversations")
      .set({ kind: "subagent", parent_conversation_id: convId })
      .where("id", "=", child)
      .execute();
    const view = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/panel?conversationId=${child}`,
    });
    expect(view.statusCode, view.body).toBe(200);
    const act = await owner({
      method: "POST",
      url: `${ui}/actions/ui-probe/panel`,
      payload: { actionId: "toast", conversationId: child },
    });
    expect(act.statusCode, act.body).toBe(409);
    expect(errCode(act)).toBe("conversation.read_only");
  });

  it("角色（A38）：guest 看不到组织页面（列表隐藏，视图 / 动作 / 嵌入令牌 / 组织流 404）；member 可以；guest 可用对话视图", async () => {
    await enable(owner, orgId, "ui-probe");
    const guestId = await account("guest");
    await testMembers(db).add(orgId, guestId, "guest", ownerId);
    const guest = await session(k, "guest");
    const guestConv = await createConv(guest, orgId, agentId);
    const ids = async (req: Req) =>
      (
        (await req({ method: "GET", url: `${ui}/contributions` })).json() as {
          items: { id: string }[];
        }
      ).items.map((i) => i.id);
    expect(await ids(guest)).toEqual(["panel", "boom", "slow", "bad", "side", "card"]);
    expect(await ids(other)).toEqual([
      "panel",
      "boom",
      "slow",
      "bad",
      "orgpage",
      "side",
      "card",
      "board",
    ]);
    // a section and an inline card follow the conversation rule: a guest who reads it may fetch them
    const side = await guest({
      method: "GET",
      url: `${ui}/views/ui-probe/side?conversationId=${guestConv}`,
    });
    expect(side.statusCode, side.body).toBe(200);
    expect((side.json() as { view: { badge: string } }).view.badge).toBe("1/3");

    const pageCalls = [
      { method: "GET", url: `${ui}/views/ui-probe/orgpage` },
      { method: "POST", url: `${ui}/actions/ui-probe/orgpage`, payload: { actionId: "go" } },
      { method: "POST", url: `${ui}/embeds/ui-probe/board/token`, payload: {} },
      { method: "GET", url: `${ui}/stream` },
    ] as const;
    for (const call of pageCalls) {
      const r = await guest(call);
      expect(r.statusCode, call.url).toBe(404);
      expect(errCode(r), call.url).toBe("ui.not_found");
    }
    for (const call of pageCalls.slice(0, 3)) {
      const r = await other(call);
      expect(r.statusCode, `${call.url} ${r.body}`).toBe(200);
    }
    expect(probe().lastAction).toEqual(expect.objectContaining({ role: "member", actionId: "go" }));
    const issued = await other(pageCalls[2]);
    const claims = JSON.parse(
      Buffer.from(
        (issued.json() as { token: string }).token.split(".")[0] ?? "",
        "base64url",
      ).toString("utf8"),
    ) as Record<string, unknown>;
    expect(claims.role).toBe("member");

    // 对话位置的贡献：能访问该对话的 guest 照常可用
    const v = await guest({
      method: "GET",
      url: `${ui}/views/ui-probe/panel?conversationId=${guestConv}`,
    });
    expect(v.statusCode, v.body).toBe(200);
    expect(probe().lastRender).toEqual(
      expect.objectContaining({ role: "guest", accountId: guestId }),
    );
    const a = await guest({
      method: "POST",
      url: `${ui}/actions/ui-probe/panel`,
      payload: { actionId: "toast", conversationId: guestConv },
    });
    expect(a.statusCode, a.body).toBe(200);
    expect(probe().lastAction).toEqual(expect.objectContaining({ role: "guest" }));
  });

  it("an inline card gets callId / key as args.card, a panel gets item; the old alias renders its target", async () => {
    await enable(owner, orgId, "ui-probe");
    // the card is attested by the log: a tool_result of this conversation recorded it (review I2)
    await k.runs.eventLog.append(convId, [
      {
        type: "tool_result",
        payload: {
          step: 0,
          callId: "call-1",
          toolKey: "ui-probe__probe",
          content: "probed",
          isError: false,
          card: { plugin: "ui-probe", view: "card", key: "k1" },
        },
      },
    ]);
    const made = (q: string) =>
      owner({ method: "GET", url: `${ui}/views/ui-probe/${q}&conversationId=${convId}` });
    // a made-up call, another key, or a call on a non-inline view → 404
    expect((await made("card?callId=call-x&key=k1")).statusCode).toBe(404);
    expect((await made("card?callId=call-1&key=k2")).statusCode).toBe(404);
    expect((await made("card?callId=call-1")).statusCode).toBe(404);
    expect((await made("panel?callId=call-1&key=k1")).statusCode).toBe(404);
    const card = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/card?conversationId=${convId}&callId=call-1&key=k1`,
    });
    expect(card.statusCode, card.body).toBe(200);
    // open targets must name a panel of the same extension (an alias of one counts); others dropped
    expect((card.json() as { view: unknown }).view).toEqual({
      open: { contribution: "panel", item: "a" },
      blocks: [
        {
          type: "checklist",
          items: [
            { text: "a", status: "pending", id: "a", open: { contribution: "panel", item: "a" } },
            { text: "b", status: "pending" },
          ],
        },
        { type: "keyValue", items: [{ label: "k", value: "v" }] },
        {
          type: "table",
          columns: [{ key: "c", label: "C" }],
          rows: [{ c: "1" }, { c: "2" }],
          open: [{ contribution: "old-panel" }, null],
        },
      ],
    });
    expect(probe().lastRender).toEqual({
      orgId,
      accountId: ownerId,
      role: "owner",
      conversationId: convId,
      locale: "en",
      card: { callId: "call-1", key: "k1" },
    });
    const panel = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/panel?conversationId=${convId}&item=a`,
    });
    expect(panel.statusCode, panel.body).toBe(200);
    expect(probe().lastRender).toMatchObject({ item: "a" });
    expect(probe().lastRender).not.toHaveProperty("card");
    // a key without callId is refused
    const keyOnly = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/card?conversationId=${convId}&key=k1`,
    });
    expect(keyOnly.statusCode).toBe(400);
    // the retired id answers with the panel it aliases (open pages keep working for a release)
    const old = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/old-panel?conversationId=${convId}&locale=zh`,
    });
    expect(old.statusCode, old.body).toBe(200);
    expect((old.json() as { view: { blocks: { text?: string }[] } }).view.blocks[0]?.text).toBe(
      "panel zh",
    );
    // other people's conversations stay 404 for the new places
    const theirs = await owner({
      method: "GET",
      url: `${ui}/views/ui-probe/side?conversationId=${otherConv}`,
    });
    expect(theirs.statusCode).toBe(404);
  });

  it("服务令牌 → 403（HUMAN_ONLY）", async () => {
    await enable(owner, orgId, "ui-probe");
    const { token } = await new ApiTokenService(db).createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: ownerId,
    });
    for (const [method, url] of [
      ["GET", `${ui}/contributions`],
      ["GET", `${ui}/views/ui-probe/orgpage`],
      ["POST", `${ui}/actions/ui-probe/panel`],
      ["GET", `${ui}/stream`],
    ] as const) {
      const r = await k.http.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(method === "POST" && { payload: { actionId: "toast", conversationId: convId } }),
      });
      expect(r.statusCode, url).toBe(403);
    }
  });

  it("组织启用页的权限清单：ui 分组含 embed，标为敏感", async () => {
    const r = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    expect(r.statusCode).toBe(200);
    const plugin = (
      r.json() as {
        extensions: {
          plugin: string;
          permissions: { category: string; sensitive: boolean; items: string[] }[];
        }[];
      }
    ).extensions.find((p) => p.plugin === "ui-probe");
    expect(plugin?.permissions.find((g) => g.category === "ui")).toEqual({
      category: "ui",
      sensitive: true,
      items: [
        "view:bad",
        "view:boom",
        "view:card",
        "view:old-panel",
        "view:orgpage",
        "view:panel",
        "view:side",
        "view:slow",
        "embed:board",
      ],
      entries: [
        ...[
          "view:bad",
          "view:boom",
          "view:card",
          "view:old-panel",
          "view:orgpage",
          "view:panel",
          "view:side",
          "view:slow",
        ].map((value) => ({
          value,
          sensitive: false,
        })),
        { value: "embed:board", sensitive: true, reason: "ui_embed" },
      ],
    });
    const toolsUi = (
      r.json() as { extensions: { plugin: string; permissions: { category: string }[] }[] }
    ).extensions.find((p) => p.plugin === "fake-tools-ui");
    expect(toolsUi?.permissions.find((g) => g.category === "ui")).toMatchObject({
      sensitive: false,
      items: ["view:tasks"],
    });
  });
});

describe("工具显示摘要", () => {
  let owner: Req;
  let orgId: string;
  let convId: string;

  beforeEach(async () => {
    await truncateTables(
      raw,
      "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.deployment_settings",
    );
    await redis.flushdb();
    lines.length = 0;
    await account("owner");
    owner = await session(k, "owner");
    orgId = await createOrg(owner);
    await enable(owner, orgId, "fake-tools-ui");
    await enable(owner, orgId, "ui-probe");
    const agentId = await createToolAgent(owner, orgId);
    convId = await createConv(owner, orgId, agentId);
  });

  const send = async (text: string, n: number) => {
    const r = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
      payload: { text },
    });
    expect(r.statusCode).toBe(202);
    await waitForTerminal(db, convId, n, 20_000);
  };
  const results = async () =>
    (await eventsOf(db, convId)).filter(
      (e): e is Extract<ConversationEvent, { type: "tool_result" }> => e.type === "tool_result",
    );

  it("摘要写进 tool_result 事件；按日志重建的模型请求里没有摘要", async () => {
    const items = {
      items: [
        { text: "Plan", status: "completed" },
        { text: "Build", status: "in_progress" },
        { text: "Ship", status: "pending" },
      ],
    };
    await send(`tool:fake-tools-ui__write:${JSON.stringify(items)}`, 1);
    const [r] = await results();
    expect(r?.payload).toMatchObject({
      toolKey: "fake-tools-ui__write",
      isError: false,
      display: { summary: { zh: "更新条目（3 项）", en: "Updated items (3)" } },
    });
    const events = await eventsOf(db, convId);
    const { request } = buildModelRequest({
      events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 3,
    });
    const json = JSON.stringify(request);
    expect(json).toContain("List updated (3 items)");
    expect(json).not.toContain("Updated items");
    expect(json).not.toContain("更新条目");
    // 压缩记录（把全部内容转成纯文本给模型做摘要）里也没有摘要
    const plan = compactionPlan(events, 0);
    expect(plan?.transcript).toContain("List updated (3 items)");
    expect(plan?.transcript).not.toContain("Updated items");
    expect(plan?.transcript).not.toContain("更新条目");
    // 本次运行实际发出的第二次模型请求的回复里也看不到摘要（model-fake 回显它看到的工具结果）
    const assistant = events.filter((e) => e.type === "assistant_message");
    expect(JSON.stringify(assistant)).not.toContain("Updated items");
  });

  it("ToolResult.card is recorded on tool_result (display only, never in the model request); an unknown or non-inline view is dropped", async () => {
    await send('tool:ui-probe__probe:{"card":"card"}', 1);
    await send('tool:ui-probe__probe:{"card":"nope"}', 2);
    await send('tool:ui-probe__probe:{"card":"panel"}', 3);
    const [good, unknown, notInline] = await results();
    expect(good?.payload.card).toEqual({ plugin: "ui-probe", view: "card", key: "card-key-zz" });
    expect(unknown?.payload.content).toBe("probed");
    expect(unknown?.payload).not.toHaveProperty("card");
    expect(notInline?.payload).not.toHaveProperty("card");
    expect(lines.filter((l) => l.includes("inline card")).length).toBeGreaterThanOrEqual(2);
    const events = await eventsOf(db, convId);
    const { request } = buildModelRequest({
      events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 7,
    });
    expect(JSON.stringify(request)).toContain("probed");
    expect(JSON.stringify(request)).not.toContain("card-key-zz");
    expect(compactionPlan(events, 0)?.transcript).not.toContain("card-key-zz");
  });

  it("插件给的摘要不合法 → 丢弃并告警，结果照常写入", async () => {
    await send('tool:ui-probe__probe:{"bad":true}', 1);
    await send("tool:ui-probe__probe:{}", 2);
    const [bad, good] = await results();
    expect(bad?.payload.content).toBe("probed");
    expect(bad?.payload).not.toHaveProperty("display");
    expect(lines.some((l) => l.includes('"warn"') && l.includes("ui-probe__probe"))).toBe(true);
    expect(good?.payload.display).toEqual({ summary: { zh: "探测完成", en: "Probe done" } });
  });
});
