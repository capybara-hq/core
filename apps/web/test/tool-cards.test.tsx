import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ChatPage from "../src/app/[locale]/(app)/chat/[conversationId]/page";
import { ApprovalCard } from "../src/components/ApprovalCard";
import { ConnectCard } from "../src/components/ConnectCard";
import { QuestionCard } from "../src/components/QuestionCard";
import { RESULT_PREVIEW_CHARS, ToolCallCard } from "../src/components/ToolCallCard";
import type { ConversationEvent, InputForm } from "../src/lib/conversations";
import { buildAnswer, initialDraft, OTHER } from "../src/lib/questions";
import { type ChatItem, chatItems, initialChatState, reduceChat } from "../src/lib/stream";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ conversationId: "c1" }) }));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;

function ev(seq: number, type: string, payload: unknown, runId: string | null = "r1") {
  return {
    conversationId: "c1",
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(seq * 1000).toISOString(),
  } as ConversationEvent;
}

const toolCall = (seq: number, id: string, name: string, input: unknown, text = "") =>
  ev(seq, "assistant_message", {
    step: 0,
    content: [
      ...(text === "" ? [] : [{ type: "text", text }]),
      { type: "tool_call", id, name, input },
    ],
    stopReason: "tool_use",
  });

const itemsOf = (events: ConversationEvent[]) =>
  chatItems(reduceChat(initialChatState, { kind: "events", events }));

const EXPIRES = "2026-10-19T12:00:00.000Z";

const APPROVAL = {
  id: "ap1",
  conversationId: "c1",
  runId: "r1",
  callId: "call_1",
  toolKey: "fixture__delete_item",
  toolName: "delete_item",
  app: { id: "app1", name: "Fixture", slug: "fixture" },
  agent: { id: "ag1", name: "Echo agent" },
  input: { id: "x1" },
  requestedFor: "a1",
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

beforeEach(() => resetNavigation("/chat/c1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("chatItems：工具调用、审批、输入请求、需要连接", () => {
  it("只有工具调用的 assistant 消息不单独成卡；工具项随 started / result 更新", () => {
    const items = itemsOf([
      ev(
        1,
        "user_message",
        { content: [{ type: "text", text: "go" }], authorAccountId: "a1" },
        null,
      ),
      ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }),
      toolCall(3, "call_1", "fixture__delete_item", { id: "x1" }),
      ev(4, "approval_requested", {
        step: 0,
        callId: "call_1",
        approvalId: "ap1",
        toolKey: "fixture__delete_item",
        expiresAt: EXPIRES,
      }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "approval"]);
    const tool = items[1] as Extract<ChatItem, { kind: "tool" }>;
    expect(tool.status).toBe("pending");
    const approval = items[2] as Extract<ChatItem, { kind: "approval" }>;
    expect(approval.input).toEqual({ id: "x1" });
    expect(approval.decided).toBeNull();

    const after = itemsOf([
      ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }),
      toolCall(3, "call_1", "fixture__delete_item", { id: "x1" }, "Deleting"),
      ev(4, "approval_requested", {
        step: 0,
        callId: "call_1",
        approvalId: "ap1",
        toolKey: "fixture__delete_item",
        expiresAt: EXPIRES,
      }),
      ev(5, "approval_decided", {
        approvalId: "ap1",
        callId: "call_1",
        decision: "approved",
        scope: "once",
        byAccountId: "a1",
      }),
      ev(6, "tool_call_started", { step: 0, callId: "call_1", toolKey: "k", specHash: "h" }),
      ev(7, "tool_result", {
        step: 0,
        callId: "call_1",
        toolKey: "k",
        content: "deleted x1",
        isError: false,
        outputId: "out_1",
      }),
    ]);
    expect(after.map((i) => i.kind)).toEqual(["assistant", "tool", "approval"]);
    expect(after[1]).toMatchObject({ status: "done", result: "deleted x1", outputId: "out_1" });
    expect(after[2]).toMatchObject({ decided: { decision: "approved", scope: "once" } });
  });

  it("运行结束仍无结果的调用标为 cancelled；question 与 connect 按位置插入并回填回答", () => {
    const form: InputForm = {
      title: "Pick",
      fields: [{ key: "c", label: "C", schema: { type: "boolean" } }],
    };
    const items = itemsOf([
      ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }),
      toolCall(3, "call_1", "ask_user", {}),
      ev(4, "question_asked", {
        step: 0,
        callId: "call_1",
        questionId: "q1",
        form,
        expiresAt: EXPIRES,
      }),
      ev(5, "question_answered", {
        questionId: "q1",
        callId: "call_1",
        answer: { c: true },
        byAccountId: "a1",
        outcome: "answered",
      }),
      toolCall(6, "call_2", "github__list", {}),
      ev(7, "connection_required", { step: 1, callId: "call_2", appId: "app2", appName: "GitHub" }),
      ev(8, "run_aborted", { byAccountId: "a1", reason: "user" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["tool", "question", "tool", "connect"]);
    expect(items[1]).toMatchObject({ answered: { outcome: "answered", answer: { c: true } } });
    expect(items[0]).toMatchObject({ status: "cancelled" });
    expect(items[3]).toMatchObject({ appId: "app2", appName: "GitHub", closed: true });
  });

  it("approval_requested / question_asked 使运行进入 waiting（不是 running），处理后恢复", () => {
    let s = reduceChat(initialChatState, {
      kind: "events",
      events: [
        ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }),
        ev(3, "approval_requested", {
          step: 0,
          callId: "c",
          approvalId: "ap1",
          toolKey: "k",
          expiresAt: EXPIRES,
        }),
      ],
    });
    expect({ running: s.running, waiting: s.waiting }).toEqual({ running: false, waiting: true });
    s = reduceChat(s, {
      kind: "events",
      events: [
        ev(4, "approval_decided", {
          approvalId: "ap1",
          callId: "c",
          decision: "denied",
          byAccountId: "a1",
        }),
      ],
    });
    expect({ running: s.running, waiting: s.waiting }).toEqual({ running: true, waiting: false });
  });
});

