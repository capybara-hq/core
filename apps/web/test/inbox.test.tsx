import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { requesterOf as skillChangeRequester } from "../src/components/SkillChangeReview";
import { requesterOf as catalogRequester } from "../src/lib/catalog";
import { keys } from "../src/lib/query/keys";
import { bodyOf, json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { personAvatarSrc, personInitial } from "./support/person";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import type { renderPage } from "./support/render";
import { expectNoFirstPaintFetch } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

type Routes = Parameters<typeof stubApi>[0];

/**
 * The inbox as a first load: the layout's prefetch (`server`) from `routes`; the browser answers
 * `routes` afterwards (`calls`).
 */
async function renderInbox(routes: Routes, opts: Parameters<typeof renderPage>[1] = {}) {
  const calls = stubApi(routes);
  const r = await renderRouteWithCache("/inbox", routes, opts);
  return { ...r, server: r.calls, calls };
}

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const T = "2026-10-19T12:00:00.000Z";

const approval = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  conversationId: `c-${id}`,
  runId: "r1",
  callId: `call-${id}`,
  toolKey: `mcp__fixture__${id}`,
  toolName: `tool_${id}`,
  connector: { id: "app1", name: "Fixture", slug: "fixture" },
  agent: { id: "ag1", name: "Echo agent" },
  input: { id },
  requestedFor: "a1",
  scopes: ["once", "session", "always"],
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
  kind: "version",
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
  requestedByAvatarUrl: "/api/v1/accounts/a2/avatar?v=abc123",
  requestedInConversation: "c9",
  conversationPath: "/chat/c9",
  decidedBy: null,
  decidedAt: null,
  createdAt: T,
  ...over,
});

