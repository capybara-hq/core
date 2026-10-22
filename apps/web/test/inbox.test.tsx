import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import InboxRoute from "../src/app/[locale]/(app)/inbox/page";
import GrantsPage from "../src/app/[locale]/(app)/settings/grants/page";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const T = "2026-10-19T12:00:00.000Z";

const approval = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  conversationId: `c-${id}`,
  runId: "r1",
  callId: `call-${id}`,
  toolKey: `fixture__${id}`,
  toolName: `tool_${id}`,
  connector: { id: "app1", name: "Fixture", slug: "fixture" },
  agent: { id: "ag1", name: "Echo agent" },
  input: { id },
  requestedFor: "a1",
  approverRole: null,
  status: "pending",
  scope: null,
  decidedBy: null,
  decidedAt: null,
  expiresAt: T,
  createdAt: T,
  conversationPath: `/chat/c-${id}`,
  initiatorAccountId: "a1",
  ...over,
});

const LIST = "GET /api/v1/orgs/o1/inbox";

/** 收件箱汇总接口的响应：各项按 type 区分。 */
const inbox = (
  approvals: ReturnType<typeof approval>[],
  changes: ReturnType<typeof skillChange>[] = [],
  truncated = false,
) => ({
  items: [
    ...approvals.map((a) => ({
      type: "tool_approval",
      id: a.id,
      createdAt: a.createdAt,
      approval: a,
    })),
    ...changes.map((c) => ({
      type: "skill_change",
      id: c.id,
      createdAt: c.createdAt,
      skillChange: c,
    })),
  ],
  truncated,
});

const skillChange = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orgId: "o1",
  agent: { id: "ag1", name: "Shared agent" },
  skillId: "k1",
  name: "notes-style",
  description: "Use for notes.",
  version: 2,
  files: [
    { path: "SKILL.md", size: 20 },
    { path: "ref/new.md", size: 5 },
  ],
  status: "pending",
  requestedBy: "a2",
  requestedByName: "Mia",
  requestedInConversation: "c9",
  conversationPath: "/chat/c9",
  decidedBy: null,
  decidedAt: null,
  createdAt: T,
  ...over,
});

beforeEach(() => resetNavigation("/inbox"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("收件箱（InboxPage）", () => {
  it.each(LOCALES)(
    "Rail 为待处理列表，内容区为第一条详情，ActionRow 有批准 / 拒绝（%s）",
    async (locale) => {
      const m = msgs[locale];
      stubApi({ [LIST]: () => json(200, inbox([approval("a"), approval("b")])) });
      const { container } = renderPage(<InboxRoute />, { locale });
      expect(container.querySelector('[data-template="InboxPage"]')).not.toBeNull();
      const table = await screen.findByRole("table", { name: m.inbox.listLabel });
      expect(within(table).getByText("Fixture · tool_a")).toBeTruthy();
      expect(within(table).getByText("Fixture · tool_b")).toBeTruthy();
      // 默认选中第一条
      const detail = container.querySelector('[data-approval-id="a"]') as HTMLElement;
      expect(detail).not.toBeNull();
      expect(within(detail).getByLabelText(m.approval.input)).toHaveProperty(
        "value",
        JSON.stringify({ id: "a" }, null, 2),
      );
      expect(
        within(screen.getByRole("radiogroup", { name: m.approval.scopeLabel })).getAllByRole(
          "radio",
        ),
      ).toHaveLength(3);
      const row = screen.getByRole("region", {
        name: locale === "zh" ? "待提交改动" : "Pending changes",
      });
      expect(
        within(row).getByRole("button", { name: m.approval.approve }).getAttribute("data-variant"),
      ).toBe("primary");
      expect(within(row).getByRole("button", { name: m.approval.deny })).toBeTruthy();
      // 打开会话
      await userEvent.setup().click(screen.getByRole("button", { name: m.inbox.openConversation }));
      expect(router.push).toHaveBeenCalledWith("/chat/c-a");
    },
  );

  it.each(LOCALES)("选中第二条、选「以后都允许」批准 → POST 后重读列表（%s）", async (locale) => {
    const m = msgs[locale];
    let pending = [approval("a"), approval("b")];
    const calls = stubApi({
      [LIST]: () => json(200, inbox(pending)),
      "POST /api/v1/orgs/o1/approvals/b/decision": () => {
        pending = pending.filter((a) => a.id !== "b");
        return json(200, { approval: { ...approval("b"), status: "approved", scope: "always" } });
      },
    });
    const refreshPending = vi.fn();
    const { container } = renderPage(<InboxRoute />, { locale, session: { refreshPending } });
    const user = userEvent.setup();
    const table = await screen.findByRole("table", { name: m.inbox.listLabel });
    await user.click(within(table).getByText("Fixture · tool_b"));
    expect(container.querySelector('[data-approval-id="b"]')).not.toBeNull();
    await user.click(screen.getByLabelText(new RegExp(m.approval.scope.always)));
    const row = screen.getByRole("region", {
      name: locale === "zh" ? "待提交改动" : "Pending changes",
    });
    await user.click(within(row).getByRole("button", { name: m.approval.approve }));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      decision: "approve",
      scope: "always",
    });
    await vi.waitFor(() => expect(screen.queryByText("Fixture · tool_b")).toBeNull());
    expect(calls.filter((c) => c.url.endsWith("/inbox"))).toHaveLength(2);
    expect(await screen.findByText(m.inbox.approved)).toBeTruthy();
    // 顶栏的待处理数立即重读，不等 30 秒轮询
    expect(refreshPending).toHaveBeenCalledTimes(1);
  });

  it("已被别人处理：toast 显示 approval.already_decided 的文案并重读", async () => {
    stubApi({
      [LIST]: () => json(200, inbox([approval("a")])),
      "POST /api/v1/orgs/o1/approvals/a/decision": () =>
        json(409, { error: { code: "approval.already_decided", message: "x" } }),
    });
    renderPage(<InboxRoute />, { locale: "zh" });
    await screen.findByRole("table", { name: zh.inbox.listLabel });
    const row = screen.getByRole("region", { name: "待提交改动" });
    await userEvent.setup().click(within(row).getByRole("button", { name: zh.approval.deny }));
    expect(await screen.findByText(zh.errors.approval.already_decided)).toBeTruthy();
  });

  it.each(LOCALES)("没有待处理：DataTable 空状态，没有 ActionRow（%s）", async (locale) => {
    const m = msgs[locale];
    stubApi({ [LIST]: () => json(200, inbox([])) });
    renderPage(<InboxRoute />, { locale });
    expect(await screen.findByText(m.inbox.empty)).toBeTruthy();
    expect(screen.queryByRole("button", { name: m.approval.approve })).toBeNull();
  });

  it("按角色升级的审批只有「仅本次」", async () => {
    stubApi({
      [LIST]: () =>
        json(200, inbox([approval("a", { requestedFor: null, approverRole: "admin" })])),
    });
    renderPage(<InboxRoute />);
    const scopes = await screen.findByRole("radiogroup", { name: en.approval.scopeLabel });
    expect(within(scopes).getAllByRole("radio")).toHaveLength(1);
  });
});

