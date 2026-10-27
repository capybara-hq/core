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
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const EXPIRES = "2026-10-19T12:00:00.000Z";

const APPROVAL = {
  id: "ap1",
  conversationId: "c1",
  runId: "r1",
  callId: "call_1",
  toolKey: "fixture__delete_item",
  toolName: "delete_item",
  connector: { id: "app1", name: "Fixture", slug: "fixture" },
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

const INFO: ToolInfo = {
  key: "fixture__delete_item",
  title: "Delete item",
  kind: "connector",
  keyArgs: ["id"],
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
    toolKey: "fixture__delete_item",
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
    expect(screen.getByText("Fixture: Delete item")).toBeTruthy();
    expect(screen.getByText("fixture__delete_item")).toBeTruthy();
    const keys = [...container.querySelectorAll('[data-part="kv-key"]')].map((k) => k.textContent);
    expect(keys).toEqual(["id", "reason"]);
    expect(screen.getByText(zh.approval.policy.connector)).toBeTruthy();
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
    expect(await screen.findByText(/你 批准了 Fixture: Delete item/)).toBeTruthy();
  });

  it("a role escalation offers only once; deny sends the reason", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, { approval: { ...APPROVAL, requestedFor: null, approverRole: "admin" } }),
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
            .replace("{tool}", "Fixture: Delete item")
            .replace("{key}", "fixture__delete_item"),
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /批准|Approve/ })).toBeNull();
    },
  );

  it("decided (from the log): one line naming who, the key, the scope and the reason", () => {
    const calls = stubApi({});
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
    expect(screen.getByText(/someone 拒绝了 Fixture: Delete item/)).toBeTruthy();
    expect(screen.getByText(/「too risky」/)).toBeTruthy();
    expect(calls).toHaveLength(0);
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
        expect(router.push).toHaveBeenCalledWith("/settings/connections#connector-app2"),
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
          toolKey: "fixture__delete_item",
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
