import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import { ApprovalCard } from "../src/components/ApprovalCard";
import type { Approval, CommandAskDetail } from "../src/lib/approvals";
import type { CommandAsk } from "../src/lib/conversations";
import type { ApprovalItem } from "../src/lib/timeline";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const EXPIRES = "2026-11-14T12:00:00.000Z";

/** A `command` ask as the timeline event carries it (display only, clipped). */
const eventCommand = (over: Partial<CommandAsk> = {}): CommandAsk => ({
  kind: "command",
  command: "rm -rf build",
  rule: "rm:forced",
  reason: "Deletes files outside the workspace",
  mode: "auto",
  ...over,
});

const DETAIL: CommandAskDetail = {
  deviceId: "d1",
  deviceName: "box",
  mode: "auto",
  kind: "command",
  command: "rm -rf build",
  rule: "rm:forced",
  reason: "Deletes files outside the workspace",
};

const APPROVAL_COMMAND = (over: Partial<Approval> = {}): Approval => ({
  id: "ap1",
  kind: "command",
  command: { ...DETAIL },
  detail: null,
  conversationId: "c1",
  runId: "r1",
  callId: "call_1",
  toolKey: "Bash",
  toolName: "Bash",
  connector: null,
  agent: { id: "ag1", name: "Echo agent" },
  input: {},
  requestedFor: "a1",
  scopes: ["once", "session"],
  approverRole: null,
  status: "pending",
  scope: null,
  decidedBy: null,
  decidedAt: null,
  expiresAt: EXPIRES,
  createdAt: EXPIRES,
  conversationPath: "/chat/c1",
  initiatorAccountId: "a1",
  ...over,
});

const item = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  approvalId: "ap1",
  callId: "call_1",
  toolKey: "Bash",
  input: {},
  expiresAt: EXPIRES,
  command: eventCommand(),
  decided: null,
  decidedAt: null,
  ...over,
});