describe("收件箱：技能变更", () => {
  const DETAIL = "GET /api/v1/orgs/o1/skill-changes/sc1";
  const detail = (over: Record<string, unknown> = {}) => ({
    ...skillChange("sc1"),
    files: [
      { path: "SKILL.md", size: 20, content: "# Notes\nkeep\nnew line\n" },
      { path: "ref/new.md", size: 5, content: "hello" },
    ],
    current: {
      version: 1,
      files: [
        { path: "SKILL.md", size: 18, content: "# Notes\nkeep\nold line\n" },
        { path: "ref/old.md", size: 3, content: "bye" },
      ],
    },
    ...over,
  });

  it.each(LOCALES)(
    "工具审批与技能变更同在列表；技能变更卡片显示 agent、发起人、文件与纯文本差异（%s）",
    async (locale) => {
      const m = msgs[locale];
      stubApi({
        [LIST]: () => json(200, inbox([approval("a")], [skillChange("sc1")])),
        [DETAIL]: () => json(200, { skillChange: detail() }),
      });
      const { container } = renderPage(<InboxRoute />, { locale });
      const table = await screen.findByRole("table", { name: m.inbox.listLabel });
      expect(within(table).getByText("Fixture · tool_a")).toBeTruthy();
      await userEvent
        .setup()
        .click(within(table).getByText(`${m.inbox.skillChange.label} · notes-style`));
      const card = await vi.waitFor(() => {
        const el = container.querySelector('[data-skill-change-id="sc1"]') as HTMLElement | null;
        if (!el) throw new Error("no card");
        return el;
      });
      expect(within(card).getAllByText("Shared agent").length).toBeGreaterThan(0);
      expect(within(card).getAllByText("Mia").length).toBeGreaterThan(0);
      // 差异：纯文本，按文件
      const diff = await within(card).findByLabelText(
        m.inbox.skillChange.diffLabel.replace("{path}", "SKILL.md"),
      );
      expect(diff.textContent).toContain("- old line");
      expect(diff.textContent).toContain("+ new line");
      expect(diff.textContent).toContain("  keep");
      expect(within(card).getByText(`ref/new.md · ${m.inbox.skillChange.added}`)).toBeTruthy();
      expect(within(card).getByText(`ref/old.md · ${m.inbox.skillChange.removed}`)).toBeTruthy();
      // 负责人看到批准 / 拒绝
      const row = screen.getByRole("region", {
        name: locale === "zh" ? "待提交改动" : "Pending changes",
      });
      expect(within(row).getByRole("button", { name: m.inbox.skillChange.approve })).toBeTruthy();
      expect(within(row).getByRole("button", { name: m.inbox.skillChange.reject })).toBeTruthy();
      // 打开发起对话
      await userEvent
        .setup()
        .click(within(card).getByRole("button", { name: m.inbox.openConversation }));
      expect(router.push).toHaveBeenCalledWith("/chat/c9");
    },
  );

  it("批准：POST decide 后重读列表、顶栏待处理数刷新", async () => {
    let changes = [skillChange("sc1")];
    const calls = stubApi({
      [LIST]: () => json(200, inbox([], changes)),
      [DETAIL]: () => json(200, { skillChange: detail() }),
      "POST /api/v1/orgs/o1/skill-changes/sc1/decide": () => {
        changes = [];
        return json(200, { skillChange: { ...skillChange("sc1"), status: "approved" } });
      },
    });
    const refreshPending = vi.fn();
    renderPage(<InboxRoute />, { session: { refreshPending } });
    const row = await screen.findByRole("region", { name: "Pending changes" });
    await userEvent
      .setup()
      .click(await within(row).findByRole("button", { name: en.inbox.skillChange.approve }));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ decision: "approve" });
    expect(await screen.findByText(en.inbox.skillChange.approved)).toBeTruthy();
    expect(await screen.findByText(en.inbox.empty)).toBeTruthy();
    expect(refreshPending).toHaveBeenCalledTimes(1);
  });

  it("拒绝失败（已被处理）：toast 显示 skill_change.already_decided 的文案", async () => {
    stubApi({
      [LIST]: () => json(200, inbox([], [skillChange("sc1")])),
      [DETAIL]: () => json(200, { skillChange: detail() }),
      "POST /api/v1/orgs/o1/skill-changes/sc1/decide": () =>
        json(409, { error: { code: "skill_change.already_decided", message: "x" } }),
    });
    renderPage(<InboxRoute />, { locale: "zh" });
    const row = await screen.findByRole("region", { name: "待提交改动" });
    await userEvent
      .setup()
      .click(await within(row).findByRole("button", { name: zh.inbox.skillChange.reject }));
    expect(await screen.findByText(zh.errors.skill_change.already_decided)).toBeTruthy();
  });

  it("新技能（没有当前版本）：全部文件为新增；自己发起的显示「两步确认」说明；列表被截断时提示", async () => {
    stubApi({
      [LIST]: () =>
        json(
          200,
          inbox([], [skillChange("sc1", { skillId: null, version: 1, requestedBy: "a1" })], true),
        ),
      [DETAIL]: () =>
        json(200, {
          skillChange: detail({ skillId: null, version: 1, requestedBy: "a1", current: null }),
        }),
    });
    const { container } = renderPage(<InboxRoute />);
    expect(await screen.findByText(en.inbox.truncated)).toBeTruthy();
    const card = await vi.waitFor(() => {
      const el = container.querySelector('[data-skill-change-id="sc1"]') as HTMLElement | null;
      if (!el) throw new Error("no card");
      return el;
    });
    expect(await within(card).findByText(`SKILL.md · ${en.inbox.skillChange.added}`)).toBeTruthy();
    expect(within(card).getByText(en.inbox.skillChange.newSkill)).toBeTruthy();
    expect(within(card).getByText(en.inbox.skillChange.selfHint)).toBeTruthy();
    const diff = within(card).getByLabelText(
      en.inbox.skillChange.diffLabel.replace("{path}", "SKILL.md"),
    );
    expect(diff.textContent).toContain("+ # Notes");
  });
});