beforeEach(() => {
  resetNavigation("/inbox");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("收件箱（InboxPage）", () => {
  it.each(LOCALES)(
    "Rail 为待处理列表，内容区为第一条详情，ActionRow 有批准 / 拒绝（%s）",
    async (locale) => {
      const m = msgs[locale];
      const { container, server, calls } = await renderInbox(
        { [LIST]: () => json(200, inbox([approval("a"), approval("b")])) },
        { locale },
      );
      // the first paint is the server's read: nothing is fetched in the browser
      expect(server.map((c) => c.url)).toContain("/api/v1/orgs/o1/inbox");
      expect(calls).toEqual([]);
      expect(container.querySelector('[data-template="InboxPage"]')).not.toBeNull();
      const table = await screen.findByRole("list", { name: m.inbox.listLabel });
      expect(within(table).getByText("Fixture [tool_a]")).toBeTruthy();
      expect(within(table).getByText("Fixture [tool_b]")).toBeTruthy();
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

  it.each(LOCALES)(
    "a secure input request has no Submit, one way to the conversation (%s)",
    async (locale) => {
      const m = msgs[locale];
      const { container } = await renderInbox(
        {
          [LIST]: () =>
            json(
              200,
              inbox([
                approval("a", {
                  kind: "secure_input",
                  input: null,
                  personFields: [
                    {
                      path: "apiKey",
                      label: { zh: "API 密钥", en: "API key" },
                      multiline: false,
                      required: true,
                      isSet: false,
                    },
                    {
                      path: "token",
                      label: { zh: "令牌", en: "Token" },
                      multiline: false,
                      required: true,
                      isSet: false,
                    },
                  ],
                  personTarget: { zh: "目标", en: "Target" },
                }),
              ]),
            ),
        },
        { locale },
      );
      await screen.findByRole("list", { name: m.inbox.listLabel });
      const detail = container.querySelector('[data-approval-id="a"]') as HTMLElement;
      expect(
        within(detail).getByText(
          locale === "zh" ? "需要在网页填写 2 项" : "2 fields to fill in on the web",
        ),
      ).toBeTruthy();
      // one control opens the conversation: the primary action (the conversation fact stays a link)
      expect(
        within(detail).queryAllByRole("link", { name: m.inbox.openConversation }),
      ).toHaveLength(0);
      const open = screen.getAllByRole("button", { name: m.inbox.openConversation });
      expect(open).toHaveLength(1);
      expect(open[0]?.getAttribute("data-variant")).toBe("primary");
      expect(screen.queryByRole("button", { name: m.approval.approve })).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: m.approval.scopeLabel })).toBeNull();
      expect(screen.getByRole("button", { name: m.approval.deny })).toBeTruthy();
    },
  );

  it("the open item is in the URL hash: opening closes the list's page, back (and the system back) returns", async () => {
    const { container } = await renderInbox({
      [LIST]: () => json(200, inbox([approval("a"), approval("b")])),
    });
    const table = await screen.findByRole("list", { name: msgs.en.inbox.listLabel });
    const region = () => container.querySelector('[data-part="list-detail"]');
    expect(region()?.getAttribute("data-open")).toBe("false");
    const user = userEvent.setup();
    await user.click(within(table).getByText("Fixture [tool_b]"));
    expect(window.location.hash).toBe("#item=b");
    expect(region()?.getAttribute("data-open")).toBe("true");
    expect(container.querySelector('[data-approval-id="b"]')).not.toBeNull();
    await user.click(screen.getAllByRole("button", { name: "Back" })[0] as HTMLElement);
    await waitFor(() => expect(region()?.getAttribute("data-open")).toBe("false"));
    expect(window.location.hash).toBe("");
  });

  it("open, then the system back, then a decision stays on /inbox (no stale history step)", async () => {
    window.history.replaceState(null, "", "/inbox");
    let pending = [approval("a"), approval("b")];
    await renderInbox({
      [LIST]: () => json(200, inbox(pending)),
      "POST /api/v1/orgs/o1/approvals/a/decision": () => {
        pending = pending.filter((x) => x.id !== "a");
        return json(200, { approval: { ...approval("a"), status: "approved", scope: "once" } });
      },
    });
    const table = await screen.findByRole("list", { name: msgs.en.inbox.listLabel });
    const user = userEvent.setup();
    await user.click(within(table).getByText("Fixture [tool_a]"));
    expect(window.location.hash).toBe("#item=a");
    await act(async () => {
      window.history.back();
      await waitFor(() => expect(window.location.hash).toBe(""));
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const back = vi.spyOn(window.history, "back");
    const row = screen.getByRole("region", { name: "Pending changes" });
    await user.click(within(row).getByRole("button", { name: msgs.en.approval.approve }));
    expect(await screen.findByText(msgs.en.inbox.approved)).toBeTruthy();
    expect(back).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/inbox");
    back.mockRestore();
    window.history.replaceState(null, "", "/");
  });

  it("/inbox#item=<id> deep-links to the item", async () => {
    window.history.replaceState(null, "", "/inbox#item=b");
    const { container } = await renderInbox({
      [LIST]: () => json(200, inbox([approval("a"), approval("b")])),
    });
    await waitFor(() =>
      expect(container.querySelector('[data-part="list-detail"]')?.getAttribute("data-open")).toBe(
        "true",
      ),
    );
    expect(container.querySelector('[data-approval-id="b"]')).not.toBeNull();
    window.history.replaceState(null, "", "/");
  });

  it.each(LOCALES)("选中第二条、选「以后都允许」批准 → POST 后重读列表（%s）", async (locale) => {
    const m = msgs[locale];
    let pending = [approval("a"), approval("b")];
    const refreshPending = vi.fn();
    const { container, calls, server } = await renderInbox(
      {
        [LIST]: () => json(200, inbox(pending)),
        "POST /api/v1/orgs/o1/approvals/b/decision": () => {
          pending = pending.filter((a) => a.id !== "b");
          return json(200, { approval: { ...approval("b"), status: "approved", scope: "always" } });
        },
      },
      { locale, session: { refreshPending } },
    );
    const user = userEvent.setup();
    const table = await screen.findByRole("list", { name: m.inbox.listLabel });
    await user.click(within(table).getByText("Fixture [tool_b]"));
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
    // the decision invalidates the inbox: it is read again in the browser, the route is not
    // refreshed
    await vi.waitFor(() => expect(screen.queryByText("Fixture [tool_b]")).toBeNull());
    expect(router.refresh).not.toHaveBeenCalled();
    expect(server.filter((c) => c.url.endsWith("/inbox"))).toHaveLength(1);
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual([
        "/api/v1/orgs/o1/inbox",
      ]),
    );
    expect(await screen.findByText(m.inbox.approved)).toBeTruthy();
    // 顶栏的待处理数立即重读，不等 30 秒轮询
    expect(refreshPending).toHaveBeenCalledTimes(1);
  });

  it("已被别人处理：toast 显示 approval.already_decided 的文案并重读", async () => {
    await renderInbox(
      {
        [LIST]: () => json(200, inbox([approval("a")])),
        "POST /api/v1/orgs/o1/approvals/a/decision": () =>
          json(409, { error: { code: "approval.already_decided", message: "x" } }),
      },
      { locale: "zh" },
    );
    await screen.findByRole("list", { name: zh.inbox.listLabel });
    const row = screen.getByRole("region", { name: "待提交改动" });
    await userEvent.setup().click(within(row).getByRole("button", { name: zh.approval.deny }));
    expect(await screen.findByText(zh.errors.approval.already_decided)).toBeTruthy();
  });

  it.each(LOCALES)(
    "nothing pending: one full-width empty state, no split, no ActionRow (%s)",
    async (locale) => {
      const m = msgs[locale];
      await renderInbox({ [LIST]: () => json(200, inbox([])) }, { locale });
      expect(await screen.findByText(m.inbox.empty)).toBeTruthy();
      expect(screen.getByText(m.inbox.emptyHint)).toBeTruthy();
      // no empty table header in a narrow list column
      expect(screen.queryByRole("table")).toBeNull();
      expect(document.querySelector(".cb-body-rail")).toBeNull();
      expect(document.querySelector('[data-part="empty-state"]')?.getAttribute("data-size")).toBe(
        "page",
      );
      expect(screen.queryByRole("button", { name: m.approval.approve })).toBeNull();
    },
  );

  it("按角色升级的审批只有「仅本次」", async () => {
    await renderInbox({
      [LIST]: () =>
        json(
          200,
          inbox([approval("a", { requestedFor: null, scopes: ["once"], approverRole: "admin" })]),
        ),
    });
    const scopes = await screen.findByRole("radiogroup", { name: en.approval.scopeLabel });
    expect(within(scopes).getAllByRole("radio")).toHaveLength(1);
  });
});

describe("inbox: command review asks (auto mode spec §5.4)", () => {
  const ask = (over: Record<string, unknown> = {}) => ({
    deviceId: "d1",
    deviceName: "box",
    mode: "auto",
    kind: "command",
    command: "rm -rf build",
    rule: "rm:forced",
    reason: "Deletes files outside the workspace",
    ...over,
  });
  const commandApproval = (over: Record<string, unknown> = {}) =>
    approval("a", {
      kind: "command",
      toolKey: "Bash",
      toolName: "Bash",
      connector: null,
      input: {},
      command: ask(),
      ...over,
    });

  it("shows the question, the reason, the device and the clipped command; never an argument box", async () => {
    const command = `rm -rf build ${"x".repeat(400)}`;
    const { container } = await renderInbox({
      [LIST]: () => json(200, inbox([commandApproval({ command: ask({ command }) })])),
    });
    const rg = await screen.findByRole("radiogroup", { name: en.approval.scopeLabel });
    expect(rg).toBeTruthy();
    expect(await screen.findByText(en.approval.command.title)).toBeTruthy();
    // the ask in the UI's language, the rule's own reason under it as detail text
    expect(
      screen.getByText("The review rule rm:forced asks you to confirm this call."),
    ).toBeTruthy();
    expect(screen.getByText("Deletes files outside the workspace")).toBeTruthy();
    expect(screen.getByText("box")).toBeTruthy();
    const code = container.querySelector('[data-part="code-block"]') as Element;
    expect(Array.from(code.textContent ?? "")).toHaveLength(300);
    expect(code.textContent?.endsWith("…")).toBe(true);
    // the empty argument box that let the owner approve blind is gone
    expect(screen.queryByLabelText(en.approval.input)).toBeNull();
  });

  it("a write asks about the path, never the tool key it carries as its command", async () => {
    const { container } = await renderInbox({
      [LIST]: () =>
        json(
          200,
          inbox([
            commandApproval({
              toolKey: "Write",
              toolName: "Write",
              command: ask({ kind: "write", command: "Write", path: "/etc/capybara/config.yaml" }),
            }),
          ]),
        ),
    });
    expect(await screen.findByText(en.approval.command.titleWrite)).toBeTruthy();
    const code = container.querySelector('[data-part="code-block"]') as Element;
    expect(code.textContent).toContain("/etc/capybara/config.yaml");
    expect(code.textContent).not.toContain("Write");
    expect(screen.getByText(en.approval.command.path)).toBeTruthy();
  });

  it("offers only the scopes the approval carries", async () => {
    await renderInbox({
      [LIST]: () =>
        json(
          200,
          inbox([commandApproval({ scopes: ["once", "session"], command: ask({ rule: null }) })]),
        ),
    });
    const scopes = await screen.findByRole("radiogroup", { name: en.approval.scopeLabel });
    expect(within(scopes).getAllByRole("radio")).toHaveLength(2);
    expect(within(scopes).getByText(en.approval.scope.session)).toBeTruthy();
    expect(within(scopes).queryByText(en.approval.scope.always)).toBeNull();
  });

  it("a classifier ask (scopes once) never shows the session scope", async () => {
    await renderInbox({
      [LIST]: () =>
        json(200, inbox([commandApproval({ scopes: ["once"], command: ask({ rule: null }) })])),
    });
    const scopes = await screen.findByRole("radiogroup", { name: en.approval.scopeLabel });
    expect(within(scopes).getAllByRole("radio")).toHaveLength(1);
    expect(within(scopes).queryByText(en.approval.scope.session)).toBeNull();
  });
});

describe("inbox: an approval that takes a file (platform web parity spec §5)", () => {
  const THUMB = "data:image/webp;base64,UklGRhIAAABXRUJQVlA4IAYAAAAwAQCdASo=";
  it("shows the file the person confirms: thumbnail, name, size and the sha256 prefix", async () => {
    const sha = "ab12cd34ef56".padEnd(64, "0");
    const { container } = await renderInbox({
      [LIST]: () =>
        json(
          200,
          inbox([
            approval("f", {
              toolKey: "Platform",
              toolName: "Platform",
              connector: null,
              input: { action: "call", operation: "agents.update-profile" },
              file: {
                name: "fox.png",
                size: 2048,
                sha256: sha,
                contentType: "image/png",
                thumbnail: THUMB,
              },
            }),
          ]),
        ),
    });
    expect(await screen.findByText("fox.png")).toBeTruthy();
    const row = container.querySelector('[data-part="file"]') as Element;
    expect(row.textContent).toContain("sha256 ab12cd34ef56");
    expect(row.textContent).not.toContain(sha);
    const img = row.querySelector('[data-part="file-thumbnail"]') as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(THUMB);
  });

  it("an approval without a file shows no file row", async () => {
    const { container } = await renderInbox({
      [LIST]: () => json(200, inbox([approval("n")])),
    });
    await screen.findByLabelText(en.approval.input);
    expect(container.querySelector('[data-part="file"]')).toBeNull();
  });
});

describe("inbox: exact permission scope and superseded asks (Task 10D)", () => {
  const LONG = `/outside/${"very-long-directory-name-".repeat(12)}end`;
  const SCOPE = {
    writeDirectories: ["/outside/reports", LONG],
    hosts: ["api.example.com", "files.example.org"],
  };
  const scoped = (over: Record<string, unknown> = {}) =>
    approval("a", {
      kind: "command",
      toolKey: "Write",
      toolName: "Write",
      connector: null,
      input: {},
      scopes: ["once"],
      command: {
        deviceId: "d1",
        deviceName: "box",
        mode: "auto",
        kind: "write",
        command: "Write",
        path: "/outside/reports/report.txt",
        rule: null,
        reason: "Writes outside the project",
        permissionScope: SCOPE,
        targetPath: "/outside/reports/report.txt",
      },
      ...over,
    });
  const values = (container: HTMLElement, k: string) =>
    [
      ...container.querySelectorAll(
        `[data-role="permission-scope"] [data-scope="${k}"] [data-pre="true"]`,
      ),
    ].map((e) => e.textContent);

  it("shows the same exact directories, hosts and separate target file as the conversation", async () => {
    const { container } = await renderInbox({ [LIST]: () => json(200, inbox([scoped()])) });
    expect(await screen.findByText(en.approval.command.titleWrite)).toBeTruthy();
    expect(values(container, "write")).toEqual(["/outside/reports", LONG]);
    // reads are never granted: no read list
    expect(values(container, "read")).toEqual([]);
    expect(values(container, "hosts")).toEqual(["api.example.com", "files.example.org"]);
    expect(values(container, "target")).toEqual(["/outside/reports/report.txt"]);
    expect(screen.getByRole("button", { name: en.approval.approve })).toBeTruthy();
  });

  it("a superseded item (a cached list) offers no approve, deny or scope", async () => {
    const { container } = await renderInbox(
      {
        [LIST]: () =>
          json(
            200,
            inbox([
              scoped({
                status: "superseded",
                supersededRevision: 5,
                supersededReason: "authority-changed",
              }),
            ]),
          ),
      },
      { locale: "zh" },
    );
    expect(await screen.findByText(zh.approval.superseded.authorityChanged)).toBeTruthy();
    expect(screen.getByText(zh.approval.decision.superseded)).toBeTruthy();
    expect(screen.queryByRole("button", { name: zh.approval.approve })).toBeNull();
    expect(screen.queryByRole("button", { name: zh.approval.deny })).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(values(container, "hosts")).toEqual(["api.example.com", "files.example.org"]);
  });

  it("a listed pending item this tab already knows as superseded loses its actions, without a read", async () => {
    const { client, calls } = await renderInbox({ [LIST]: () => json(200, inbox([scoped()])) });
    expect(await screen.findByRole("button", { name: en.approval.approve })).toBeTruthy();
    // a conversation's stream or card read it superseded meanwhile
    act(() =>
      client.setQueryData(keys.org("o1").approval("a"), {
        ...scoped(),
        status: "superseded",
        supersededRevision: 2,
        supersededReason: "user",
      }),
    );
    expect(await screen.findByText(en.approval.superseded.user)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.approval.approve })).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(calls.filter((c) => c.url.includes("/approvals/"))).toEqual([]);
  });

  it("a late decision on an item superseded meanwhile reads the inbox again and never retries", async () => {
    let listed = 0;
    const { calls } = await renderInbox({
      [LIST]: () => json(200, inbox(++listed <= 1 ? [scoped()] : [])),
      "GET /api/v1/orgs/o1/inbox/count": () => json(200, { count: 0 }),
      "POST /api/v1/orgs/o1/approvals/a/decision": () =>
        json(409, {
          error: { code: "approval.already_decided", message: "Approval already decided" },
        }),
    });
    await userEvent.setup().click(await screen.findByRole("button", { name: en.approval.approve }));
    expect(await screen.findByText(en.inbox.empty)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.filter((c) => c.url === "/api/v1/orgs/o1/inbox").length).toBeGreaterThan(0);
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
      const { container } = await renderInbox(
        {
          [LIST]: () => json(200, inbox([approval("a")], [skillChange("sc1")])),
          [DETAIL]: () => json(200, { skillChange: detail() }),
        },
        { locale },
      );
      const table = await screen.findByRole("list", { name: m.inbox.listLabel });
      expect(within(table).getByText("Fixture [tool_a]")).toBeTruthy();
      await userEvent
        .setup()
        .click(within(table).getByText("notes-style", { selector: '[data-part="list-title"]' }));
      const card = await vi.waitFor(() => {
        const el = container.querySelector('[data-skill-change-id="sc1"]') as HTMLElement | null;
        if (!el) throw new Error("no card");
        return el;
      });
      expect(within(card).getAllByText("Shared agent").length).toBeGreaterThan(0);
      expect(within(card).getAllByText("Mia").length).toBeGreaterThan(0);
      expect(personAvatarSrc(card)).toBe("/api/v1/accounts/a2/avatar?v=abc123");
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
      // the proposing conversation is the requester's: an admin reviewing it gets no link
      expect(within(card).queryByRole("button", { name: m.inbox.openConversation })).toBeNull();
    },
  );

  it("the requester sees a link to the proposing conversation", async () => {
    const { container } = await renderInbox({
      [LIST]: () => json(200, inbox([], [skillChange("sc1", { requestedBy: "a1" })])),
      [DETAIL]: () => json(200, { skillChange: detail({ requestedBy: "a1" }) }),
    });
    const table = await screen.findByRole("list", { name: en.inbox.listLabel });
    await userEvent
      .setup()
      .click(within(table).getByText("notes-style", { selector: '[data-part="list-title"]' }));
    const card = await vi.waitFor(() => {
      const el = container.querySelector('[data-skill-change-id="sc1"]') as HTMLElement | null;
      if (!el) throw new Error("no card");
      return el;
    });
    await userEvent
      .setup()
      .click(within(card).getByRole("button", { name: en.inbox.openConversation }));
    expect(router.push).toHaveBeenCalledWith("/chat/c9");
  });

  it("批准：POST decide 后重读列表、顶栏待处理数刷新", async () => {
    let changes = [skillChange("sc1")];
    const refreshPending = vi.fn();
    const { calls, client } = await renderInbox(
      {
        [LIST]: () => json(200, inbox([], changes)),
        [DETAIL]: () => json(200, { skillChange: detail() }),
        "POST /api/v1/orgs/o1/skill-changes/sc1/decide": () => {
          changes = [];
          return json(200, { skillChange: { ...skillChange("sc1"), status: "approved" } });
        },
      },
      { session: { refreshPending } },
    );
    // the visible skill change's detail is prefetched by the layout too
    expect(calls.filter((c) => c.method === "GET")).toEqual([]);
    // the sidebar's count is cached (the shell reads it)
    client.setQueryData(["org", "o1", "inboxCount"], { count: 1 });
    client.setQueryData(["org", "o1", "skills"], { skills: [] });
    client.setQueryData(["org", "o1", "components"], { items: [] });
    client.setQueryData(["org", "o1", "agentSkills", "ag1"], { skills: [] });
    const row = await screen.findByRole("region", { name: "Pending changes" });
    await userEvent
      .setup()
      .click(await within(row).findByRole("button", { name: en.inbox.skillChange.approve }));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ decision: "approve" });
    expect(await screen.findByText(en.inbox.skillChange.approved)).toBeTruthy();
    expect(await screen.findByText(en.inbox.empty)).toBeTruthy();
    expect(refreshPending).toHaveBeenCalledTimes(1);
    // the inbox is read again after the decision (once); the decided change is marked stale
    // without a read (it is hidden at once), and the sidebar's count is stale too
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/v1/orgs/o1/skill-changes/sc1/decide",
      "GET /api/v1/orgs/o1/inbox",
    ]);
    expect(client.getQueryState(["org", "o1", "skillChange", "sc1"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["org", "o1", "inboxCount"])?.isInvalidated).toBe(true);
    // approving a share creates an org skill (a version changes one): the org lists are stale too
    expect(client.getQueryState(["org", "o1", "skills"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["org", "o1", "components"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["org", "o1", "agentSkills", "ag1"])?.isInvalidated).toBe(true);
  });

  it("拒绝失败（已被处理）：toast 显示 skill_change.already_decided 的文案", async () => {
    await renderInbox(
      {
        [LIST]: () => json(200, inbox([], [skillChange("sc1")])),
        [DETAIL]: () => json(200, { skillChange: detail() }),
        "POST /api/v1/orgs/o1/skill-changes/sc1/decide": () =>
          json(409, { error: { code: "skill_change.already_decided", message: "x" } }),
      },
      { locale: "zh" },
    );
    const row = await screen.findByRole("region", { name: "待提交改动" });
    await userEvent
      .setup()
      .click(await within(row).findByRole("button", { name: zh.inbox.skillChange.reject }));
    expect(await screen.findByText(zh.errors.skill_change.already_decided)).toBeTruthy();
  });

  it("新技能（没有当前版本）：全部文件为新增；共享申请显示共享说明、没有发起会话时不显示打开会话；列表被截断时提示", async () => {
    const { container } = await renderInbox({
      [LIST]: () =>
        json(
          200,
          inbox(
            [],
            [
              skillChange("sc1", {
                kind: "share",
                version: 1,
                requestedBy: "a1",
                requestedInConversation: null,
                conversationPath: null,
              }),
            ],
            true,
          ),
        ),
      [DETAIL]: () =>
        json(200, {
          skillChange: detail({ kind: "share", version: 1, requestedBy: "a1", current: null }),
        }),
    });
    expect(await screen.findByText(en.inbox.truncated)).toBeTruthy();
    const card = await vi.waitFor(() => {
      const el = container.querySelector('[data-skill-change-id="sc1"]') as HTMLElement | null;
      if (!el) throw new Error("no card");
      return el;
    });
    expect(await within(card).findByText(`SKILL.md · ${en.inbox.skillChange.added}`)).toBeTruthy();
    expect(within(card).getByText(en.inbox.skillChange.newSkill)).toBeTruthy();
    expect(within(card).getByText(en.inbox.skillChange.shareHint)).toBeTruthy();
    // a share request has no proposing conversation to open
    expect(within(card).queryByRole("button", { name: en.inbox.openConversation })).toBeNull();
    const diff = within(card).getByLabelText(
      en.inbox.skillChange.diffLabel.replace("{path}", "SKILL.md"),
    );
    expect(diff.textContent).toContain("+ # Notes");
  });
});

