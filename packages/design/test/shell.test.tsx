import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActionRow,
  AppShell,
  assertHeader,
  Body,
  DesignProvider,
  type HeaderAction,
  PageHeader,
  type PageHeaderProps,
  PageTabs,
  StatCards,
  StatusBar,
  useStatusBar,
} from "../src/index";

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const realMatchMedia = window.matchMedia;
function stubMedia(...matching: number[]) {
  const queries = new Set(matching.map((n) => `(max-width: ${n}px)`));
  window.matchMedia = ((q: string) => ({
    matches: queries.has(q),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

const sidebar = {
  context: {
    kind: "work" as const,
    org: { name: "Acme", initial: "A", slug: "acme", role: "所有者", menu: [] },
    primary: [
      { id: "overview", label: "首页", href: "/", icon: "home" as const },
      { id: "agents", label: "Agents", href: "/agents", icon: "agent" as const },
    ],
    more: [{ id: "settings", label: "组织设置", href: "/settings", icon: "settings" as const }],
  },
  newConversation: { href: "/chat" },
  activeNav: "agents",
  conversations: {
    state: "ready" as const,
    groups: [],
    moreGroups: false,
    onMoreGroups: () => {},
    onRetry: () => {},
    filter: { q: "", state: "all" as const, onChange: () => {} },
    archived: { count: 0, open: false, onOpenChange: () => {} },
    onRename: async () => {},
    onArchive: async () => {},
    onDelete: async () => {},
  },
  account: { name: "grant", menu: [] },
};
const commands = [{ label: "跳转", items: [{ id: "go", label: "前往概览", onSelect: () => {} }] }];
const status = { context: "grant@acme:/agents", version: "0.1.0", timeZone: "UTC+8" };

function Page() {
  const [on, setOn] = useState(true);
  return (
    <>
      {on ? <Status /> : null}
      <button type="button" onClick={() => setOn(false)}>
        卸载
      </button>
    </>
  );
}
function Status() {
  useStatusBar("已筛选 18 / 24");
  return <div>内容区</div>;
}

const shell = (children: React.ReactNode = <div>内容区</div>) => (
  <AppShell sidebar={sidebar} commands={commands} status={status}>
    {children}
  </AppShell>
);

describe("AppShell", () => {
  it("sidebar | content column; the status bar sits inside the content column", () => {
    zh(shell());
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const content = screen.getByText("内容区");
    const footer = screen.getByRole("contentinfo");
    const column = document.querySelector('[data-part="shell-content"]') as HTMLElement;
    expect(column).toBeTruthy();
    expect(footer.parentElement).toBe(column);
    expect(column.contains(content)).toBe(true);
    expect(column.contains(nav)).toBe(false);
    expect(content.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("link", { name: "Agents" }).getAttribute("aria-current")).toBe("page");
  });

  it("status bar: context left, version and time zone right, no `> ` prefix", () => {
    zh(shell());
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText("grant@acme:/agents")).toBeTruthy();
    const right = footer.querySelector('[data-part="status-bar-right"]') as HTMLElement;
    expect(Array.from(right.children, (c) => c.textContent)).toEqual(["0.1.0", "UTC+8"]);
    expect(footer.textContent).not.toContain(">");
  });

  it("useStatusBar writes the page status and clears it on unmount", async () => {
    zh(shell(<Page />));
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText("已筛选 18 / 24")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "卸载" }));
    expect(within(footer).queryByText("已筛选 18 / 24")).toBeNull();
  });

  it("⌘K opens the command palette", async () => {
    zh(shell(<div />));
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("前往概览")).toBeTruthy();
  });

  it("the sidebar's search button opens the command palette", async () => {
    zh(shell(<div />));
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("below 960: the drawer bar's menu button opens the drawer; Esc closes it, focus returns", async () => {
    stubMedia(1279, 959);
    zh(shell());
    expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
    const menu = screen.getByRole("button", { name: "打开导航" });
    await userEvent.click(menu);
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByRole("navigation", { name: "主导航" })).toBeTruthy();
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it("below 960: the drawer bar has a search button that opens the command palette (m2)", async () => {
    stubMedia(1279, 959);
    zh(shell());
    const bar = document.querySelector('[data-part="drawer-bar"]') as HTMLElement;
    const search = within(bar).getByRole("button", { name: /搜索/ });
    expect(search.querySelector('[data-icon="search"]')).not.toBeNull();
    // it is the bar's last control, at the right end
    expect(bar.lastElementChild?.contains(search)).toBe(true);
    await userEvent.click(search);
    expect(screen.getByRole("dialog", { name: "命令面板" })).toBeTruthy();
  });

  it("a skip link is the first tab stop and leads to the main content (m9)", async () => {
    zh(shell(<p>页面</p>));
    await userEvent.tab();
    const skip = screen.getByRole("link", { name: "跳到主要内容" });
    expect(document.activeElement).toBe(skip);
    const main = screen.getByRole("main");
    expect(skip.getAttribute("href")).toBe(`#${main.id}`);
    expect(main.id).not.toBe("");
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("at 960 and wider there is no drawer bar", () => {
    zh(shell());
    expect(screen.queryByRole("button", { name: "打开导航" })).toBeNull();
  });
});

describe("PageHeader", () => {
  it("renders the path with separators and marks the last segment current", () => {
    zh(
      <PageHeader
        path={[
          { label: "capybara", href: "/" },
          { label: "agents", href: "/agents" },
          { label: "研究助手" },
        ]}
        title="编辑 Agent"
      />,
    );
    const nav = screen.getByRole("navigation", { name: "路径" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["capybara", "/"],
      ["agents", "/agents"],
    ]);
    expect(nav.textContent).toBe("capybara/agents/研究助手");
    const last = nav.querySelector('[aria-current="page"]');
    expect(last?.textContent).toBe("研究助手");
    expect(screen.getByRole("heading", { level: 1, name: "编辑 Agent" })).toBeTruthy();
  });

  it("the path is labelled Path in English", () => {
    render(
      <DesignProvider locale="en">
        <PageHeader path={[{ label: "~" }]} title="Home" />
      </DesignProvider>,
    );
    expect(screen.getByRole("navigation", { name: "Path" })).toBeTruthy();
  });

  it("renders tabs with counts and the search at the row end", () => {
    const onSearch = vi.fn();
    const onSelect = vi.fn();
    zh(
      <PageHeader
        path={[{ label: "capybara" }]}
        title="Agents"
        tabs={[
          { id: "all", label: "全部", count: 6 },
          { id: "mine", label: "我的", count: 3, onSelect },
        ]}
        activeTab="all"
        search={{ label: "搜索 Agent", value: "", onChange: onSearch }}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["全部6", "我的3"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    const row = document.querySelector<HTMLElement>(
      '[data-part="page-header-tabs"]',
    ) as HTMLElement;
    const input = within(row).getByRole("searchbox", { name: "搜索 Agent" });
    expect(row.lastElementChild?.contains(input)).toBe(true);
    fireEvent.click(tabs[1] as HTMLElement);
    expect(onSelect).toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "x" } });
    expect(onSearch).toHaveBeenCalledWith("x");
  });

  it("description renders under the title", () => {
    zh(<PageHeader path={[{ label: "~" }]} title="连接器" description="把外部服务接进来。" />);
    const h1 = screen.getByRole("heading", { level: 1 });
    const desc = screen.getByText("把外部服务接进来。");
    expect(desc.getAttribute("data-part")).toBe("page-header-description");
    expect(h1.compareDocumentPosition(desc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(desc.getAttribute("title")).toBe("把外部服务接进来。");
  });

  it("two primaries throw; six metrics throw", () => {
    const p = (label: string): HeaderAction => ({ label, variant: "primary" });
    expect(() => assertHeader({ path: [], title: "x", actions: [p("a"), p("b")] })).toThrow();
    const m = Array.from({ length: 6 }, (_, i) => ({ label: `m${i}`, value: i }));
    expect(() => assertHeader({ path: [], title: "x", metrics: m } as PageHeaderProps)).toThrow();
    expect(() =>
      assertHeader({ path: [], title: "x", actions: [p("a")], metrics: m.slice(0, 5) }),
    ).not.toThrow();
  });

  it("an 80-character title keeps the full text in title", () => {
    const long = "长".repeat(80);
    zh(<PageHeader path={[{ label: "~" }]} title={long} />);
    expect(screen.getByRole("heading", { level: 1 }).getAttribute("title")).toBe(long);
  });

  it("actions call onSelect; a menu action renders a menu button", async () => {
    const onSelect = vi.fn();
    zh(
      <PageHeader
        path={[{ label: "~" }]}
        title="t"
        actions={[
          { menu: [{ label: "导出", onSelect: () => {} }], label: "更多" },
          { label: "新建", variant: "primary", onSelect },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "新建" }));
    expect(onSelect).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "更多" })).toBeTruthy();
  });

  it("the primary action is drawn rightmost whatever the given order", () => {
    zh(
      <PageHeader
        path={[{ label: "~" }]}
        title="t"
        actions={[
          { label: "新建", variant: "primary", onSelect: () => {} },
          { label: "导入", variant: "default", onSelect: () => {} },
        ]}
      />,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["导入", "新建"]);
  });

  it("metrics are not drawn by the header (the template draws StatCards)", () => {
    zh(
      <PageHeader
        path={[{ label: "~" }]}
        title="t"
        metrics={[{ label: "成功率", value: "98%" }]}
      />,
    );
    expect(screen.queryByText("成功率")).toBeNull();
  });

  it("below 640 the actions other than the primary fold into more-horizontal", async () => {
    stubMedia(639);
    zh(
      <PageHeader
        path={[{ label: "~" }]}
        title="t"
        actions={[
          { label: "导入", variant: "default", onSelect: () => {} },
          { label: "新建", variant: "primary", onSelect: () => {} },
        ]}
      />,
    );
    expect(screen.queryByRole("button", { name: "导入" })).toBeNull();
    expect(screen.getByRole("button", { name: "新建" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "导入" })).toBeTruthy();
  });
});

describe("PageHeader first paint (m6)", () => {
  it("the server render draws the inline actions and the fold menu; CSS picks one by width", () => {
    const html = renderToString(
      <DesignProvider locale="zh">
        <PageHeader
          path={[{ label: "~" }]}
          title="t"
          actions={[
            { label: "导入", variant: "default", onSelect: () => {} },
            { label: "导出", variant: "default", onSelect: () => {} },
            { label: "新建", variant: "primary", onSelect: () => {} },
          ]}
        />
      </DesignProvider>,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const actions = doc.querySelector(".cb-pageheader-actions") as HTMLElement;
    expect(actions.getAttribute("data-responsive")).toBe("true");
    const wide = [...actions.querySelectorAll('[data-fold="inline"]')].map((e) => e.textContent);
    expect(wide).toEqual(["导入", "导出"]);
    const menu = actions.querySelector('[data-fold="menu"]');
    expect(menu?.querySelector('[aria-label="更多操作"]')).not.toBeNull();
    // the primary is drawn once, always, and last
    expect(actions.lastElementChild?.textContent).toBe("新建");
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/shell.css"), "utf8");
    expect(css).toMatch(
      /@media \(max-width: 639px\) \{\s*\.cb-pageheader-actions\[data-responsive="true"\] \[data-fold="inline"\] \{\s*display: none;/,
    );
    expect(css).toMatch(
      /@media \(min-width: 640px\) \{\s*\.cb-pageheader-actions\[data-responsive="true"\] \[data-fold="menu"\] \{\s*display: none;/,
    );
  });
});

describe("PageHeader tabs row (acceptance round 2, A5)", () => {
  it("the tabs sit on the row's bottom border and the search is centered; one row height", () => {
    zh(
      <PageHeader
        path={[{ label: "~" }]}
        title="t"
        tabs={[{ id: "a", label: "全部", count: 1 }]}
        search={{ label: "搜索", value: "", onChange: () => {} }}
      />,
    );
    const row = document.querySelector('[data-part="page-header-tabs"]') as HTMLElement;
    expect(row.querySelector(".cb-tabs")).not.toBeNull();
    expect(row.querySelector(".cb-pageheader-search")).not.toBeNull();
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/shell.css"), "utf8");
    const rule = (sel: string) => {
      const m = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css);
      return m?.[1] ?? "";
    };
    const tabsRow = rule(".cb-pageheader-tabs");
    // the tabs are aligned to the row bottom, the row keeps one height with or without search
    expect(tabsRow).toMatch(/align-items: flex-end;/);
    expect(tabsRow).toMatch(
      /height: calc\(var\(--cb-control-default\) \+ 2 \* var\(--cb-space-1\)\);/,
    );
    // the selected tab's underline overlaps the row's border
    expect(rule(".cb-pageheader-tabs .cb-tabs")).toMatch(/margin-bottom: -1px;/);
    const search = rule(".cb-pageheader-search");
    expect(search).toMatch(/align-self: center;/);
    expect(search).not.toMatch(/padding/);
  });
});

describe("StatCards", () => {
  it("one card per metric: label then value; warn / fail tone only the value", () => {
    zh(
      <StatCards
        metrics={[
          { label: "已接入", value: "24" },
          { label: "需要授权", value: "2", tone: "warn" },
          { label: "错误", value: "1", tone: "fail" },
        ]}
      />,
    );
    const cards = document.querySelectorAll('[data-part="stat-card"]');
    expect(cards.length).toBe(3);
    expect(cards[0]?.querySelector('[data-part="stat-label"]')?.textContent).toBe("已接入");
    expect(cards[0]?.querySelector('[data-part="stat-value"]')?.textContent).toBe("24");
    expect(cards[1]?.querySelector('[data-part="stat-value"]')?.getAttribute("data-tone")).toBe(
      "warn",
    );
    expect(
      cards[0]?.querySelector('[data-part="stat-value"]')?.getAttribute("data-tone"),
    ).toBeNull();
  });

  it("a metric with href is a link to its page: the whole card, named by label and value", () => {
    zh(
      <StatCards
        metrics={[
          { label: "组织", value: "3", href: "/admin/orgs" },
          { label: "账号", value: "12" },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: "组织 3" });
    expect(link.getAttribute("href")).toBe("/admin/orgs");
    expect(link.getAttribute("data-part")).toBe("stat-card");
    expect(link.querySelector('[data-part="stat-value"]')?.textContent).toBe("3");
    const plain = document.querySelectorAll('[data-part="stat-card"]')[1];
    expect(plain?.tagName).toBe("DIV");
  });

  it("six metrics throw", () => {
    const m = Array.from({ length: 6 }, (_, i) => ({ label: `m${i}`, value: i }));
    expect(() => zh(<StatCards metrics={m} />)).toThrow();
  });
});

describe("PageTabs", () => {
  it("渲染标签", () => {
    zh(<PageTabs label="详情" items={[{ id: "a", label: "概览" }]} value="a" />);
    expect(screen.getByRole("tab", { name: "概览" })).toBeTruthy();
  });
});

describe("ActionRow", () => {
  it("unsaved and errors on the left, primary last", () => {
    zh(
      <ActionRow
        unsaved={2}
        errors={1}
        cancel={{ label: "取消", onSelect: () => {} }}
        secondary={{ label: "存草稿", onSelect: () => {} }}
        primary={{ label: "保存", onSelect: () => {}, shortcut: "⌘S" }}
      />,
    );
    expect(screen.getByText("2 处未保存的修改")).toBeTruthy();
    const errors = document.querySelector('[data-part="action-row-errors"]') as HTMLElement;
    expect(errors.textContent).toBe("1 个错误");
    // the signed reference: the error count is fail-toned text, no icon, after an inline " · "
    expect(errors.querySelector("svg")).toBeNull();
    expect(errors.parentElement?.textContent).toBe("2 处未保存的修改 · 1 个错误");
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["取消", "存草稿", "保存⌘S"]);
  });

  it("unsaved=0 reads 没有未保存的修改; without counts nothing is shown", () => {
    const { unmount } = zh(
      <ActionRow unsaved={0} primary={{ label: "保存", onSelect: () => {} }} />,
    );
    expect(screen.getByText("没有未保存的修改")).toBeTruthy();
    unmount();
    zh(<ActionRow primary={{ label: "保存", onSelect: () => {} }} />);
    expect(screen.queryByText(/未保存/)).toBeNull();
  });

  it("primary click and loading", async () => {
    const onSelect = vi.fn();
    const { rerender } = zh(<ActionRow primary={{ label: "保存", onSelect }} />);
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    rerender(
      <DesignProvider locale="zh">
        <ActionRow primary={{ label: "保存", onSelect, loading: true }} />
      </DesignProvider>,
    );
    expect((screen.getByRole("button", { name: /保存/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Body", () => {
  const body = (
    <Body
      layout="rail-inspector"
      rail={<div>筛选器内容</div>}
      inspector={<div>检查器内容</div>}
      inspectorTitle="运行详情"
    >
      <div>主内容</div>
    </Body>
  );

  it("宽屏直接渲染 rail / content / inspector", () => {
    zh(body);
    expect(screen.getByText("筛选器内容")).toBeTruthy();
    expect(screen.getByText("主内容")).toBeTruthy();
    expect(screen.getByText("检查器内容")).toBeTruthy();
  });

  it("< 1280：inspector 改为 Sheet，由「详情」按钮打开", async () => {
    stubMedia(1279);
    zh(body);
    expect(screen.queryByText("检查器内容")).toBeNull();
    expect(screen.getByText("筛选器内容")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(screen.getByText("检查器内容")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "运行详情" })).toBeTruthy();
  });

  it("< 960：rail 改为「筛选」按钮 + Sheet", async () => {
    stubMedia(1279, 959);
    zh(body);
    expect(screen.queryByText("筛选器内容")).toBeNull();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "筛选" }));
    });
    expect(screen.getByText("筛选器内容")).toBeTruthy();
  });

  it("centered: no anchor navigation; content at the content width", () => {
    zh(
      <Body layout="centered" loose width="content">
        <div>表单</div>
      </Body>,
    );
    expect(screen.queryByRole("navigation")).toBeNull();
    const content = document.querySelector('[data-part="content"]') as HTMLElement;
    expect(content.getAttribute("data-width")).toBe("content");
    expect(content.getAttribute("data-gap")).toBe("loose");
    expect(content.textContent).toBe("表单");
  });

  it("server render draws the rail and its Filter button; CSS media queries pick one", () => {
    const html = renderToString(
      <DesignProvider locale="zh">
        <Body layout="rail-inspector" rail={<div>r</div>} inspector={<div>i</div>}>
          <div>c</div>
        </Body>
      </DesignProvider>,
    );
    for (const v of ["from-960", "below-960", "from-1280", "below-1280"]) {
      expect(html).toContain(`data-responsive="${v}"`);
    }
  });

  it("a body is the whole width unless a frame template asks for the content width", () => {
    zh(
      <Body layout="single">
        <div>主内容</div>
      </Body>,
    );
    expect(document.querySelector('[data-part="content"]')?.getAttribute("data-width")).toBe(
      "full",
    );
  });

  it("Rail 内容默认带内边距容器；railFlush 时直接贴边；contentPadded 标记内容区", () => {
    const { container } = zh(
      <Body layout="rail" rail={<div>筛选器内容</div>} contentPadded>
        <div>主内容</div>
      </Body>,
    );
    expect(screen.getByText("筛选器内容").parentElement?.className).toBe("cb-body-rail-inner");
    expect(container.querySelector(".cb-body-content")?.getAttribute("data-padded")).toBe("true");
    cleanup();
    const r = zh(
      <Body layout="rail" rail={<div>筛选器内容</div>} railFlush>
        <div>主内容</div>
      </Body>,
    );
    expect(screen.getByText("筛选器内容").parentElement?.className).toBe("cb-body-rail");
    expect(r.container.querySelector(".cb-body-content")?.getAttribute("data-padded")).toBeNull();
  });

  it("Inspector 内容放进带内边距的容器", () => {
    zh(
      <Body layout="inspector" inspector={<div>检查器内容</div>}>
        <div>主内容</div>
      </Body>,
    );
    expect(screen.getByText("检查器内容").parentElement?.className).toBe("cb-body-inspector-inner");
  });
});

describe("useMediaQuery", () => {
  it("同一 query 重渲染不重新订阅", () => {
    const add = vi.fn();
    const remove = vi.fn();
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener: add,
      removeEventListener: remove,
    })) as unknown as typeof window.matchMedia;
    const r = zh(shell(<div />));
    const subscribed = add.mock.calls.length;
    r.rerender(
      <DesignProvider locale="zh">
        <AppShell sidebar={{ ...sidebar }} commands={commands} status={{ ...status }}>
          <div />
        </AppShell>
      </DesignProvider>,
    );
    expect(add.mock.calls.length).toBe(subscribed);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("Body 折叠与关闭、数值 0", () => {
  it("Rail 可折叠：收起筛选 / 展开筛选", async () => {
    zh(
      <Body layout="rail" rail={<div>筛选器内容</div>}>
        <div>主内容</div>
      </Body>,
    );
    await userEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(screen.queryByText("筛选器内容")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(screen.getByText("筛选器内容")).toBeTruthy();
  });

  it("Inspector 传入 onInspectorClose 时可关闭", async () => {
    const onClose = vi.fn();
    zh(
      <Body layout="inspector" inspector={<div>检查器内容</div>} onInspectorClose={onClose}>
        <div>主内容</div>
      </Body>,
    );
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("未传 onInspectorClose 时没有关闭按钮", () => {
    zh(
      <Body layout="inspector" inspector={<div>检查器内容</div>}>
        <div>主内容</div>
      </Body>,
    );
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
  });

  it("PageHeader count=0 渲染 0", () => {
    zh(<PageHeader path={[{ label: "~" }]} title="Agents" count={0} />);
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("StatusBar with an empty context renders no context (before the session loads)", () => {
    zh(<StatusBar context="" version="v1" />);
    expect(document.querySelector('[data-part="status-bar-context"]')).toBeNull();
    expect(screen.getByText("v1")).toBeTruthy();
  });

  it("StatusBar right part: system, version, time zone, separated by spacing only (reference)", () => {
    zh(<StatusBar context="a" version="v1" timeZone="UTC+8" system="系统正常" />);
    const right = document.querySelector('[data-part="status-bar-right"]') as HTMLElement;
    expect(Array.from(right.children, (c) => c.textContent)).toEqual(["系统正常", "v1", "UTC+8"]);
    expect(right.textContent).not.toContain("·");
  });

  it("StatusBar pageStatus=0 渲染 0", () => {
    zh(<StatusBar context="a" version="v1" pageStatus={0} />);
    expect(screen.getByText("0")).toBeTruthy();
  });
});

describe("清理：PageHeader 链接操作", () => {
  it("href 操作与按钮一样显示快捷键提示", () => {
    zh(
      <PageHeader
        path={[{ label: "~" }]}
        title="t"
        actions={[
          { label: "编辑", variant: "default", href: "/edit", shortcut: "E" },
          { label: "保存", variant: "primary", shortcut: "⌘S", onSelect() {} },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: /编辑/ });
    expect(link.getAttribute("href")).toBe("/edit");
    const linkHint = link.querySelector(".cb-btn-shortcut");
    expect(linkHint?.textContent).toBe("E");
    const button = screen.getByRole("button", { name: /保存/ });
    expect(button.querySelector(".cb-btn-shortcut")?.textContent).toBe("⌘S");
  });

  it("类型上 href 与 onSelect 互斥", () => {
    const ok: HeaderAction[] = [
      { label: "a", variant: "default", href: "/a" },
      { label: "b", variant: "default", onSelect() {} },
    ];
    // @ts-expect-error href 与 onSelect 不能同时给
    const bad: HeaderAction = { label: "c", variant: "default", href: "/c", onSelect() {} };
    expect(ok.length + (bad ? 1 : 0)).toBe(3);
  });
});
