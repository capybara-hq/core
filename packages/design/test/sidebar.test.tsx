import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactElement, StrictMode, useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesignProvider,
  LinkPendingMark,
  type SetupStep,
  Sidebar,
  type SidebarConversations,
  type SidebarFilter,
  type SidebarGroup,
  type SidebarProps,
  untitledLabel,
} from "../src/index";

const zh = (ui: ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

const STORE_KEY = "cap.sidebar.collapsed";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m);

function group(agentId: string, agentName: string, n: number, more = false): SidebarGroup {
  return {
    agentId,
    agentName,
    conversations: Array.from({ length: n }, (_, i) => ({
      id: `${agentId}-c${i + 1}`,
      title: `${agentName} 会话 ${i + 1}`,
      startedAt: at(20 + i, 9, 0),
      href: `/chat/${agentId}-c${i + 1}`,
      activity: null,
    })),
    more,
    onMore: vi.fn(),
    onNew: vi.fn(),
  };
}

/** Work-context props: the conversations are always there. */
type WorkProps = SidebarProps & { conversations: SidebarConversations };

function props(over: Partial<SidebarProps> = {}): WorkProps {
  return {
    context: {
      kind: "work",
      org: { name: "示例组织", initial: "示", slug: "demo", role: "所有者", menu: [] },
      primary: [
        { id: "agents", label: "Agents", href: "/agents", icon: "agent" },
        { id: "skills", label: "技能", href: "/skills", icon: "skills" },
        { id: "connectors", label: "连接器", href: "/connectors", icon: "connector" },
      ],
      inbox: { href: "/inbox", count: 120 },
      more: [
        { id: "plugins", label: "插件", href: "/plugins", icon: "catalog" },
        { id: "settings", label: "组织设置", href: "/settings/organization", icon: "settings" },
      ],
    },
    newConversation: { href: "/chat" },
    activeNav: "agents",
    conversations: {
      state: "ready",
      groups: [group("agt_a", "研究助手", 2, true), group("agt_b", "客服分流", 1)],
      moreGroups: false,
      onMoreGroups: vi.fn(),
      onRetry: vi.fn(),
      filter: { q: "", state: "all", onChange: vi.fn() },
      archived: { count: 0, open: false, onOpenChange: vi.fn() },
      onRename: vi.fn(async () => {}),
      onArchive: vi.fn(async () => {}),
      onDelete: vi.fn(async () => {}),
    },
    account: { name: "grant", menu: [] },
    onOpenCommands: vi.fn(),
    ...over,
  };
}

const mainNav = () => screen.getByRole("navigation", { name: "主导航" });
const convSection = () => screen.getByRole("region", { name: "会话" });

const workOf = (p: SidebarProps) => {
  if (p.context.kind !== "work") throw new Error("work context expected");
  return p.context;
};