describe("inbox: skill change kinds", () => {
  it.each(LOCALES)("each row names its kind: share or new version (%s)", async (locale) => {
    const m = msgs[locale];
    await renderInbox(
      {
        [LIST]: () =>
          json(
            200,
            inbox(
              [],
              [
                skillChange("sc1", { kind: "share", name: "alpha" }),
                skillChange("sc2", { kind: "version", name: "beta" }),
              ],
            ),
          ),
        "GET /api/v1/orgs/o1/skill-changes/sc1": () => json(404, { error: { code: "x" } }),
        "GET /api/v1/orgs/o1/skill-changes/sc2": () => json(404, { error: { code: "x" } }),
      },
      { locale },
    );
    const table = await screen.findByRole("list", { name: m.inbox.listLabel });
    const rowOf = (name: string) =>
      within(table)
        .getAllByRole("listitem")
        .find((r) => r.textContent?.includes(name)) as HTMLElement;
    expect(rowOf("alpha").textContent).toContain(
      `${m.inbox.skillChange.kind.share} · Shared agent`,
    );
    expect(rowOf("beta").textContent).toContain(
      `${m.inbox.skillChange.kind.version} · Shared agent`,
    );
  });
});

describe("inbox: my decided requests", () => {
  const request = (status: "approved" | "rejected", reason: string | null = null) => ({
    id: "r1",
    orgId: "o1",
    orgName: "Acme",
    kind: "enable",
    item: { id: "11111111-1111-4111-8111-111111111111", name: "crm", displayName: null },
    entry: null,
    status,
    note: "",
    reason,
    requestedBy: "a1",
    requestedByName: "Grant",
    decidedBy: "a2",
    decidedAt: T,
    stagingId: null,
    createdAt: T,
  });
  const withDecided = (r: ReturnType<typeof request> | null) => ({
    items:
      r === null ? [] : [{ type: "catalog_request_decided", id: r.id, createdAt: T, request: r }],
    truncated: false,
  });

  it.each(LOCALES)("an approved request shows and is dismissed (%s)", async (locale) => {
    const m = msgs[locale];
    let open: ReturnType<typeof request> | null = request("approved");
    const { calls } = await renderInbox(
      {
        [LIST]: () => json(200, withDecided(open)),
        "POST /api/v1/orgs/o1/catalog-requests/r1/dismiss": () => {
          open = null;
          return noContent();
        },
      },
      { locale },
    );
    const table = await screen.findByRole("list", { name: m.inbox.listLabel });
    expect(within(table).getByText("crm", { selector: '[data-part="list-title"]' })).toBeTruthy();
    expect(
      within(table).getByText(
        `${m.inbox.requestDecided.label} · ${m.inbox.requestDecided.approved}`,
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText(m.inbox.requestDecided.titleApproved.replace("{name}", "crm")),
    ).toBeTruthy();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: m.inbox.requestDecided.dismiss }));
    expect(await screen.findByText(m.inbox.empty)).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/v1/orgs/o1/catalog-requests/r1/dismiss",
      "GET /api/v1/orgs/o1/inbox",
    ]);
  });

  it("a rejected request shows the reason", async () => {
    await renderInbox({ [LIST]: () => json(200, withDecided(request("rejected", "Not now."))) });
    expect(
      await screen.findByText(en.inbox.requestDecided.titleRejected.replace("{name}", "crm")),
    ).toBeTruthy();
    expect(screen.getByText("Not now.")).toBeTruthy();
  });
});