beforeEach(() => resetNavigation("/chat/c1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ApprovalCard: a command review ask (auto mode §5.4)", () => {
  it("asks to run the command with the reason, both scopes and the scope it posts", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL_COMMAND() }),
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () =>
        json(200, {
          approval: {
            ...APPROVAL_COMMAND(),
            status: "approved",
            scope: "session",
            decidedBy: "a1",
            decidedAt: EXPIRES,
          },
        }),
    });
    const { container } = renderPage(<ApprovalCard orgId="o1" item={item()} />, { locale: "zh" });
    expect(
      await screen.findByRole("group", { name: "智能体想运行这条命令，允许吗？" }),
    ).toBeTruthy();
    expect(container.querySelector('[data-part="command-reason"]')?.textContent).toBe(
      "Deletes files outside the workspace",
    );
    expect(container.querySelector('[data-part="code-block"]')?.textContent).toBe("rm -rf build");
    expect(screen.getByRole("button", { name: "允许一次" })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "本会话允许同类" }));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      decision: "approve",
      scope: "session",
    });
    expect(await screen.findByText(/已允许（本会话同类）/)).toBeTruthy();
  });

  it("a classifier ask (scopes once) never shows 本会话允许同类", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, {
          approval: APPROVAL_COMMAND({
            scopes: ["once"],
            command: { ...DETAIL, rule: null },
          }),
        }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item()} />, { locale: "zh" });
    expect(await screen.findByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "本会话允许同类" })).toBeNull();
  });

  it("a write names the path, never the tool key it carries as its command", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, {
          approval: APPROVAL_COMMAND({
            toolKey: "Write",
            command: {
              ...DETAIL,
              kind: "write",
              command: "Write",
              path: "/etc/capybara/config.yaml",
            },
          }),
        }),
    });
    const { container } = renderPage(
      <ApprovalCard
        orgId="o1"
        item={item({ toolKey: "Write", command: eventCommand({ kind: "write", path: "/x" }) })}
      />,
      { locale: "zh" },
    );
    expect(
      await screen.findByRole("group", { name: "智能体想写入这个文件，允许吗？" }),
    ).toBeTruthy();
    const code = container.querySelector('[data-part="code-block"]') as Element;
    expect(code.textContent).toContain("/etc/capybara/config.yaml");
    expect(code.textContent).not.toContain("Write");
  });

  it("uses the full command from the approval, not the timeline's clipped copy", async () => {
    const full = `pnpm test ${"--filter @capybara-hq/kernel ".repeat(5)}`;
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, {
          approval: APPROVAL_COMMAND({
            command: { ...DETAIL, command: full },
          }),
        }),
    });
    const { container } = renderPage(
      <ApprovalCard
        orgId="o1"
        item={item({ command: eventCommand({ command: "pnpm test …" }) })}
      />,
      { locale: "zh" },
    );
    await screen.findByRole("group", { name: "智能体想运行这条命令，允许吗？" });
    expect(container.querySelector('[data-part="code-block"]')?.textContent).toBe(full);
  });

  it.each([
    ["once", "已允许（一次）"],
    ["session", "已允许（本会话同类）"],
  ] as const)("decided with scope %s reads %s", (scope, word) => {
    const { container } = renderPage(
      <ApprovalCard
        orgId="o1"
        item={item({
          decided: {
            approvalId: "ap1",
            callId: "call_1",
            decision: "approved",
            scope,
            byAccountId: "a1",
          },
          decidedAt: EXPIRES,
        })}
      />,
      { locale: "zh" },
    );
    expect(container.textContent).toContain(word);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("denied names the reason; expired reads 已过期; neither reads 已跳过", () => {
    stubApi({});
    const denied = renderPage(
      <ApprovalCard
        orgId="o1"
        item={item({
          decided: {
            approvalId: "ap1",
            callId: "call_1",
            decision: "denied",
            byAccountId: "a1",
            reason: "Too broad",
          },
          decidedAt: EXPIRES,
        })}
      />,
      { locale: "zh" },
    );
    expect(denied.container.textContent).toContain("已拒绝");
    expect(denied.container.textContent).toContain("「Too broad」");
    expect(denied.container.textContent).not.toContain("已跳过");
    cleanup();
    const expired = renderPage(
      <ApprovalCard
        orgId="o1"
        item={item({
          decided: { approvalId: "ap1", callId: "call_1", decision: "expired", byAccountId: null },
          decidedAt: EXPIRES,
        })}
      />,
      { locale: "zh" },
    );
    expect(expired.container.textContent).toContain("已过期");
    expect(expired.container.textContent).not.toContain("已跳过");
  });

  it("speaks English", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () => json(200, { approval: APPROVAL_COMMAND() }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item()} />, { locale: "en" });
    expect(
      await screen.findByRole("group", { name: "The agent wants to run this command. Allow?" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Allow this kind for this conversation" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(screen.getByText("Deletes files outside the workspace")).toBeTruthy();
  });

  it("while the approval read is pending: the event's clipped command, disabled buttons, no session scope", async () => {
    let answer!: (r: Response) => void;
    const read = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const clipped = `rm -rf build ${"x".repeat(400)}`;
    stubApi({ "GET /api/v1/orgs/o1/approvals/ap1": () => read });
    const { container } = renderPage(
      <ApprovalCard orgId="o1" item={item({ command: eventCommand({ command: clipped }) })} />,
      { locale: "zh" },
    );
    // before the authoritative read answers: the log's clipped copy, only one scope, all disabled
    const once = await screen.findByRole("button", { name: "允许一次" });
    expect(once).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "本会话允许同类" })).toBeNull();
    const code = container.querySelector('[data-part="code-block"]') as Element;
    expect(Array.from(code.textContent ?? "")).toHaveLength(300);
    expect(code.textContent?.endsWith("…")).toBe(true);

    // the read answers: both scopes become offered and the buttons interactive
    await act(async () => {
      answer(json(200, { approval: APPROVAL_COMMAND() }));
    });
    expect(await screen.findByRole("button", { name: "本会话允许同类" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "允许一次" })).toHaveProperty("disabled", false);
    expect(container.querySelector('[data-part="code-block"]')?.textContent).toBe("rm -rf build");
  });

  it("a viewer who cannot decide waits for the device owner", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(404, { error: { code: "approval.not_found", message: "Not found" } }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item()} />, { locale: "zh" });
    expect(await screen.findByText(zh.approval.command.otherApprover)).toBeTruthy();
  });

  it("a non-decider of a write reads the write wording, not 'run a command'", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(404, { error: { code: "approval.not_found", message: "Not found" } }),
    });
    renderPage(
      <ApprovalCard
        orgId="o1"
        item={item({ toolKey: "Write", command: eventCommand({ kind: "write", path: "/x" }) })}
      />,
      { locale: "zh" },
    );
    expect(await screen.findByText(zh.approval.command.otherApproverWrite)).toBeTruthy();
    expect(screen.queryByText(zh.approval.command.otherApprover)).toBeNull();
  });
});

/** An outside write's exact reach (permission profiles Task 7 wire): long paths, several hosts. */
const LONG = `/outside/${"very-long-directory-name-".repeat(12)}end`;
const SCOPE = {
  readDirectories: ["/outside/reports", LONG],
  writeDirectories: ["/outside/reports"],
  hosts: ["api.example.com", "files.example.org", "registry.npmjs.org"],
};
const scopeOf = (container: HTMLElement) => {
  const box = container.querySelector('[data-role="permission-scope"]');
  const values = (k: string) =>
    [...(box?.querySelectorAll(`[data-scope="${k}"] [data-pre="true"]`) ?? [])].map(
      (e) => e.textContent,
    );
  return {
    write: values("write"),
    read: values("read"),
    hosts: values("hosts"),
    target: values("target"),
  };
};

