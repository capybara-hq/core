import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  ComposerBox,
  type ComposerBoxProps,
  ContextSection,
  ConversationPage,
  type ConversationPageProps,
  ConvMenu,
  clampPanelWidth,
  DesignProvider,
  FilesSection,
  InlineCard,
  PANEL_WIDTH_KEY,
  PanelTabs,
  PropertiesPanel,
  PropertySection,
  RightPanel,
  TitleBar,
  type TitleBarProps,
  titleBarFit,
} from "../src/index";
import { ShellPageContext } from "../src/shell/shell-page";
import { css, parseCss } from "./css-rules";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const noop = () => {};

const titleBar = (over: Partial<TitleBarProps> = {}): TitleBarProps => ({
  title: "分析 9 月示例表差异",
  untitled: "未命名会话 · 10-26 14:32",
  menu: [
    { id: "rename", label: "重命名", icon: "square-pen", onSelect: noop },
    "separator",
    { id: "delete", label: "删除会话", icon: "trash-2", tone: "fail", onSelect: noop },
  ],
  properties: { pressed: false, onToggle: noop },
  panels: [{ id: "files", label: "文件", icon: "file-text", pressed: false, onOpen: noop }],
  ...over,
});

const page = (over: Partial<ConversationPageProps> = {}): ConversationPageProps => ({
  titleBar: titleBar(),
  thread: <p>消息</p>,
  composer: <div data-testid="composer" />,
  properties: <aside data-testid="properties" />,
  panel: <aside data-testid="panel" />,
  right: "none",
  onCloseRight: noop,
  layout: "inline",
  ...over,
});

describe("ConversationPage (§5.4)", () => {
  it("announces the run state once, in a polite status inside the middle column", () => {
    render(<ConversationPage {...page({ announce: "运行中" })} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("运行中");
    expect(status.getAttribute("data-part")).toBe("run-announce");
    expect(status.classList.contains("cb-sr-only")).toBe(true);
    expect(status.closest('[data-part="conv-main"]')).toBeTruthy();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("properties sit inside the middle column, under its title bar", () => {
    wrap(<ConversationPage {...page({ right: "properties" })} />);
    const props = screen.getByTestId("properties");
    const main = props.closest('[data-part="conv-main"]');
    expect(main).toBeTruthy();
    expect(main?.querySelector('[data-part="title-bar"]')).toBeTruthy();
    // a sibling of the thread's column, not of the title bar
    expect(props.parentElement?.querySelector('[data-part="thread"]')).toBeTruthy();
    expect(screen.queryByTestId("panel")).toBeNull();
  });

  it("a right panel sits outside the middle column, full height; never both", () => {
    wrap(<ConversationPage {...page({ right: "panel" })} />);
    const panel = screen.getByTestId("panel");
    expect(panel.closest('[data-part="conv-main"]')).toBeNull();
    expect(screen.queryByTestId("properties")).toBeNull();
    expect(screen.getByRole("separator", { name: "调整右侧面板宽度" })).toBeTruthy();
  });

  it("none shows neither", () => {
    wrap(<ConversationPage {...page()} />);
    expect(screen.queryByTestId("panel")).toBeNull();
    expect(screen.queryByTestId("properties")).toBeNull();
  });

  it("the sheet layout opens the right area as a dialog that Esc closes", async () => {
    const onCloseRight = vi.fn();
    wrap(<ConversationPage {...page({ right: "panel", layout: "sheet", onCloseRight })} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("panel")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(onCloseRight).toHaveBeenCalled();
  });

  it("the properties panel as a sheet has its own head with a close button (phones have no scrim to tap)", async () => {
    const onCloseRight = vi.fn();
    wrap(<ConversationPage {...page({ right: "properties", layout: "sheet", onCloseRight })} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("properties")).toBeTruthy();
    expect(within(dialog).getByText("属性面板")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(onCloseRight).toHaveBeenCalled();
  });

  it("a right panel in a sheet keeps only its own head (no second close button)", () => {
    wrap(
      <ConversationPage {...page({ right: "panel", layout: "sheet", onCloseRight: vi.fn() })} />,
    );
    expect(document.querySelector('[data-part="sheet-head"]')).toBeNull();
  });

  it("a new conversation shows the agent, its description and only context and version", () => {
    wrap(
      <ConversationPage
        {...page({
          newConversation: { agentName: "研究助手", description: "检索资料" },
        })}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "研究助手" })).toBeTruthy();
    expect(screen.getByText("新会话")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "属性面板" })).toBeNull();
  });

  describe("panel width", () => {
    beforeEach(() => localStorage.clear());

    it("clamps to [panel-min, content − chat-min]", () => {
      expect(clampPanelWidth(560, 1024)).toBe(544);
      expect(clampPanelWidth(400, 1600)).toBe(400);
      expect(clampPanelWidth(200, 1600)).toBe(360);
      expect(clampPanelWidth(900, 1600)).toBe(900);
      expect(clampPanelWidth(2000, 1600)).toBe(1120);
      expect(clampPanelWidth(560, 0)).toBe(560);
    });

    it("arrow keys move it by 16 and the width is remembered", async () => {
      wrap(<ConversationPage {...page({ right: "panel" })} />);
      const handle = screen.getByRole("separator");
      expect(handle.getAttribute("aria-valuenow")).toBe("560");
      handle.focus();
      await userEvent.keyboard("{ArrowLeft}");
      expect(handle.getAttribute("aria-valuenow")).toBe("576");
      expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe("576");
      await userEvent.keyboard("{ArrowRight>14/}");
      // never below layout.panel-min
      expect(handle.getAttribute("aria-valuenow")).toBe("360");
    });

    it("reads the remembered width, clamped", () => {
      localStorage.setItem(PANEL_WIDTH_KEY, "100");
      wrap(<ConversationPage {...page({ right: "panel" })} />);
      expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("360");
    });

    it("survives storage that throws", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      wrap(<ConversationPage {...page({ right: "panel" })} />);
      expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("560");
      vi.restoreAllMocks();
    });
  });
});