describe("the inbox from the cache", () => {
  it("a first render from the hydrated cache makes no browser read; a refused skill change detail shows its error", async () => {
    const browser = expectNoFirstPaintFetch();
    const { container } = await renderRouteWithCache("/inbox", {
      [LIST]: () => json(200, inbox([], [skillChange("sc1")])),
      "GET /api/v1/orgs/o1/skill-changes/sc1": () =>
        json(404, { error: { code: "skill_change.not_found", message: "x" } }),
    });
    const card = container.querySelector('[data-skill-change-id="sc1"]') as HTMLElement;
    expect(within(card).getByRole("alert")).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(browser).toEqual([]);
  });

  it("an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/inbox", {
      [LIST]: async () => {
        await held;
        return json(200, inbox([approval("a")]));
      },
    });
    await vi.waitFor(() => {
      if (document.querySelector('[data-template="InboxPage"]') === null) throw new Error("none");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("Fixture [tool_a]")).toBeNull();
    // the loaded inbox opens its first item: its four facts and the decision row, its buttons
    // disabled until the item is here
    expect(document.querySelector('[data-part="list-detail-facts"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-part="loading-inspector-row"]')).toHaveLength(4);
    expect(document.querySelectorAll('[data-part="action-row"]')).toHaveLength(1);
    const approve = screen.getByRole("button", { name: en.approval.approve }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    // the head shows no pending count while the inbox loads (not "0")
    const count = () => document.querySelector('[data-part="page-header"] .cb-pageheader-count');
    expect(count()).toBeNull();
    await act(async () => release());
    expect(await screen.findAllByText("Fixture [tool_a]")).not.toHaveLength(0);
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
    // the head's count is the pending number
    expect(count()?.textContent).toBe("1");
  });
});

