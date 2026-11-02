// biome-ignore-all lint/correctness/useJsxKeyInIterable: 用例表是 [名称, 元素] 元组，不是渲染列表
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as design from "../src/index";
import {
  AuthPage,
  ConversationPage,
  DesignProvider,
  DetailPage,
  FormPage,
  FormSection,
  InboxPage,
  KeyValue,
  ListPage,
  OnboardingPage,
  OverviewPage,
  PAGE_TEMPLATES,
  PendingState,
  SettingsPage,
  SetupPage,
  StatusPage,
  TracePage,
  WizardPage,
} from "../src/index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

const header = { path: [{ label: "capybara" }], title: "页面标题" };
const row = { primary: { label: "保存", onSelect: () => {} } };

function root(name: string) {
  return document.querySelector(`[data-template="${name}"]`);
}

describe("页面模板根节点与页头", () => {
  const cases: [string, React.ReactElement][] = [
    ["OverviewPage", <OverviewPage header={header}>x</OverviewPage>],
    [
      "ListPage",
      <ListPage header={header} rail={<div>r</div>}>
        x
      </ListPage>,
    ],
    [
      "DetailPage",
      <DetailPage
        header={header}
        tabs={{ items: [{ id: "a", label: "概要" }], value: "a", label: "标签" }}
        inspector={<div>i</div>}
      >
        x
      </DetailPage>,
    ],
    [
      "FormPage",
      <FormPage header={header} actionRow={row}>
        x
      </FormPage>,
    ],
    [
      "SettingsPage",
      <SettingsPage
        header={header}
        nav={[{ group: "g", items: [{ id: "org", label: "组织", href: "/org" }] }]}
        activeNav="org"
      >
        x
      </SettingsPage>,
    ],
    [
      "InboxPage",
      <InboxPage header={header} list={<div>l</div>} inspector={<div>i</div>}>
        x
      </InboxPage>,
    ],
    ["TracePage", <TracePage header={header} waterfall={<div>w</div>} detail={<div>d</div>} />],
    [
      "WizardPage",
      <WizardPage header={header} steps={["一", "二", "三"]} current={1} actionRow={row}>
        x
      </WizardPage>,
    ],
    [
      "StatusPage",
      <StatusPage header={header} kind="404" title="未找到" description="页面不存在" />,
    ],
    [
      "OnboardingPage",
      <OnboardingPage
        header={header}
        steps={[{ label: "接入模型", description: "d", done: false }]}
      />,
    ],
  ];
  for (const [name, el] of cases) {
    it(`${name}`, () => {
      zh(el);
      expect(root(name)).toBeTruthy();
      expect(screen.getByRole("heading", { level: 1, name: "页面标题" })).toBeTruthy();
    });
    it(`${name}: the root and the head use the one content width (no full-width template)`, () => {
      zh(el);
      expect(root(name)?.getAttribute("data-width")).toBe("content");
      const head = document.querySelector(".cb-template-head-frame");
      expect(head?.getAttribute("data-width")).toBe("content");
    });
  }

  it("AuthPage 无 Shell：标题可见，含 Dither 与 Logo，无页头", () => {
    zh(
      <AuthPage title="登录" subtitle="欢迎回来" footer={<span>页脚</span>}>
        <input aria-label="邮箱" />
      </AuthPage>,
    );
    expect(root("AuthPage")).toBeTruthy();
    expect(screen.getByText("登录")).toBeTruthy();
    expect(document.querySelectorAll(".cb-dither").length).toBe(2);
    expect(document.querySelector(".cb-logo")).toBeTruthy();
    expect(document.querySelector(".cb-pageheader")).toBeNull();
  });

  it("其他模板不含 Dither", () => {
    zh(<OverviewPage header={header}>x</OverviewPage>);
    expect(document.querySelector(".cb-dither")).toBeNull();
  });
});

