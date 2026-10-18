import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
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

const topBar = {
  nav: [
    { id: "overview", label: "概览", href: "/" },
    { id: "agents", label: "Agents", href: "/agents" },
  ],
  activeNav: "agents",
  org: { name: "Acme" },
  user: { name: "grant", menu: [{ label: "退出", onSelect: () => {} }] },
  commands: [{ label: "跳转", items: [{ id: "go", label: "前往概览", onSelect: () => {} }] }],
};
const status = { context: "grant@acme:/agents", version: "v0.1.0" };

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

describe("AppShell", () => {
  it("顺序为 TopBar、内容、StatusBar", () => {
    zh(
      <AppShell topBar={topBar} status={status}>
        <div>内容区</div>
      </AppShell>,
    );
    const banner = screen.getByRole("banner");
    const content = screen.getByText("内容区");
    const footer = screen.getByRole("contentinfo");
    expect(banner.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(content.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(footer).getByText(/grant@acme:\/agents/)).toBeTruthy();
    expect(within(footer).getByText("v0.1.0")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Agents" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "概览" }).getAttribute("aria-current")).toBeNull();
  });

  it("useStatusBar 写入页面状态，卸载后清除", async () => {
    zh(
      <AppShell topBar={topBar} status={status}>
        <Page />
      </AppShell>,
    );
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText("已筛选 18 / 24")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "卸载" }));
    expect(within(footer).queryByText("已筛选 18 / 24")).toBeNull();
  });

  it("⌘K 打开命令面板", async () => {
    zh(
      <AppShell topBar={topBar} status={status}>
        <div />
      </AppShell>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("前往概览")).toBeTruthy();
  });

  it("点击搜索框也打开命令面板", async () => {
    zh(
      <AppShell topBar={topBar} status={status}>
        <div />
      </AppShell>,
    );
    await userEvent.click(screen.getByRole("button", { name: /搜索或执行命令/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("PageHeader", () => {
  it("带 parent 时渲染链接与标题", () => {
    zh(<PageHeader parent={{ label: "Agents", href: "/agents" }} title="客服助手" />);
    const link = screen.getByRole("link", { name: "Agents /" });
    expect(link.getAttribute("href")).toBe("/agents");
    expect(screen.getByRole("heading", { level: 1, name: "客服助手" })).toBeTruthy();
  });

  it("两个 primary 抛错；6 个 metrics 抛错", () => {
    const p = (label: string): HeaderAction => ({ label, variant: "primary" });
    expect(() => assertHeader({ title: "x", actions: [p("a"), p("b")] })).toThrow();
    const m = Array.from({ length: 6 }, (_, i) => ({ label: `m${i}`, value: i }));
    expect(() => assertHeader({ title: "x", metrics: m } as PageHeaderProps)).toThrow();
    expect(() =>
      assertHeader({ title: "x", actions: [p("a")], metrics: m.slice(0, 5) }),
    ).not.toThrow();
  });

  it("80 字标题带 title 属性", () => {
    const long = "长".repeat(80);
    zh(<PageHeader title={long} />);
    expect(screen.getByRole("heading", { level: 1 }).getAttribute("title")).toBe(long);
  });

  it("操作按钮触发 onSelect；menu 操作渲染菜单按钮", async () => {
    const onSelect = vi.fn();
    zh(
      <PageHeader
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

  it("< 640 时指标折叠进 ⋯", () => {
    stubMedia(639);
    zh(<PageHeader title="t" metrics={[{ label: "成功率", value: "98%" }]} />);
    expect(screen.queryByText("成功率")).toBeNull();
    expect(screen.getByRole("button", { name: "指标" })).toBeTruthy();
  });
});

describe("PageTabs", () => {
  it("渲染标签", () => {
    zh(<PageTabs label="详情" items={[{ id: "a", label: "概览" }]} value="a" />);
    expect(screen.getByRole("tab", { name: "概览" })).toBeTruthy();
  });
});

describe("ActionRow", () => {
  it("显示未保存与错误，primary 在最后", () => {
    zh(
      <ActionRow
        unsaved={2}
        errors={1}
        cancel={{ label: "取消", onSelect: () => {} }}
        secondary={{ label: "存草稿", onSelect: () => {} }}
        primary={{ label: "保存", onSelect: () => {}, shortcut: "⌘S" }}
      />,
    );
    expect(screen.getByText("‖ 2 处未保存")).toBeTruthy();
    expect(screen.getByText("· 1 处错误")).toBeTruthy();
    const buttons = screen.getAllByRole("button");
    expect(buttons[buttons.length - 1]?.textContent).toContain("保存");
    expect(buttons.map((b) => b.textContent)).toEqual(["取消", "存草稿", "保存⌘S"]);
  });

  it("为 0 时不显示计数", () => {
    zh(<ActionRow primary={{ label: "保存", onSelect: () => {} }} />);
    expect(screen.queryByText(/未保存/)).toBeNull();
  });

  it("primary 点击与 loading", async () => {
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

  it("centered：当前锚点 aria-current，含错误的分组后缀 ●（不加 ✗ 前缀）", async () => {
    zh(
      <Body
        layout="centered"
        anchors={[
          { id: "basic", label: "基础" },
          { id: "model", label: "模型", error: true },
        ]}
      >
        <div>表单</div>
      </Body>,
    );
    const nav = screen.getByRole("navigation", { name: "页内导航" });
    const basic = within(nav).getByRole("link", { name: "基础" });
    expect(basic.getAttribute("href")).toBe("#basic");
    expect(basic.getAttribute("aria-current")).toBe("location");
    const model = within(nav).getByRole("link", { name: /模型/ });
    expect(model.textContent).not.toContain("✗");
    expect(model.textContent?.startsWith("模型")).toBe(true);
    const dot = model.querySelector(".cb-body-anchor-error") as HTMLElement;
    expect(dot.textContent).toContain("●");
    expect(model.getAttribute("aria-current")).toBeNull();
    await userEvent.click(model);
    expect(model.getAttribute("aria-current")).toBe("location");
    expect(basic.getAttribute("aria-current")).toBeNull();
  });

  it("centered：activeAnchor 指定当前项", () => {
    zh(
      <Body
        layout="centered"
        activeAnchor="model"
        anchors={[
          { id: "basic", label: "基础" },
          { id: "model", label: "模型" },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "模型" }).getAttribute("aria-current")).toBe(
      "location",
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

describe("TopBar 窄屏", () => {
  const wideNav = {
    ...topBar,
    nav: [
      { id: "overview", label: "概览", href: "/" },
      { id: "agents", label: "Agents", href: "/agents" },
      { id: "runs", label: "运行记录", href: "/runs" },
    ],
  };

  it("≥1280：完整搜索框，导航全部可见", () => {
    zh(
      <AppShell topBar={wideNav} status={status}>
        <div />
      </AppShell>,
    );
    expect(screen.getByRole("button", { name: /搜索或执行命令/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "运行记录" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /更多/ })).toBeNull();
  });

  it("<1280：搜索收成图标按钮（aria-label 搜索），点击打开命令面板", async () => {
    stubMedia(1279);
    zh(
      <AppShell topBar={wideNav} status={status}>
        <div />
      </AppShell>,
    );
    expect(screen.queryByRole("button", { name: /搜索或执行命令/ })).toBeNull();
    expect(screen.getByRole("link", { name: "运行记录" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("<960：只显示当前项，其余收进「更多 ▾」菜单", async () => {
    stubMedia(1279, 959);
    zh(
      <AppShell topBar={wideNav} status={status}>
        <div />
      </AppShell>,
    );
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Agents"]);
    await userEvent.click(within(nav).getByRole("button", { name: /更多/ }));
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["概览", "运行记录"]);
    expect(items[1]?.getAttribute("href")).toBe("/runs");
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
    zh(<PageHeader title="Agents" count={0} />);
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("StatusBar context 为空时不渲染 `>` 上下文（会话加载前）", () => {
    zh(<StatusBar context="" version="v1" />);
    expect(document.querySelector(".cb-statusbar-ctx")).toBeNull();
    expect(screen.queryByText(/^>/)).toBeNull();
    expect(screen.getByText("v1")).toBeTruthy();
  });

  it("StatusBar pageStatus=0 渲染 0", () => {
    zh(<StatusBar context="a" version="v1" pageStatus={0} />);
    expect(screen.getByText("0")).toBeTruthy();
  });
});