describe("已记住的授权（SettingsPage）", () => {
  it.each(LOCALES)("列出授权，撤销 → DELETE 后重读（%s）", async (locale) => {
    const m = msgs[locale];
    let grants = [
      {
        agentId: "ag1",
        agentName: "Echo agent",
        toolKey: "mcp__fixture__delete_item",
        specHash: "h",
        createdAt: T,
      },
    ];
    const calls = stubApi({
      "GET /api/v1/orgs/o1/me/tool-grants": () => json(200, { grants }),
      "DELETE /api/v1/orgs/o1/me/tool-grants/ag1/mcp__fixture__delete_item": () => {
        grants = [];
        return noContent();
      },
    });
    const { container } = await renderRouteWithCache("/account/grants", lastStubRoutes(), {
      locale,
    });
    expect(container.querySelector('[data-template="SettingsPage"]')).not.toBeNull();
    expect(
      screen.getByRole("link", { name: m.connections.nav.grants }).getAttribute("aria-current"),
    ).toBe("page");
    // the label, with the raw key kept as secondary text
    expect(await screen.findByText("fixture [delete_item]")).toBeTruthy();
    expect(screen.getByText("mcp__fixture__delete_item")).toBeTruthy();
    await userEvent.setup().click(
      screen.getByRole("button", {
        name: m.connections.grants.revokeLabel
          .replace("{tool}", "fixture [delete_item]")
          .replace("{agent}", "Echo agent"),
      }),
    );
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(await screen.findByText(m.connections.grants.empty)).toBeTruthy();
  });
});

type N = (typeof msgs)["en"]["inbox"]["orgNotice"];