describe("ApprovalCard: exact permission scope and supersession (Task 10D)", () => {
  it("shows every directory and host whole, the target file apart, from the event before the read", async () => {
    stubApi({
      // the read never answers here: the log's own fields draw the same scope
      "GET /api/v1/orgs/o1/approvals/ap1": () => new Promise<Response>(() => {}),
    });
    const { container } = renderPage(
      <ApprovalCard
        orgId="o1"
        item={item({
          toolKey: "Write",
          command: eventCommand({
            kind: "write",
            path: "/outside/reports/report.txt",
            permissionScope: SCOPE,
            targetPath: "/outside/reports/report.txt",
          }),
        })}
      />,
      { locale: "en" },
    );
    expect(scopeOf(container)).toEqual({
      write: ["/outside/reports"],
      read: ["/outside/reports", LONG],
      hosts: ["api.example.com", "files.example.org", "registry.npmjs.org"],
      target: ["/outside/reports/report.txt"],
    });
    expect(
      screen.getByText(
        "Approving grants this access for this operation only. Each directory includes everything inside it.",
      ),
    ).toBeTruthy();
    // nothing clipped, nothing inferred (no parent, no root), nothing a link
    expect(container.textContent).toContain(LONG);
    expect(container.querySelector('[data-role="permission-scope"] a')).toBeNull();
    expect(scopeOf(container).read).not.toContain("/outside");
  });

  it("the approval read's scope agrees with the event's", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, {
          approval: APPROVAL_COMMAND({
            scopes: ["once"],
            command: {
              ...DETAIL,
              permissionScope: SCOPE,
              targetPath: "/outside/reports/report.txt",
            },
          }),
        }),
    });
    const { container } = renderPage(<ApprovalCard orgId="o1" item={item()} />, {
      locale: "zh",
    });
    expect(await screen.findByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "本会话允许同类" })).toBeNull();
    expect(scopeOf(container).hosts).toEqual(SCOPE.hosts);
    expect(scopeOf(container).target).toEqual(["/outside/reports/report.txt"]);
    expect(screen.getByText(zh.approval.permissionScope.write)).toBeTruthy();
  });

  it("superseded in the log is final before any read: no approve, deny or scope controls", async () => {
    const calls = stubApi({});
    const { container } = renderPage(
      <ApprovalCard
        orgId="o1"
        item={item({
          command: eventCommand({ permissionScope: SCOPE }),
          decided: {
            approvalId: "ap1",
            callId: "call_1",
            decision: "superseded",
            byAccountId: null,
            reason: "user",
            revision: 7,
          },
          decidedAt: EXPIRES,
        })}
      />,
      { locale: "en" },
    );
    expect(container.querySelector('[data-state="superseded"]')).toBeTruthy();
    expect(screen.getByText("Superseded")).toBeTruthy();
    expect(
      screen.getByText(
        "A permission change replaced this request before anyone decided it. Nothing was approved; if still needed, a new request appears.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Permissions revision 7")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(scopeOf(container).hosts).toEqual(SCOPE.hosts);
    // decided in the log: nothing is read, nothing is posted
    expect(calls).toEqual([]);
  });

  it("a sub-agent's card read from the API maps supersededRevision/Reason (authority change)", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, {
          approval: APPROVAL_COMMAND({
            status: "superseded",
            supersededRevision: 3,
            supersededReason: "authority-changed",
          }),
        }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item()} fromRead />, { locale: "zh" });
    expect(await screen.findByText(zh.approval.superseded.authorityChanged)).toBeTruthy();
    expect(screen.getByText("已被取代")).toBeTruthy();
    expect(screen.getByText("权限版本 3")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("a late click on a card superseded meanwhile reads it again, drops the actions and never retries", async () => {
    let read = 0;
    const calls = stubApi({
      "GET /api/v1/orgs/o1/approvals/ap1": () =>
        json(200, {
          approval:
            ++read === 1
              ? APPROVAL_COMMAND()
              : APPROVAL_COMMAND({
                  status: "superseded",
                  supersededRevision: 4,
                  supersededReason: "user",
                }),
        }),
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () =>
        json(409, {
          error: { code: "approval.already_decided", message: "Approval already decided" },
        }),
      "GET /api/v1/orgs/o1/inbox": () => json(200, { items: [] }),
      "GET /api/v1/orgs/o1/inbox/count": () => json(200, { count: 0 }),
    });
    renderPage(<ApprovalCard orgId="o1" item={item()} />, { locale: "en" });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Allow once" }));
    expect(await screen.findByText("Superseded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});
