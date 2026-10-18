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
  app: { id: "app1", name: "Fixture", slug: "fixture" },
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

const LIST = "GET /api/v1/orgs/o1/approvals?status=pending";

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
      stubApi({ [LIST]: () => json(200, { approvals: [approval("a"), approval("b")] }) });
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
      [LIST]: () => json(200, { approvals: pending }),
      "POST /api/v1/orgs/o1/approvals/b/decision": () => {
        pending = pending.filter((a) => a.id !== "b");
        return json(200, { approval: { ...approval("b"), status: "approved", scope: "always" } });
      },
    });
    const { container } = renderPage(<InboxRoute />, { locale });
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
    expect(calls.filter((c) => c.url.endsWith("status=pending"))).toHaveLength(2);
    expect(await screen.findByText(m.inbox.approved)).toBeTruthy();
  });

  it("已被别人处理：toast 显示 approval.already_decided 的文案并重读", async () => {
    stubApi({
      [LIST]: () => json(200, { approvals: [approval("a")] }),
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
    stubApi({ [LIST]: () => json(200, { approvals: [] }) });
    renderPage(<InboxRoute />, { locale });
    expect(await screen.findByText(m.inbox.empty)).toBeTruthy();
    expect(screen.queryByRole("button", { name: m.approval.approve })).toBeNull();
  });

  it("按角色升级的审批只有「仅本次」", async () => {
    stubApi({
      [LIST]: () =>
        json(200, { approvals: [approval("a", { requestedFor: null, approverRole: "admin" })] }),
    });
    renderPage(<InboxRoute />);
    const scopes = await screen.findByRole("radiogroup", { name: en.approval.scopeLabel });
    expect(within(scopes).getAllByRole("radio")).toHaveLength(1);
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
