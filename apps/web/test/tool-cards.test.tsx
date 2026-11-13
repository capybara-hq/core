import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { ApprovalCard } from "../src/components/ApprovalCard";
import { ConnectCard } from "../src/components/ConnectCard";
import { QuestionCard } from "../src/components/QuestionCard";
import type { InputForm, ToolInfo } from "../src/lib/conversations";
import { buildAnswer, initialDraft, OTHER } from "../src/lib/questions";
import type { ApprovalItem, QuestionItem } from "../src/lib/timeline";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME, renderPage, testQueryClient } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const EXPIRES = "2026-10-19T12:00:00.000Z";

const APPROVAL = {
  id: "ap1",
  conversationId: "c1",
  runId: "r1",
  callId: "call_1",
  toolKey: "mcp__fixture__delete_item",
  toolName: "delete_item",
  connector: { id: "app1", name: "Fixture", slug: "fixture" },
  agent: { id: "ag1", name: "Echo agent" },
  input: { id: "x1" },
  requestedFor: "a1",
  scopes: ["once", "session", "always"],
  approverRole: null,
  status: "pending",
  scope: null,
  decidedBy: null,
  decidedAt: null,
  expiresAt: EXPIRES,
  createdAt: EXPIRES,
  conversationPath: "/chat/c1",
  initiatorAccountId: "a1",
};

const INFO: ToolInfo = {
  key: "mcp__fixture__delete_item",
  title: "Delete item",
  kind: "connector",
  sandbox: false,
  keyArgs: ["id"],
  tool: "delete_item",
  source: { kind: "connector", id: "app1", name: "Fixture" },
};