describe("FormPage", () => {
  it("unsaved>0 注册 beforeunload，卸载后移除", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = zh(
      <FormPage header={header} actionRow={{ ...row, unsaved: 1 }}>
        x
      </FormPage>,
    );
    expect(add.mock.calls.some((c) => c[0] === "beforeunload")).toBe(true);
    unmount();
    expect(remove.mock.calls.some((c) => c[0] === "beforeunload")).toBe(true);
  });

  it("beforeunload：preventDefault 且 returnValue 设为空串（兼容旧浏览器）", () => {
    const add = vi.spyOn(window, "addEventListener");
    zh(
      <FormPage header={header} actionRow={{ ...row, unsaved: 2 }}>
        x
      </FormPage>,
    );
    const call = add.mock.calls.find((c) => c[0] === "beforeunload");
    const handler = call?.[1] as (e: BeforeUnloadEvent) => void;
    const e = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    handler(e as unknown as BeforeUnloadEvent);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.returnValue).toBe("");
  });

  it("unsaved=0 不注册 beforeunload", () => {
    const add = vi.spyOn(window, "addEventListener");
    zh(
      <FormPage header={header} actionRow={{ ...row, unsaved: 0 }}>
        x
      </FormPage>,
    );
    expect(add.mock.calls.some((c) => c[0] === "beforeunload")).toBe(false);
  });

  it("FormSection 渲染 id、标题、说明与两栏网格", () => {
    zh(
      <FormSection id="basic" title="基础信息" description="名称与描述">
        <div>字段</div>
      </FormSection>,
    );
    expect(document.getElementById("basic")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "基础信息" })).toBeTruthy();
    expect(screen.getByText("名称与描述")).toBeTruthy();
    // Two columns: the title and description, then the fields on a card
    const head = document.querySelector('[data-part="form-section-head"]') as HTMLElement;
    const card = document.querySelector('[data-part="form-card"]') as HTMLElement;
    expect(head.parentElement).toBe(card.parentElement);
    expect(card.textContent).toBe("字段");
    // 分组以标题命名为 region，便于辅助技术与测试按分组定位
    expect(screen.getByRole("region", { name: "基础信息" }).id).toBe("basic");
  });

  it("始终渲染 ActionRow", () => {
    zh(
      <FormPage header={header} actionRow={row}>
        x
      </FormPage>,
    );
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
  });
});

describe("widths, stat cards and the form without anchors", () => {
  const width = () =>
    document.querySelector('[data-part="content"]')?.getAttribute("data-width") ?? null;
  const widths: [string, React.ReactElement, string][] = [
    ["OverviewPage", <OverviewPage header={header}>x</OverviewPage>, "content"],
    ["ListPage", <ListPage header={header}>x</ListPage>, "content"],
    [
      "FormPage",
      <FormPage header={header} actionRow={row}>
        x
      </FormPage>,
      "content",
    ],
    [
      "SettingsPage",
      <SettingsPage
        header={header}
        nav={[{ group: "g", items: [{ id: "o", label: "组织", href: "/o" }] }]}
        activeNav="o"
      >
        x
      </SettingsPage>,
      "content",
    ],
    [
      "WizardPage",
      <WizardPage header={header} steps={["一"]} current={0} actionRow={row}>
        x
      </WizardPage>,
      "content",
    ],
    [
      "DetailPage",
      <DetailPage
        header={header}
        tabs={{ items: [{ id: "a", label: "概要" }], value: "a", label: "t" }}
      >
        x
      </DetailPage>,
      "content",
    ],
    [
      "InboxPage",
      <InboxPage header={header} list={<div>l</div>}>
        x
      </InboxPage>,
      "content",
    ],
    [
      "TracePage",
      <TracePage header={header} waterfall={<div>w</div>} detail={<div>d</div>} />,
      "content",
    ],
    [
      "StatusPage",
      <StatusPage header={header} kind="404" title="未找到" description="页面不存在" />,
      "content",
    ],
    [
      "OnboardingPage",
      <OnboardingPage
        header={header}
        steps={[{ label: "接入模型", description: "d", done: false }]}
      />,
      "content",
    ],
  ];
  for (const [name, el, w] of widths) {
    it(`${name} is data-width="${w}" (frame templates share the content width)`, () => {
      zh(el);
      expect(width()).toBe(w);
    });
  }

  it("DetailPage: the head and the content share one width container", () => {
    zh(
      <DetailPage
        header={header}
        tabs={{ items: [{ id: "a", label: "概要" }], value: "a", label: "t" }}
        inspector={<div>i</div>}
      >
        x
      </DetailPage>,
    );
    const head = document.querySelector(".cb-template-head-frame") as HTMLElement;
    const content = document.querySelector('[data-part="content"]') as HTMLElement;
    expect(head.getAttribute("data-width")).toBe("content");
    expect(content.getAttribute("data-width")).toBe("content");
    expect(head.closest(".cb-body-main")).not.toBeNull();
    expect(head.closest(".cb-body-main")).toBe(content.closest(".cb-body-main"));
  });

  it("ListPage renders StatCards after the header when metrics are given", () => {
    zh(
      <ListPage
        header={{
          path: [{ label: "capybara" }],
          title: "连接器",
          metrics: [
            { label: "已接入", value: "24" },
            { label: "需要授权", value: "2", tone: "warn" },
          ],
        }}
      >
        <div>表格</div>
      </ListPage>,
    );
    const h1 = screen.getByRole("heading", { level: 1 });
    const stats = document.querySelector('[data-part="stat-cards"]') as HTMLElement;
    const table = screen.getByText("表格");
    expect(stats).toBeTruthy();
    expect(h1.compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stats.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stats.querySelectorAll('[data-part="stat-card"]').length).toBe(2);
  });

  it("ListPage without metrics has no stat cards", () => {
    zh(<ListPage header={header}>x</ListPage>);
    expect(document.querySelector('[data-part="stat-cards"]')).toBeNull();
  });

  it("FormPage has no anchor navigation", () => {
    zh(
      <FormPage header={header} actionRow={row}>
        <FormSection id="basic" title="基础信息">
          <div>字段</div>
        </FormSection>
      </FormPage>,
    );
    expect(screen.queryByRole("navigation", { name: "页内导航" })).toBeNull();
    // only the path line is a navigation landmark
    const navs = screen.queryAllByRole("navigation");
    expect(navs.map((n) => n.getAttribute("data-part"))).toEqual(["path"]);
  });
});

