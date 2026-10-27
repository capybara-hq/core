// biome-ignore-all lint/correctness/useJsxKeyInIterable: 用例表是 [名称, 元素] 元组，不是渲染列表
import { cleanup, render, screen } from "@testing-library/react";
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
  ListPage,
  OnboardingPage,
  OverviewPage,
  PAGE_TEMPLATES,
  SettingsPage,
  StatusPage,
  TracePage,
  WizardPage,
} from "../src/index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

const header = { title: "页面标题" };
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
        nav={[{ id: "org", label: "组织", href: "/org" }]}
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
    ["OverviewPage", <OverviewPage header={header}>x</OverviewPage>, "list"],
    ["ListPage", <ListPage header={header}>x</ListPage>, "list"],
    [
      "FormPage",
      <FormPage header={header} actionRow={row}>
        x
      </FormPage>,
      "form",
    ],
    [
      "SettingsPage",
      <SettingsPage header={header} nav={[{ id: "o", label: "组织", href: "/o" }]} activeNav="o">
        x
      </SettingsPage>,
      "form",
    ],
    [
      "WizardPage",
      <WizardPage header={header} steps={["一"]} current={0} actionRow={row}>
        x
      </WizardPage>,
      "form",
    ],
    [
      "DetailPage",
      <DetailPage
        header={header}
        tabs={{ items: [{ id: "a", label: "概要" }], value: "a", label: "t" }}
      >
        x
      </DetailPage>,
      "full",
    ],
    [
      "InboxPage",
      <InboxPage header={header} list={<div>l</div>}>
        x
      </InboxPage>,
      "full",
    ],
    [
      "TracePage",
      <TracePage header={header} waterfall={<div>w</div>} detail={<div>d</div>} />,
      "full",
    ],
  ];
  for (const [name, el, w] of widths) {
    it(`${name} content is data-width="${w}"`, () => {
      zh(el);
      expect(width()).toBe(w);
    });
  }

  it("ListPage renders StatCards after the header when metrics are given", () => {
    zh(
      <ListPage
        header={{
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
    expect(screen.queryByRole("navigation")).toBeNull();
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

  it("ListPage 无 rail 时为 single", () => {
    zh(<ListPage header={header}>x</ListPage>);
    expect(document.querySelector('.cb-body[data-layout="single"]')).toBeTruthy();
  });

  it("SettingsPage 当前导航项 aria-current", () => {
    zh(
      <SettingsPage
        header={header}
        nav={[
          { id: "org", label: "组织", href: "/org" },
          { id: "sec", label: "安全", href: "/sec" },
        ]}
        activeNav="sec"
      >
        x
      </SettingsPage>,
    );
    expect(screen.getByRole("link", { name: "安全" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "组织" }).getAttribute("aria-current")).toBeNull();
  });

  it("OnboardingPage 区分完成与待办，并渲染 action", () => {
    zh(
      <OnboardingPage
        header={header}
        steps={[
          { label: "接入模型", description: "d1", done: true },
          {
            label: "创建 Agent",
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
    expect(screen.getByText("待办")).toBeTruthy();
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
  // 12 templates; ConversationPage replaced PlaygroundPage when the conversation page moved over.
  it("has 12 entries, each an exported component", () => {
    expect(PAGE_TEMPLATES.length).toBe(12);
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
        header={{ title: "组织设置" }}
        nav={[
          { id: "org", label: "组织", href: "/org" },
          { id: "members", label: "成员", href: "/members" },
        ]}
        activeNav="org"
      >
        <p>内容</p>
      </SettingsPage>,
    );

  it("the header sits in the content column, beside the rail, not above it", () => {
    settings();
    const title = screen.getByRole("heading", { name: "组织设置" });
    const content = document.querySelector('[data-part="content"]') as HTMLElement;
    const main = title.closest(".cb-body-main");
    expect(main).not.toBeNull();
    expect(main?.contains(content)).toBe(true);
    const rail = document.querySelector(".cb-body-rail") as HTMLElement;
    expect(rail.contains(title)).toBe(false);
    expect(rail.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the header frame has the form width, like the content frame
    expect(title.closest(".cb-template-head-frame")?.getAttribute("data-width")).toBe("form");
  });

  it("the nav starts the rail: no collapse button above it; the nav has a name", () => {
    settings();
    expect(screen.queryByRole("button", { name: "收起侧栏" })).toBeNull();
    const nav = screen.getByRole("navigation", { name: "设置导航" });
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("组织");
  });
});
