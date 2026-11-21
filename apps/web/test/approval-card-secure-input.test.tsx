import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/components/ApprovalCard";
import type { Approval } from "../src/lib/approvals";
import type { ApprovalItem } from "../src/lib/timeline";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { currentPageClient, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const EXPIRES = "2026-11-14T12:00:00.000Z";
const SECRET = "sk-live-0123456789abcdef";

const APPROVAL = (over: Partial<Approval> = {}): Approval => ({
  id: "ap1",
  kind: "secure_input",
  conversationId: "c1",
  runId: "r1",
  callId: "call_1",
  toolKey: "Platform",
  toolName: "Platform",
  connector: null,
  agent: { id: "ag1", name: "Echo agent" },
  input: null,
  requestedFor: "a1",
  scopes: ["once", "session", "always"],
  approverRole: null,
  status: "pending",
  scope: null,
  decidedBy: null,
  decidedByPerson: null,
  decidedAt: null,
  expiresAt: EXPIRES,
  createdAt: EXPIRES,
  conversationPath: "/chat/c1",
  initiatorAccountId: "a1",
  personFields: [
    {
      path: "apiKey",
      label: { zh: "API 密钥", en: "API key" },
      description: { zh: "在服务商控制台创建", en: "Create it in the provider console" },
      multiline: false,
      required: true,
      isSet: false,
    },
  ],
  personTarget: { zh: "Anthropic：平台配置", en: "Anthropic: deployment config" },
  ...over,
});

const item: ApprovalItem = {
  approvalId: "ap1",
  callId: "call_1",
  toolKey: "Platform",
  input: {},
  expiresAt: EXPIRES,
  secureInput: {
    target: { zh: "Anthropic：平台配置", en: "Anthropic: deployment config" },
    fields: ["apiKey"],
  },
  decided: null,
  decidedAt: null,
};

const DECIDED = {
  ...APPROVAL(),
  status: "approved",
  scope: "once",
  decidedBy: "a1",
  decidedAt: EXPIRES,
};

beforeEach(() => resetNavigation("/chat/c1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const omitSecure = ({ secureInput: _s, ...rest }: ApprovalItem): ApprovalItem => rest;

const field = async () => (await screen.findByLabelText("API key")) as HTMLInputElement;

describe("ApprovalCard: secure input", () => {
  it("keeps Submit disabled until every field has a value, and offers Cancel, never a scope", async () => {
    stubApi({ "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL() }) });
    renderPage(<ApprovalCard orgId="o1" item={item} />, { locale: "en" });
    const input = await field();
    const approve = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /conversation|always|Approve|Deny/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByText(/Secure input: Anthropic: deployment config/)).toBeTruthy();
    await userEvent.setup().type(input, SECRET);
    expect(approve.disabled).toBe(false);
  });

  it("posts the values once with the approve decision and clears them from the cache", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL() }),
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () => json(200, { approval: DECIDED }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item} />, { locale: "en" });
    const user = userEvent.setup();
    await user.type(await field(), SECRET);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      decision: "approve",
      scope: "once",
      inputs: { apiKey: SECRET },
    });
    await waitFor(() => expect(screen.queryByLabelText("API key")).toBeNull());
    expect(await screen.findByText(/Submitted/)).toBeTruthy();
    expect(
      JSON.stringify(
        currentPageClient()
          .getQueryCache()
          .getAll()
          .map((q) => q.state),
      ),
    ).not.toContain(SECRET);
    expect(
      JSON.stringify(
        currentPageClient()
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      ),
    ).not.toContain(SECRET);
  });

  it.each([
    ["zh", "API 密钥", "在服务商控制台创建"],
    ["en", "API key", "Create it in the provider console"],
  ] as const)(
    "shows the label and description in the viewer's language (%s)",
    async (locale, label, help) => {
      stubApi({ "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL() }) });
      renderPage(<ApprovalCard orgId="o1" item={item} />, { locale });
      expect(await screen.findByLabelText(label)).toBeTruthy();
      expect(screen.getByText(help)).toBeTruthy();
    },
  );

  it("shows the leak copy under the field and stays pending", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL() }),
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () =>
        json(422, {
          error: {
            code: "approval.input_leaked",
            message: "leaked",
            details: [{ fields: ["apiKey"] }],
          },
        }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item} />, { locale: "zh" });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("API 密钥"), SECRET);
    await user.click(screen.getByRole("button", { name: "提交" }));
    expect(
      await screen.findByText("这个值在对话里出现过，视为已泄露。请到服务商那里新建一个再填写。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交" })).toBeTruthy();
    // the leaked value is cleared, the refusal stays, and Submit waits for a new value
    expect(((await screen.findByLabelText("API 密钥")) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "提交" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows an invalid value's problem under its field", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL() }),
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () =>
        json(422, {
          error: {
            code: "approval.inputs_invalid",
            message: "invalid",
            details: [{ fields: [{ path: "apiKey", problem: "API key is too short." }] }],
          },
        }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item} />, { locale: "en" });
    const user = userEvent.setup();
    await user.type(await field(), "x");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("API key is too short.")).toBeTruthy();
  });

  it("Cancel posts a deny without inputs", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL() }),
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () =>
        json(200, { approval: { ...DECIDED, status: "denied", scope: null } }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item} />, { locale: "en" });
    const user = userEvent.setup();
    await user.type(await field(), SECRET);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ decision: "deny" });
    expect(await screen.findByText(/Cancelled/)).toBeTruthy();
  });

  it("a leaked field of the read approval shows its error on reload and stays empty", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, { approval: APPROVAL({ leakedFields: ["apiKey"] }) }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item} />, { locale: "en" });
    expect(((await field()) as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/appeared in the conversation/)).toBeTruthy();
  });

  it("a decided request reads Submitted without reading the approval's fields", async () => {
    stubApi({});
    renderPage(
      <ApprovalCard
        orgId="o1"
        item={{
          ...item,
          decided: {
            approvalId: "ap1",
            callId: "call_1",
            decision: "approved",
            byAccountId: "a1",
          },
          decidedAt: EXPIRES,
        }}
      />,
      { locale: "zh" },
    );
    expect(await screen.findByText(/已提交/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
  });

  it("a tool approval the review model was unsure about says so", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, {
          approval: {
            ...APPROVAL({ kind: "tool", input: {}, reviewUnsure: true }),
            personFields: undefined,
            personTarget: undefined,
          },
        }),
    });
    renderPage(<ApprovalCard orgId="o1" item={{ ...omitSecure(item), input: {} }} />, {
      locale: "en",
    });
    expect(
      await screen.findByText("The review model wasn't sure, so it's your call."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });
});