describe("WizardPage", () => {
  it("current=1：第 1 步 done，第 2 步 current，第 3 步 todo", () => {
    zh(
      <WizardPage header={header} steps={["一", "二", "三"]} current={1} actionRow={row}>
        x
      </WizardPage>,
    );
    const steps = document.querySelectorAll("[data-step]");
    expect(Array.from(steps).map((s) => s.getAttribute("data-state"))).toEqual([
      "done",
      "current",
      "todo",
    ]);
    expect(document.querySelector('[data-state="current"]')?.getAttribute("aria-current")).toBe(
      "step",
    );
  });
});

describe("其他模板行为", () => {
  it("DetailPage / InboxPage 透传 onInspectorClose", async () => {
    const onClose = vi.fn();
    const tabs = { items: [{ id: "a", label: "概要" }], value: "a", label: "标签" };
    const { unmount } = zh(
      <DetailPage header={header} tabs={tabs} inspector={<div>i</div>} onInspectorClose={onClose}>
        x
      </DetailPage>,
    );
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    unmount();
    zh(
      <InboxPage
        header={header}
        list={<div>l</div>}
        inspector={<div>i</div>}
        onInspectorClose={onClose}
      >
        x
      </InboxPage>,
    );
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("InboxPage with no items: one page empty state instead of the list + detail split", () => {
    zh(
      <InboxPage header={header} list={<div>l</div>} empty={{ text: "没有待处理的事项" }}>
        x
      </InboxPage>,
    );
    expect(screen.getByText("没有待处理的事项")).toBeTruthy();
    expect(document.querySelector('[data-part="empty-state"]')?.getAttribute("data-size")).toBe(
      "page",
    );
    expect(document.querySelector(".cb-body-rail")).toBeNull();
    expect(screen.queryByText("l")).toBeNull();
    expect(screen.queryByText("x")).toBeNull();
    expect(document.querySelector(".cb-body")?.getAttribute("data-layout")).toBe("single");
  });

  it("InboxPage: the split is capped at the content width, inside the content padding", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/shell.css"), "utf8");
    expect(css).toMatch(
      /\.cb-template\[data-template="InboxPage"\] \.cb-body:not\(\[data-layout="single"\]\) \{[^}]*padding: 0 var\(--cb-content-pad\);[^}]*scrollbar-gutter: stable;/,
    );
    expect(css).toMatch(
      /\.cb-template\[data-template="InboxPage"\] \.cb-body-row \{[^}]*max-width: var\(--cb-layout-content\);[^}]*margin: 0 auto;/,
    );
  });

  it("the template head has one padding rule: the content padding, no page gutter", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/shell.css"), "utf8");
    const head = /\.cb-template-head \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(head).toContain("padding: var(--cb-space-5) var(--cb-content-pad) var(--cb-space-3);");
    expect(head).toContain("scrollbar-gutter: stable;");
    expect(css).not.toContain('.cb-template-head[data-width="content"]');
  });

  it("TracePage: an info grid in the detail panel is one label/value pair per row", () => {
    // The real stylesheets: the conversation's argument grid must not lay KeyValue out in pairs
    const styles = ["display.css", "conversation.css"].map((f) => {
      const el = document.createElement("style");
      el.textContent = readFileSync(resolve(import.meta.dirname, `../src/styles/${f}`), "utf8");
      document.head.append(el);
      return el;
    });
    try {
      zh(
        <TracePage
          header={header}
          waterfall={<div>w</div>}
          detail={
            <KeyValue
              keyWidth="16ch"
              rows={[
                { k: "版本", v: "v3" },
                { k: "发起人", v: "Grant" },
                { k: "开始", v: "10:00" },
                { k: "结束", v: "10:01" },
              ]}
            />
          }
        />,
      );
      const dl = document.querySelector(".cb-trace-detail dl.cb-kv") as HTMLElement;
      expect(getComputedStyle(dl).display).toBe("flex");
      expect(getComputedStyle(dl).flexDirection).toBe("column");
      const rows = [...dl.children];
      expect(rows).toHaveLength(4);
      for (const r of rows) {
        expect([...r.children].map((c) => c.tagName)).toEqual(["DT", "DD"]);
      }
    } finally {
      for (const el of styles) el.remove();
    }
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/templates.css"), "utf8");
    // the right panel never scrolls sideways
    expect(css).toMatch(/\.cb-trace-detail \{[^}]*overflow: hidden auto;/);
  });

  it("TracePage: the detail follows the waterfall in one column, a right panel from 1280", () => {
    zh(<TracePage header={header} waterfall={<div>w</div>} detail={<div>d</div>} />);
    const waterfall = document.querySelector(".cb-trace-waterfall") as HTMLElement;
    const detail = document.querySelector(".cb-trace-detail") as HTMLElement;
    expect(waterfall.parentElement).toBe(detail.parentElement);
    expect(waterfall.nextElementSibling).toBe(detail);
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/templates.css"), "utf8");
    const trace = /\.cb-trace \{([^}]*)\}/.exec(css)?.[1] ?? "";
    // no stretched waterfall pinning the detail to the bottom (the dead gap)
    expect(trace).not.toContain("min-height: 100%");
    expect(css).toMatch(
      /@media \(min-width: 1280px\) \{[^@]*\.cb-trace \{[^}]*grid-template-columns: minmax\(0, 1fr\) 400px;/,
    );
  });

  it("ListPage 无 rail 时为 single", () => {
    zh(<ListPage header={header}>x</ListPage>);
    expect(document.querySelector('.cb-body[data-layout="single"]')).toBeTruthy();
  });

  it("SettingsPage 当前导航项 aria-current", () => {
    zh(
      <SettingsPage
        header={header}
        nav={[
          {
            group: "g",
            items: [
              { id: "org", label: "组织", href: "/org" },
              { id: "sec", label: "安全", href: "/sec" },
            ],
          },
        ]}
        activeNav="sec"
      >
        x
      </SettingsPage>,
    );
    expect(screen.getByRole("link", { name: "安全" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "组织" }).getAttribute("aria-current")).toBeNull();
  });

  it("OnboardingPage marks done and to-do steps; a to-do step shows only its action", () => {
    zh(
      <OnboardingPage
        header={header}
        steps={[
          { label: "接入模型", description: "d1", done: true },
          {
            label: "新建 agent",
            description: "d2",
            done: false,
            action: <button type="button">开始</button>,
          },
        ]}
      />,
    );
    const items = document.querySelectorAll("[data-step]");
    expect(Array.from(items).map((i) => i.getAttribute("data-state"))).toEqual(["done", "todo"]);
    expect(screen.getByRole("button", { name: "开始" })).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.queryByText("待办")).toBeNull();
  });

  it("StatusPage 渲染标题、说明、操作与 kind", () => {
    zh(
      <StatusPage
        header={header}
        kind="maintenance"
        title="维护中"
        description="稍后再试"
        action={<button type="button">刷新</button>}
      />,
    );
    expect(root("StatusPage")?.getAttribute("data-kind")).toBe("maintenance");
    expect(screen.getByRole("heading", { level: 2, name: "维护中" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
  });
});

describe("PAGE_TEMPLATES", () => {
  // 13 templates; ConversationPage replaced PlaygroundPage when the conversation page moved over;
  // SetupPage is the guided setup layout (acceptance round 2, D).
  it("has 13 entries, each an exported component", () => {
    expect(PAGE_TEMPLATES.length).toBe(13);
    for (const n of PAGE_TEMPLATES) {
      expect(typeof (design as Record<string, unknown>)[n]).toBe("function");
    }
  });
});

describe("ConversationPage 跟随最新消息", () => {
  /** jsdom 不做布局：用内容行数模拟 scrollHeight（每行 40px），视口高 100px。 */
  function mockLayout() {
    const tops = new WeakMap<Element, number>();
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
      return this.querySelectorAll("p").length * 40;
    });
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(100);
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
      return tops.get(this) ?? 0;
    });
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
      this: Element,
      v: number,
    ) {
      tops.set(this, Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)));
    });
  }
  const page = (n: number) => (
    <DesignProvider locale="zh">
      <ConversationPage
        titleBar={{
          title: "t",
          untitled: "u",
          menu: [],
          properties: { pressed: false, onToggle: () => {} },
          panels: [],
        }}
        thread={Array.from({ length: n }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态用例
          <p key={i}>消息 {i}</p>
        ))}
        composer={<div>c</div>}
        status={{ context: "", version: "" }}
        right="none"
        onCloseRight={() => {}}
      />
    </DesignProvider>
  );
  const thread = () => document.querySelector(".cb-conv-scroll") as HTMLElement;
  const scrollTo = (el: HTMLElement, top: number) => {
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  };

  it("挂载时滚到底部，内容增长时继续跟随", async () => {
    mockLayout();
    const r = render(page(10));
    expect(thread().scrollTop).toBe(300);
    r.rerender(page(12));
    await vi.waitFor(() => expect(thread().scrollTop).toBe(380));
  });

  it("在底部 48px 以内仍跟随；上翻后停止跟随，回到底部恢复", async () => {
    mockLayout();
    const r = render(page(10));
    const el = thread();
    scrollTo(el, 260); // 距底 40px：仍算在底部
    r.rerender(page(11));
    await vi.waitFor(() => expect(el.scrollTop).toBe(340));

    scrollTo(el, 100); // 上翻
    r.rerender(page(13));
    await new Promise((res) => setTimeout(res, 0));
    expect(el.scrollTop).toBe(100);

    scrollTo(el, 420); // 回到底部
    r.rerender(page(14));
    await vi.waitFor(() => expect(el.scrollTop).toBe(460));
  });
});