beforeEach(() => resetNavigation("/chat/c1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ApprovalCard (design ApprovalBlock)", () => {
  const item = (decided: ApprovalItem["decided"] = null): ApprovalItem => ({
    approvalId: "ap1",
    callId: "call_1",
    toolKey: "mcp__fixture__delete_item",
    input: { reason: "cleanup", id: "x1" },
    expiresAt: EXPIRES,
    policy: "connector",
    decided,
    decidedAt: decided ? "2026-10-19T10:41:00.000Z" : null,
  });

  it("shows the tool, its key and every argument (key arguments first) and the asking rule", async () => {
    stubApi({ "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL }) });
    const { container } = renderPage(<ApprovalCard orgId="o1" item={item()} info={INFO} />, {
      locale: "zh",
    });
    await screen.findByRole("button", { name: "本会话内都批准" });
    expect(screen.getByText("Fixture [delete_item]")).toBeTruthy();
    expect(screen.getByText("mcp__fixture__delete_item")).toBeTruthy();
    const keys = [...container.querySelectorAll('[data-part="kv-key"]')].map((k) => k.textContent);
    expect(keys).toEqual(["id", "reason"]);
    expect(screen.getByText(zh.approval.policy.connector)).toBeTruthy();
  });

  it("a Platform confirmation shows the operation, the summary in the UI language and only once", async () => {
    const platform = {
      ...APPROVAL,
      toolKey: "Platform:marketplaces.add",
      toolName: "Platform",
      connector: null,
      input: { action: "call", operation: "marketplaces.add", params: { url: "https://x" } },
      summary: { zh: "添加市场源 https://x", en: "Add marketplace source https://x" },
      scopes: ["once"],
    };
    stubApi({ "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: platform }) });
    const platformItem = { ...item(), toolKey: "Platform", input: platform.input };
    const { container } = renderPage(<ApprovalCard orgId="o1" item={platformItem} />, {
      locale: "zh",
    });
    await screen.findByRole("button", { name: "批准" });
    expect(screen.getByText("Platform [marketplaces.add]")).toBeTruthy();
    expect(screen.getByText("添加市场源 https://x")).toBeTruthy();
    expect(container.querySelector('[data-part="summary"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "本会话内都批准" })).toBeNull();
    expect(screen.queryByRole("button", { name: "总是批准" })).toBeNull();
  });

  describe("an approved accounts.create shows its generated password once to the approver", () => {
    const createInput = {
      action: "call",
      operation: "accounts.create",
      params: { login: "alice", displayName: "Alice" },
    };
    const createItem = (byAccountId: string): ApprovalItem => ({
      ...item({
        approvalId: "ap1",
        callId: "call_1",
        decision: "approved",
        scope: "once",
        byAccountId,
      }),
      toolKey: "Platform:accounts.create",
      input: createInput,
    });

    it("the approver reads it on a click; it is shown in a secret field, never fetched before", async () => {
      const calls = stubApi({
        "POST /api/v1/orgs/o1/approvals/ap1/initial-password": () =>
          json(200, { accountId: "acc9", login: "alice", password: "Gen3ratedPassw0rdXyz" }),
      });
      renderPage(<ApprovalCard orgId="o1" item={createItem(ME.account.id)} />, { locale: "zh" });
      const show = await screen.findByRole("button", { name: zh.approval.initialPassword.show });
      expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      await userEvent.setup().click(show);
      const field = await screen.findByLabelText("alice 的初始密码");
      expect((field as HTMLInputElement).value).toBe("Gen3ratedPassw0rdXyz");
      expect(screen.queryByRole("button", { name: zh.approval.initialPassword.show })).toBeNull();
    });

    it("read already: the error says so, the button goes, nothing is shown", async () => {
      stubApi({
        "POST /api/v1/orgs/o1/approvals/ap1/initial-password": () =>
          json(404, {
            error: { code: "account.initial_password_unavailable", message: "No initial password" },
          }),
      });
      renderPage(<ApprovalCard orgId="o1" item={createItem(ME.account.id)} />, { locale: "en" });
      await userEvent
        .setup()
        .click(await screen.findByRole("button", { name: en.approval.initialPassword.show }));
      expect(await screen.findByText(en.errors.account.initial_password_unavailable)).toBeTruthy();
      expect(screen.queryByRole("button", { name: en.approval.initialPassword.show })).toBeNull();
    });

    it("someone else's approval, or another operation, offers nothing", async () => {
      stubApi({});
      renderPage(<ApprovalCard orgId="o1" item={createItem("someone-else")} />, { locale: "en" });
      await screen.findByText(/Approved|approved/);
      expect(screen.queryByRole("button", { name: en.approval.initialPassword.show })).toBeNull();
      cleanup();
      const other = {
        ...createItem(ME.account.id),
        toolKey: "Platform:accounts.disable",
        input: { ...createInput, operation: "accounts.disable" },
      };
      renderPage(<ApprovalCard orgId="o1" item={other} />, { locale: "en" });
      await screen.findByText(/Approved|approved/);
      expect(screen.queryByRole("button", { name: en.approval.initialPassword.show })).toBeNull();
    });
  });

  it.each([
    ["once", "批准"],
    ["session", "本会话内都批准"],
    ["always", "总是批准"],
  ] as const)("approving with scope %s posts it", async (scope, label) => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL }),
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () =>
        json(200, {
          approval: { ...APPROVAL, status: "approved", scope, decidedBy: "a1", decidedAt: EXPIRES },
        }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item()} info={INFO} />, { locale: "zh" });
    await userEvent.setup().click(await screen.findByRole("button", { name: label }));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ decision: "approve", scope });
    expect(await screen.findByText(/你 批准了 Fixture \[delete_item\]/)).toBeTruthy();
  });

  it("a decision in the conversation invalidates the inbox and its count (the inbox list is not left stale)", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL }),
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () =>
        json(200, {
          approval: { ...APPROVAL, status: "approved", scope: "once", decidedBy: "a1" },
        }),
    });
    const client = testQueryClient();
    // the inbox and the sidebar's count are cached (as after a visit to /inbox)
    client.setQueryData(["org", "o1", "inbox"], { items: [] });
    client.setQueryData(["org", "o1", "inboxCount"], { count: 1 });
    renderPage(<ApprovalCard orgId="o1" item={item()} info={INFO} />, { locale: "en", client });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Approve" }));
    await vi.waitFor(() =>
      expect(client.getQueryState(["org", "o1", "inbox"])?.isInvalidated).toBe(true),
    );
    expect(client.getQueryState(["org", "o1", "inboxCount"])?.isInvalidated).toBe(true);
    expect(client.getQueryData(["org", "o1", "approval", "ap1"])).toMatchObject({
      status: "approved",
    });
  });

  it("a role escalation offers only once; deny sends the reason", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, {
          approval: { ...APPROVAL, requestedFor: null, scopes: ["once"], approverRole: "admin" },
        }),
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () =>
        json(200, { approval: { ...APPROVAL, status: "denied", decidedBy: "a1" } }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item()} info={INFO} />, { locale: "en" });
    await screen.findByRole("button", { name: "Approve" });
    expect(screen.queryByRole("button", { name: /for this conversation/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Always/ })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Deny…" }));
    await user.type(screen.getByRole("textbox", { name: "Reason for denying" }), "not now");
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      decision: "deny",
      reason: "not now",
    });
  });

  it.each(["zh", "en"] as const)(
    "a viewer who can't decide (404) only waits (%s)",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      stubApi({
        "GET /api/v1/orgs/o1/approvals/ap1": () =>
          json(404, { error: { code: "approval.not_found", message: "x" } }),
      });
      renderPage(<ApprovalCard orgId="o1" item={item()} info={INFO} />, { locale });
      expect(
        await screen.findByText(
          m.approval.otherApproverFor
            .replace("{tool}", "Fixture [delete_item]")
            .replace("{key}", "mcp__fixture__delete_item"),
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /批准|Approve/ })).toBeNull();
    },
  );

  it("decided (from the log): one line naming who, the key, the scope and the reason", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/members": () =>
        json(200, {
          members: [{ account: { id: "someone", displayName: "李四" }, role: "member" }],
        }),
    });
    renderPage(
      <ApprovalCard
        orgId="o1"
        item={item({
          approvalId: "ap1",
          callId: "call_1",
          decision: "denied",
          byAccountId: "someone",
          reason: "too risky",
        })}
        info={INFO}
      />,
      { locale: "zh", me: ME },
    );
    // the decider's name, read from the member list (the approval itself is not read)
    expect(await screen.findByText(/李四 拒绝了 Fixture \[delete_item\]/)).toBeTruthy();
    expect(screen.getByText(/「too risky」/)).toBeTruthy();
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/orgs/o1/members"]);
  });

  it("a viewer who can't decide is told who is awaited by name", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(404, { error: { code: "approval.not_found", message: "x" } }),
      "GET /api/v1/orgs/o1/members": () =>
        json(200, {
          members: [{ account: { id: "acc_zhang", displayName: "张三" }, role: "member" }],
        }),
    });
    renderPage(
      <ApprovalCard
        orgId="o1"
        item={{ ...item(), approver: { kind: "account", accountId: "acc_zhang" } }}
        info={INFO}
      />,
      { locale: "zh", me: ME },
    );
    expect(
      await screen.findByText(
        "Fixture [delete_item]（mcp__fixture__delete_item）需要审批，等待 张三 处理。",
      ),
    ).toBeTruthy();
  });

  it("an approval escalated by role names the role, without reading the member list", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(404, { error: { code: "approval.not_found", message: "x" } }),
    });
    renderPage(
      <ApprovalCard
        orgId="o1"
        item={{ ...item(), approver: { kind: "role", role: "admin" } }}
        info={INFO}
      />,
      { locale: "en", me: ME },
    );
    expect(
      await screen.findByText(
        "Fixture [delete_item] (mcp__fixture__delete_item) needs approval; waiting for an org admin.",
      ),
    ).toBeTruthy();
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/orgs/o1/approvals/ap1"]);
  });
});