describe("ToolCallCard", () => {
  const item = (over: Partial<Extract<ChatItem, { kind: "tool" }>> = {}) =>
    ({
      kind: "tool",
      key: "k",
      callId: "call_1",
      name: "fixture__search",
      input: { q: "capybara" },
      status: "done",
      result: "3 results",
      outputId: null,
      ...over,
    }) as Extract<ChatItem, { kind: "tool" }>;

  it.each(LOCALES)(
    "时间线一行，默认折叠；展开显示 IN（参数 JSON）与 OUT（结果）（%s）",
    async (locale) => {
      renderPage(<ToolCallCard item={item()} />, { locale });
      const row = screen.getByRole("button", { name: /fixture__search/ });
      const card = row.closest("[data-role]");
      expect(card?.getAttribute("data-role")).toBe("tool");
      expect(card?.getAttribute("data-status")).toBe("done");
      // 没有显示摘要：退回输入的前几个字段
      expect(within(row).getByText("q: capybara")).toBeTruthy();
      expect(row.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText("3 results")).toBeNull();
      await userEvent.setup().click(row);
      expect(row.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText(/"q": "capybara"/).textContent).toBe(
        JSON.stringify({ q: "capybara" }, null, 2),
      );
      expect(screen.getByText("3 results")).toBeTruthy();
    },
  );

  it.each(LOCALES)("超长结果只显示预览并给出存档 id；失败显示 ✗（%s）", async (locale) => {
    const m = msgs[locale];
    const long = "x".repeat(RESULT_PREVIEW_CHARS + 10);
    renderPage(<ToolCallCard item={item({ status: "error", result: long, outputId: "out_9" })} />, {
      locale,
    });
    expect(screen.getByText(`✗ ${m.tools.status.error}`)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: /fixture__search/ }));
    expect(screen.getByText("x".repeat(RESULT_PREVIEW_CHARS))).toBeTruthy();
    expect(screen.getByText(m.tools.outputId.replace("{id}", "out_9"))).toBeTruthy();
  });

  it.each(LOCALES)("等待审批的调用显示「等待中」（%s）", (locale) => {
    const m = msgs[locale];
    renderPage(<ToolCallCard item={item({ status: "pending", result: null })} />, { locale });
    expect(screen.getByText(`● ${m.tools.status.pending}`)).toBeTruthy();
  });
});