describe("SettingsPage column (blind round 2)", () => {
  const settings = () =>
    zh(
      <SettingsPage
        header={{ path: [], title: "组织设置" }}
        nav={[
          {
            group: "g",
            items: [
              { id: "org", label: "组织", href: "/org" },
              { id: "members", label: "成员", href: "/members" },
            ],
          },
        ]}
        activeNav="org"
      >
        <p>内容</p>
      </SettingsPage>,
    );

  it("the header spans the content width above the sub-nav and the content", () => {
    settings();
    const title = screen.getByRole("heading", { name: "组织设置" });
    const nav = screen.getByRole("navigation", { name: "设置导航" });
    const content = document.querySelector('[data-part="content"]') as HTMLElement;
    expect(content.contains(nav)).toBe(true);
    expect(content.contains(title)).toBe(false);
    expect(title.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.closest(".cb-template-head-frame")?.getAttribute("data-width")).toBe("content");
  });

  it("the head's description sits at the top of the content column, so the sub-nav never moves", () => {
    zh(
      <SettingsPage
        header={{ path: [], title: "服务令牌", description: "给脚本用的令牌。" }}
        nav={[{ group: "g", items: [{ id: "tokens", label: "服务令牌", href: "/t" }] }]}
        activeNav="tokens"
      >
        <p>内容</p>
      </SettingsPage>,
    );
    const description = screen.getByText("给脚本用的令牌。");
    expect(description.closest(".cb-template-head")).toBeNull();
    const column = description.closest(".cb-settings-content") as HTMLElement;
    expect(column).not.toBeNull();
    expect(column.firstElementChild).toBe(description);
    expect(document.querySelector('[data-part="page-header-description"]')).toBeNull();
  });

  it("the sub-nav has a name and no collapse button", () => {
    settings();
    expect(screen.queryByRole("button", { name: "收起侧栏" })).toBeNull();
    const nav = screen.getByRole("navigation", { name: "设置导航" });
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("组织");
  });
});

