import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Checklist,
  CodeBlock,
  DesignProvider,
  EmbedFrame,
  IoBlock,
  Tabs,
  ThinkingRow,
  Timeline,
  TimelineItem,
  ToolCallRow,
} from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("Timeline", () => {
  it("列表语义，每项带标记类型", () => {
    const { container } = wrap(
      <Timeline label="本轮步骤">
        <TimelineItem mark="dot">a</TimelineItem>
        <TimelineItem mark="hollow">b</TimelineItem>
        <TimelineItem mark="running">c</TimelineItem>
        <TimelineItem mark="error">d</TimelineItem>
      </Timeline>,
    );
    const list = screen.getByRole("list", { name: "本轮步骤" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    for (const m of ["dot", "hollow", "running", "error"]) {
      expect(container.querySelector(`[data-mark="${m}"]`)).toBeTruthy();
    }
  });
});

describe("ThinkingRow", () => {
  it("显示「思考了 N 秒」，有正文时可展开", async () => {
    wrap(<ThinkingRow seconds={7} text="先查本周消息" />);
    const btn = screen.getByRole("button", { name: /思考了 7 秒/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("先查本周消息")).toBeNull();
    await userEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("先查本周消息")).toBeTruthy();
  });
  it("英文与自定义 labels", () => {
    wrap(<ThinkingRow seconds={3} />, "en");
    expect(screen.getByText("Thought for 3s")).toBeTruthy();
    cleanup();
    wrap(<ThinkingRow seconds={3} labels={{ title: "想了 {n} 秒" }} />);
    expect(screen.getByText("想了 3 秒")).toBeTruthy();
  });
  it("无正文时不可展开", () => {
    wrap(<ThinkingRow seconds={2} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("aria-controls 只指向存在的元素", () => {
  /** 按钮的 aria-controls（若有）必须指向文档里存在的元素；返回它是否存在。 */
  const controls = (btn: HTMLElement): boolean => {
    const id = btn.getAttribute("aria-controls");
    if (id === null) return false;
    expect(document.getElementById(id), `aria-controls=${id}`).not.toBeNull();
    return true;
  };
  it("ThinkingRow / ToolCallRow：收起时不带 aria-controls（面板不在 DOM），展开后带上", async () => {
    for (const el of [
      <ThinkingRow key="t" seconds={7} text="x" />,
      <ToolCallRow key="c" name="tool" status="done" input="{}" />,
    ]) {
      wrap(el);
      const btn = screen.getAllByRole("button")[0] as HTMLElement;
      expect(controls(btn)).toBe(false);
      await userEvent.click(btn);
      expect(controls(btn)).toBe(true);
      cleanup();
    }
  });
});

describe("ToolCallRow", () => {
  it("默认只显示一行，展开后显示 IN / OUT", async () => {
    wrap(
      <ToolCallRow
        name="slack__search"
        summary="搜索 #feedback 本周消息 · 42 条"
        status="done"
        input='{"q":"feedback"}'
        output="42 results"
      />,
    );
    const head = screen.getByRole("button", { name: /slack__search/ });
    expect(head.textContent).toContain("搜索 #feedback 本周消息 · 42 条");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("IN")).toBeNull();
    expect(screen.queryByText("OUT")).toBeNull();
    await userEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("IN")).toBeTruthy();
    expect(screen.getByText("OUT")).toBeTruthy();
    expect(screen.getByText('{"q":"feedback"}')).toBeTruthy();
    expect(screen.getByText("42 results")).toBeTruthy();
  });
  it("运行中显示状态、无 OUT", () => {
    wrap(<ToolCallRow name="t" status="running" input="{}" defaultExpanded />);
    expect(screen.getByText(/运行中/)).toBeTruthy();
    expect(screen.queryByText("OUT")).toBeNull();
  });
  it("出错与已取消显示状态", () => {
    const { container } = wrap(<ToolCallRow name="t" status="error" input="{}" output="boom" />);
    expect(container.querySelector('[data-status="error"]')).toBeTruthy();
    expect(screen.getByText(/失败/)).toBeTruthy();
    cleanup();
    wrap(<ToolCallRow name="t" status="cancelled" input="{}" />, "en");
    expect(screen.getByText(/Cancelled/)).toBeTruthy();
  });
  it("输出被截断时提供「查看全部」", async () => {
    const onShowAll = vi.fn();
    wrap(
      <ToolCallRow
        name="t"
        status="done"
        input="{}"
        output="part"
        outputTruncated
        onShowAll={onShowAll}
        defaultExpanded
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "查看全部输出" }));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });
});

describe("IoBlock", () => {
  it("不超过 12 行不折叠", () => {
    wrap(<IoBlock label="IN" text={lines(12)} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/line 12/)).toBeTruthy();
  });
  it("超过 12 行时折叠，「展开全部」后显示全部", async () => {
    wrap(<IoBlock label="OUT" text={lines(20)} />);
    expect(screen.queryByText(/line 20/)).toBeNull();
    expect(screen.getByText(/line 12/)).toBeTruthy();
    const btn = screen.getByRole("button", { name: /展开全部/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(btn);
    expect(screen.getByText(/line 20/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /收起/ }).getAttribute("aria-expanded")).toBe("true");
  });
  it("collapsedLines 可调", () => {
    wrap(<IoBlock label="OUT" text={lines(5)} collapsedLines={3} />);
    expect(screen.queryByText(/line 4/)).toBeNull();
    expect(screen.getByRole("button", { name: /展开全部/ })).toBeTruthy();
  });
});

describe("Checklist", () => {
  it("in_progress 高亮（aria-current），completed 带划线语义", () => {
    const { container } = wrap(
      <Checklist
        label="任务"
        items={[
          { text: "读需求", status: "completed" },
          { text: "写测试", status: "in_progress" },
          { text: "实现", status: "pending" },
        ]}
      />,
    );
    const items = within(screen.getByRole("list", { name: "任务" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[1]?.getAttribute("aria-current")).toBe("step");
    expect(items[0]?.getAttribute("aria-current")).toBeNull();
    expect(items[1]?.getAttribute("data-status")).toBe("in_progress");
    // 划线语义：<s>（HTML-AAM 映射为 deletion），只用于已完成项
    const struck = container.querySelectorAll("s");
    expect(struck).toHaveLength(1);
    expect(struck[0]?.textContent).toBe("读需求");
    expect(items[0]?.getAttribute("data-status")).toBe("completed");
    // 状态文字供读屏
    expect(within(items[0] as HTMLElement).getByText("已完成")).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText("进行中")).toBeTruthy();
  });
});

describe("CodeBlock", () => {
  it("等宽代码块与语言标注", () => {
    const { container } = wrap(<CodeBlock language="ts" text="const a = 1;" />);
    expect(container.querySelector("pre code")?.textContent).toBe("const a = 1;");
    expect(screen.getByText("ts")).toBeTruthy();
  });
});

describe("EmbedFrame", () => {
  it("sandbox 恰为 allow-scripts allow-forms，不含 allow-same-origin", () => {
    wrap(<EmbedFrame src="https://plugin.example/ui/board" title="看板" onMessage={() => {}} />);
    const frame = screen.getByTitle("看板") as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("src")).toBe("https://plugin.example/ui/board");
  });
  it("高度来自 props", () => {
    wrap(<EmbedFrame src="about:blank" title="f" height={480} onMessage={() => {}} />);
    expect(screen.getByTitle("f").getAttribute("height")).toBe("480");
  });
  it("只转发来自本 iframe 的 message，并暴露 frameRef", () => {
    const onMessage = vi.fn();
    const ref = createRef<HTMLIFrameElement>();
    wrap(<EmbedFrame src="about:blank" title="f" onMessage={onMessage} frameRef={ref} />);
    const frame = screen.getByTitle("f") as HTMLIFrameElement;
    expect(ref.current).toBe(frame);
    const own = frame.contentWindow as Window;
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: "other", source: window }));
      window.dispatchEvent(new MessageEvent("message", { data: "none" }));
      window.dispatchEvent(new MessageEvent("message", { data: "mine", source: own }));
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0].data).toBe("mine");
  });
  it("卸载时移除同一个 message 监听", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      const onMessage = vi.fn();
      const { unmount } = wrap(<EmbedFrame src="about:blank" title="f" onMessage={onMessage} />);
      const added = add.mock.calls.filter(([type]) => type === "message").map(([, l]) => l);
      expect(added).toHaveLength(1);
      unmount();
      const removed = remove.mock.calls.filter(([type]) => type === "message").map(([, l]) => l);
      expect(removed).toContain(added[0]);
      expect(onMessage).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});

describe("Tabs badge / alert", () => {
  it("渲染 badge 与提醒标记", () => {
    wrap(
      <Tabs
        label="面板"
        value="tasks"
        items={[
          { id: "run", label: "运行", alert: true },
          { id: "tasks", label: "任务", badge: "2/4" },
        ]}
      />,
    );
    const tasks = screen.getByRole("tab", { name: /任务/ });
    expect(tasks.textContent).toContain("2/4");
    const run = screen.getByRole("tab", { name: /运行/ });
    expect(run.querySelector("[data-alert]")).toBeTruthy();
    expect(within(run).getByText("有待处理")).toBeTruthy();
    // The marker is a drawn square, not a character (design-char-icon)
    expect(run.querySelector("[data-alert]")?.textContent).toBe("有待处理");
    expect(tasks.querySelector("[data-alert]")).toBeNull();
  });
});