describe("ApprovalCard", () => {
  const item = (decided: Extract<ChatItem, { kind: "approval" }>["decided"] = null) =>
    ({
      kind: "approval",
      key: "e4",
      approvalId: "ap1",
      callId: "call_1",
      toolKey: "fixture__delete_item",
      input: { id: "x1" },
      expiresAt: EXPIRES,
      decided,
    }) as Extract<ChatItem, { kind: "approval" }>;

  it.each(LOCALES)(
    "工具名、应用、参数、三种范围；选「本会话内」批准 → POST decision（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL }),
        "POST /api/v1/orgs/o1/approvals/ap1/decision": () =>
          json(200, {
            approval: { ...APPROVAL, status: "approved", scope: "session", decidedBy: "a1" },
          }),
      });
      renderPage(<ApprovalCard orgId="o1" item={item()} />, { locale });
      expect(await screen.findByText("Fixture")).toBeTruthy();
      expect(screen.getByText("delete_item")).toBeTruthy();
      expect(screen.getByText(m.approval.title)).toBeTruthy();
      expect(screen.getByLabelText(m.approval.input)).toHaveProperty(
        "value",
        JSON.stringify({ id: "x1" }, null, 2),
      );
      const scopes = screen.getByRole("radiogroup", { name: m.approval.scopeLabel });
      expect(within(scopes).getAllByRole("radio")).toHaveLength(3);
      const user = userEvent.setup();
      await user.click(within(scopes).getByLabelText(new RegExp(m.approval.scope.session)));
      await user.click(screen.getByRole("button", { name: m.approval.approve }));
      const post = calls.find((c) => c.method === "POST");
      expect(bodyOf(post)).toEqual({ decision: "approve", scope: "session" });
      expect(post?.headers.get("x-capybara-csrf")).toBe("1");
      expect(await screen.findByText(`✓ ${m.approval.decision.approved}`)).toBeTruthy();
      expect(screen.getByText(m.approval.decidedBy.replace("{who}", m.approval.you))).toBeTruthy();
      expect(screen.queryByRole("button", { name: m.approval.approve })).toBeNull();
    },
  );

  it("按角色升级的审批只有「仅本次」；拒绝不带 scope", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, { approval: { ...APPROVAL, requestedFor: null, approverRole: "admin" } }),
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () =>
        json(200, { approval: { ...APPROVAL, status: "denied", decidedBy: "a1" } }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item()} />);
    const scopes = await screen.findByRole("radiogroup", { name: en.approval.scopeLabel });
    expect(within(scopes).getAllByRole("radio")).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole("button", { name: en.approval.deny }));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ decision: "deny" });
    expect(await screen.findByText(`✗ ${en.approval.decision.denied}`)).toBeTruthy();
  });

  it.each(LOCALES)("当前用户不能处理（404）：只显示等待审批人（%s）", async (locale) => {
    const m = msgs[locale];
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(404, { error: { code: "approval.not_found", message: "x" } }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item()} />, { locale });
    expect(await screen.findByText(m.approval.otherApprover)).toBeTruthy();
    expect(screen.getByText("fixture__delete_item")).toBeTruthy();
    expect(screen.queryByRole("button", { name: m.approval.approve })).toBeNull();
  });

  it.each(LOCALES)("已处理（事件回填）：显示结果、范围与处理人，不再请求详情（%s）", (locale) => {
    const m = msgs[locale];
    const calls = stubApi({});
    renderPage(
      <ApprovalCard
        orgId="o1"
        item={item({
          approvalId: "ap1",
          callId: "call_1",
          decision: "approved",
          scope: "always",
          byAccountId: "someone",
        })}
      />,
      { locale, me: ME },
    );
    expect(screen.getByText(`✓ ${m.approval.decision.approved}`)).toBeTruthy();
    expect(screen.getByText(m.approval.scope.always)).toBeTruthy();
    expect(screen.getByText(m.approval.decidedBy.replace("{who}", "someone"))).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

describe("QuestionCard（通用 InputForm 渲染器）", () => {
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
      {
        key: "regions",
        label: "Regions",
        schema: { type: "string", enum: ["us", "eu"] },
        multiSelect: true,
        allowOther: true,
      },
      { key: "notify", label: { zh: "通知", en: "Notify" }, schema: { type: "boolean" } },
      {
        key: "replicas",
        label: { zh: "副本数", en: "Replicas" },
        schema: { type: "integer", minimum: 1, maximum: 5 },
      },
      { key: "note", label: { en: "Note" } as never, schema: { type: "string" } },
    ],
  };

  const item = (answered: Extract<ChatItem, { kind: "question" }>["answered"] = null) =>
    ({
      kind: "question",
      key: "e5",
      questionId: "q1",
      callId: "call_1",
      form: FORM,
      expiresAt: EXPIRES,
      answered,
    }) as Extract<ChatItem, { kind: "question" }>;

  it.each(LOCALES)(
    "枚举 → 单选（含「其他」+ 输入框），多选 → 复选框组，布尔 → 开关，带范围数字 → 滑块，字符串 → 输入框（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        "POST /api/v1/orgs/o1/questions/q1/answer": () =>
          json(200, { question: { id: "q1", status: "answered" } }),
      });
      renderPage(<QuestionCard orgId="o1" item={item()} />, { locale });
      // 标题与标签取当前语言；纯字符串原样；缺当前语言回退 en
      expect(screen.getByText(locale === "zh" ? "部署选项" : "Deploy options")).toBeTruthy();
      const env = screen.getByRole("radiogroup", {
        name: locale === "zh" ? "环境" : "Environment",
      });
      expect(within(env).getAllByRole("radio")).toHaveLength(3);
      const regions = screen.getByRole("group", { name: "Regions" });
      expect(within(regions).getAllByRole("checkbox")).toHaveLength(3);
      const notify = screen.getByRole("switch", { name: locale === "zh" ? "通知" : "Notify" });
      expect(
        screen.getByRole("slider", { name: locale === "zh" ? "副本数" : "Replicas" }),
      ).toBeTruthy();
      const note = screen.getByRole("textbox", { name: "Note" });

      const user = userEvent.setup();
      // 必填未填：显示错误，不提交
      await user.click(screen.getByRole("button", { name: m.question.submit }));
      expect(screen.getByText(`✗ ${m.question.fieldRequired}`)).toBeTruthy();
      expect(calls).toHaveLength(0);

      await user.click(within(env).getByLabelText(m.question.other));
      await user.type(
        screen.getByRole("textbox", {
          name: m.question.otherLabel.replace("{field}", locale === "zh" ? "环境" : "Environment"),
        }),
        "qa",
      );
      await user.click(within(regions).getByLabelText("eu"));
      await user.click(notify);
      await user.type(note, "hello");
      await user.click(screen.getByRole("button", { name: m.question.submit }));
      expect(bodyOf(calls[0])).toEqual({
        answer: { env: "qa", regions: ["eu"], notify: true, note: "hello" },
      });
      // 提交后显示答案摘要
      expect(await screen.findByText(`✓ ${m.question.outcome.answered}`)).toBeTruthy();
      expect(screen.getByText("qa")).toBeTruthy();
    },
  );

  it.each(LOCALES)("已回答（事件回填）显示答案；过期显示状态与说明（%s）", (locale) => {
    const m = msgs[locale];
    renderPage(
      <QuestionCard
        orgId="o1"
        item={item({
          questionId: "q1",
          callId: "call_1",
          answer: { env: "prod", regions: ["us", "eu"], notify: false },
          byAccountId: "a1",
          outcome: "answered",
        })}
      />,
      { locale },
    );
    expect(screen.getByText(`us${m.question.separator}eu`)).toBeTruthy();
    expect(screen.getByText(m.question.no)).toBeTruthy();
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
      { locale },
    );
    expect(screen.getByText(`⊘ ${m.question.outcome.expired}`)).toBeTruthy();
    expect(screen.getByText(m.question.outcomeHint.expired)).toBeTruthy();
    expect(screen.queryByRole("button", { name: m.question.submit })).toBeNull();
  });

  it.each(LOCALES)(
    "URL 模式（MCP elicitation）：显示完整链接与「打开链接」（新窗口、noopener），确认「已完成」后提交（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        "POST /api/v1/orgs/o1/questions/q1/answer": () =>
          json(200, { question: { id: "q1", status: "answered" } }),
      });
      const open = vi.fn();
      vi.stubGlobal("open", open);
      const url = "https://auth.example.com/connect?state=abc";
      renderPage(
        <QuestionCard
          orgId="o1"
          item={{
            ...item(),
            form: {
              title: "Connect your account",
              url,
              fields: [
                {
                  key: "completed",
                  label: { en: "I have completed this step", zh: "我已完成这一步" },
                  schema: { type: "boolean" },
                  required: true,
                },
              ],
            },
          }}
        />,
        { locale },
      );
      expect(screen.getByText(url)).toBeTruthy();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: m.question.openLink }));
      expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
      await user.click(
        screen.getByRole("switch", {
          name: locale === "zh" ? "我已完成这一步" : "I have completed this step",
        }),
      );
      await user.click(screen.getByRole("button", { name: m.question.submit }));
      expect(bodyOf(calls[0])).toEqual({ answer: { completed: true } });
    },
  );

  it("url 不是 http(s)（如 javascript:）→ 不显示链接也不能打开", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    renderPage(
      <QuestionCard
        orgId="o1"
        item={{
          ...item(),
          form: {
            title: "Bad",
            url: "javascript:alert(1)",
            fields: [{ key: "completed", label: "Done", schema: { type: "boolean" } }],
          },
        }}
      />,
      { locale: "en" },
    );
    expect(screen.queryByText("javascript:alert(1)")).toBeNull();
    expect(screen.queryByRole("button", { name: en.question.openLink })).toBeNull();
  });

  it("buildAnswer：多选里的「其他」换成文本；选了「其他」没写文本算未填", () => {
    const draft = initialDraft(FORM);
    expect(draft.values).toEqual({ regions: [], notify: false });
    draft.values.env = OTHER;
    draft.values.regions = ["us", OTHER];
    draft.other.regions = "apac";
    expect(buildAnswer(FORM, draft)).toEqual({
      answer: { regions: ["us", "apac"], notify: false },
      missing: ["env"],
    });
  });
});