describe("SetupPage (the guided setup layout)", () => {
  const org = {
    name: "Acme",
    initial: "A",
    slug: "acme",
    role: "所有者",
    menu: [{ label: "Beta", checked: false, onSelect: vi.fn() }],
  };
  const account = { name: "Grant", menu: [{ label: "退出登录", onSelect: vi.fn() }] };
  const status = { context: "grant@acme:~/setup", version: "v1.0.0" };
  const steps: design.SetupStep[] = [
    { id: "model", label: "配置模型", state: "done", href: "/admin/extensions" },
    { id: "agent", label: "创建 agent", state: "todo", href: "/agents/new" },
    { id: "channels", label: "连接渠道", state: "todo", href: "/channels/new", optional: true },
  ];
  const sidebar = { org, home: { href: "/" }, steps, activeNav: "home", account };

  it("the shell's geometry: the setup sidebar, the content area, the status bar; no top bar", () => {
    zh(
      <SetupPage sidebar={sidebar} status={status}>
        <p>清单</p>
      </SetupPage>,
    );
    const root = document.querySelector('[data-template="SetupPage"]') as HTMLElement;
    expect(root.querySelector('[data-part="setup-top-bar"]')).toBeNull();
    const shell = root.querySelector(".cb-shell") as HTMLElement;
    const aside = shell.querySelector('[data-part="sidebar"]') as HTMLElement;
    expect(aside.getAttribute("data-context")).toBe("setup");
    const content = shell.querySelector('[data-part="shell-content"]') as HTMLElement;
    expect(content.querySelector("main")?.textContent).toBe("清单");
    expect(screen.getByText("grant@acme:~/setup")).toBeTruthy();
    // the steps are the navigation; no search, no inbox, no conversations
    const nav = screen.getAllByRole("navigation", { name: "主导航" })[0] as HTMLElement;
    expect(nav.textContent).toContain("配置模型");
    expect(screen.queryByRole("button", { name: /搜索/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "会话" })).toBeNull();
  });

  it("the org opens its menu; the account opens its menu", async () => {
    zh(<SetupPage sidebar={sidebar} status={status} />);
    const user = userEvent.setup();
    const [orgButton] = screen.getAllByRole("button", { name: "当前组织：Acme，切换组织" });
    if (!orgButton) throw new Error("no org switcher");
    await user.click(orgButton);
    await user.click(await screen.findByRole("menuitemradio", { name: "Beta" }));
    expect(org.menu[0]?.onSelect).toHaveBeenCalledTimes(1);
    const [accountButton] = screen.getAllByRole("button", { name: "账户: Grant" });
    if (!accountButton) throw new Error("no account button");
    await user.click(accountButton);
    await user.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    expect(account.menu[0]?.onSelect).toHaveBeenCalledTimes(1);
  });

  it("⌘K opens nothing (no command palette in the setup frame)", async () => {
    zh(<SetupPage sidebar={sidebar} status={status} />);
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the drawer bar below 960 has the menu button and no search", () => {
    zh(
      <SetupPage sidebar={sidebar} status={status} reference={{ drawer: true }} title="开始之前" />,
    );
    const bar = document.querySelector('[data-part="drawer-bar"]') as HTMLElement;
    expect(bar.querySelector('[aria-label="打开导航"]')).not.toBeNull();
    expect(bar.querySelector('[aria-label^="搜索"]')).toBeNull();
    expect(bar.textContent).toContain("开始之前");
  });
});

describe("PendingState (the neutral loading state)", () => {
  afterEach(() => vi.useRealTimers());

  it("is empty at first and shows a quiet skeleton only after 300 ms", () => {
    vi.useFakeTimers();
    zh(<PendingState frame="app" />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(el.querySelectorAll('[data-part="pending-bar"]')).toHaveLength(0);
    act(() => vi.advanceTimersByTime(299));
    expect(el.querySelectorAll('[data-part="pending-bar"]')).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(el.querySelectorAll('[data-part="pending-bar"]').length).toBeGreaterThan(0);
  });
});