describe("inbox: org notices of phase 3 (org admins)", () => {
  type Case = {
    kind: string;
    detail: Record<string, unknown>;
    label: (n: N) => string;
    row: string;
    title: (n: N, a: string) => string;
    extra?: (n: N) => string;
  };
  const ref = { kind: "plugin", id: "i1" };
  const cases: Case[] = [
    {
      kind: "item_shared",
      detail: { ref, name: "crm", org: { id: "o2", name: "Beta" } },
      label: (n) => n.itemSharedLabel,
      row: "crm",
      title: (n) => n.itemSharedTitle.replace("{name}", "crm").replace("{org}", "Beta"),
    },
    {
      kind: "item_shared",
      detail: { ref, name: "crm", org: "all_orgs" },
      label: (n) => n.itemSharedLabel,
      row: "crm",
      title: (n) => n.itemSharedAllTitle.replace("{name}", "crm"),
    },
    {
      kind: "shared_item_updated",
      detail: {
        ref,
        name: "crm",
        from: "1.0.0",
        to: "1.1.0",
        owner: { kind: "org", orgId: "o9", name: "Acme" },
      },
      label: (n) => n.sharedItemUpdatedLabel,
      row: "crm",
      title: (n) =>
        n.sharedItemUpdatedTitle
          .replace("{owner}", "Acme")
          .replace("{name}", "crm")
          .replace("{from}", "v1.0.0")
          .replace("{to}", "v1.1.0"),
      extra: () => "Acme",
    },
    {
      kind: "upload_confirmed",
      detail: { itemId: "i1", name: "crm", version: "2.0.0" },
      label: (n) => n.uploadConfirmedLabel,
      row: "crm",
      title: (n) => n.uploadConfirmedTitle.replace("{name}", "crm").replace("{version}", "v2.0.0"),
    },
    {
      kind: "upload_rejected",
      detail: { itemId: "i1", name: "crm", version: "2.0.0", reason: "too broad" },
      label: (n) => n.uploadRejectedLabel,
      row: "crm",
      title: (n) => n.uploadRejectedTitle.replace("{name}", "crm").replace("{version}", "v2.0.0"),
      extra: () => "too broad",
    },
  ];

  it.each(LOCALES.flatMap((locale) => cases.map((c, i) => [locale, c.kind, i] as const)))(
    "shows %s %s (case %i) and dismisses it",
    async (locale, _kind, i) => {
      const c = cases[i] as Case;
      const n = msgs[locale].inbox.orgNotice;
      let open = true;
      const notice = { id: "n1", kind: c.kind, createdAt: T, detail: c.detail };
      const { calls } = await renderInbox(
        {
          [LIST]: () =>
            json(200, {
              items: open ? [{ type: c.kind, id: "n1", createdAt: T, notice }] : [],
              truncated: false,
            }),
          "POST /api/v1/orgs/o1/inbox/notices/n1/dismiss": () => {
            open = false;
            return noContent();
          },
        },
        { locale },
      );
      const table = await screen.findByRole("list", { name: msgs[locale].inbox.listLabel });
      // The row leads with the item's name; what kind of notice it is comes second
      const name = within(table).getByText(c.row, { selector: '[data-part="list-title"]' });
      const row = name.closest("li") as HTMLElement;
      expect(row.textContent).toContain(c.label(n));
      expect(await screen.findByText(c.title(n, ""))).toBeTruthy();
      if (c.extra) expect(screen.getAllByText(c.extra(n)).length).toBeGreaterThan(0);
      await userEvent.setup().click(screen.getByRole("button", { name: n.dismiss }));
      expect(await screen.findByText(n.dismissed)).toBeTruthy();
      expect(calls.map((x) => `${x.method} ${x.url}`)[0]).toBe(
        "POST /api/v1/orgs/o1/inbox/notices/n1/dismiss",
      );
    },
  );

  it.each([
    [
      "zh",
      "item_shared",
      { ref, name: "crm", org: { id: "o2", name: "Beta" } },
      "Beta 现在可以使用 crm",
      null,
    ],
    ["zh", "item_shared", { ref, name: "crm", org: "all_orgs" }, "所有组织现在可以使用 crm", null],
    [
      "zh",
      "shared_item_updated",
      {
        ref,
        name: "crm",
        from: "1.0.0",
        to: "1.1.0",
        owner: { kind: "org", orgId: "o9", name: "Acme" },
      },
      "Acme 更新了 crm：v1.0.0 → v1.1.0",
      null,
    ],
    [
      "zh",
      "shared_item_updated",
      { ref, name: "crm", from: "1", to: "2", owner: { kind: "platform" } },
      "平台 更新了 crm：v1 → v2",
      null,
    ],
    [
      "zh",
      "upload_confirmed",
      { itemId: "i1", name: "crm", version: "2.0.0" },
      "超级管理员已确认 crm v2.0.0",
      null,
    ],
    [
      "zh",
      "upload_rejected",
      { itemId: "i1", name: "crm", version: "2.0.0", reason: "权限太宽" },
      "超级管理员未通过 crm v2.0.0",
      "权限太宽",
    ],
    [
      "en",
      "item_shared",
      { ref, name: "crm", org: { id: "o2", name: "Beta" } },
      "Beta can now use crm",
      null,
    ],
    [
      "en",
      "item_shared",
      { ref, name: "crm", org: "all_orgs" },
      "All organizations can now use crm",
      null,
    ],
    [
      "en",
      "upload_rejected",
      { itemId: "i1", name: "crm", version: "2.0.0", reason: null },
      "The super admin did not approve crm v2.0.0",
      null,
    ],
  ] as const)("%s %s reads as the spec says (%s)", async (locale, kind, detail, title, reason) => {
    const n = msgs[locale].inbox.orgNotice;
    const notice = { id: "n1", kind, createdAt: T, detail };
    await renderInbox(
      {
        [LIST]: () =>
          json(200, { items: [{ type: kind, id: "n1", createdAt: T, notice }], truncated: false }),
      },
      { locale },
    );
    expect(await screen.findByText(title)).toBeTruthy();
    if (reason !== null) expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
    if (kind === "upload_rejected" && reason === null)
      expect(screen.queryByText(n.reason)).toBeNull();
  });

  it.each(LOCALES)(
    "an upload notice names the plugin by its display name and the version as v0.1.0, never cut (%s)",
    async (locale) => {
      const n = msgs[locale].inbox.orgNotice;
      const displayName = { zh: "会议纪要", en: "Meeting minutes" };
      const notice = {
        id: "n1",
        kind: "upload_confirmed",
        createdAt: T,
        detail: { itemId: "i1", name: "acc-minutes", displayName, version: "0.1.0" },
      };
      await renderInbox(
        {
          [LIST]: () =>
            json(200, {
              items: [{ type: "upload_confirmed", id: "n1", createdAt: T, notice }],
              truncated: false,
            }),
        },
        { locale },
      );
      const table = await screen.findByRole("list", { name: msgs[locale].inbox.listLabel });
      const name = within(table).getByText(displayName[locale]);
      expect(name.getAttribute("title")).toBe(displayName[locale]);
      const version = within(name.closest("li") as HTMLElement).getByText("v0.1.0");
      expect(version.getAttribute("data-part")).toBe("list-trailing");
      expect(within(table).queryByText("acc-minutes", { exact: false })).toBeNull();
      expect(
        await screen.findByText(
          n.uploadConfirmedTitle
            .replace("{name}", displayName[locale])
            .replace("{version}", "v0.1.0"),
        ),
      ).toBeTruthy();
    },
  );

  it.each(LOCALES)(
    "item_shared and shared_item_updated name a plugin by its display name (%s)",
    async (locale) => {
      const n = msgs[locale].inbox.orgNotice;
      const displayName = { zh: "客户管理", en: "CRM suite" };
      const shared = {
        id: "n1",
        kind: "item_shared",
        createdAt: T,
        detail: { ref, name: "acc-crm", displayName, org: { id: "o2", name: "Beta" } },
      };
      const updated = {
        id: "n2",
        kind: "shared_item_updated",
        createdAt: T,
        detail: {
          ref,
          name: "acc-crm",
          displayName,
          from: "1.0.0",
          to: "1.1.0",
          owner: { kind: "org", orgId: "o9", name: "Acme" },
        },
      };
      await renderInbox(
        {
          [LIST]: () =>
            json(200, {
              items: [
                { type: "item_shared", id: "n1", createdAt: T, notice: shared },
                { type: "shared_item_updated", id: "n2", createdAt: T, notice: updated },
              ],
              truncated: false,
            }),
        },
        { locale },
      );
      const table = await screen.findByRole("list", { name: msgs[locale].inbox.listLabel });
      const names = within(table).getAllByText(displayName[locale], {
        selector: '[data-part="list-title"]',
      });
      expect(names).toHaveLength(2);
      expect(within(table).queryByText("acc-crm", { exact: false })).toBeNull();
      expect(within(names[1]?.closest("li") as HTMLElement).getByText("v1.1.0")).toBeTruthy();
      expect(
        await screen.findByText(
          n.itemSharedTitle.replace("{name}", displayName[locale]).replace("{org}", "Beta"),
        ),
      ).toBeTruthy();
    },
  );

  it("an unknown notice kind renders a generic notice and an unknown item type is skipped", async () => {
    const n = msgs.en.inbox.orgNotice;
    await renderInbox({
      [LIST]: () =>
        json(200, {
          items: [
            {
              type: "future_kind",
              id: "n1",
              createdAt: T,
              notice: { id: "n1", kind: "future_kind", createdAt: T, detail: {} },
            },
            { type: "mystery", id: "x1", createdAt: T },
          ],
          truncated: false,
        }),
    });
    const table = await screen.findByRole("list", { name: msgs.en.inbox.listLabel });
    expect(within(table).getByText(n.unknownLabel)).toBeTruthy();
    expect(within(table).getAllByRole("listitem")).toHaveLength(1);
  });
});

