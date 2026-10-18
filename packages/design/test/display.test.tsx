import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Badge,
  BarChart,
  CAPYBARA_BITMAP,
  DesignProvider,
  Dither,
  Kbd,
  Logo,
  Metric,
  Pagination,
  Segmented,
  Skeleton,
  StatusMark,
  Tabs,
  Tooltip,
} from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

describe("StatusMark", () => {
  it("failed zh / en", () => {
    wrap(<StatusMark status="failed" />);
    expect(screen.getByText("✗ 失败")).toBeTruthy();
    cleanup();
    wrap(<StatusMark status="failed" />, "en");
    expect(screen.getByText("✗ Failed")).toBeTruthy();
  });
  it("六种状态符号", () => {
    const map = {
      running: "●",
      success: "✓",
      failed: "✗",
      waiting: "‖",
      queued: "○",
      cancelled: "⊘",
    } as const;
    for (const [s, g] of Object.entries(map)) {
      const { container } = wrap(<StatusMark status={s as keyof typeof map} />);
      expect(container.textContent?.startsWith(g)).toBe(true);
      expect(container.querySelector(`[data-status="${s}"]`)).toBeTruthy();
      cleanup();
    }
  });
  it("自定义 label", () => {
    wrap(<StatusMark status="success" label="完成" />);
    expect(screen.getByText("✓ 完成")).toBeTruthy();
  });
});

describe("Pagination", () => {
  it("范围、禁用上一页、下一页回调", async () => {
    const onPage = vi.fn();
    wrap(<Pagination page={1} pageSize={50} total={1284} onPage={onPage} />);
    expect(screen.getByText("1–50 / 1,284")).toBeTruthy();
    expect((screen.getByRole("button", { name: /上一页/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(screen.getByRole("button", { name: /下一页/ }));
    expect(onPage).toHaveBeenCalledWith(2);
  });
  it("末页禁用下一页、范围截断", () => {
    wrap(<Pagination page={26} pageSize={50} total={1284} onPage={() => {}} />);
    expect(screen.getByText("1,251–1,284 / 1,284")).toBeTruthy();
    expect((screen.getByRole("button", { name: /下一页/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it("当前页 aria-current，每页切换", () => {
    const onPageSize = vi.fn();
    wrap(
      <Pagination
        page={2}
        pageSize={50}
        total={1284}
        pageSizes={[25, 50]}
        onPage={() => {}}
        onPageSize={onPageSize}
      />,
    );
    expect(screen.getByRole("button", { name: "2" }).getAttribute("aria-current")).toBe("page");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "25" } });
    expect(onPageSize).toHaveBeenCalledWith(25);
  });
  it("total=0", () => {
    wrap(<Pagination page={1} pageSize={50} total={0} onPage={() => {}} />);
    expect(screen.getByText("0 / 0")).toBeTruthy();
  });
});

describe("Tabs", () => {
  it("带 href：当前项 aria-current=page，无 tablist", () => {
    wrap(
      <Tabs
        label="导航"
        value="b"
        items={[
          { id: "a", label: "A", href: "/a" },
          { id: "b", label: "B", href: "/b", count: 3 },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: /B/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /A/ }).getAttribute("aria-current")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
  it("无 href：tablist、aria-selected、onChange、禁用", async () => {
    const onChange = vi.fn();
    wrap(
      <Tabs
        label="分区"
        value="a"
        onChange={onChange}
        items={[
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C", disabled: true },
        ]}
      />,
    );
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("分区");
    expect(screen.getByRole("tab", { name: "A" }).getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: "B" }));
    expect(onChange).toHaveBeenCalledWith("b");
    expect((screen.getByRole("tab", { name: "C" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("方向键移动", async () => {
    const onChange = vi.fn();
    wrap(
      <Tabs
        label="x"
        value="a"
        onChange={onChange}
        items={[
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ]}
      />,
    );
    screen.getByRole("tab", { name: "A" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("Segmented", () => {
  it("radiogroup、选中、onChange", async () => {
    const onChange = vi.fn();
    wrap(
      <Segmented
        label="视图"
        value="a"
        onChange={onChange}
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
      />,
    );
    expect(screen.getByRole("radiogroup").getAttribute("aria-label")).toBe("视图");
    expect(screen.getByRole("radio", { name: "A" }).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("radio", { name: "B" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("Badge / Kbd / Metric", () => {
  it("Badge tone", () => {
    const { container } = wrap(<Badge tone="accent">新</Badge>);
    expect(container.querySelector('[data-tone="accent"]')?.textContent).toBe("新");
  });
  it("Kbd", () => {
    const { container } = wrap(<Kbd>⌘K</Kbd>);
    expect(container.querySelector("kbd")?.textContent).toBe("⌘K");
  });
  it("Metric 涨跌符号", () => {
    const { container } = wrap(
      <Metric label="成功率" value="98%" delta={{ value: "8.2%", direction: "up" }} />,
    );
    expect(screen.getByText("成功率")).toBeTruthy();
    expect(screen.getByText("▲8.2%").getAttribute("data-direction")).toBe("up");
    cleanup();
    wrap(<Metric label="延迟" value="1s" delta={{ value: "1.1s", direction: "down" }} />);
    expect(screen.getByText("▼1.1s")).toBeTruthy();
    expect(container).toBeTruthy();
  });
});

describe("Tooltip", () => {
  it("聚焦后显示内容", async () => {
    wrap(
      <Tooltip content="提示文字">
        <button type="button">触发</button>
      </Tooltip>,
    );
    await userEvent.tab();
    expect((await screen.findAllByText("提示文字")).length).toBeGreaterThan(0);
  });
});

describe("Logo", () => {
  it("path 方块数等于位图 X 数（spec 位图实为 84，brief 中的 106 有误）", () => {
    const { container } = wrap(<Logo />);
    const x = CAPYBARA_BITMAP.join("").split("X").length - 1;
    expect(x).toBe(84);
    const d = container.querySelector("path")?.getAttribute("d") ?? "";
    expect((d.match(/M/g) ?? []).length).toBe(84);
    expect(container.querySelector("svg")?.getAttribute("shape-rendering")).toBe("crispEdges");
    expect(container.querySelector("svg")?.getAttribute("width")).toBe(String(14 * 3));
  });
  it("wordmark", () => {
    wrap(<Logo wordmark />);
    expect(screen.getByText("CAPYBARA")).toBeTruthy();
  });
});

describe("Dither", () => {
  it("确定性、4px 方块、主色 ≤1%", () => {
    const a = render(<Dither side="left" seed={7} />).container.innerHTML;
    cleanup();
    const b = render(<Dither side="left" seed={7} />).container.innerHTML;
    expect(a).toBe(b);
    cleanup();
    const { container } = render(<Dither side="right" seed={7} />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const rects = container.querySelectorAll("rect");
    expect(rects.length).toBeGreaterThan(0);
    const accent = container.querySelectorAll('rect[data-accent="true"]').length;
    expect(accent / rects.length).toBeLessThanOrEqual(0.01);
    expect(rects[0]?.getAttribute("width")).toBe("4");
  });
});

describe("Skeleton / BarChart", () => {
  it("Skeleton 行数", () => {
    const { container } = wrap(<Skeleton rows={3} />);
    expect(container.querySelectorAll(".cb-skeleton-row").length).toBe(3);
  });
  it("BarChart role=img + aria-label", () => {
    wrap(
      <BarChart
        label="近 12 小时运行"
        current={1}
        series={[{ value: 3 }, { value: 5, fail: 2 }]}
      />,
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("近 12 小时运行");
  });
});
