import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, formatSpanDuration, type Span, SpanWaterfall } from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const SPANS: Span[] = [
  { id: "r", kind: "run", label: "run · v3", startMs: 0, durationMs: 4000, status: "ok" },
  {
    id: "s",
    parentId: "r",
    kind: "step",
    label: "step 0",
    startMs: 0,
    durationMs: 4000,
    status: "ok",
  },
  {
    id: "m",
    parentId: "s",
    kind: "model",
    label: "model-fake/fake-1",
    startMs: 0,
    durationMs: 1000,
    status: "ok",
    meta: "↑1,000 ↓100",
  },
  {
    id: "t",
    parentId: "s",
    kind: "tool",
    label: "fixture__delete_item",
    startMs: 1000,
    durationMs: 3000,
    status: "error",
  },
  {
    id: "w",
    parentId: "t",
    kind: "wait",
    label: "approval",
    startMs: 1000,
    durationMs: null,
    status: "pending",
  },
];

function Controlled({ onSelect }: { onSelect?: (id: string) => void }) {
  const [sel, setSel] = useState<string | null>("m");
  return (
    <SpanWaterfall
      spans={SPANS}
      selectedId={sel}
      onSelect={(id) => {
        setSel(id);
        onSelect?.(id);
      }}
      labels={{ empty: "没有 span" }}
    />
  );
}

describe("SpanWaterfall", () => {
  it("tree 语义：每个 span 一行，层级、选中、状态与耗时", () => {
    const { container } = wrap(<Controlled />);
    const list = screen.getByRole("tree", { name: "Span 瀑布" });
    const rows = within(list).getAllByRole("treeitem");
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.getAttribute("aria-level"))).toEqual(["1", "2", "3", "3", "4"]);
    expect(rows[2]?.getAttribute("aria-selected")).toBe("true");
    expect(rows[0]?.getAttribute("aria-selected")).toBe("false");
    // 有子 span 的节点总是展开；叶子不带 aria-expanded
    expect(rows.map((r) => r.getAttribute("aria-expanded"))).toEqual([
      "true",
      "true",
      null,
      "true",
      null,
    ]);
    expect(within(rows[2] as HTMLElement).getByText("model-fake/fake-1")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("↑1,000 ↓100")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("1.0s")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText("失败")).toBeTruthy();
    // 等待中的 wait span：待审批，耗时未知
    expect(within(rows[4] as HTMLElement).getByText("待审批")).toBeTruthy();
    expect(within(rows[4] as HTMLElement).getByText("—")).toBeTruthy();
    expect(container.querySelector('[data-kind="wait"][data-open="true"]')).toBeTruthy();
  });

  it("条形按偏移与时长定位（总时长 = 最晚结束）", () => {
    const { container } = wrap(<Controlled />);
    const bar = (id: string) =>
      container.querySelector<HTMLElement>(`[data-span="${id}"] .cb-waterfall-bar`);
    expect(bar("r")?.style.left).toBe("0%");
    expect(bar("r")?.style.width).toBe("100%");
    expect(bar("t")?.style.left).toBe("25%");
    expect(bar("t")?.style.width).toBe("75%");
    // 未结束的 span 延伸到时间轨末端
    expect(bar("w")?.style.left).toBe("25%");
    expect(bar("w")?.style.width).toBe("75%");
  });

  it("点击选中；键盘 ↑ / ↓ / Home / End", async () => {
    const onSelect = vi.fn();
    wrap(<Controlled onSelect={onSelect} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("fixture__delete_item"));
    expect(onSelect).toHaveBeenLastCalledWith("t");
    const list = screen.getByRole("tree");
    const active = document.getElementById(list.getAttribute("aria-activedescendant") ?? "");
    expect(active?.getAttribute("data-span")).toBe("t");
    list.focus();
    await user.keyboard("{ArrowDown}");
    expect(onSelect).toHaveBeenLastCalledWith("w");
    await user.keyboard("{ArrowDown}");
    expect(onSelect).toHaveBeenLastCalledWith("w");
    await user.keyboard("{Home}");
    expect(onSelect).toHaveBeenLastCalledWith("r");
    await user.keyboard("{ArrowUp}");
    expect(onSelect).toHaveBeenLastCalledWith("r");
    await user.keyboard("{End}");
    expect(onSelect).toHaveBeenLastCalledWith("w");
    await user.keyboard("{ArrowUp}");
    expect(onSelect).toHaveBeenLastCalledWith("t");
  });

  it("空列表显示 labels.empty；英文与自定义名称", () => {
    wrap(
      <SpanWaterfall
        spans={[]}
        selectedId={null}
        onSelect={() => {}}
        labels={{ empty: "Nothing yet" }}
      />,
      "en",
    );
    expect(screen.getByText("Nothing yet")).toBeTruthy();
    expect(screen.queryByRole("treeitem")).toBeNull();
    cleanup();
    wrap(
      <SpanWaterfall spans={SPANS} selectedId={null} onSelect={() => {}} labels={{ empty: "" }} />,
      "en",
    );
    expect(screen.getByRole("tree", { name: "Span waterfall" })).toBeTruthy();
    cleanup();
    wrap(
      <SpanWaterfall
        label="运行 1"
        spans={SPANS}
        selectedId={null}
        onSelect={() => {}}
        labels={{ empty: "" }}
      />,
    );
    expect(screen.getByRole("tree", { name: "运行 1" })).toBeTruthy();
  });

  it("kind 徽标走 design i18n（中 / 英），可经 labels.kinds 覆盖", () => {
    const { container } = wrap(<Controlled />);
    const kind = (id: string) =>
      container.querySelector(`[data-span="${id}"] .cb-waterfall-kind`)?.textContent;
    expect(["r", "s", "m", "t", "w"].map(kind)).toEqual(["运行", "步骤", "模型", "工具", "等待"]);
    cleanup();
    const en = wrap(<Controlled />, "en").container;
    expect(en.querySelector('[data-span="w"] .cb-waterfall-kind')?.textContent).toBe("wait");
    expect(en.querySelector('[data-span="r"] .cb-waterfall-kind')?.textContent).toBe("run");
    cleanup();
    const custom = wrap(
      <SpanWaterfall
        spans={SPANS}
        selectedId={null}
        onSelect={() => {}}
        labels={{ empty: "", kinds: { model: "LLM" } }}
      />,
    ).container;
    expect(custom.querySelector('[data-span="m"] .cb-waterfall-kind')?.textContent).toBe("LLM");
    expect(custom.querySelector('[data-span="t"] .cb-waterfall-kind')?.textContent).toBe("工具");
  });

  it("耗时格式（spec §7）", () => {
    expect(formatSpanDuration(null)).toBe("—");
    expect(formatSpanDuration(0)).toBe("0ms");
    expect(formatSpanDuration(312)).toBe("312ms");
    expect(formatSpanDuration(6800)).toBe("6.8s");
    expect(formatSpanDuration(41_249)).toBe("41.2s");
    expect(formatSpanDuration(138_000)).toBe("00:02:18");
    expect(formatSpanDuration(3_600_000 + 61_000)).toBe("01:01:01");
  });
});