describe("ConnectCard", () => {
  it.each(LOCALES)("静态凭据应用：「连接」跳到个人连接页填 token（%s）", async (locale) => {
    const m = msgs[locale];
    renderPage(
      <ConnectCard
        orgId="o1"
        item={{
          kind: "connect",
          key: "e7",
          callId: "c",
          appId: "app2",
          appName: "GitHub",
          closed: false,
        }}
      />,
      { locale },
    );
    stubApi({
      "GET /api/v1/orgs/o1/apps/app2": () =>
        json(200, {
          app: { id: "app2", auth: { type: "bearer", ownership: "personal" } },
        }),
    });
    expect(screen.getByText(m.connect.description.replace("{app}", "GitHub"))).toBeTruthy();
    const connect = screen.getByRole("button", { name: m.connect.action });
    expect(connect.getAttribute("data-variant")).not.toBe("primary");
    await userEvent.setup().click(connect);
    await vi.waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/settings/connections#app-app2"),
    );
  });

  it.each(LOCALES)("所在运行已结束：只显示说明，没有「连接」与待处理状态（%s）", (locale) => {
    const m = msgs[locale];
    renderPage(
      <ConnectCard
        orgId="o1"
        item={{
          kind: "connect",
          key: "e7",
          callId: "c",
          appId: "app2",
          appName: "GitHub",
          closed: true,
        }}
      />,
      { locale },
    );
    expect(screen.getByText(m.connect.ended.replace("{app}", "GitHub"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: m.connect.action })).toBeNull();
    expect(screen.queryByText(`‖ ${m.connect.status}`)).toBeNull();
  });
});