describe("ApprovalCard: a network ask (network ask spec §6.5)", () => {
  const NET = {
    ...APPROVAL,
    toolKey: "Bash",
    toolName: "Bash",
    connector: null,
    input: { command: "npm install" },
    kind: "network",
    scopes: ["once", "always"],
    detail: {
      deviceId: "d1",
      hosts: [
        { host: "registry.npmjs.org", port: 443 },
        { host: "files.slack.com.evil.io", port: 443 },
      ],
      command: "npm install",
      description: "Install the dependencies",
    },
  };
  const netItem = (decided: ApprovalItem["decided"] = null): ApprovalItem => ({
    approvalId: "ap1",
    callId: "call_1",
    toolKey: "Bash",
    input: { command: "npm install", description: "Install the dependencies" },
    expiresAt: EXPIRES,
    network: { hosts: ["registry.npmjs.org", "files.slack.com.evil.io"] },
    decided,
    decidedAt: decided ? "2026-10-19T10:41:00.000Z" : null,
  });

  it("asks for the hosts and posts the checked ones with the scope", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: NET }),
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () =>
        json(200, {
          approval: {
            ...NET,
            status: "approved",
            scope: "once",
            decidedBy: ME.account.id,
            decidedAt: EXPIRES,
            detail: { ...NET.detail, grantedHosts: ["registry.npmjs.org"], outcome: "once" },
          },
        }),
    });
    const { container } = renderPage(<ApprovalCard orgId="o1" item={netItem()} />, {
      locale: "zh",
    });
    const once = await screen.findByRole("button", { name: "这次允许" });
    expect(once.getAttribute("data-variant")).toBe("primary");
    expect(screen.getByRole("button", { name: "这台设备一直允许" })).toBeTruthy();
    expect(
      screen.getByText("这条命令被这台设备的网络规则拦下了：Install the dependencies"),
    ).toBeTruthy();
    // the registrable domain is prominent: a lookalike shows evil.io
    const registrable = [...container.querySelectorAll('[data-part="registrable"]')].map(
      (e) => e.textContent,
    );
    expect(registrable).toEqual(["npmjs.org", "evil.io"]);
    // no tool policy note on a network ask
    expect(container.querySelector('[data-part="card-note"]')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "files.slack.com.evil.io" }));
    await user.click(once);
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      decision: "approve",
      scope: "once",
      hosts: ["registry.npmjs.org"],
    });
    expect(await screen.findByText(/已允许（这次）/)).toBeTruthy();
  });

  it("a device that takes no remote grants offers only this time, with the device command", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, { approval: { ...NET, scopes: ["once"] } }),
    });
    const { container } = renderPage(<ApprovalCard orgId="o1" item={netItem()} />, {
      locale: "en",
    });
    await screen.findByRole("button", { name: "Allow this time" });
    expect(screen.queryByRole("button", { name: "Always allow on this device" })).toBeNull();
    expect(container.querySelector('[data-part="network-remote-off"]')?.textContent).toContain(
      "capybara-device policy add allowedDomains",
    );
  });

  it("decided from the log, it reads the approval for the fallback from always to this time", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, {
          approval: {
            ...NET,
            status: "approved",
            scope: "always",
            decidedBy: ME.account.id,
            decidedAt: EXPIRES,
            detail: {
              ...NET.detail,
              grantedHosts: ["registry.npmjs.org", "files.slack.com.evil.io"],
              outcome: "once_fallback",
              fallback: "offline",
            },
          },
        }),
    });
    renderPage(
      <ApprovalCard
        orgId="o1"
        item={netItem({
          approvalId: "ap1",
          callId: "call_1",
          decision: "approved",
          scope: "always",
          byAccountId: ME.account.id,
        })}
      />,
      { locale: "zh", me: ME },
    );
    expect(await screen.findByText(/设备离线，已按这次允许/)).toBeTruthy();
    expect(screen.getByText(/已允许（这次）/)).toBeTruthy();
  });

  it("the card shows why the device change was not confirmed", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, {
          approval: {
            ...NET,
            detail: { ...NET.detail, attempt: { outcome: "unknown", message: "x" } },
          },
        }),
    });
    renderPage(<ApprovalCard orgId="o1" item={netItem()} />, { locale: "zh" });
    expect(await screen.findByText(zh.approval.network.attempt.unknown)).toBeTruthy();
    // still pending: the owner may decide again
    expect(screen.getByRole("button", { name: "这台设备一直允许" })).toBeTruthy();
    cleanup();
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, {
          approval: {
            ...NET,
            detail: {
              ...NET.detail,
              attempt: { outcome: "failed", message: "Remote grants are off." },
            },
          },
        }),
    });
    renderPage(<ApprovalCard orgId="o1" item={netItem()} />, { locale: "en" });
    expect(
      await screen.findByText(
        en.approval.network.attempt.failed.replace("{message}", "Remote grants are off."),
      ),
    ).toBeTruthy();
    cleanup();
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, {
          approval: {
            ...NET,
            detail: { ...NET.detail, attempt: { outcome: "applied_undecided", message: "x" } },
          },
        }),
    });
    renderPage(<ApprovalCard orgId="o1" item={netItem()} />, { locale: "zh" });
    expect(await screen.findByText(zh.approval.network.attempt.appliedUndecided)).toBeTruthy();
  });

  it("skipped: one line", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, { approval: { ...NET, status: "skipped", decidedBy: ME.account.id } }),
    });
    renderPage(
      <ApprovalCard
        orgId="o1"
        item={netItem({
          approvalId: "ap1",
          callId: "call_1",
          decision: "skipped",
          byAccountId: ME.account.id,
        })}
      />,
      { locale: "en", me: ME },
    );
    expect(await screen.findByText(/^Skipped/)).toBeTruthy();
  });

  it("a viewer who is not the device owner (404) only waits", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(404, { error: { code: "approval.not_found", message: "x" } }),
    });
    renderPage(<ApprovalCard orgId="o1" item={netItem()} />, { locale: "zh" });
    expect(
      await screen.findByText(
        "智能体想访问 registry.npmjs.org, files.slack.com.evil.io，等待设备所有者处理。",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "这次允许" })).toBeNull();
  });
});

