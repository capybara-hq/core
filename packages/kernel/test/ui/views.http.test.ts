import { fileURLToPath } from "node:url";
import { UI_LIMITS } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
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
 * 插件视图接口（单副本 api+worker，测试内联插件 ui-probe + todo）：
 * 列出贡献、取视图（成功 / 抛错 502 / 超时 504 / 非法 502 + 告警且不写对话日志）、执行动作；
 * 他人的对话、未启用的插件一律 404（审查重点 1、2）；工具显示摘要写进 tool_result、不进模型请求。
 */

const UI_PROBE = fileURLToPath(new URL("../fixtures/plugins/ui-probe/index.ts", import.meta.url));
const TODO = fileURLToPath(new URL("../../../../plugins/todo/src/index.ts", import.meta.url));

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
    { ...base, plugins: [...base.plugins, UI_PROBE, TODO] },
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
          { kind: "plugin", plugin: "todo", name: "write" },
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
    url: `/api/v1/orgs/${orgId}/plugins/${plugin}`,
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
    expect(items).toEqual([
      {
        plugin: "ui-probe",
        id: "panel",
        title: { zh: "面板", en: "Panel" },
        place: "conversation",
        kind: "view",
      },
      {
        plugin: "ui-probe",
        id: "boom",
        title: { zh: "出错", en: "Boom" },
        place: "conversation",
        kind: "view",
      },
      {
        plugin: "ui-probe",
        id: "slow",
        title: { zh: "很慢", en: "Slow" },
        place: "conversation",
        kind: "view",
      },
      {
        plugin: "ui-probe",
        id: "bad",
        title: { zh: "非法", en: "Bad" },
        place: "conversation",
        kind: "view",
      },
      {
        plugin: "ui-probe",
        id: "orgpage",
        title: { zh: "组织页", en: "Org page" },
        place: "page",
        kind: "view",
      },
      {
        plugin: "ui-probe",
        id: "board",
        title: { zh: "看板", en: "Board" },
        place: "page",
        kind: "embed",
        path: "/ui/board",
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
    expect(probe().lastRender).toEqual({ orgId, accountId: expect.any(String), locale: "en" });
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
      url: `${ui}/actions/ui-probe/orgpage`,
      payload: { actionId: "x" },
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
    const r = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/plugins` });
    expect(r.statusCode).toBe(200);
    const plugin = (
      r.json() as {
        plugins: {
          plugin: string;
          permissions: { category: string; sensitive: boolean; items: string[] }[];
        }[];
      }
    ).plugins.find((p) => p.plugin === "ui-probe");
    expect(plugin?.permissions.find((g) => g.category === "ui")).toEqual({
      category: "ui",
      sensitive: true,
      items: ["view:bad", "view:boom", "view:orgpage", "view:panel", "view:slow", "embed:board"],
    });
    const todo = (
      r.json() as { plugins: { plugin: string; permissions: { category: string }[] }[] }
    ).plugins.find((p) => p.plugin === "todo");
    expect(todo?.permissions.find((g) => g.category === "ui")).toMatchObject({
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
    await enable(owner, orgId, "todo");
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
    const todos = {
      todos: [
        { content: "Plan", status: "completed", activeForm: "Planning" },
        { content: "Build", status: "in_progress", activeForm: "Building" },
        { content: "Ship", status: "pending", activeForm: "Shipping" },
      ],
    };
    await send(`tool:todo__write:${JSON.stringify(todos)}`, 1);
    const [r] = await results();
    expect(r?.payload).toMatchObject({
      toolKey: "todo__write",
      isError: false,
      display: { summary: { zh: "更新任务清单（3 项）", en: "Updated task list (3 items)" } },
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
    expect(json).toContain("Todo list updated (3 items)");
    expect(json).not.toContain("Updated task list");
    expect(json).not.toContain("更新任务清单");
    // 压缩记录（把全部内容转成纯文本给模型做摘要）里也没有摘要
    const plan = compactionPlan(events, 0);
    expect(plan?.transcript).toContain("Todo list updated (3 items)");
    expect(plan?.transcript).not.toContain("Updated task list");
    expect(plan?.transcript).not.toContain("更新任务清单");
    // 本次运行实际发出的第二次模型请求的回复里也看不到摘要（model-fake 回显它看到的工具结果）
    const assistant = events.filter((e) => e.type === "assistant_message");
    expect(JSON.stringify(assistant)).not.toContain("Updated task list");
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
