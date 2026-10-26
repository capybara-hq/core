import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesignProvider,
  Sidebar,
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
    })),
    more,
    onMore: vi.fn(),
    onNew: vi.fn(),
  };
}

function props(over: Partial<SidebarProps> = {}): SidebarProps {
  return {
    newConversation: { href: "/agents" },
    nav: [
      { id: "overview", label: "概览", href: "/", icon: "home" },
      { id: "agents", label: "Agents", href: "/agents", icon: "agent" },
      { id: "inbox", label: "收件箱", href: "/inbox", icon: "inbox", count: 120 },
      { id: "connectors", label: "连接器", href: "/connectors", icon: "connector" },
    ],
    activeNav: "agents",
    footerNav: [{ id: "settings", label: "设置", href: "/settings", icon: "settings" }],
    conversations: {
      state: "ready",
      groups: [group("agt_a", "研究助手", 2, true), group("agt_b", "客服分流", 1)],
      moreGroups: false,
      onMoreGroups: vi.fn(),
      onRetry: vi.fn(),
    },
    account: { name: "grant", org: "示例组织", menu: [] },
    onOpenCommands: vi.fn(),
    ...over,
  };
}

const mainNav = () => screen.getByRole("navigation", { name: "主导航" });
const convSection = () => screen.getByRole("region", { name: "会话" });

describe("Sidebar navigation", () => {
  it("renders new conversation, nav and footer nav in order; aria-current on activeNav", () => {
    zh(<Sidebar {...props()} />);
    const links = within(mainNav()).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "新会话",
      "概览",
      "Agents",
      "收件箱99+",
      "连接器",
      "设置",
    ]);
    expect(
      within(mainNav()).getByRole("link", { name: "Agents" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(mainNav()).getByRole("link", { name: "概览" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(within(mainNav()).getByRole("link", { name: "新会话" }).getAttribute("href")).toBe(
      "/agents",
    );
  });

  it("inbox count: 99+ above 99, n+ when truncated; the accessible name includes it", () => {
    zh(<Sidebar {...props()} />);
    expect(screen.getByRole("link", { name: "收件箱，99+ 项待处理" })).toBeTruthy();
    cleanup();
    zh(
      <Sidebar
        {...props({
          nav: [
            {
              id: "inbox",
              label: "收件箱",
              href: "/inbox",
              icon: "inbox",
              count: 3,
              countMore: true,
            },
          ],
        })}
      />,
    );
    expect(screen.getByRole("link", { name: "收件箱，3+ 项待处理" })).toBeTruthy();
  });

  it("Extensions group only when there are pages", () => {
    zh(<Sidebar {...props({ extensions: [] })} />);
    expect(screen.queryByText("扩展")).toBeNull();
    cleanup();
    zh(
      <Sidebar
        {...props({
          extensions: [
            { id: "board", label: "任务看板", href: "/p/board" },
            { id: "todo", label: "待办清单", href: "/p/todo" },
          ],
        })}
      />,
    );
    expect(screen.getByText("扩展")).toBeTruthy();
    expect(screen.getByRole("link", { name: "任务看板" }).getAttribute("href")).toBe("/p/board");
    expect(screen.getByRole("link", { name: "待办清单" })).toBeTruthy();
  });

  it("search button opens the command palette", async () => {
    const p = props();
    zh(<Sidebar {...p} />);
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));
    expect(p.onOpenCommands).toHaveBeenCalledTimes(1);
  });

  it("account footer shows name · org and opens the account menu", async () => {
    const onSelect = vi.fn();
    zh(
      <Sidebar
        {...props({
          account: { name: "grant", org: "示例组织", menu: [{ label: "退出登录", onSelect }] },
        })}
      />,
    );
    const btn = screen.getByRole("button", { name: "账户: grant · 示例组织" });
    expect(btn.textContent).toContain("grant · 示例组织");
    await userEvent.click(btn);
    await userEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
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
      { id: "u1", title: null, startedAt: new Date(2026, 9, 26, 14, 2), href: "/chat/u1" },
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
    g.conversations = [{ id: "l1", title, startedAt: at(24, 9, 0), href: "/chat/l1" }];
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
    const more = within(convSection()).getAllByRole("button", { name: "更多" });
    expect(more).toHaveLength(1);
    await userEvent.click(more[0] as HTMLElement);
    expect(a.onMore).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "更多分组" }));
    expect(p.conversations.onMoreGroups).toHaveBeenCalledTimes(1);
  });

  it("loading: skeleton bars in three groups and aria-busy, no spinner", () => {
    const p = props();
    zh(<Sidebar {...p} conversations={{ ...p.conversations, state: "loading", groups: [] }} />);
    const sec = convSection();
    expect(sec.getAttribute("aria-busy")).toBe("true");
    expect(sec.querySelectorAll('[data-part="skeleton-bar"]')).toHaveLength(7);
    expect(sec.querySelector('[data-part="icon"]')).toBeNull();
  });

  it("error: message and Retry calls onRetry", async () => {
    const p = props();
    zh(<Sidebar {...p} conversations={{ ...p.conversations, state: "error", groups: [] }} />);
    expect(screen.getByRole("alert").textContent).toContain("会话列表加载失败");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(p.conversations.onRetry).toHaveBeenCalledTimes(1);
  });

  it("ready with no groups: one muted hint line", () => {
    const p = props();
    zh(<Sidebar {...p} conversations={{ ...p.conversations, groups: [] }} />);
    expect(within(convSection()).getByText(/还没有会话/)).toBeTruthy();
  });
});

describe("Sidebar keyboard", () => {
  it("one roving tab stop for the nav list: ↓ / End move focus, Tab leaves the list", async () => {
    const user = userEvent.setup();
    zh(<Sidebar {...props({ activeNav: "" })} />);
    const links = within(mainNav()).getAllByRole("link");
    expect(links.filter((l) => l.tabIndex === 0)).toHaveLength(1);
    (links[0] as HTMLElement).focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(links[1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(links.at(-1));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(links[0]);
    await user.tab();
    expect(mainNav().contains(document.activeElement)).toBe(false);
  });

  it("Tab enters the nav list at the current item", async () => {
    const user = userEvent.setup();
    zh(<Sidebar {...props()} />);
    const agents = within(mainNav()).getByRole("link", { name: "Agents" });
    expect(agents.tabIndex).toBe(0);
    await user.tab(); // the search button
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
    expect(tabbable).toEqual([active]);
    active.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(sec).getByRole("link", { name: "研究助手 会话 2" }));
  });
});

describe("Sidebar rail", () => {
  it("icons only; links keep their accessible names; conversations behind the expand button", () => {
    zh(<Sidebar {...props()} mode="rail" />);
    expect(within(mainNav()).getByRole("link", { name: "Agents" })).toBeTruthy();
    expect(within(mainNav()).getByRole("link", { name: "收件箱，99+ 项待处理" })).toBeTruthy();
    expect(within(mainNav()).queryByText("Agents")).toBeNull();
    expect(screen.queryByRole("region", { name: "会话" })).toBeNull();
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBeTruthy();
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

  it("drawer mode is controlled through `drawer`; its close button closes it", async () => {
    const onOpenChange = vi.fn();
    zh(<Sidebar {...props()} mode="drawer" drawer={{ open: true, onOpenChange }} />);
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(within(drawer).getByRole("button", { name: "关闭导航" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
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
    zh(<Sidebar {...props({ account: { name: "👩‍💻dev", org: null, menu: [] } })} />);
    expect(document.querySelector('[data-part="avatar"]')?.textContent).toBe("👩‍💻");
  });
});