describe("对话页里的工具与审批", () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readonly listeners = new Map<string, ((e: Event) => void)[]>();
    readyState = 1;
    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
    }
    addEventListener(type: string, fn: (e: Event) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    close() {
      this.readyState = 2;
    }
    emit(type: string, data: unknown) {
      const e = new MessageEvent(type, { data: JSON.stringify(data) });
      for (const fn of this.listeners.get(type) ?? []) fn(e);
    }
  }

  it.each(LOCALES)(
    "等待审批：状态为「等你处理」、卡片在消息列表中；事件流送来决定后卡片更新（%s）",
    async (locale) => {
      const m = msgs[locale];
      vi.stubGlobal("EventSource", FakeEventSource);
      FakeEventSource.instances = [];
      stubApi({
        "GET /api/v1/orgs/o1/conversations/c1/events": () =>
          json(200, {
            events: [
              ev(
                1,
                "user_message",
                { content: [{ type: "text", text: "go" }], authorAccountId: "a1" },
                null,
              ),
              ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }),
              toolCall(3, "call_1", "fixture__delete_item", { id: "x1" }),
              ev(4, "approval_requested", {
                step: 0,
                callId: "call_1",
                approvalId: "ap1",
                toolKey: "fixture__delete_item",
                expiresAt: EXPIRES,
              }),
            ],
          }),
        "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL }),
      });
      renderPage(<ChatPage />, { locale });
      const log = await screen.findByRole("log");
      expect(await within(log).findByText(m.approval.title)).toBeTruthy();
      expect(within(log).getByRole("button", { name: /fixture__delete_item/ })).toBeTruthy();
      const inspector = screen.getByRole("complementary");
      expect(within(inspector).getByText(`‖ ${m.chat.waiting}`)).toBeTruthy();
      // 等待时也可以停止
      expect(within(inspector).getByRole("button", { name: m.chat.stop })).toBeTruthy();

      act(() => {
        FakeEventSource.instances[0]?.emit(
          "event",
          ev(5, "approval_decided", {
            approvalId: "ap1",
            callId: "call_1",
            decision: "approved",
            scope: "once",
            byAccountId: "a1",
          }),
        );
      });
      expect(within(log).getByText(`✓ ${m.approval.decision.approved}`)).toBeTruthy();
      expect(within(inspector).getByText(`● ${m.chat.running}`)).toBeTruthy();
    },
  );

  it.each(LOCALES)(
    "审批、输入请求、需要连接同时待处理时，整个视图只有一个主操作（输入框的「发送」）（%s）",
    async (locale) => {
      const m = msgs[locale];
      vi.stubGlobal("EventSource", FakeEventSource);
      FakeEventSource.instances = [];
      const form: InputForm = {
        title: "Pick",
        fields: [{ key: "c", label: "C", schema: { type: "boolean" } }],
      };
      stubApi({
        "GET /api/v1/orgs/o1/conversations/c1/events": () =>
          json(200, {
            events: [
              ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }),
              toolCall(3, "call_1", "fixture__delete_item", { id: "x1" }),
              ev(4, "approval_requested", {
                step: 0,
                callId: "call_1",
                approvalId: "ap1",
                toolKey: "fixture__delete_item",
                expiresAt: EXPIRES,
              }),
              ev(5, "question_asked", {
                step: 0,
                callId: "call_2",
                questionId: "q1",
                form,
                expiresAt: EXPIRES,
              }),
              ev(6, "connection_required", {
                step: 0,
                callId: "call_3",
                appId: "app2",
                appName: "GitHub",
              }),
            ],
          }),
        "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL }),
      });
      const { container } = renderPage(<ChatPage />, { locale });
      const log = await screen.findByRole("log");
      await within(log).findByRole("button", { name: m.approval.approve });
      expect(within(log).getByRole("button", { name: m.question.submit })).toBeTruthy();
      expect(within(log).getByRole("button", { name: m.connect.action })).toBeTruthy();
      const primaries = container.querySelectorAll(
        '[data-variant="primary"], .cb-btn-link-primary',
      );
      expect([...primaries].map((el) => el.textContent)).toEqual([m.chat.send]);
    },
  );
});