describe("ConversationPage composer", () => {
  it("is a sibling of the scrolling thread, never inside it", () => {
    const { container } = wrap(<ConversationPage {...page()} />);
    const scroll = container.querySelector(".cb-conv-scroll") as HTMLElement;
    const composerSlot = container.querySelector(".cb-conv-composer") as HTMLElement;
    expect(scroll).not.toBeNull();
    expect(composerSlot.parentElement).toBe(scroll.parentElement);
    expect(scroll.contains(composerSlot)).toBe(false);
    expect(scroll.contains(screen.getByTestId("composer"))).toBe(false);
    expect(composerSlot.contains(screen.getByTestId("composer"))).toBe(true);
  });
});

describe("TitleBar (§6.16.1)", () => {
  it("shows the path before the title; a segment with an href links", () => {
    wrap(
      <TitleBar
        {...titleBar({
          path: [{ label: "acme" }, { label: "研究助手", href: "/agents/a1" }],
        })}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "路径" });
    expect(nav.textContent).toBe("acme/研究助手/");
    expect(within(nav).getByRole("link", { name: "研究助手" }).getAttribute("href")).toBe(
      "/agents/a1",
    );
    expect(within(nav).queryByRole("link", { name: "acme" })).toBeNull();
    // the path precedes the title button
    const title = screen.getByRole("button", { name: /分析 9 月示例表差异/ });
    expect(nav.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the path spaces every "/" like the page head: space.2 on both sides', () => {
    const css = (f: string) =>
      readFileSync(resolve(import.meta.dirname, "../src/styles", f), "utf8");
    const gapOf = (text: string, selector: string) =>
      new RegExp(`${selector.replace(".", "\\.")} \\{[^}]*gap: ([^;]+);`).exec(text)?.[1];
    expect(gapOf(css("shell.css"), ".cb-pageheader-path")).toBe("var(--cb-space-2)");
    expect(gapOf(css("conversation-page.css"), ".cb-title-path")).toBe("var(--cb-space-2)");
    expect(gapOf(css("conversation-page.css"), ".cb-title-path-item")).toBe("var(--cb-space-2)");
  });

  it("without a path there is no path nav", () => {
    wrap(<TitleBar {...titleBar()} />);
    expect(screen.queryByRole("navigation", { name: "路径" })).toBeNull();
  });

  it("the open item's icon is pressed", () => {
    wrap(<TitleBar {...titleBar({ properties: { pressed: true, onToggle: noop } })} />);
    expect(screen.getByRole("button", { name: "属性面板" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "文件" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("an untitled conversation shows the placeholder", () => {
    wrap(<TitleBar {...titleBar({ title: null })} />);
    const title = screen.getByRole("button", { name: /未命名会话 · 10-26 14:32/ });
    expect(title.getAttribute("data-untitled")).toBe("true");
  });

  it("icons that don't fit move into More", async () => {
    let report: ((w: number) => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: (e: { contentRect: { width: number } }[]) => void) {
          report = (w) => cb([{ contentRect: { width: w } }]);
        }
        observe() {}
        disconnect() {}
      },
    );
    const panels = ["文件", "待办", "任务看板", "看板 2", "看板 3", "看板 4"].map((label, i) => ({
      id: `p${i}`,
      label,
      icon: "extension" as const,
      pressed: false,
      onOpen: noop,
    }));
    wrap(<TitleBar {...titleBar({ panels })} />);
    act(() => report?.(titleBarWidthFor(3)));
    expect(screen.getByRole("button", { name: "文件" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "任务看板" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "看板 2" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["看板 2", "看板 3", "看板 4"]);
  });

  it("with every icon shown there is no More (a menu of what is already on the bar)", () => {
    wrap(<TitleBar {...titleBar()} />);
    expect(screen.getByRole("button", { name: "文件" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
  });

  it("one icon that doesn't fit takes More's place: More holds two or more", () => {
    let report: ((w: number) => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: (e: { contentRect: { width: number } }[]) => void) {
          report = (w) => cb([{ contentRect: { width: w } }]);
        }
        observe() {}
        disconnect() {}
      },
    );
    const panels = ["文件", "待办", "任务看板"].map((label, i) => ({
      id: `p${i}`,
      label,
      icon: "extension" as const,
      pressed: false,
      onOpen: noop,
    }));
    wrap(<TitleBar {...titleBar({ panels })} />);
    act(() => report?.(titleBarWidthFor(2)));
    for (const name of ["文件", "待办", "任务看板"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
    act(() => report?.(titleBarWidthFor(1)));
    expect(screen.queryByRole("button", { name: "待办" })).toBeNull();
    expect(screen.getByRole("button", { name: "更多" })).toBeTruthy();
  });

  it("without panels there is no separator and no More", () => {
    wrap(<TitleBar {...titleBar({ panels: [] })} />);
    expect(document.querySelector('[data-part="title-bar-separator"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
  });

  it("the title menu holds rename and a fail-toned delete", async () => {
    const onRename = vi.fn();
    wrap(
      <TitleBar
        {...titleBar({
          menu: [
            { id: "rename", label: "重命名", icon: "square-pen", onSelect: onRename },
            "separator",
            { id: "delete", label: "删除会话", icon: "trash-2", tone: "fail", onSelect: noop },
          ],
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /分析 9 月示例表差异/ }));
    expect(screen.getByRole("menuitem", { name: "删除会话" }).getAttribute("data-tone")).toBe(
      "fail",
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    expect(onRename).toHaveBeenCalled();
  });
});

describe("titleBarFit on phones", () => {
  it("counts 40 px tap targets below 640, so fewer icons fit the same width", () => {
    // 16 + 4 padding, a 160 title, the toggle, the separator and More around 44 px slots
    expect(titleBarFit(500, 99, true)).toBe(4);
    expect(titleBarFit(500, 99)).toBe(5);
    expect(titleBarFit(390, 1, true)).toBe(1);
  });
});

/** A title-bar width that leaves room for exactly `n` panel icons. */
function titleBarWidthFor(n: number): number {
  let w = 300;
  while (titleBarFit(w, 99) < n) w += 1;
  return w;
}

const pickers = (over: Partial<ComposerBoxProps["pickers"]> = {}): ComposerBoxProps["pickers"] => ({
  agent: {
    label: "切换 agent",
    value: "研究助手",
    locked: { hint: "发送第一条消息后不能再换 agent" },
    groups: [],
    onPick: noop,
  },
  model: {
    label: "切换模型",
    value: "opus 5.5",
    groups: [
      {
        label: "Anthropic",
        items: [
          { id: "opus", label: "opus 5.5", tag: "agent 默认", checked: true },
          { id: "sonnet", label: "sonnet 5" },
        ],
      },
    ],
    note: "从下一条消息起生效",
    onPick: noop,
  },
  effort: {
    label: "思考档位",
    value: "中等",
    groups: [{ items: [{ id: "medium", label: "中等", checked: true }] }],
    onPick: noop,
  },
  ...over,
});

const composer = (over: Partial<ComposerBoxProps> = {}): ComposerBoxProps => ({
  value: "",
  onChange: noop,
  placeholder: "输入消息，/ 使用命令",
  onAttach: noop,
  pickers: pickers(),
  send: { mode: "send", disabled: true, onClick: noop },
  ...over,
});

describe("ComposerBox (§6.16.2)", () => {
  it("stop mode renders a Stop button", () => {
    wrap(<ComposerBox {...composer({ send: { mode: "stop", onClick: noop } })} />);
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });

  it("a locked agent picker is plain text with the hint as its tooltip", () => {
    const { container } = wrap(<ComposerBox {...composer()} />);
    const agent = container.querySelector('[data-part="picker"][data-locked="true"]');
    expect(agent?.textContent).toBe("研究助手");
    expect(agent?.getAttribute("title")).toBe("发送第一条消息后不能再换 agent");
    expect(agent?.tagName).toBe("SPAN");
  });

  it("no effort control when the model declares none", () => {
    const { effort: _, ...rest } = pickers();
    wrap(<ComposerBox {...composer({ pickers: rest })} />);
    expect(screen.queryByRole("button", { name: /思考档位/ })).toBeNull();
    expect(screen.getByRole("button", { name: "切换模型: opus 5.5" })).toBeTruthy();
  });

  it("send is disabled without text and the hint replaces the placeholder while running", () => {
    wrap(<ComposerBox {...composer({ hint: "运行中发送的消息会在下一步交给智能体" })} />);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("消息").getAttribute("placeholder")).toBe(
      "运行中发送的消息会在下一步交给智能体",
    );
  });

  it("the model picker lists groups, the agent-default tag, the check and the note", async () => {
    const onPick = vi.fn();
    wrap(
      <ComposerBox
        {...composer({ pickers: pickers({ model: { ...pickers().model, onPick } }) })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "切换模型: opus 5.5" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Anthropic")).toBeTruthy();
    expect(within(menu).getByText("agent 默认")).toBeTruthy();
    expect(within(menu).getByText("从下一条消息起生效")).toBeTruthy();
    const opus = within(menu).getByRole("menuitemradio", { name: /opus 5.5/ });
    expect(opus.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "sonnet 5" }));
    expect(onPick).toHaveBeenCalledWith("sonnet");
  });
});

describe("blocks that fail show the failure in place", () => {
  it("PropertySection failed renders 加载失败 · 重试", async () => {
    const onRetry = vi.fn();
    wrap(
      <PropertySection
        title="待办"
        state="failed"
        failure={{ reason: "扩展 10 秒内没有响应" }}
        onRetry={onRetry}
      >
        <p>不显示</p>
      </PropertySection>,
    );
    expect(screen.getByText("待办 加载失败")).toBeTruthy();
    expect(screen.queryByText("不显示")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("InlineCard: loading is skeleton bars, never a spinner; failed is in the card", () => {
    const { container, rerender } = wrap(<InlineCard source="待办" state="loading" />);
    expect(container.querySelectorAll('[data-part="skeleton-bar"]').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-part="spinner"]')).toBeNull();
    expect(screen.getByText("来自 待办 的卡片")).toBeTruthy();
    rerender(
      <DesignProvider locale="zh">
        <InlineCard source="任务看板" state="failed" failure={{ reason: "超时" }} onRetry={noop} />
      </DesignProvider>,
    );
    expect(screen.getByText("任务看板 加载失败")).toBeTruthy();
  });

  it("InlineCard ⤢ opens the right panel", async () => {
    const onExpand = vi.fn();
    wrap(<InlineCard source="待办" state="ready" badge="2 / 4" onExpand={onExpand} />);
    await userEvent.click(screen.getByRole("button", { name: "在右侧面板打开" }));
    expect(onExpand).toHaveBeenCalled();
  });

  it("RightPanel failed keeps its header and shows the failure in its body", () => {
    wrap(
      <RightPanel
        title="任务看板"
        state="failed"
        failure={{ reason: "扩展 10 秒内没有响应" }}
        onRetry={noop}
        onFullscreen={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByRole("complementary", { name: "任务看板" })).toBeTruthy();
    expect(screen.getByText("任务看板 加载失败")).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("RightPanel without a switcher has a plain title; with one, a menu of panels and files", async () => {
    const onSwitch = vi.fn();
    wrap(
      <RightPanel
        title="9月差异明细.xlsx"
        badge="XLSX"
        switcher={{
          groups: [
            { label: "扩展", items: [{ id: "todo", label: "待办", icon: "list-checks" }] },
            { label: "文件", items: [{ id: "f1", label: "9月差异明细.xlsx", badge: "XLSX" }] },
          ],
          current: "f1",
          onSwitch,
        }}
        onFullscreen={noop}
        onClose={noop}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /9月差异明细.xlsx/ }));
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getByRole("menuitemradio", { name: /9月差异明细/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "待办" }));
    expect(onSwitch).toHaveBeenCalledWith("todo");
  });
});

describe("ContextSection", () => {
  /** The labeled rows as [label, value] pairs. */
  const rows = () =>
    [...document.querySelectorAll('[data-part="context-row"]')].map((r) => [
      r.querySelector("dt")?.textContent,
      r.querySelector("dd")?.textContent,
    ]);

  it("shows the ratio, a meter and labeled rows: model, device, connectors", () => {
    wrap(
      <ContextSection
        ratio={43}
        model="opus 5.5"
        device="个人设备 · 在线"
        connectors={["Acme 文档", "Acme 工单"]}
      />,
    );
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("43");
    expect(screen.getByText("43%")).toBeTruthy();
    expect(document.querySelector('[data-part="context-facts"]')?.tagName).toBe("DL");
    expect(rows()).toEqual([
      ["模型", "opus 5.5"],
      ["设备", "个人设备 · 在线"],
      ["连接器", "Acme 文档、Acme 工单"],
    ]);
  });

  it("the last run joins its parts; no rows for what is absent", () => {
    wrap(
      <ContextSection
        ratio={9}
        model="deepseek-flash"
        connectors={[]}
        lastRun={["27 秒", "236,137 token"]}
      />,
    );
    expect(rows()).toEqual([
      ["模型", "deepseek-flash"],
      ["上次运行", "27 秒 · 236,137 token"],
    ]);
    expect(document.querySelector('[data-part="context-last-run"]')?.textContent).toBe(
      "27 秒 · 236,137 token",
    );
  });

  it("the device mark sits under the device, warn by default and fail when asked", () => {
    const r = wrap(
      <ContextSection ratio={10} model="m" device="Laptop" deviceBadge="开放" connectors={[]} />,
    );
    const mark = screen.getByText("开放");
    expect(mark.getAttribute("data-tone")).toBe("warn");
    expect(mark.closest("dd")?.textContent).toBe("Laptop开放");
    expect(mark.parentElement?.className).toBe("cb-context-mark");
    r.unmount();
    wrap(
      <ContextSection
        ratio={10}
        model="m"
        device="Laptop"
        deviceBadge="不使用沙箱"
        deviceBadgeTone="fail"
        connectors={[]}
      />,
    );
    expect(screen.getByText("不使用沙箱").getAttribute("data-tone")).toBe("fail");
  });

  it("rounds row renders with part context-rounds before the last run", () => {
    wrap(
      <ContextSection
        ratio={10}
        model="m"
        connectors={[]}
        rounds="第 3 轮 · 已用 12k"
        lastRun={["27 秒"]}
      />,
    );
    const value = document.querySelector('[data-part="context-rounds"]');
    expect(value?.textContent).toBe("第 3 轮 · 已用 12k");
    expect(value?.previousElementSibling?.textContent).toBe("轮次");
    expect(rows().map((r) => r[0])).toEqual(["模型", "轮次", "上次运行"]);
  });

  it("a total row (tokens with sub-agents) only when given", () => {
    const { unmount } = wrap(
      <ContextSection ratio={10} model="m" connectors={[]} total="1,234 token（含子智能体）" />,
    );
    const value = screen.getByText("1,234 token（含子智能体）");
    expect(value.getAttribute("data-part")).toBe("context-total");
    expect(value.previousElementSibling?.textContent).toBe("合计");
    unmount();
    wrap(<ContextSection ratio={10} model="m" connectors={[]} />);
    expect(document.querySelector('[data-part="context-total"]')).toBeNull();
  });
});

describe("PropertySection hint", () => {
  it("an info button after the title, described by the hint; a tap toggles the tooltip", async () => {
    wrap(
      <PropertySection title="后台任务" hint="运行中的工作保留开始时的权限。">
        body
      </PropertySection>,
    );
    const button = screen.getByRole("button", { name: "关于「后台任务」" });
    expect(button.getAttribute("data-part")).toBe("property-hint");
    expect(button.closest("h3")?.textContent).toContain("后台任务");
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("运行中的工作保留开始时的权限。");
    expect(screen.queryByRole("tooltip")).toBeNull();
    const user = userEvent.setup();
    await user.pointer({ keys: "[TouchA]", target: button });
    expect((await screen.findByRole("tooltip")).textContent).toBe("运行中的工作保留开始时的权限。");
    await user.pointer({ keys: "[TouchA]", target: button });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keyboard focus reaches it; no button without a hint", async () => {
    const { unmount } = wrap(
      <PropertySection title="后台任务" hint="说明">
        body
      </PropertySection>,
    );
    await userEvent.tab();
    expect(document.activeElement?.getAttribute("data-part")).toBe("property-hint");
    // focus opens it
    expect((await screen.findByRole("tooltip")).textContent).toBe("说明");
    unmount();
    wrap(<PropertySection title="文件">body</PropertySection>);
    expect(document.querySelector('[data-part="property-hint"]')).toBeNull();
  });
});

describe("frames hidden while their body renders nothing", () => {
  let show: (on: boolean) => void = noop;
  const Maybe = ({ text }: { text: string }) => {
    const [on, setOn] = useState(false);
    show = setOn;
    return on ? <p>{text}</p> : null;
  };
  const sectionOf = () => document.querySelector('[data-part="property-section"]') as HTMLElement;

  it("PropertySection hideWhenEmpty is not drawn until its body draws a node", async () => {
    wrap(
      <PropertySection title="协作" hideWhenEmpty>
        <Maybe text="协作内容" />
      </PropertySection>,
    );
    expect(sectionOf().hidden).toBe(true);
    expect(sectionOf().getAttribute("data-empty")).toBe("true");
    await act(async () => show(true));
    expect(sectionOf().hidden).toBe(false);
    expect(sectionOf().getAttribute("data-empty")).toBeNull();
    await act(async () => show(false));
    expect(sectionOf().hidden).toBe(true);
  });

  it("a section with content, or without hideWhenEmpty, is drawn", () => {
    const { unmount } = wrap(
      <PropertySection title="协作" hideWhenEmpty>
        text
      </PropertySection>,
    );
    expect(sectionOf().hidden).toBe(false);
    unmount();
    wrap(<PropertySection title="协作">{null}</PropertySection>);
    expect(sectionOf().hidden).toBe(false);
  });

  it("the stylesheet removes an empty section from the layout", () => {
    const rule = parseCss(css("conversation-page.css")).find(
      (r) => r.at === null && r.selector === '.cb-property-section[data-empty="true"]',
    );
    expect(rule?.decls.display).toBe("none");
  });

  it("RightPanel emptyText shows the empty state while the body renders nothing", async () => {
    wrap(
      <RightPanel title="协作" onClose={noop} emptyText="没有内容">
        <Maybe text="面板内容" />
      </RightPanel>,
    );
    const panel = screen.getByRole("complementary", { name: "协作" });
    expect(within(panel).getByText("没有内容")).toBeTruthy();
    await act(async () => show(true));
    expect(within(panel).getByText("面板内容")).toBeTruthy();
    expect(within(panel).queryByText("没有内容")).toBeNull();
    await act(async () => show(false));
    expect(within(panel).getByText("没有内容")).toBeTruthy();
  });
});

describe("FilesSection", () => {
  const files = [
    { id: "f1", name: "report.pdf", badge: "PDF", size: "12 KB" },
    { id: "f2", name: "tree.txt", badge: "TXT", size: "1 KB", from: "列出目录树" },
  ];

  it("a sub-agent's file says which sub-agent delivered it, in faint", () => {
    wrap(<FilesSection files={files} onOpen={noop} onAll={noop} />);
    const from = screen.getByText("来自 列出目录树");
    expect(from.getAttribute("data-part")).toBe("file-from");
    expect(from.closest("button")?.textContent).toContain("tree.txt");
    expect(document.querySelectorAll('[data-part="file-from"]')).toHaveLength(1);
  });

  it("en copy", () => {
    wrap(<FilesSection files={files} onOpen={noop} onAll={noop} />, "en");
    expect(screen.getByText("from 列出目录树")).toBeTruthy();
  });
});

describe("final review a11y (m11, m13, m14)", () => {
  it("m11: the inline right area takes focus when it opens and gives it back to its opener when it closes", () => {
    const rightPanel = (
      <RightPanel title="Tasks" onClose={noop} onFullscreen={noop}>
        <p>body</p>
      </RightPanel>
    );
    const ui = (right: ConversationPageProps["right"]) => (
      <DesignProvider locale="en">
        <button type="button">opener</button>
        <ConversationPage
          {...page({ right, panel: rightPanel, properties: <PropertiesPanel /> })}
        />
      </DesignProvider>
    );
    const { rerender } = render(ui("none"));
    const opener = screen.getByRole("button", { name: "opener" });
    opener.focus();
    rerender(ui("panel"));
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Tasks" }));
    // Back to the properties panel: it takes focus (the panel's button unmounted)
    rerender(ui("properties"));
    expect(document.activeElement?.getAttribute("data-part")).toBe("properties");
    rerender(ui("none"));
    expect(document.activeElement).toBe(opener);
  });

  it("m13: PanelTabs move with the arrow keys, Home and End, and name their panel", async () => {
    const onSelect = vi.fn();
    const items = [
      { id: "a", label: "Sheet A" },
      { id: "b", label: "Sheet B" },
      { id: "c", label: "Sheet C" },
    ];
    const { rerender } = wrap(
      <PanelTabs items={items} current="a" onSelect={onSelect} label="Sheets" controls="body" />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-controls"))).toEqual(["body", "body", "body"]);
    (tabs[0] as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onSelect).toHaveBeenLastCalledWith("b");
    expect(document.activeElement).toBe(tabs[1]);
    rerender(
      <DesignProvider locale="zh">
        <PanelTabs items={items} current="b" onSelect={onSelect} label="Sheets" controls="body" />
      </DesignProvider>,
    );
    await userEvent.keyboard("{End}");
    expect(onSelect).toHaveBeenLastCalledWith("c");
    await userEvent.keyboard("{Home}");
    expect(onSelect).toHaveBeenLastCalledWith("a");
    await userEvent.keyboard("{ArrowLeft}");
    expect(onSelect).toHaveBeenLastCalledWith("c");
  });

  it("m14: a menu's note describes the menu", async () => {
    wrap(
      <ConvMenu
        inline
        label="Model"
        trigger={<button type="button">Model</button>}
        entries={[
          { kind: "item", id: "a", label: "A", checked: true, onSelect: noop },
          { kind: "note", text: "From the next message" },
        ]}
      />,
    );
    const menu = screen.getByRole("menu", { name: "Model" });
    const ids = (menu.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "From the next message",
    ]);
  });
});

describe("ConversationPage on a phone (§5.4, mobile layout spec §5.4)", () => {
  function phone(compact: boolean) {
    vi.stubGlobal(
      "matchMedia",
      (q: string) =>
        ({
          matches: compact
            ? q === "not all and (min-width: 600px)" ||
              q === "(max-width: 599px)" ||
              q === "(max-width: 1279px)"
            : false,
          media: q,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
  }

  it("the open right area is a pushed full-screen page with a back control, not a dialog", async () => {
    phone(true);
    const onCloseRight = vi.fn();
    wrap(<ConversationPage {...page({ right: "properties", layout: "auto", onCloseRight })} />);
    const root = document.querySelector('[data-template="ConversationPage"]') as HTMLElement;
    expect(root.getAttribute("data-right")).toBe("pushed");
    const pushed = document.querySelector('[data-part="pushed"]') as HTMLElement;
    expect(pushed).not.toBeNull();
    expect(within(pushed).getByTestId("properties")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(within(pushed).getByRole("button", { name: "返回" }));
    expect(onCloseRight).toHaveBeenCalledTimes(1);
  });

  it("a panel is pushed too, and Esc goes back", async () => {
    phone(true);
    const onCloseRight = vi.fn();
    wrap(<ConversationPage {...page({ right: "panel", layout: "auto", onCloseRight })} />);
    const pushed = document.querySelector('[data-part="pushed"]') as HTMLElement;
    expect(within(pushed).getByTestId("panel")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(onCloseRight).toHaveBeenCalledTimes(1);
  });

  it("closed, nothing is pushed and data-right stays none", () => {
    phone(true);
    wrap(<ConversationPage {...page({ right: "none", layout: "auto" })} />);
    const root = document.querySelector('[data-template="ConversationPage"]') as HTMLElement;
    expect(root.getAttribute("data-right")).toBe("none");
    expect(document.querySelector('[data-part="pushed"]')).toBeNull();
  });

  it("a wider window keeps the sheet (medium) and is never pushed", () => {
    vi.stubGlobal(
      "matchMedia",
      (q: string) =>
        ({
          matches: q === "(max-width: 1279px)",
          media: q,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    wrap(<ConversationPage {...page({ right: "properties", layout: "auto" })} />);
    expect(document.querySelector('[data-part="pushed"]')).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("an explicit layout never pushes", () => {
    phone(true);
    wrap(<ConversationPage {...page({ right: "properties", layout: "sheet" })} />);
    expect(document.querySelector('[data-part="pushed"]')).toBeNull();
  });

  it("without a shell the page draws its own cover and back bar and the thread is inert", () => {
    phone(true);
    wrap(<ConversationPage {...page({ right: "properties", layout: "auto" })} />);
    const pushed = document.querySelector('[data-part="pushed"]') as HTMLElement;
    expect(pushed.getAttribute("data-shell")).toBeNull();
    expect(pushed.querySelector('[data-part="pushed-bar"]')).not.toBeNull();
    expect(document.querySelector('[data-part="conv-main"]')?.hasAttribute("inert")).toBe(true);
  });

  it("inside a shell there is one back: the shell's, registered with onBack and a title", () => {
    phone(true);
    const register = vi.fn();
    const onCloseRight = vi.fn();
    wrap(
      <ShellPageContext.Provider value={register}>
        <ConversationPage {...page({ right: "properties", layout: "auto", onCloseRight })} />
      </ShellPageContext.Provider>,
    );
    const pushed = document.querySelector('[data-part="pushed"]') as HTMLElement;
    expect(pushed.getAttribute("data-shell")).toBe("true");
    expect(pushed.querySelector('[data-part="pushed-bar"]')).toBeNull();
    expect(within(pushed).queryByRole("button", { name: "返回" })).toBeNull();
    // covered, not removed from the layout (its scroll position survives): inert and hidden from
    // assistive technology
    const main = document.querySelector('[data-part="conv-main"]') as HTMLElement;
    expect(main.hasAttribute("hidden")).toBe(false);
    expect(main.hasAttribute("inert")).toBe(true);
    expect(main.getAttribute("aria-hidden")).toBe("true");
    expect(main.getAttribute("data-covered")).toBe("true");
    const last = register.mock.calls.filter((c) => c[1] !== null).at(-1)?.[1] as {
      onBack: () => void;
      title: string;
    };
    expect(last.title).toBe("属性面板");
    last.onBack();
    expect(onCloseRight).toHaveBeenCalledTimes(1);
  });

  it("closing a pushed right area in a shell keeps the conversation's scroll position", () => {
    phone(true);
    const register = vi.fn();
    const at = (right: "none" | "properties") => (
      <DesignProvider locale="zh">
        <ShellPageContext.Provider value={register}>
          <ConversationPage {...page({ right, layout: "auto" })} />
        </ShellPageContext.Provider>
      </DesignProvider>
    );
    const { rerender } = render(at("none"));
    const thread = document.querySelector('[data-part="thread"]') as HTMLElement;
    thread.scrollTop = 480;
    rerender(at("properties"));
    rerender(at("none"));
    const after = document.querySelector('[data-part="thread"]') as HTMLElement;
    expect(after).toBe(thread);
    expect(after.scrollTop).toBe(480);
    // the covered conversation stays laid out (display: none would drop its scroll position)
    const rules = parseCss(css("conversation-page.css"));
    const covered = rules.filter((r) => r.selector.includes(".cb-conv-main[data-covered"));
    expect(covered.map((r) => r.decls.visibility)).toContain("hidden");
    expect(covered.map((r) => r.decls.position)).toContain("absolute");
    expect(covered.some((r) => r.decls.display === "none")).toBe(false);
    expect(rules.some((r) => r.selector === ".cb-conv-main[hidden]")).toBe(false);
  });

  describe("a pushed RightPanel with its own back, in a shell", () => {
    const sidebar = {
      context: { kind: "work" as const, org: null, primary: [], more: [] },
      activeNav: "",
      account: { name: "grant", menu: [] },
    };
    const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };
    const inShell = (
      panelBack: (() => void) | undefined,
      onCloseRight: () => void,
      open = true,
    ) => (
      <DesignProvider locale="zh">
        <AppShell sidebar={sidebar} pathname="/chat/9f3a">
          <ConversationPage
            {...page({
              right: open ? "panel" : "none",
              layout: "auto",
              onCloseRight,
              panel: (
                <RightPanel
                  title="子智能体"
                  onClose={onCloseRight}
                  {...(panelBack ? { onBack: panelBack } : {})}
                >
                  body
                </RightPanel>
              ),
            })}
          />
        </AppShell>
      </DesignProvider>
    );
    const shellBack = () =>
      document.querySelector('[data-part="floating-bar"] button[aria-label="返回"]') as HTMLElement;

    it("the shell's back steps within the panel first (opened from the conversation)", async () => {
      phone(true);
      const panelBack = vi.fn();
      const onCloseRight = vi.fn();
      const { rerender } = render(inShell(panelBack, onCloseRight, false));
      rerender(inShell(panelBack, onCloseRight));
      await userEvent.click(shellBack());
      expect(panelBack).toHaveBeenCalledTimes(1);
      expect(onCloseRight).not.toHaveBeenCalled();
    });

    it("the same when the page loads with the panel open (a deep link)", async () => {
      phone(true);
      const panelBack = vi.fn();
      const onCloseRight = vi.fn();
      render(inShell(panelBack, onCloseRight));
      await userEvent.click(shellBack());
      expect(panelBack).toHaveBeenCalledTimes(1);
      expect(onCloseRight).not.toHaveBeenCalled();
    });

    it("at the panel's root (no onBack) the shell's back closes the right area", async () => {
      phone(true);
      const onCloseRight = vi.fn();
      render(inShell(undefined, onCloseRight));
      await userEvent.click(shellBack());
      expect(onCloseRight).toHaveBeenCalledTimes(1);
    });
  });

  it("a pushed RightPanel draws no ×, full-screen button or back chevron of its own", () => {
    phone(true);
    wrap(
      <ConversationPage
        {...page({
          right: "panel",
          layout: "auto",
          panel: (
            <RightPanel title="文件" onClose={noop} onFullscreen={noop} onBack={noop}>
              body
            </RightPanel>
          ),
        })}
      />,
    );
    const pushed = document.querySelector('[data-part="pushed"]') as HTMLElement;
    expect(within(pushed).getByText("文件")).toBeTruthy();
    expect(within(pushed).queryByRole("button", { name: "关闭" })).toBeNull();
    expect(within(pushed).queryByRole("button", { name: "全屏" })).toBeNull();
    expect(within(pushed).queryAllByRole("button", { name: "返回" })).toHaveLength(1);
  });
});

describe("the conversation's papers (layered shell spec §2)", () => {
  const rules = parseCss(css("conversation-page.css")).filter((r) => r.at === "(min-width: 600px)");
  const decls = (sel: string) => rules.find((r) => r.selector === sel)?.decls ?? {};

  it("the middle column and the inline panel are papers space.2 apart, no border, no shadow", () => {
    expect(decls(".cb-conv-page").gap).toBe("var(--cb-space-2)");
    expect(decls(".cb-conv-page").padding).toMatch(/^var\(--cb-space-2\) var\(--cb-space-2\) /);
    const main = decls(".cb-conv-main");
    expect(main.background).toBe("var(--cb-bg)");
    expect(main["border-radius"]).toBe("var(--cb-radius-md)");
    expect(main.overflow).toBe("clip");
    const panel = decls('.cb-conv-page .cb-conv-panel:not([data-full="true"])');
    expect(panel["border-radius"]).toBe("var(--cb-radius-md)");
    const inner = decls('.cb-conv-page .cb-conv-panel:not([data-full="true"]) > .cb-rpanel');
    expect(inner["border-left"]).toBe("0");
    expect(inner.overflow).toBe("clip");
    for (const d of [main, panel, inner]) {
      expect(d["box-shadow"]).toBeUndefined();
      expect(d.border).toBeUndefined();
    }
  });

  it("the resize handle fills the gap between the papers and starts below the top gutter", () => {
    expect(decls(".cb-conv-page .cb-conv-panel > .cb-conv-resize").left).toBe(
      "calc(-1 * var(--cb-space-2))",
    );
    // the handle spans its panel from the panel's top (inset 0 …); the panel starts below the
    // page's top padding, which is the gutter's height, so the gutter never lies over it
    const base = parseCss(css("conversation-page.css")).find(
      (r) => r.at === null && r.selector === ".cb-conv-resize",
    )?.decls;
    expect(base?.inset?.split(" ")[0]).toBe("0");
    expect(decls(".cb-conv-page").padding?.split(" ")[0]).toBe("var(--cb-space-2)");
    const gutter = parseCss(css("shell.css")).find(
      (r) => r.at === "(min-width: 600px)" && r.selector === ".cb-shell-gutter",
    )?.decls;
    expect(gutter?.height).toBe("var(--cb-space-2)");
  });

  it("the panel is paper in the paper's colour", () => {
    expect(decls(".cb-conv-page .cb-conv-panel > .cb-rpanel").background).toBe("var(--cb-bg)");
  });

  it("a maximised panel draws no paper of its own; the shell main draws none on this page", () => {
    const slot = decls('.cb-conv-page .cb-conv-panel[data-full="true"]');
    expect(slot.background).toBeUndefined();
    expect(slot["box-shadow"]).toBeUndefined();
    const full = decls('.cb-conv-page .cb-conv-panel[data-full="true"] > .cb-rpanel');
    expect(full["border-left"]).toBe("0");
    expect(full["border-radius"]).toBe("0 0 var(--cb-radius-md) var(--cb-radius-md)");
    expect(full["box-shadow"]).toBeUndefined();
    const shell = parseCss(css("shell.css")).find(
      (r) => r.at === "(min-width: 600px)" && r.selector === ".cb-shell-main:has(.cb-conv-page)",
    )?.decls;
    expect(shell?.margin).toBe("0");
    expect(shell?.background).toBe("transparent");
  });
});