describe("inbox: my automation needs me", () => {
  const S = en.inboxAutomation;
  const attention = (over: Record<string, unknown> = {}) => ({
    items: [
      {
        type: "automation_attention",
        id: "s1:grants",
        createdAt: T,
        attention: {
          taskId: "s1",
          name: "Daily report",
          reason: "missing_grants",
          pausedBy: null,
          missing: ["Bash", "mcp__crm__delete", "connection:github"],
          needsRole: ["mcp__crm__delete"],
          error: null,
          ...over,
        },
      },
    ],
    truncated: false,
  });

  it.each(LOCALES)(
    "refused tools: add, needs a role, connect; the primary opens the task (%s)",
    async (locale) => {
      const m = msgs[locale];
      const { calls } = await renderInbox(
        {
          [LIST]: () => json(200, attention()),
          "POST /api/v1/orgs/o1/automations/s1/grants": () =>
            json(200, { items: [{ toolKey: "Bash", specHash: "h", connectorId: null }] }),
          "GET /api/v1/orgs/o1/inbox/count": () => json(200, { count: 0, more: false }),
        },
        { locale },
      );
      const table = await screen.findByRole("list", { name: m.inbox.listLabel });
      expect(
        within(table).getByText(
          `${m.inboxAutomation.label} · ${m.inboxAutomation.reason.missing_grants}`,
        ),
      ).toBeTruthy();
      const missing = within(screen.getByRole("list", { name: m.inboxAutomation.missing }));
      expect(missing.getByText(m.inboxAutomation.needsRole)).toBeTruthy();
      expect(
        missing.getByRole("link", { name: m.inboxAutomation.connect.replace("{slug}", "github") }),
      ).toBeTruthy();
      const user = userEvent.setup();
      // only Bash can be added (the role-gated tool has no button)
      const add = missing.getAllByRole("button", { name: m.inboxAutomation.add });
      expect(add).toHaveLength(1);
      await user.click(add[0] as HTMLElement);
      expect(
        bodyOf(calls.find((c) => c.method === "POST" && c.url.endsWith("/automations/s1/grants"))),
      ).toEqual({ grants: [{ toolKey: "Bash" }] });
      await user.click(screen.getByRole("button", { name: m.inboxAutomation.open }));
      expect(router.push).toHaveBeenCalledWith("/automations/s1");
    },
  );

  it("an admin's pause names the admin", async () => {
    await renderInbox({
      [LIST]: () =>
        json(
          200,
          attention({
            reason: "admin",
            pausedBy: { id: "a2", name: "Mei" },
            missing: [],
            needsRole: [],
          }),
        ),
    });
    expect(
      (await screen.findAllByText(S.reason.admin.replace("{name}", "Mei"), { exact: false }))
        .length,
    ).toBeGreaterThan(0);
  });
  it("an admin's pause whose admin has left names a former member", async () => {
    await renderInbox({
      [LIST]: () =>
        json(200, attention({ reason: "admin", pausedBy: null, missing: [], needsRole: [] })),
    });
    expect(
      (
        await screen.findAllByText(S.reason.admin.replace("{name}", en.people.departed), {
          exact: false,
        })
      ).length,
    ).toBeGreaterThan(0);
  });
  it("a failed latest run says so, with its error", async () => {
    await renderInbox({
      [LIST]: () =>
        json(
          200,
          attention({
            reason: "failed",
            missing: [],
            needsRole: [],
            error: "The model is not available",
          }),
        ),
    });
    expect((await screen.findAllByText(S.reason.failed, { exact: false })).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("The model is not available")).toBeTruthy();
  });
});

describe("inbox: network requests (network ask spec §5.3)", () => {
  const NR = en.inbox.network;
  const request = (over: Record<string, unknown> = {}) => ({
    id: "r9",
    orgId: "o1",
    orgName: "Acme",
    kind: "network_allowlist",
    item: null,
    entry: null,
    agent: null,
    connectors: null,
    network: { hosts: ["files.slack.com"], conversationId: "c7", agentId: "ag1" },
    status: "pending",
    note: "For the weekly export",
    reason: null,
    requestedBy: "a3",
    requestedByName: "Mia",
    requestedByAvatarUrl: null,
    decidedBy: null,
    decidedAt: null,
    stagingId: null,
    createdAt: T,
    ...over,
  });
  const inbox = (type: string, r: ReturnType<typeof request> | null) => ({
    items: r === null ? [] : [{ type, id: r.id, createdAt: T, request: r }],
    truncated: false,
  });

  it("a requester who left is titled a former member, never a dash or an id", async () => {
    const r = request({ requestedBy: "gone", requestedByName: null });
    await renderInbox({ [LIST]: () => json(200, inbox("catalog_request", r)) });
    expect(await screen.findByText(NR.title.replace("{name}", en.people.departed))).toBeTruthy();
    expect(document.body.textContent).not.toContain("gone");
  });

  it("an org admin sees the hosts, who asked, the note and the conversation; approving decides it", async () => {
    let open: ReturnType<typeof request> | null = request();
    const { calls } = await renderInbox({
      [LIST]: () => json(200, inbox("catalog_request", open)),
      "POST /api/v1/orgs/o1/catalog-requests/r9/decide": () => {
        const r = request({ status: "approved" });
        open = null;
        return json(200, { request: r });
      },
      "GET /api/v1/orgs/o1/inbox/count": () => json(200, { count: 0, more: false }),
    });
    const table = await screen.findByRole("list", { name: en.inbox.listLabel });
    expect(within(table).getByText("files.slack.com", { selector: '[data-part="list-title"]' }));
    expect(within(table).getByText(`${NR.label} · Mia`)).toBeTruthy();
    expect(await screen.findByText(NR.title.replace("{name}", "Mia"))).toBeTruthy();
    expect(screen.getByText("For the weekly export")).toBeTruthy();
    // the requester without an avatar draws the initial
    expect(personAvatarSrc(document.body)).toBeNull();
    expect(personInitial(document.body)).toBe("M");
    expect(screen.getByRole("link", { name: en.inbox.openConversation }).getAttribute("href")).toBe(
      "/chat/c7",
    );
    await userEvent.setup().click(screen.getByRole("button", { name: NR.approve }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.url.endsWith("/catalog-requests/r9/decide")))).toEqual({
        approve: true,
      }),
    );
    expect(await screen.findByText(NR.approved)).toBeTruthy();
  });

  it("the requester's decided notice says the domains are allowed and links the conversation", async () => {
    await renderInbox({
      [LIST]: () =>
        json(200, inbox("catalog_request_decided", request({ status: "approved", decidedAt: T }))),
    });
    expect(
      await screen.findByText(NR.titleApproved.replace("{hosts}", "files.slack.com")),
    ).toBeTruthy();
    expect(screen.getByText(NR.hintApproved)).toBeTruthy();
    expect(screen.getByRole("link", { name: en.inbox.openConversation }).getAttribute("href")).toBe(
      "/chat/c7",
    );
  });
});