describe("QuestionCard (design QuestionBlock)", () => {
  const FORM: InputForm = {
    title: { zh: "部署选项", en: "Deploy options" },
    fields: [
      {
        key: "env",
        label: { zh: "环境", en: "Environment" },
        schema: { type: "string", enum: ["staging", "prod"] },
        allowOther: true,
        required: true,
      },
      { key: "notify", label: { zh: "通知", en: "Notify" }, schema: { type: "boolean" } },
      { key: "note", label: { en: "Note" } as never, schema: { type: "string" } },
    ],
  };
  const item = (answered: QuestionItem["answered"] = null): QuestionItem => ({
    questionId: "q1",
    callId: "call_1",
    form: FORM,
    expiresAt: EXPIRES,
    answered,
  });

  it("options with Other, a switch and text; required is checked; Answer posts", async () => {
    const calls = stubApi({
      "POST /api/v1/orgs/o1/questions/q1/answer": () =>
        json(200, { question: { id: "q1", status: "answered" } }),
    });
    renderPage(<QuestionCard orgId="o1" item={item()} />, { locale: "en" });
    expect(screen.getByText("Deploy options")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Answer" }));
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole("radio", { name: "prod" }));
    await user.click(screen.getByRole("switch", { name: "Notify" }));
    await user.type(screen.getByRole("textbox", { name: "Note" }), "hello");
    await user.click(screen.getByRole("button", { name: "Answer" }));
    expect(bodyOf(calls[0])).toEqual({ answer: { env: "prod", notify: true, note: "hello" } });
    expect(await screen.findByText(/prod/)).toBeTruthy();
  });

  it("answered from the log collapses to question and answer; expired says so", () => {
    renderPage(
      <QuestionCard
        orgId="o1"
        item={item({
          questionId: "q1",
          callId: "call_1",
          answer: { env: "prod", notify: false },
          byAccountId: "a1",
          outcome: "answered",
        })}
      />,
      { locale: "zh" },
    );
    expect(screen.getByText("环境：prod")).toBeTruthy();
    expect(screen.getByText("通知：否")).toBeTruthy();
    cleanup();
    renderPage(
      <QuestionCard
        orgId="o1"
        item={item({
          questionId: "q1",
          callId: "call_1",
          answer: null,
          byAccountId: null,
          outcome: "expired",
        })}
      />,
      { locale: "zh" },
    );
    expect(screen.getByText("已过期")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "回答" })).toBeNull();
  });

  it("skipped by a message reads as skipped by the viewer; cancelled reads as cancelled, not skipped", () => {
    const done = (outcome: "skipped" | "cancelled", byAccountId: string | null) =>
      item({
        questionId: "q1",
        callId: "call_1",
        answer: null,
        byAccountId,
        outcome,
        ...(outcome === "skipped" ? { skippedBySeq: 9 } : {}),
      });
    const state = (c: HTMLElement) =>
      c.querySelector('[data-part="question-done"]')?.getAttribute("data-state");
    const zhSkip = renderPage(<QuestionCard orgId="o1" item={done("skipped", ME.account.id)} />, {
      locale: "zh",
    });
    expect(state(zhSkip.container)).toBe("skipped");
    expect(zhSkip.container.textContent).toContain("已跳过：直接回复了消息 · 你");
    cleanup();
    const enSkip = renderPage(<QuestionCard orgId="o1" item={done("skipped", ME.account.id)} />, {
      locale: "en",
    });
    expect(enSkip.container.textContent).toContain("Skipped: replied with a message · You");
    cleanup();
    const zhCancel = renderPage(<QuestionCard orgId="o1" item={done("cancelled", null)} />, {
      locale: "zh",
    });
    expect(state(zhCancel.container)).toBe("cancelled");
    expect(zhCancel.container.textContent).toContain("已取消");
    expect(zhCancel.container.textContent).not.toContain("已跳过");
    expect(screen.queryByRole("button", { name: "回答" })).toBeNull();
  });

  it("URL elicitation: the full address as a link in a new window, then I'm done answers", async () => {
    const calls = stubApi({
      "POST /api/v1/orgs/o1/questions/q1/answer": () =>
        json(200, { question: { id: "q1", status: "answered" } }),
    });
    const url = "https://auth.example.com/connect?state=abc";
    renderPage(
      <QuestionCard
        orgId="o1"
        item={{ ...item(), form: { title: "Connect your account", url, fields: [] } }}
      />,
      { locale: "en" },
    );
    const link = screen.getByRole("link", { name: url });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Open link" }));
    await user.click(screen.getByRole("button", { name: "I'm done" }));
    expect(bodyOf(calls[0])).toEqual({ answer: {} });
  });

  it("a url that isn't http(s) is never linked", () => {
    renderPage(
      <QuestionCard
        orgId="o1"
        item={{
          ...item(),
          form: { title: "Bad", url: "javascript:alert(1)", fields: [] },
        }}
      />,
      { locale: "en" },
    );
    expect(screen.queryByText("javascript:alert(1)")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("buildAnswer: Other in a multi select becomes the text; Other without text is missing", () => {
    const form: InputForm = {
      title: "x",
      fields: [
        {
          key: "env",
          label: "env",
          schema: { type: "string", enum: ["a"] },
          allowOther: true,
          required: true,
        },
        {
          key: "regions",
          label: "r",
          schema: { type: "string", enum: ["us"] },
          multiSelect: true,
          allowOther: true,
        },
      ],
    };
    const draft = initialDraft(form);
    draft.values.env = OTHER;
    draft.values.regions = ["us", OTHER];
    draft.other.regions = "apac";
    expect(buildAnswer(form, draft)).toEqual({
      answer: { regions: ["us", "apac"] },
      missing: ["env"],
    });
  });
});

describe("ConnectCard (design ConnectBlock)", () => {
  it.each(["zh", "en"] as const)(
    "a static-credential connector: Connect goes to the personal connections page (%s)",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      stubApi({
        "GET /api/v1/orgs/o1/connectors/app2": () =>
          json(200, {
            connector: { id: "app2", auth: { type: "bearer", ownership: "personal" } },
          }),
      });
      renderPage(
        <ConnectCard
          orgId="o1"
          item={{ callId: "c", connectorId: "app2", connectorName: "GitHub", closed: false }}
        />,
        { locale },
      );
      expect(screen.getByText(m.connect.description.replace("{connector}", "GitHub"))).toBeTruthy();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: locale === "zh" ? "连接" : "Connect" }));
      await vi.waitFor(() =>
        expect(router.push).toHaveBeenCalledWith("/account/connections#connector-app2"),
      );
    },
  );

  it("after the run ended only the explanation stays", () => {
    renderPage(
      <ConnectCard
        orgId="o1"
        item={{ callId: "c", connectorId: "app2", connectorName: "GitHub", closed: true }}
      />,
      { locale: "en" },
    );
    expect(screen.getByText(en.connect.ended.replace("{connector}", "GitHub"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });
});

describe("the approval block lists every scope only when allowed", () => {
  it("within one group, each scope is a button", async () => {
    stubApi({ "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL }) });
    renderPage(
      <ApprovalCard
        orgId="o1"
        item={{
          approvalId: "ap1",
          callId: "call_1",
          toolKey: "mcp__fixture__delete_item",
          input: {},
          expiresAt: EXPIRES,
          decided: null,
          decidedAt: null,
        }}
      />,
      { locale: "en" },
    );
    const group = await screen.findByRole("group", { name: "Approval needed" });
    await within(group).findByRole("button", { name: "Approve" });
    expect(within(group).getAllByRole("button").length).toBeGreaterThanOrEqual(4);
  });
});

describe("QuestionCard: a single choice question", () => {
  it("shows AskUserQuestion's question as the title (the field draws no label of its own)", () => {
    renderPage(
      <QuestionCard
        orgId="o1"
        item={{
          questionId: "q2",
          callId: "c",
          expiresAt: EXPIRES,
          answered: null,
          form: {
            title: "Env",
            fields: [
              {
                key: "q0",
                label: "Which environment?",
                schema: { type: "string", enum: ["staging", "prod"] },
                allowOther: true,
                required: true,
              },
            ],
          },
        }}
      />,
      { locale: "en" },
    );
    expect(screen.getByText("Which environment?")).toBeTruthy();
  });
});