describe("已记住的授权（SettingsPage）", () => {
  it.each(LOCALES)("列出授权，撤销 → DELETE 后重读（%s）", async (locale) => {
    const m = msgs[locale];
    let grants = [
      {
        agentId: "ag1",
        agentName: "Echo agent",
        toolKey: "fixture__delete_item",
        specHash: "h",
        createdAt: T,
      },
    ];
    const calls = stubApi({
      "GET /api/v1/orgs/o1/me/tool-grants": () => json(200, { grants }),
      "DELETE /api/v1/orgs/o1/me/tool-grants/ag1/fixture__delete_item": () => {
        grants = [];
        return noContent();
      },
    });
    const { container } = renderPage(<GrantsPage />, { locale });
    expect(container.querySelector('[data-template="SettingsPage"]')).not.toBeNull();
    expect(
      screen.getByRole("link", { name: m.connections.nav.grants }).getAttribute("aria-current"),
    ).toBe("page");
    expect(await screen.findByText("fixture__delete_item")).toBeTruthy();
    await userEvent.setup().click(
      screen.getByRole("button", {
        name: m.connections.grants.revokeLabel
          .replace("{tool}", "fixture__delete_item")
          .replace("{agent}", "Echo agent"),
      }),
    );
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(await screen.findByText(m.connections.grants.empty)).toBeTruthy();
  });
});
