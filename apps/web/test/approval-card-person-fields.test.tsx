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
  kind: "tool",
  conversationId: "c1",
  runId: "r1",
  callId: "call_1",
  toolKey: "Platform",
  toolName: "Platform",
  connector: null,
  agent: { id: "ag1", name: "Echo agent" },
  input: {},
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
  personFields: [
    { path: "apiKey", label: "API key", multiline: false, required: true, isSet: false },
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

const field = async () => (await screen.findByLabelText("API key")) as HTMLInputElement;

describe("ApprovalCard: person fields", () => {
  it("keeps Approve disabled until every field has a value, and offers only once", async () => {
    stubApi({ "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL() }) });
    renderPage(<ApprovalCard orgId="o1" item={item} />, { locale: "en" });
    const input = await field();
    const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /conversation|always/i })).toBeNull();
    expect(screen.getByText(/Anthropic: deployment config/)).toBeTruthy();
    await userEvent.setup().type(input, SECRET);
    expect(approve.disabled).toBe(false);
  });

  it("posts the values once with the approve and clears them from the cache", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL() }),
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () => json(200, { approval: DECIDED }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item} />, { locale: "en" });
    const user = userEvent.setup();
    await user.type(await field(), SECRET);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      decision: "approve",
      scope: "once",
      inputs: { apiKey: SECRET },
    });
    await waitFor(() => expect(screen.queryByLabelText("API key")).toBeNull());
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
    await user.type(await screen.findByLabelText("API key"), SECRET);
    await user.click(screen.getByRole("button", { name: "批准" }));
    expect(
      await screen.findByText("这个值在对话里出现过，视为已泄露。请到服务商那里新建一个再填写。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "批准" })).toBeTruthy();
    // the leaked value is cleared, the refusal stays, and Approve waits for a new value
    expect(((await field()) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "批准" }).hasAttribute("disabled")).toBe(true);
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
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("API key is too short.")).toBeTruthy();
  });

  it("Deny posts no inputs", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL() }),
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () =>
        json(200, { approval: { ...DECIDED, status: "denied", scope: null } }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item} />, { locale: "en" });
    const user = userEvent.setup();
    await user.type(await field(), SECRET);
    await user.click(screen.getByRole("button", { name: /^Deny/ }));
    await user.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ decision: "deny" });
  });
});