describe("inbox: a task refused domains", () => {
  const S = en.inboxAutomation;
  const attention = (over: Record<string, unknown> = {}) => ({
    items: [
      {
        type: "automation_attention",
        id: "s1:grants",
        createdAt: T,
        attention: {
          taskId: "s1",
          name: "Daily report",
          reason: "missing_grants",
          pausedBy: null,
          missing: ["network:files.slack.com", "network:api.example.com"],
          needsRole: [],
          needsAdmin: ["network:api.example.com"],
          error: null,
          ...over,
        },
      },
    ],
    truncated: false,
  });

  it("a domain the org allows can be added; one outside it needs an admin", async () => {
    const { calls } = await renderInbox({
      [LIST]: () => json(200, attention()),
      "POST /api/v1/orgs/o1/automations/s1/grants": () =>
        json(200, {
          items: [{ toolKey: "network:files.slack.com", specHash: "network", connectorId: null }],
        }),
      "GET /api/v1/orgs/o1/inbox/count": () => json(200, { count: 0, more: false }),
    });
    const missing = within(await screen.findByRole("list", { name: S.missing }));
    expect(missing.getByText("files.slack.com")).toBeTruthy();
    expect(missing.getByText(S.needsAdmin)).toBeTruthy();
    const add = missing.getAllByRole("button", { name: S.addDomain });
    expect(add).toHaveLength(1);
    await userEvent.setup().click(add[0] as HTMLElement);
    expect(
      bodyOf(calls.find((c) => c.method === "POST" && c.url.endsWith("/automations/s1/grants"))),
    ).toEqual({ grants: [{ toolKey: "network:files.slack.com" }] });
  });
});

describe("requesters who left", () => {
  it("are null (drawn as a former member), never their raw account id", () => {
    expect(
      skillChangeRequester({
        requestedBy: "gone",
        requestedByName: "",
        requestedByAvatarUrl: null,
      }),
    ).toBeNull();
    expect(
      skillChangeRequester({
        requestedBy: "a2",
        requestedByName: "Bo",
        requestedByAvatarUrl: null,
      }),
    ).toEqual({ id: "a2", name: "Bo", avatarUrl: null });
    expect(
      catalogRequester({ requestedBy: "gone", requestedByName: null, requestedByAvatarUrl: null }),
    ).toBeNull();
  });
});

describe("personal inbox items", () => {
  const pluginItem = (over: Record<string, unknown> = {}) => ({
    id: "i1",
    source: "plugin",
    plugin: "tracker",
    pluginName: { zh: "项目", en: "Projects" },
    kind: "item.assigned",
    title: "CAP-12 was assigned to you",
    body: "Export reports as PDF",
    link: "/p/tracker/items?key=CAP-12",
    actions: [
      { id: "accept", label: { zh: "接受", en: "Accept" }, style: "primary" },
      { id: "reassign", label: { zh: "转派", en: "Reassign" } },
    ],
    expiresAt: "2026-11-30T12:00:00.000Z",
    createdAt: T,
    ...over,
  });
  const listed = (items: ReturnType<typeof pluginItem>[]) => ({
    items: items.map((i) => ({ type: "item", id: i.id, createdAt: i.createdAt, item: i })),
    truncated: false,
  });

  it.each(LOCALES)(
    "shows the item under its plugin's name; a button runs its action and closes it (%s)",
    async (locale) => {
      const m = msgs[locale];
      let open = true;
      const { calls } = await renderInbox(
        {
          [LIST]: () => json(200, listed(open ? [pluginItem()] : [])),
          "POST /api/v1/orgs/o1/inbox/items/i1/actions/accept": () => {
            open = false;
            return json(200, { toast: { zh: "已接受", en: "Accepted" } });
          },
        },
        { locale },
      );
      const table = await screen.findByRole("list", { name: m.inbox.listLabel });
      const name = within(table).getByText("CAP-12 was assigned to you", {
        selector: '[data-part="list-title"]',
      });
      expect((name.closest("li") as HTMLElement).textContent).toContain(
        locale === "zh" ? "项目" : "Projects",
      );
      expect(await screen.findByText("Export reports as PDF")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: locale === "zh" ? "转派" : "Reassign" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: m.inbox.item.dismiss })).toBeTruthy();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: locale === "zh" ? "接受" : "Accept" }));
      expect(await screen.findByText(locale === "zh" ? "已接受" : "Accepted")).toBeTruthy();
      expect(calls[0]).toMatchObject({
        method: "POST",
        url: "/api/v1/orgs/o1/inbox/items/i1/actions/accept",
      });
      expect(bodyOf(calls[0])).toEqual({ locale });
      expect(await screen.findByText(m.inbox.empty)).toBeTruthy();
    },
  );

  it("dismiss closes it without pressing a button", async () => {
    let open = true;
    const { calls } = await renderInbox({
      [LIST]: () => json(200, listed(open ? [pluginItem()] : [])),
      "POST /api/v1/orgs/o1/inbox/items/i1/dismiss": () => {
        open = false;
        return noContent();
      },
    });
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: en.inbox.item.dismiss }));
    expect(await screen.findByText(en.inbox.item.dismissed)).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.url}`)[0]).toBe(
      "POST /api/v1/orgs/o1/inbox/items/i1/dismiss",
    );
  });

  it.each(LOCALES)(
    "a platform item reads its kind's own copy and opens its link (%s)",
    async (locale) => {
      const m = msgs[locale];
      await renderInbox(
        {
          [LIST]: () =>
            json(
              200,
              listed([
                pluginItem({
                  source: "kernel",
                  plugin: null,
                  pluginName: null,
                  kind: "automation_depth_stopped",
                  title: "Nightly triage",
                  body: "An English fallback the web does not show.",
                  link: "/automations/a1",
                  actions: [],
                }),
              ]),
            ),
        },
        { locale },
      );
      const table = await screen.findByRole("list", { name: m.inbox.listLabel });
      const row = within(table)
        .getByText("Nightly triage", { selector: '[data-part="list-title"]' })
        .closest("li") as HTMLElement;
      expect(row.textContent).toContain(
        `${m.inbox.item.platform} · ${m.inbox.item.kinds.automation_depth_stopped.label}`,
      );
      expect(
        await screen.findByText(m.inbox.item.kinds.automation_depth_stopped.hint),
      ).toBeTruthy();
      expect(screen.queryByText("An English fallback the web does not show.")).toBeNull();
      await userEvent.setup().click(screen.getByRole("button", { name: m.inbox.item.open }));
      expect(router.push).toHaveBeenCalledWith("/automations/a1");
    },
  );

  it("a failed click shows the error copy and reads the inbox again", async () => {
    const { calls } = await renderInbox({
      [LIST]: () => json(200, listed([pluginItem()])),
      "POST /api/v1/orgs/o1/inbox/items/i1/actions/accept": () =>
        json(404, { error: { code: "inbox.item_not_found", message: "Inbox item not found" } }),
    });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Accept" }));
    expect(await screen.findByText(en.errors.inbox.item_not_found)).toBeTruthy();
    await waitFor(() =>
      expect(calls.map((c) => `${c.method} ${c.url}`)).toContain("GET /api/v1/orgs/o1/inbox"),
    );
  });
});
