// biome-ignore-all lint/correctness/useJsxKeyInIterable: 用例表是 [名称, 元素] 元组，不是渲染列表
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as design from "../src/index";
import {
  AuthPage,
  DesignProvider,
  DetailPage,
  FormPage,
  FormSection,
  InboxPage,
  ListPage,
  OnboardingPage,
  OverviewPage,
  PAGE_TEMPLATES,
  PlaygroundPage,
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
      <FormPage header={header} anchors={[{ id: "a", label: "基础" }]} actionRow={row}>
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
    [
      "PlaygroundPage",
      <PlaygroundPage header={header} composer={<div>c</div>} inspector={<div>i</div>}>
        x
      </PlaygroundPage>,
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
      <FormPage header={header} anchors={[]} actionRow={{ ...row, unsaved: 1 }}>
        x
      </FormPage>,
    );
    expect(add.mock.calls.some((c) => c[0] === "beforeunload")).toBe(true);
    unmount();
    expect(remove.mock.calls.some((c) => c[0] === "beforeunload")).toBe(true);
  });

  it("unsaved=0 不注册 beforeunload", () => {
    const add = vi.spyOn(window, "addEventListener");
    zh(
      <FormPage header={header} anchors={[]} actionRow={{ ...row, unsaved: 0 }}>
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
    expect(document.querySelector('.cb-grid[data-columns="form"]')).toBeTruthy();
    // 分组以标题命名为 region，便于辅助技术与测试按分组定位
    expect(screen.getByRole("region", { name: "基础信息" }).id).toBe("basic");
  });

  it("始终渲染 ActionRow", () => {
    zh(
      <FormPage header={header} anchors={[]} actionRow={row}>
        x
      </FormPage>,
    );
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
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
  it("DetailPage / InboxPage / PlaygroundPage 透传 onInspectorClose", async () => {
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
    cleanup();
    zh(
      <PlaygroundPage
        header={header}
        composer={<div>c</div>}
        inspector={<div>i</div>}
        onInspectorClose={onClose}
      >
        x
      </PlaygroundPage>,
    );
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(3);
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
  it("长度 12 且均为导出的组件", () => {
    expect(PAGE_TEMPLATES.length).toBe(12);
    for (const n of PAGE_TEMPLATES) {
      expect(typeof (design as Record<string, unknown>)[n]).toBe("function");
    }
  });
});