describe("Sidebar navigation (work context)", () => {
  it("new conversation, primary items, then 更多; aria-current on activeNav", () => {
    zh(<Sidebar {...props()} />);
    const nav = mainNav();
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["新会话", "Agents", "技能", "连接器"]);
    // search and the inbox are not menu items any more
    expect(within(nav).queryByRole("button", { name: "搜索 ⌘K" })).toBeNull();
    expect(within(nav).queryByRole("link", { name: /收件箱/ })).toBeNull();
    expect(within(nav).getByRole("button", { name: "更多" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Agents" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(within(nav).getByRole("link", { name: "技能" }).getAttribute("aria-current")).toBeNull();
    expect(within(nav).getByRole("link", { name: "新会话" }).getAttribute("href")).toBe("/chat");
  });

  it("activeNav `new` marks New conversation current (the new conversation is the home)", () => {
    zh(<Sidebar {...props({ activeNav: "new" })} />);
    const nav = mainNav();
    const current = within(nav)
      .getAllByRole("link")
      .filter((l) => l.getAttribute("aria-current") === "page");
    expect(current.map((l) => l.textContent)).toEqual(["新会话"]);
    // the roving tab stop starts there
    expect(within(nav).getByRole("link", { name: "新会话" }).tabIndex).toBe(0);
    expect(
      within(nav).getByRole("button", { name: "更多" }).getAttribute("data-active"),
    ).toBeNull();
  });

  it("the brand row holds the logo, then the search and inbox icon buttons", () => {
    zh(<Sidebar {...props()} />);
    const top = document.querySelector('[data-part="brand-row"]') as HTMLElement;
    expect(top.querySelector(".cb-logo")).not.toBeNull();
    const search = within(top).getByRole("button", { name: "搜索 ⌘K" });
    const inbox = within(top).getByRole("link", { name: "收件箱，99+ 项待处理" });
    expect(inbox.getAttribute("href")).toBe("/inbox");
    expect(inbox.querySelector('[data-part="inbox-badge"]')?.textContent).toBe("99+");
    expect(search.compareDocumentPosition(inbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("inbox: a badge only with pending items; n+ when truncated; current on /inbox", () => {
    const p = props();
    zh(<Sidebar {...p} context={{ ...workOf(p), inbox: { href: "/inbox", count: 0 } }} />);
    const inbox = screen.getByRole("link", { name: "收件箱" });
    expect(inbox.querySelector('[data-part="inbox-badge"]')).toBeNull();
    cleanup();
    zh(
      <Sidebar
        {...p}
        activeNav="inbox"
        context={{ ...workOf(p), inbox: { href: "/inbox", count: 3, countMore: true } }}
      />,
    );
    const more = screen.getByRole("link", { name: "收件箱，3+ 项待处理" });
    expect(more.getAttribute("aria-current")).toBe("page");
  });

  it("search opens the command palette", async () => {
    const p = props();
    zh(<Sidebar {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "搜索 ⌘K" }));
    expect(p.onOpenCommands).toHaveBeenCalledTimes(1);
  });

  it("work context shows the org switcher and opens its menu", async () => {
    const onSelect = vi.fn();
    const p = props();
    const org = workOf(p).org;
    if (!org) throw new Error("org expected");
    zh(
      <Sidebar
        {...p}
        context={{
          ...workOf(p),
          org: {
            ...org,
            menu: [
              { label: "示例组织", checked: true, onSelect: vi.fn() },
              { label: "另一个组织", checked: false, onSelect },
            ],
          },
        }}
      />,
    );
    const sw = screen.getByRole("button", { name: "当前组织：示例组织，切换组织" });
    expect(sw.textContent).toContain("示例组织");
    expect(sw.textContent).toContain("~/demo · 所有者");
    expect(sw.querySelector('[data-part="org-initial"]')?.textContent).toBe("示");
    await userEvent.click(sw);
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "另一个组织" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("更多 opens a flyout menu to the right, extension pages after a separator", async () => {
    const p = props();
    zh(
      <Sidebar
        {...p}
        context={{
          ...workOf(p),
          moreExtensions: [
            { id: "ext:todo/board", label: "看板", href: "/p/todo/board", icon: "extension" },
          ],
        }}
      />,
    );
    const more = within(mainNav()).getByRole("button", { name: "更多" });
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    // no inline group
    expect(within(mainNav()).queryByRole("link", { name: "插件" })).toBeNull();
    await userEvent.click(more);
    const menu = await screen.findByRole("menu");
    expect(menu.getAttribute("data-side")).toBe("right");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["插件", "组织设置", "看板"]);
    // like the main nav, every flyout item carries its icon
    for (const item of within(menu).getAllByRole("menuitem")) {
      expect(item.querySelector(".cb-icon")).not.toBeNull();
    }
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
    // nothing remembered
    expect(localStorage.getItem("cap.sidebar.more")).toBeNull();
  });

  it("更多 is active when the current page is one of its items, marked current inside", async () => {
    zh(<Sidebar {...props({ activeNav: "plugins" })} />);
    const more = within(mainNav()).getByRole("button", { name: "更多" });
    expect(more.getAttribute("data-active")).toBe("true");
    // still closed: no "open while active"
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(more);
    const item = await screen.findByRole("menuitem", { name: "插件" });
    expect(item.getAttribute("aria-current")).toBe("page");
    expect(
      screen.getByRole("menuitem", { name: "组织设置" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("更多: ↑ / ↓ move along the nav and never open the flyout", async () => {
    const user = userEvent.setup();
    zh(<Sidebar {...props({ activeNav: "" })} />);
    const more = within(mainNav()).getByRole("button", { name: "更多" });
    more.focus();
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(within(mainNav()).getByRole("link", { name: "连接器" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(more);
    await user.keyboard("{ArrowDown}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("更多: → opens the flyout, Escape closes it and returns focus", async () => {
    const user = userEvent.setup();
    zh(<Sidebar {...props()} />);
    const more = within(mainNav()).getByRole("button", { name: "更多" });
    more.focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("menu")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("admin entry sits above the account row", () => {
    const p = props({
      account: { name: "grant", menu: [{ label: "退出登录", onSelect: vi.fn() }] },
    });
    zh(<Sidebar {...p} context={{ ...workOf(p), adminHref: "/admin" }} />);
    const admin = screen.getByRole("link", { name: "管理后台" });
    expect(admin.getAttribute("href")).toBe("/admin");
    expect(mainNav().contains(admin)).toBe(false);
    const account = screen.getByRole("button", { name: "账户: grant" });
    expect(admin.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      convSection().compareDocumentPosition(admin) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    cleanup();
    zh(<Sidebar {...props()} />);
    expect(screen.queryByRole("link", { name: "管理后台" })).toBeNull();
  });

  it("admin context shows the static block, the back link and no conversations", () => {
    zh(
      <Sidebar
        {...props({
          activeNav: "accounts",
          context: {
            kind: "admin",
            back: { href: "/", slug: "demo" },
            items: [
              { id: "overview", label: "概览", href: "/admin", icon: "home" },
              { id: "accounts", label: "账号", href: "/admin/accounts", icon: "user" },
            ],
          },
        })}
      />,
    );
    const block = document.querySelector('[data-part="context-block"]');
    expect(block?.textContent).toContain("管理后台");
    expect(block?.textContent).toContain("整个部署 · /admin");
    expect(block?.tagName).not.toBe("BUTTON");
    expect(screen.getByRole("link", { name: "回到工作区 ~/demo" }).getAttribute("href")).toBe("/");
    const nav = mainNav();
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["概览", "账号"]);
    expect(within(nav).getByRole("link", { name: "账号" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.queryByRole("region", { name: "会话" })).toBeNull();
    expect(screen.queryByRole("link", { name: "新会话" })).toBeNull();
    expect(screen.queryByRole("button", { name: /切换组织/ })).toBeNull();
  });

  it("account row shows the name and opens the account menu", async () => {
    const onSelect = vi.fn();
    zh(
      <Sidebar
        {...props({ account: { name: "grant", menu: [{ label: "退出登录", onSelect }] } })}
      />,
    );
    const btn = screen.getByRole("button", { name: "账户: grant" });
    expect(btn.textContent).toBe("Ggrant");
    await userEvent.click(btn);
    await userEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
describe("Sidebar theme switch and account submenus", () => {
  const theme = () => ({
    label: "主题",
    value: "dark" as const,
    lightLabel: "浅色",
    darkLabel: "深色",
    onChange: vi.fn(),
  });
  const languages = (onSelect: () => void) => ({
    label: "语言",
    submenu: [
      { label: "中文", checked: true, onSelect: vi.fn() },
      { label: "English", checked: false, onSelect },
    ],
  });

  it("full: the theme radio sits after the account; the language is an account submenu", async () => {
    const th = theme();
    const toEnglish = vi.fn();
    zh(
      <Sidebar
        {...props({
          account: {
            name: "grant",
            menu: [languages(toEnglish), "separator", { label: "退出登录", onSelect: vi.fn() }],
          },
          theme: th,
        })}
        mode="full"
      />,
    );
    const themes = screen.getByRole("radiogroup", { name: "主题" });
    const account = screen.getByRole("button", { name: "账户: grant" });
    // the switch follows the account in the same footer row
    expect(account.closest(".cb-sidebar-foot")?.contains(themes)).toBe(true);
    expect((within(themes).getByRole("radio", { name: "深色" }) as HTMLInputElement).checked).toBe(
      true,
    );
    await userEvent.click(within(themes).getByRole("radio", { name: "浅色" }));
    expect(th.onChange).toHaveBeenCalledWith("light");

    await userEvent.click(account);
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["语言", "退出登录"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "语言" }));
    const english = await screen.findByRole("menuitemradio", { name: "English" });
    expect(english.getAttribute("aria-checked")).toBe("false");
    english.focus();
    await userEvent.keyboard("{Enter}");
    expect(toEnglish).toHaveBeenCalledTimes(1);
  });

  it("rail: no room for the switch, so it leads the account menu", async () => {
    const th = theme();
    zh(
      <Sidebar
        {...props({
          account: {
            name: "grant",
            menu: [{ label: "退出登录", onSelect: vi.fn() }],
          },
          theme: th,
        })}
        mode="rail"
      />,
    );
    expect(screen.queryByRole("radiogroup", { name: "主题" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "账户: grant" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "主题: 浅色",
      "退出登录",
    ]);
    await userEvent.click(screen.getByRole("menuitem", { name: "主题: 浅色" }));
    expect(th.onChange).toHaveBeenCalledWith("light");
  });
});

describe("Sidebar conversations", () => {
  it("groups render the agent name and conversation links; aria-current on activeId", () => {
    const p = props();
    zh(
      <Sidebar {...p} conversations={{ ...p.conversations, activeId: "agt_a-c2" }} activeNav="" />,
    );
    const sec = convSection();
    expect(
      within(sec).getByRole("button", { name: "研究助手" }).getAttribute("aria-expanded"),
    ).toBe("true");
    const active = within(sec).getByRole("link", { name: "研究助手 会话 2" });
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(active.getAttribute("href")).toBe("/chat/agt_a-c2");
    expect(
      within(sec).getByRole("link", { name: "研究助手 会话 1" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(
      within(mainNav())
        .queryAllByRole("link")
        .some((l) => l.getAttribute("aria-current")),
    ).toBe(false);
  });

  it("untitled conversations read 未命名会话 · MM-DD HH:mm", () => {
    expect(untitledLabel(new Date(2026, 9, 26, 14, 2), "zh")).toBe("未命名会话 · 10-26 14:02");
    expect(untitledLabel(new Date(2026, 0, 5, 9, 7), "en")).toBe(
      "Untitled conversation · 01-05 09:07",
    );
    const g = group("agt_a", "研究助手", 1);
    g.conversations = [
      {
        id: "u1",
        title: null,
        startedAt: new Date(2026, 9, 26, 14, 2),
        href: "/chat/u1",
        activity: null,
      },
    ];
    const p = props();
    zh(<Sidebar {...p} conversations={{ ...p.conversations, groups: [g] }} />);
    expect(screen.getByRole("link", { name: "未命名会话 · 10-26 14:02" })).toBeTruthy();
  });

  it("long titles and agent names keep the full text in title", () => {
    const title =
      "请根据上一季度各事业部提交的经营数据汇总表逐项核对收入成本费用并给出差异原因分析和改进建议清单与时间表。";
    const name = "跨部门季度经营分析与年度预算编制及执行情况跟踪复盘总结小助手";
    expect(title.length).toBeGreaterThanOrEqual(48);
    const g = group("agt_l", name, 1);
    g.conversations = [
      { id: "l1", title, startedAt: at(24, 9, 0), href: "/chat/l1", activity: null },
    ];
    const p = props();
    zh(<Sidebar {...p} conversations={{ ...p.conversations, groups: [g] }} />);
    expect(screen.getByRole("link", { name: title }).getAttribute("title")).toBe(title);
    expect(screen.getByRole("button", { name }).getAttribute("title")).toBe(name);
  });

  it("group toggle collapses, hides the rows and remembers the agent id", async () => {
    zh(<Sidebar {...props()} />);
    const toggle = screen.getByRole("button", { name: "研究助手" });
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "研究助手 会话 1" })).toBeNull();
    expect(screen.getByRole("link", { name: "客服分流 会话 1" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]")).toEqual(["agt_a"]);
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]")).toEqual([]);
  });

  it("reads collapsed groups from localStorage; renders expanded when storage throws", () => {
    localStorage.setItem(STORE_KEY, JSON.stringify(["agt_b"]));
    zh(<Sidebar {...props()} />);
    expect(screen.getByRole("button", { name: "客服分流" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    cleanup();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    zh(<Sidebar {...props()} />);
    const toggle = screen.getByRole("button", { name: "客服分流" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("group ＋ creates with that agent; More loads the group; More groups pages groups", async () => {
    const p = props({});
    p.conversations.moreGroups = true;
    zh(<Sidebar {...p} />);
    const [a] = p.conversations.groups as [SidebarGroup];
    await userEvent.click(screen.getByRole("button", { name: "与 研究助手 新建会话" }));
    expect(a.onNew).toHaveBeenCalledTimes(1);
    const more = within(convSection()).getAllByRole("button", { name: "显示更多" });
    expect(more).toHaveLength(1);
    await userEvent.click(more[0] as HTMLElement);
    expect(a.onMore).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "更多分组" }));
    expect(p.conversations.onMoreGroups).toHaveBeenCalledTimes(1);
    cleanup();
    const q = props();
    const [b] = q.conversations.groups as [SidebarGroup];
    b.moreCount = 9;
    zh(<Sidebar {...q} />);
    expect(within(convSection()).getByRole("button", { name: "再显示 9 个" })).toBeTruthy();
  });

  it("loading: skeleton bars in three groups and aria-busy, no spinner", () => {
    const p = props();
    zh(<Sidebar {...p} conversations={{ ...p.conversations, state: "loading", groups: [] }} />);
    const sec = convSection();
    expect(sec.getAttribute("aria-busy")).toBe("true");
    expect(sec.querySelectorAll('[data-part="skeleton-bar"]')).toHaveLength(7);
    expect(sec.querySelector('.cb-sidebar-convs-body [data-part="icon"]')).toBeNull();
  });

  it("error: message and Retry calls onRetry", async () => {
    const p = props();
    zh(<Sidebar {...p} conversations={{ ...p.conversations, state: "error", groups: [] }} />);
    expect(screen.getByRole("alert").textContent).toContain("会话列表加载失败");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(p.conversations.onRetry).toHaveBeenCalledTimes(1);
  });

  it("row state dot only for running and waiting", () => {
    const g = group("agt_a", "研究助手", 3);
    const [c1, c2, c3] = g.conversations as [
      SidebarGroup["conversations"][number],
      SidebarGroup["conversations"][number],
      SidebarGroup["conversations"][number],
    ];
    c1.activity = "running";
    c2.activity = "waiting";
    c3.activity = null;
    const p = props();
    zh(<Sidebar {...p} conversations={{ ...p.conversations, groups: [g] }} />);
    const dots = convSection().querySelectorAll('[data-part="state-dot"]');
    expect([...dots].map((d) => d.getAttribute("data-activity"))).toEqual(["running", "waiting"]);
    expect(screen.getByRole("img", { name: "运行中" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "等待我" })).toBeTruthy();
    // the dot is beside the link: the link's name stays the title
    expect(screen.getByRole("link", { name: "研究助手 会话 1" })).toBeTruthy();
  });

  it("row menu renames inline (Enter saves, Escape cancels)", async () => {
    const user = userEvent.setup();
    const p = props();
    zh(<Sidebar {...p} conversations={{ ...p.conversations, activeId: "agt_a-c1" }} />);
    const actions = screen.getAllByRole("button", { name: "会话操作：研究助手 会话 1" });
    expect(actions).toHaveLength(1);
    await user.click(actions[0] as HTMLElement);
    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const input = await screen.findByRole("textbox", { name: "会话标题" });
    expect((input as HTMLInputElement).value).toBe("研究助手 会话 1");
    // focus moves into the input (the menu does not take it back)
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    await user.clear(input);
    await user.keyboard("{Enter}");
    // empty is not allowed: still editing, nothing saved
    expect(p.conversations.onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "会话标题" })).toBeTruthy();
    await user.type(input, "  季度核对  {Enter}");
    expect(p.conversations.onRename).toHaveBeenCalledWith("agt_a-c1", "季度核对");
    const row1 = await screen.findByRole("link", { name: "研究助手 会话 1" });
    expect(screen.queryByRole("textbox", { name: "会话标题" })).toBeNull();
    // back on the row
    await vi.waitFor(() => expect(document.activeElement).toBe(row1));

    await user.click(screen.getByRole("button", { name: "会话操作：研究助手 会话 2" }));
    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const again = await screen.findByRole("textbox", { name: "会话标题" });
    await user.type(again, "不要了");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "会话标题" })).toBeNull();
    expect(p.conversations.onRename).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("link", { name: "研究助手 会话 2" })),
    );
  });

  it("rename ignores Enter and Escape while an IME composes", async () => {
    const user = userEvent.setup();
    const p = props();
    zh(<Sidebar {...p} />);
    await user.click(screen.getByRole("button", { name: "会话操作：研究助手 会话 1" }));
    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const input = await screen.findByRole("textbox", { name: "会话标题" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(p.conversations.onRename).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(screen.getByRole("textbox", { name: "会话标题" })).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(p.conversations.onRename).toHaveBeenCalledWith("agt_a-c1", "研究助手 会话 1");
  });

  it("a failed rename keeps editing with focus in the input", async () => {
    const user = userEvent.setup();
    const p = props();
    p.conversations.onRename = vi.fn(async () => {
      throw new Error("nope");
    });
    zh(<Sidebar {...p} />);
    await user.click(screen.getByRole("button", { name: "会话操作：研究助手 会话 1" }));
    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const input = await screen.findByRole("textbox", { name: "会话标题" });
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false));
    expect(screen.getByRole("textbox", { name: "会话标题" })).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("a rename ends when its row is filtered out", async () => {
    const user = userEvent.setup();
    const p = props();
    const r = zh(<Sidebar {...p} />);
    await user.click(screen.getByRole("button", { name: "会话操作：研究助手 会话 1" }));
    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));
    expect(await screen.findByRole("textbox", { name: "会话标题" })).toBeTruthy();
    const filtered = { ...p.conversations, filter: { ...p.conversations.filter, q: "客服" } };
    r.rerender(
      <DesignProvider locale="zh">
        <Sidebar {...p} conversations={filtered} />
      </DesignProvider>,
    );
    r.rerender(
      <DesignProvider locale="zh">
        <Sidebar {...p} />
      </DesignProvider>,
    );
    expect(screen.queryByRole("textbox", { name: "会话标题" })).toBeNull();
    expect(screen.getByRole("link", { name: "研究助手 会话 1" })).toBeTruthy();
  });

  it("archive failures are swallowed by the row (the caller reports them)", async () => {
    const user = userEvent.setup();
    const p = props();
    p.conversations.onArchive = vi.fn(() => Promise.reject(new Error("nope")));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    zh(<Sidebar {...p} />);
    await user.click(screen.getByRole("button", { name: "会话操作：客服分流 会话 1" }));
    await user.click(await screen.findByRole("menuitem", { name: "归档" }));
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", unhandled);
    expect(p.conversations.onArchive).toHaveBeenCalledWith("agt_b-c1", true);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("row menu archives and deletes (delete asks to confirm)", async () => {
    const user = userEvent.setup();
    const p = props();
    zh(<Sidebar {...p} />);
    await user.click(screen.getByRole("button", { name: "会话操作：客服分流 会话 1" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "重命名",
      "归档",
      "删除",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "归档" }));
    expect(p.conversations.onArchive).toHaveBeenCalledWith("agt_b-c1", true);

    await user.click(screen.getByRole("button", { name: "会话操作：客服分流 会话 1" }));
    await user.click(await screen.findByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("dialog", { name: "删除会话？" });
    expect(dialog.textContent).toContain("客服分流 会话 1");
    expect(p.conversations.onDelete).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(p.conversations.onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "会话操作：客服分流 会话 1" }));
    await user.click(await screen.findByRole("menuitem", { name: "删除" }));
    const confirm = await screen.findByRole("dialog", { name: "删除会话？" });
    await user.click(within(confirm).getByRole("button", { name: "删除" }));
    expect(p.conversations.onDelete).toHaveBeenCalledWith("agt_b-c1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("filter narrows by text and state", async () => {
    const user = userEvent.setup();
    const g = group("agt_a", "研究助手", 3);
    const rows = g.conversations;
    (rows[0] as (typeof rows)[number]).activity = "running";
    (rows[1] as (typeof rows)[number]).activity = "waiting";
    const onChange = vi.fn();
    function Harness() {
      const [f, setF] = useState<SidebarFilter>({ q: "", state: "all" });
      const p = props();
      return (
        <Sidebar
          {...p}
          conversations={{
            ...p.conversations,
            groups: [g, group("agt_b", "客服分流", 1)],
            filter: {
              ...f,
              onChange: (n) => {
                onChange(n);
                setF(n);
              },
            },
          }}
        />
      );
    }
    zh(<Harness />);
    const toggle = screen.getByRole("button", { name: "筛选会话" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    await user.type(screen.getByRole("textbox", { name: "按标题搜索" }), "会话 2");
    expect(onChange).toHaveBeenLastCalledWith({ q: "会话 2", state: "all" });
    const sec = convSection();
    expect(
      within(sec)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["研究助手 会话 2"]);
    // a group without matching rows is hidden
    expect(within(sec).queryByRole("button", { name: "客服分流" })).toBeNull();
    await user.clear(screen.getByRole("textbox", { name: "按标题搜索" }));
    await user.click(screen.getByRole("radio", { name: "运行中" }));
    expect(onChange).toHaveBeenLastCalledWith({ q: "", state: "running" });
    expect(
      within(sec)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["研究助手 会话 1"]);
    await user.type(screen.getByRole("textbox", { name: "按标题搜索" }), "没有这个");
    expect(within(sec).getByText("没有匹配的会话")).toBeTruthy();
    // closing the filter clears it
    await user.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith({ q: "", state: "all" });
    expect(within(sec).getAllByRole("link")).toHaveLength(4);
  });

  it("archived entry swaps the list in place and the header returns", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const p = props();
    zh(
      <Sidebar
        {...p}
        conversations={{ ...p.conversations, archived: { count: 7, open: false, onOpenChange } }}
      />,
    );
    const sec0 = convSection();
    const entry = within(sec0).getByRole("button", { name: "已归档 · 7" });
    // in the section header, next to the filter; no bottom entry
    const head = sec0.querySelector(".cb-sidebar-convs-head");
    expect(head?.contains(entry)).toBe(true);
    expect(head?.contains(within(sec0).getByRole("button", { name: "筛选会话" }))).toBe(true);
    expect(sec0.querySelectorAll('[data-part="archived-entry"]')).toHaveLength(1);
    await user.click(entry);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    cleanup();
    const archived = group("agt_x", "旧助手", 1);
    zh(
      <Sidebar
        {...p}
        conversations={{
          ...p.conversations,
          groups: [archived],
          archived: { count: 7, open: true, onOpenChange },
        }}
      />,
    );
    const sec = convSection();
    expect(within(sec).queryByRole("button", { name: "已归档 · 7" })).toBeNull();
    const back = within(sec).getByRole("button", { name: "返回会话列表：已归档 · 7" });
    expect(back.textContent).toContain("已归档 · 7");
    expect(
      within(sec)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["旧助手 会话 1"]);
    // no ＋ in the archived list
    expect(within(sec).queryByRole("button", { name: "与 旧助手 新建会话" })).toBeNull();
    await user.click(within(sec).getByRole("button", { name: "会话操作：旧助手 会话 1" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["取消归档", "删除"]);
    await user.click(screen.getByRole("menuitem", { name: "取消归档" }));
    expect(p.conversations.onArchive).toHaveBeenCalledWith("agt_x-c1", false);
    await user.click(back);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("the archive button is absent with nothing archived", () => {
    zh(<Sidebar {...props()} />);
    expect(within(convSection()).queryByRole("button", { name: /已归档/ })).toBeNull();
  });

  it("the archived list keeps its way back while loading or on error", async () => {
    const onOpenChange = vi.fn();
    const p = props();
    for (const state of ["error", "loading"] as const) {
      zh(
        <Sidebar
          {...p}
          conversations={{
            ...p.conversations,
            state,
            groups: [],
            archived: { count: 7, open: true, onOpenChange },
          }}
        />,
      );
      await userEvent.click(
        within(convSection()).getByRole("button", { name: "返回会话列表：已归档 · 7" }),
      );
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
      cleanup();
    }
  });

  it("the filter applies to the archived list", () => {
    const p = props();
    zh(
      <Sidebar
        {...p}
        conversations={{
          ...p.conversations,
          groups: [group("agt_x", "旧助手", 2)],
          filter: { q: "会话 2", state: "all", onChange: vi.fn() },
          filterOpen: true,
          archived: { count: 2, open: true, onOpenChange: vi.fn() },
        }}
      />,
    );
    const sec = convSection();
    expect(within(sec).getByRole("button", { name: "返回会话列表：已归档 · 2" })).toBeTruthy();
    expect(
      within(sec)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["旧助手 会话 2"]);
  });

  it("ready with no groups: the panel empty state (capybara at scale 4) with a default New conversation link", () => {
    const p = props();
    zh(<Sidebar {...p} conversations={{ ...p.conversations, groups: [] }} />);
    const sec = convSection();
    const es = sec.querySelector('[data-part="empty-state"]');
    expect(es?.getAttribute("data-size")).toBe("panel");
    const art = es?.querySelector('[data-part="empty-illustration"] svg');
    expect([art?.getAttribute("width"), art?.getAttribute("height")]).toEqual(["57", "41"]);
    expect(within(sec).getByText("还没有会话")).toBeTruthy();
    const link = within(sec).getByRole("link", { name: "新会话" });
    expect(link.getAttribute("href")).toBe("/chat");
    expect(link.className).toContain("cb-btn-link-default");
    expect(link.getAttribute("data-density")).toBe("dense");
  });

  it("a filter that matches nothing: the empty state with Clear filter", async () => {
    const p = props();
    const onChange = vi.fn();
    zh(
      <Sidebar
        {...p}
        conversations={{
          ...p.conversations,
          groups: [],
          filter: { q: "zzz", state: "all", onChange },
          filterOpen: true,
        }}
      />,
    );
    const sec = convSection();
    expect(within(sec).getByText("没有匹配的会话")).toBeTruthy();
    // the same panel empty state as the empty list, the capybara included
    const hint = sec.querySelector('[data-part="empty-hint"]');
    expect(hint?.getAttribute("data-state")).toBe("no-match");
    const es = hint?.querySelector('[data-part="empty-state"]');
    expect(es?.getAttribute("data-size")).toBe("panel");
    expect(es?.querySelector('[data-part="empty-illustration"]')).toBeTruthy();
    await userEvent.click(within(sec).getByRole("button", { name: "清除筛选" }));
    expect(onChange).toHaveBeenCalledWith({ q: "", state: "all" });
  });
});

describe("Sidebar keyboard", () => {
  it("one roving tab stop for the nav list: ↓ / End move focus, Tab leaves the list", async () => {
    const user = userEvent.setup();
    zh(<Sidebar {...props({ activeNav: "" })} />);
    const items = Array.from(mainNav().querySelectorAll<HTMLElement>("[data-rove]"));
    expect(items.map((i) => i.textContent)).toEqual(["新会话", "Agents", "技能", "连接器", "更多"]);
    expect(items.filter((l) => l.tabIndex === 0)).toEqual([items[0]]);
    (items[0] as HTMLElement).focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(items.at(-1));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(items[0]);
    await user.tab();
    expect(mainNav().contains(document.activeElement)).toBe(false);
  });

  it("Tab enters the nav list at the current item", async () => {
    const user = userEvent.setup();
    zh(<Sidebar {...props()} />);
    const agents = within(mainNav()).getByRole("link", { name: "Agents" });
    expect(agents.tabIndex).toBe(0);
    // the brand row's search and inbox come first; the org switcher has no menu here, so it is
    // not a tab stop
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "搜索 ⌘K" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: /^收件箱/ }));
    await user.tab();
    expect(document.activeElement).toBe(agents);
  });

  it("conversation list: one tab stop at the active conversation; ↓ moves between rows", async () => {
    const user = userEvent.setup();
    const p = props();
    zh(<Sidebar {...p} conversations={{ ...p.conversations, activeId: "agt_a-c1" }} />);
    const sec = convSection();
    const active = within(sec).getByRole("link", { name: "研究助手 会话 1" });
    const tabbable = Array.from(sec.querySelectorAll<HTMLElement>("a, button")).filter(
      (e) => e.tabIndex === 0,
    );
    // the filter button, the active row and its actions
    expect(tabbable).toEqual([
      within(sec).getByRole("button", { name: "筛选会话" }),
      active,
      within(sec).getByRole("button", { name: "会话操作：研究助手 会话 1" }),
    ]);
    active.focus();
    await user.keyboard("{ArrowDown}");
    const next = within(sec).getByRole("link", { name: "研究助手 会话 2" });
    expect(document.activeElement).toBe(next);
    // the actions of the row holding the tab stop follow it
    expect(within(sec).getByRole("button", { name: "会话操作：研究助手 会话 2" }).tabIndex).toBe(0);
  });
});

describe("Sidebar rail", () => {
  it("icons only; links keep their accessible names; conversations behind the expand button", () => {
    zh(<Sidebar {...props()} mode="rail" />);
    expect(within(mainNav()).getByRole("link", { name: "Agents" })).toBeTruthy();
    expect(within(mainNav()).queryByText("Agents")).toBeNull();
    // the brand row is the logo alone; search and inbox are rail icons at the top
    const top = document.querySelector('[data-part="brand-row"]') as HTMLElement;
    expect(within(top).queryByRole("button")).toBeNull();
    expect(within(top).queryByRole("link")).toBeNull();
    const tools = document.querySelector(".cb-sidebar-rail-tools") as HTMLElement;
    expect(within(tools).getByRole("button", { name: "搜索 ⌘K" })).toBeTruthy();
    expect(within(tools).getByRole("link", { name: "收件箱，99+ 项待处理" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "会话" })).toBeNull();
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBeTruthy();
  });

  it("rail mode keeps primary icons and the org initial", async () => {
    const p = props();
    const org = workOf(p).org;
    if (!org) throw new Error("org expected");
    const onSelect = vi.fn();
    zh(
      <Sidebar
        {...p}
        context={{
          ...workOf(p),
          org: { ...org, menu: [{ label: "另一个组织", checked: false, onSelect }] },
          adminHref: "/admin",
        }}
        mode="rail"
      />,
    );
    const nav = mainNav();
    for (const name of ["新会话", "Agents", "技能", "连接器"])
      expect(within(nav).getByRole("link", { name })).toBeTruthy();
    expect(screen.getByRole("button", { name: "搜索 ⌘K" })).toBeTruthy();
    expect(within(nav).queryByText("技能")).toBeNull();
    const sw = screen.getByRole("button", { name: "当前组织：示例组织，切换组织" });
    expect(sw.textContent).toBe("示");
    expect(screen.getByRole("link", { name: "管理后台" })).toBeTruthy();
    // 更多 opens the same flyout
    await userEvent.click(within(nav).getByRole("button", { name: "更多" }));
    expect((await screen.findByRole("menu")).getAttribute("data-side")).toBe("right");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["插件", "组织设置"]);
  });

  it("expand opens the drawer with the full sidebar; Esc closes it and returns focus", async () => {
    const user = userEvent.setup();
    zh(<Sidebar {...props()} mode="rail" />);
    const expand = screen.getByRole("button", { name: "展开侧栏" });
    await user.click(expand);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("region", { name: "会话" })).toBeTruthy();
    expect(within(drawer).getByText("Agents")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);
  });

  it("Esc in the drawer's rename or filter input stays with the input", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    zh(<Sidebar {...props()} mode="drawer" drawer={{ open: true, onOpenChange }} />);
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "会话操作：研究助手 会话 1" }));
    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const input = await within(drawer).findByRole("textbox", { name: "会话标题" });
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    await user.keyboard("{Escape}");
    expect(within(drawer).queryByRole("textbox", { name: "会话标题" })).toBeNull();
    await user.click(within(drawer).getByRole("button", { name: "筛选会话" }));
    await user.click(within(drawer).getByRole("textbox", { name: "按标题搜索" }));
    await user.keyboard("{Escape}");
    expect(within(drawer).queryByRole("textbox", { name: "按标题搜索" })).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // elsewhere Esc still closes it
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("drawer mode is controlled through `drawer`; its close button closes it", async () => {
    const onOpenChange = vi.fn();
    zh(<Sidebar {...props()} mode="drawer" drawer={{ open: true, onOpenChange }} />);
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(within(drawer).getByRole("button", { name: "关闭导航" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("Sidebar drawer: 更多 is a disclosure", () => {
  const withExtensions = (): WorkProps => {
    const p = props();
    if (p.context.kind === "work") {
      p.context.moreExtensions = [
        { id: "ext-todo", label: "待办", href: "/x/todo", icon: "extension" },
      ];
    }
    return p;
  };

  it("lists its items in place, one level in, with aria-expanded; no flyout menu", async () => {
    zh(
      <Sidebar
        {...withExtensions()}
        mode="drawer"
        drawer={{ open: true, onOpenChange: vi.fn() }}
      />,
    );
    const drawer = await screen.findByRole("dialog");
    const more = within(drawer).getByRole("button", { name: "更多" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(within(drawer).queryByRole("link", { name: "插件" })).toBeNull();
    await userEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("menu")).toBeNull();
    const group = within(drawer).getByRole("group", { name: "更多" });
    expect(more.getAttribute("aria-controls")).toBe(group.id);
    const links = within(group).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["插件", "组织设置", "待办"]);
    for (const l of links) expect(l.getAttribute("data-depth")).toBe("1");
    // the fixed items and the extension pages are split as in the flyout
    expect(within(group).getByRole("separator")).toBeTruthy();
    // the sub-list follows its toggle in the nav (DOM and tab order)
    expect(more.nextElementSibling).toBe(group);
    expect(more.querySelector('[data-part="more-chevron"]')).not.toBeNull();
    await userEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(within(drawer).queryByRole("group", { name: "更多" })).toBeNull();
  });

  it("opens expanded when the current page is one of its items, marked current", async () => {
    zh(
      <Sidebar
        {...props({ activeNav: "plugins" })}
        mode="drawer"
        drawer={{ open: true, onOpenChange: vi.fn() }}
      />,
    );
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("button", { name: "更多" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    const current = within(drawer).getByRole("link", { name: "插件" });
    expect(current.getAttribute("aria-current")).toBe("page");
  });

  it("an item navigates and closes the drawer like the other nav items", async () => {
    const onOpenChange = vi.fn();
    zh(<Sidebar {...props()} mode="drawer" drawer={{ open: true, onOpenChange }} />);
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(within(drawer).getByRole("button", { name: "更多" }));
    const link = within(drawer).getByRole("link", { name: "插件" });
    expect(link.getAttribute("href")).toBe("/plugins");
    link.addEventListener("click", (e) => e.preventDefault());
    await userEvent.click(link);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("the drawer scrolls its middle as one region between the fixed top row and bottom block", async () => {
    const p = props();
    if (p.context.kind === "work") p.context.adminHref = "/admin";
    zh(<Sidebar {...p} mode="drawer" drawer={{ open: true, onOpenChange: vi.fn() }} />);
    const drawer = await screen.findByRole("dialog");
    const aside = drawer.querySelector('[data-part="sidebar"]') as HTMLElement;
    const scroll = aside.querySelector('[data-part="drawer-scroll"]') as HTMLElement;
    expect(scroll.parentElement).toBe(aside);
    // the brand row before it, the admin entry and the account after it, outside the region
    const kids = [...aside.children];
    const at = kids.indexOf(scroll);
    expect(kids.indexOf(aside.querySelector('[data-part="brand-row"]') as Element)).toBeLessThan(
      at,
    );
    const foot = aside.querySelector(".cb-sidebar-foot") as Element;
    expect(kids.indexOf(foot)).toBeGreaterThan(at);
    expect(scroll.contains(within(drawer).getByRole("link", { name: "管理后台" }))).toBe(false);
    // inside: the org switcher, the nav (with the 更多 group) and the conversations
    expect(scroll.querySelector('[data-part="org-switcher"]')).not.toBeNull();
    expect(scroll.querySelector('[data-part="more-toggle"]')).not.toBeNull();
    const convs = within(scroll).getByRole("region", { name: "会话" });
    // the conversations keep their 显示更多 inside the shared scroll
    expect(within(convs).getAllByRole("button", { name: "显示更多" }).length).toBeGreaterThan(0);
  });

  it("the full sidebar and the rail have no shared scroll region", () => {
    const { unmount } = zh(<Sidebar {...props()} mode="full" />);
    expect(document.querySelector('[data-part="drawer-scroll"]')).toBeNull();
    unmount();
    zh(<Sidebar {...props()} mode="rail" />);
    expect(document.querySelector('[data-part="drawer-scroll"]')).toBeNull();
  });

  it("the full sidebar keeps the flyout (no aria-expanded disclosure)", () => {
    zh(<Sidebar {...props()} mode="full" />);
    const more = screen.getByRole("button", { name: "更多" });
    expect(more.getAttribute("aria-controls") ?? "").not.toMatch(/^cb-sidebar-more-/);
    expect(screen.queryByRole("group", { name: "更多" })).toBeNull();
  });
});

describe("Sidebar first paint and remembered state", () => {
  it("server render draws the full and rail variants, chosen by CSS media queries", () => {
    const html = renderToString(
      <DesignProvider locale="zh">
        <Sidebar {...props()} />
      </DesignProvider>,
    );
    expect(html).toContain('data-mode="full"');
    expect(html).toContain('data-mode="rail"');
    expect(html.match(/data-responsive="true"/g)?.length).toBe(2);
  });

  it("an explicit mode server-renders that variant only", () => {
    const html = renderToString(
      <DesignProvider locale="zh">
        <Sidebar {...props()} mode="full" />
      </DesignProvider>,
    );
    expect(html).toContain('data-mode="full"');
    expect(html).not.toContain('data-mode="rail"');
    expect(html).not.toContain("data-responsive");
  });

  it("after mount one variant is rendered", () => {
    zh(<Sidebar {...props()} />);
    expect(document.querySelectorAll('[data-part="sidebar"]')).toHaveLength(1);
  });

  it("remembered collapsed groups apply on the first commit, without the height motion", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify(["agt_a"]));
    zh(<Sidebar {...props()} />);
    const toggle = screen.getByRole("button", { name: "研究助手" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(convSection().getAttribute("data-motion")).toBeNull();
    await userEvent.click(toggle);
    expect(convSection().getAttribute("data-motion")).toBe("on");
  });

  it("with a scope (the org) the remembered groups are per scope; pruning stays inside it (m4)", async () => {
    localStorage.setItem(`${STORE_KEY}.o1`, JSON.stringify(["agt_gone_from_o2_view"]));
    localStorage.setItem(`${STORE_KEY}.o2`, JSON.stringify(["agt_b"]));
    const p = props();
    const r = zh(<Sidebar {...p} conversations={{ ...p.conversations, scope: "o2" }} />);
    expect(screen.getByRole("button", { name: "客服分流" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    await userEvent.click(screen.getByRole("button", { name: "研究助手" }));
    expect(JSON.parse(localStorage.getItem(`${STORE_KEY}.o2`) ?? "[]")).toEqual(["agt_b", "agt_a"]);
    // org o1's list is untouched by a toggle in o2, though none of its ids are listed here
    expect(JSON.parse(localStorage.getItem(`${STORE_KEY}.o1`) ?? "[]")).toEqual([
      "agt_gone_from_o2_view",
    ]);
    expect(localStorage.getItem(STORE_KEY)).toBeNull();
    // switching the scope reads the other org's list
    r.rerender(
      <DesignProvider locale="zh">
        <Sidebar {...p} conversations={{ ...p.conversations, scope: "o1" }} />
      </DesignProvider>,
    );
    expect(screen.getByRole("button", { name: "客服分流" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("a toggle writes storage once, also under StrictMode", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    render(
      <StrictMode>
        <DesignProvider locale="zh">
          <Sidebar {...props()} />
        </DesignProvider>
      </StrictMode>,
    );
    set.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "研究助手" }));
    expect(set.mock.calls.filter((c) => c[0] === STORE_KEY)).toHaveLength(1);
  });

  it("stale ids are pruned once every group is loaded; the list is capped", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify(["agt_gone", "agt_b"]));
    zh(<Sidebar {...props()} />);
    await userEvent.click(screen.getByRole("button", { name: "研究助手" }));
    expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]")).toEqual(["agt_b", "agt_a"]);
    cleanup();
    const many = Array.from({ length: 150 }, (_, i) => `agt_${i}`);
    localStorage.setItem(STORE_KEY, JSON.stringify(many));
    const p = props();
    zh(<Sidebar {...p} conversations={{ ...p.conversations, moreGroups: true }} />);
    await userEvent.click(screen.getByRole("button", { name: "研究助手" }));
    const kept = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as string[];
    expect(kept).toHaveLength(100);
    expect(kept.at(-1)).toBe("agt_a");
  });

  it("without menu items the account footer is not a button (the session is loading)", () => {
    zh(<Sidebar {...props()} />);
    expect(screen.queryByRole("button", { name: /账户/ })).toBeNull();
    expect(document.querySelector('[data-part="account"]')?.textContent).toContain("grant");
  });

  it("the avatar initial is the first grapheme", () => {
    zh(<Sidebar {...props({ account: { name: "👩‍💻dev", menu: [] } })} />);
    expect(document.querySelector('[data-part="avatar"]')?.textContent).toBe("👩‍💻");
  });
});

describe("Sidebar setup context", () => {
  const steps: SetupStep[] = [
    { id: "model", label: "配置模型", state: "done", href: "/admin/extensions" },
    { id: "agent", label: "创建 agent", state: "todo", href: "/agents/new" },
    { id: "members", label: "邀请成员", state: "waiting", reason: "等待管理员配置模型" },
    { id: "channels", label: "连接渠道", state: "todo", href: "/channels/new", optional: true },
  ];
  const setupProps = (over: Partial<SidebarProps> = {}): SidebarProps => ({
    context: {
      kind: "setup",
      org: { name: "示例组织", initial: "示", slug: "demo", role: "所有者", menu: [] },
      home: { href: "/" },
      steps,
      adminHref: "/admin",
    },
    activeNav: "agent",
    account: { name: "grant", menu: [] },
    onOpenCommands: vi.fn(),
    ...over,
  });
  const item = (label: string) =>
    within(mainNav())
      .getByText(label)
      .closest('[data-part="step-item"], [data-part="nav-item"]') as HTMLElement;

  it("the home item first, the required steps, the later group, then the optional steps", () => {
    zh(<Sidebar {...setupProps()} mode="full" />);
    const nav = mainNav();
    const labels = [...nav.querySelectorAll(".cb-sidebar-label, [data-part=step-group-label]")].map(
      (e) => e.textContent,
    );
    expect(labels).toEqual([
      "开始之前",
      "配置模型",
      "创建 agent",
      "邀请成员",
      "可以稍后再做",
      "连接渠道",
    ]);
    expect(item("开始之前").getAttribute("href")).toBe("/");
    expect(item("开始之前").getAttribute("data-part")).toBe("nav-item");
    expect(item("连接渠道").getAttribute("data-optional")).toBe("true");
  });

  it("state marks are icons: check (success), circle, clock; the waiting reason is a second line", () => {
    zh(<Sidebar {...setupProps()} mode="full" />);
    const mark = (label: string) =>
      item(label).querySelector('[data-part="step-mark"]') as HTMLElement;
    expect(mark("配置模型").getAttribute("data-state")).toBe("done");
    expect(mark("配置模型").querySelector('svg[data-icon="check"]')).not.toBeNull();
    expect(mark("创建 agent").querySelector('svg[data-icon="circle"]')).not.toBeNull();
    expect(mark("邀请成员").querySelector('svg[data-icon="clock"]')).not.toBeNull();
    const reason = item("邀请成员").querySelector('[data-part="step-reason"]');
    expect(reason?.textContent).toBe("等待管理员配置模型");
  });

  it("done and to-do steps are links; a waiting step is not a link (aria-disabled)", () => {
    zh(<Sidebar {...setupProps()} mode="full" />);
    expect(item("配置模型").tagName).toBe("A");
    expect(item("配置模型").getAttribute("href")).toBe("/admin/extensions");
    expect(item("创建 agent").getAttribute("href")).toBe("/agents/new");
    const waiting = item("邀请成员");
    expect(waiting.tagName).not.toBe("A");
    expect(waiting.getAttribute("href")).toBeNull();
    expect(waiting.getAttribute("aria-disabled")).toBe("true");
    // the accessible names carry the state, the waiting one its reason
    expect(within(mainNav()).getByRole("link", { name: "配置模型，已完成" })).toBeTruthy();
    expect(within(mainNav()).getByRole("link", { name: "创建 agent，未完成" })).toBeTruthy();
    expect(
      within(mainNav()).getByRole("link", { name: "邀请成员，等待管理员配置模型" }),
    ).toBeTruthy();
  });

  it("activeNav marks a step or the home item current", () => {
    zh(<Sidebar {...setupProps()} mode="full" />);
    expect(item("创建 agent").getAttribute("aria-current")).toBe("page");
    expect(item("开始之前").getAttribute("aria-current")).toBeNull();
    cleanup();
    zh(<Sidebar {...setupProps({ activeNav: "home" })} mode="full" />);
    expect(item("开始之前").getAttribute("aria-current")).toBe("page");
  });

  it("no search, no inbox, no conversations, no new conversation; the org, the admin entry, the account", () => {
    zh(<Sidebar {...setupProps()} mode="full" />);
    expect(screen.queryByRole("button", { name: "搜索 ⌘K" })).toBeNull();
    expect(screen.queryByRole("link", { name: /收件箱/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "会话" })).toBeNull();
    expect(screen.queryByRole("link", { name: "新会话" })).toBeNull();
    expect(document.querySelector('[data-part="org-switcher"]')?.textContent).toContain("示例组织");
    expect(screen.getByRole("link", { name: "管理后台" }).getAttribute("href")).toBe("/admin");
    expect(document.querySelector('[data-part="sidebar"]')?.getAttribute("data-context")).toBe(
      "setup",
    );
  });

  it("rail: step marks only, the label and state in a tooltip; the later group is a divider", async () => {
    zh(<Sidebar {...setupProps()} mode="rail" railTooltip="members" />);
    const nav = mainNav();
    expect(within(nav).queryByText("配置模型")).toBeNull();
    expect(within(nav).getByRole("link", { name: "配置模型，已完成" })).toBeTruthy();
    expect(nav.querySelector('[data-part="step-reason"]')).toBeNull();
    expect(nav.querySelector('[data-part="step-group-label"]')).toBeNull();
    expect(nav.querySelector('[data-part="step-divider"]')).not.toBeNull();
    // the open tooltip of the waiting step names it with its reason
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "邀请成员，等待管理员配置模型",
    );
    expect(screen.queryByRole("button", { name: "搜索 ⌘K" })).toBeNull();
  });

  it("rail: a waiting step's tooltip carries its reason; a done step's its state", async () => {
    zh(<Sidebar {...setupProps()} mode="rail" railTooltip="members" />);
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("等待管理员配置模型");
    expect(tip.textContent).toContain("邀请成员");
    cleanup();
    zh(<Sidebar {...setupProps()} mode="rail" railTooltip="model" />);
    expect((await screen.findByRole("tooltip")).textContent).toContain("配置模型，已完成");
  });

  it("drawer: the full setup sidebar with its close button", async () => {
    const onOpenChange = vi.fn();
    zh(<Sidebar {...setupProps()} mode="drawer" drawer={{ open: true, onOpenChange }} />);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("可以稍后再做")).toBeTruthy();
    expect(within(drawer).getByText("等待管理员配置模型")).toBeTruthy();
    await userEvent.click(within(drawer).getByRole("button", { name: "关闭导航" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("roving focus walks every step, the waiting one included", async () => {
    const user = userEvent.setup();
    zh(<Sidebar {...setupProps()} mode="full" />);
    await user.tab();
    expect(document.activeElement).toBe(item("创建 agent"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("邀请成员"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("连接渠道"));
  });
});

describe("Link pending state", () => {
  it("design links carry a pending mark that follows the provider's hook", () => {
    const steps: SetupStep[] = [{ id: "agent", label: "创建 agent", state: "todo", href: "/a" }];
    const p: SidebarProps = {
      context: { kind: "setup", org: null, home: { href: "/" }, steps },
      activeNav: "home",
      account: { name: "grant", menu: [] },
      onOpenCommands: vi.fn(),
    };
    const { unmount } = render(
      <DesignProvider locale="zh" useLinkPending={() => true}>
        <Sidebar {...p} mode="full" />
      </DesignProvider>,
    );
    const link = screen.getByRole("link", { name: "创建 agent，未完成" });
    const mark = link.querySelector('[data-part="link-pending"]') as HTMLElement;
    expect(mark.getAttribute("data-pending")).toBe("true");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    unmount();
    // without a hook nothing is ever pending
    zh(<Sidebar {...p} mode="full" />);
    const idle = screen
      .getByRole("link", { name: "创建 agent，未完成" })
      .querySelector('[data-part="link-pending"]');
    expect(idle?.getAttribute("data-pending")).toBeNull();
  });

  it("under the default provider (no hook) the mark renders and is never pending", () => {
    zh(<LinkPendingMark />);
    const mark = document.querySelector('[data-part="link-pending"]');
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("data-pending")).toBeNull();
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
  });

  it("the mark sits inside the link (so the router's link status reaches it)", () => {
    render(
      <DesignProvider locale="zh" useLinkPending={() => true}>
        <LinkPendingMark />
      </DesignProvider>,
    );
    expect(document.querySelector('[data-part="link-pending"]')?.getAttribute("data-pending")).toBe(
      "true",
    );
  });
});
