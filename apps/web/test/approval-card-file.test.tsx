import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/components/ApprovalCard";
import type { Approval } from "../src/lib/approvals";
import type { ApprovalItem } from "../src/lib/timeline";
import { json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const EXPIRES = "2026-11-14T12:00:00.000Z";
const SHA = "0123456789abcdef".repeat(4);
const THUMB = "data:image/webp;base64,UklGRgAAAABXRUJQ";

const APPROVAL = (file: Approval["file"]): Approval => ({
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
  scopes: ["once"],
  approverRole: null,
  status: "pending",
  scope: null,
  decidedBy: null,
  decidedAt: null,
  expiresAt: EXPIRES,
  createdAt: EXPIRES,
  conversationPath: "/chat/c1",
  initiatorAccountId: "a1",
  ...(file !== undefined ? { file } : {}),
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

beforeEach(() => resetNavigation("/chat/c1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (file: Approval["file"]) => {
  stubApi({
    "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL(file) }),
  });
  return renderPage(<ApprovalCard orgId="o1" item={item} />, { locale: "en" });
};

describe("ApprovalCard: file row", () => {
  it("shows the name, the size, the first 12 hex of the sha256 and the thumbnail", async () => {
    const { container } = show({
      name: "logo.png",
      size: 1536,
      sha256: SHA,
      contentType: "image/png",
      thumbnail: THUMB,
    });
    expect(await screen.findByText("logo.png")).toBeTruthy();
    expect(screen.getByText("1.5 KB · sha256 0123456789ab")).toBeTruthy();
    expect(container.querySelector('[data-part="file-thumbnail"]')?.getAttribute("src")).toBe(
      THUMB,
    );
  });

  it("shows the row in Chinese and without a thumbnail for a non-image", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, {
          approval: APPROVAL({
            name: "crm.tgz",
            size: 20,
            sha256: SHA,
            contentType: "application/gzip",
          }),
        }),
    });
    const { container } = renderPage(<ApprovalCard orgId="o1" item={item} />, { locale: "zh" });
    expect(await screen.findByText("crm.tgz")).toBeTruthy();
    expect(screen.getByText("20 B · sha256 0123456789ab")).toBeTruthy();
    expect(container.querySelector('[data-part="file-thumbnail"]')).toBeNull();
  });

  it("never renders a thumbnail that is not a WebP data URL", async () => {
    const { container } = show({
      name: "x.png",
      size: 5,
      sha256: SHA,
      contentType: "image/png",
      thumbnail: "https://evil.example/x.png",
    });
    expect(await screen.findByText("x.png")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows no file row for a call without a file", async () => {
    const { container } = show(undefined);
    await screen.findByRole("button", { name: "Approve" });
    expect(container.querySelector('[data-part="file"]')).toBeNull();
  });
});
