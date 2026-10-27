import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComposerBox,
  type ComposerBoxProps,
  ContextSection,
  ConversationPage,
  type ConversationPageProps,
  clampPanelWidth,
  DesignProvider,
  InlineCard,
  PANEL_WIDTH_KEY,
  PropertySection,
  RightPanel,
  TitleBar,
  type TitleBarProps,
  titleBarFit,
} from "../src/index";

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
  status: { context: "grant@示例组织:/chat/9f3a", version: "v0.1.0" },
  properties: <aside data-testid="properties" />,
  panel: <aside data-testid="panel" />,
  right: "none",
  onCloseRight: noop,
  layout: "inline",
  ...over,
});

describe("ConversationPage (§5.4)", () => {
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

  it("a new conversation shows the agent, its description and only context and version", () => {
    wrap(
      <ConversationPage
        {...page({
          newConversation: { agentName: "研究助手", description: "检索资料" },
          status: { context: "grant@示例组织:/chat", version: "v0.1.0" },
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
      expect(clampPanelWidth(400, 1600)).toBe(520);
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
      await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
      // never below layout.panel-min
      expect(handle.getAttribute("aria-valuenow")).toBe("520");
    });

    it("reads the remembered width, clamped", () => {
      localStorage.setItem(PANEL_WIDTH_KEY, "100");
      wrap(<ConversationPage {...page({ right: "panel" })} />);
      expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("520");
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

describe("TitleBar (§6.16.1)", () => {
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
    wrap(<ComposerBox {...composer({ hint: "按 ↵ 立即发送，按 ⌘↵ 加入队列" })} />);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("消息").getAttribute("placeholder")).toBe(
      "按 ↵ 立即发送，按 ⌘↵ 加入队列",
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
  it("shows the ratio, a meter, model · sandbox and the connectors", () => {
    wrap(
      <ContextSection
        ratio={43}
        model="opus 5.5"
        sandbox="沙箱运行中"
        connectors={["Acme 文档", "Acme 工单"]}
      />,
    );
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("43");
    expect(screen.getByText("43%")).toBeTruthy();
    expect(screen.getByText("opus 5.5 · 沙箱运行中")).toBeTruthy();
    expect(screen.getByText("连接器：Acme 文档、Acme 工单")).toBeTruthy();
  });

  it("a total line (tokens with sub-agents) only when given", () => {
    const { unmount } = wrap(
      <ContextSection ratio={10} model="m" connectors={[]} total="含子代理共 1,234 tokens" />,
    );
    const line = screen.getByText("含子代理共 1,234 tokens");
    expect(line.getAttribute("data-part")).toBe("context-total");
    unmount();
    wrap(<ContextSection ratio={10} model="m" connectors={[]} />);
    expect(document.querySelector('[data-part="context-total"]')).toBeNull();
  });
});
