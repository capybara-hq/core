import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { TREND_CHART_FIXTURE as F } from "../src/fixtures/index";
import {
  DensityContext,
  DesignProvider,
  formatCompact,
  TrendChart,
  type TrendChartPanel,
  type TrendChartProps,
} from "../src/index";

// TrendChart (spec §6.8; admin overview design §10.1): small multiples, one panel per measure,
// stacked on one shared x-axis with one crosshair and one tooltip; never a second y-scale (D1).

afterEach(cleanup);

const count = (n: number) => n.toLocaleString("en-US");
const compact = (n: number) => formatCompact(n, "zh");

function panels(
  runs: (number | null)[] = F.runs.values,
  tokens: (number | null)[] = F.tokens.values,
) {
  return [
    { id: F.runs.id, label: F.runs.label, values: runs, format: count },
    { id: F.tokens.id, label: F.tokens.label, values: tokens, format: compact },
  ];
}

const wrap = (ui: ReactNode, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

function chart(over: Partial<TrendChartProps> = {}) {
  return wrap(
    <TrendChart
      label={F.label}
      x={F.x}
      panels={panels()}
      current={F.current}
      extra={(i) => `${F.costLabel} ${F.cost[i]}`}
      empty={F.empty}
      {...over}
    />,
  );
}

const plots = (c: HTMLElement) => [
  ...c.querySelectorAll<SVGSVGElement>('[data-part="trend-chart-plot"]'),
];
const points = (plot: Element) => [...plot.querySelectorAll('[data-part="trend-chart-point"]')];
const segments = (plot: Element) => [...plot.querySelectorAll('[data-part="trend-chart-segment"]')];
const num = (el: Element, attr: string) => Number.parseFloat(el.getAttribute(attr) ?? "NaN");
const live = (c: HTMLElement) =>
  c.querySelector('[data-part="trend-chart-live"]')?.textContent ?? "";

describe("TrendChart geometry", () => {
  it("draws one panel per measure, stacked, each with a point per value", () => {
    const { container } = chart();
    const ps = plots(container);
    expect(ps).toHaveLength(2);
    for (const p of ps) {
      expect(points(p)).toHaveLength(7);
      expect(segments(p)).toHaveLength(6);
      // the points sit in the middle of their columns, left to right
      const xs = points(p).map((el) => num(el, "x"));
      expect(xs[0]).toBeCloseTo((0.5 / 7) * 100, 3);
      expect(xs[6]).toBeCloseTo((6.5 / 7) * 100, 3);
      expect([...xs].sort((a, b) => a - b)).toEqual(xs);
      expect(p.getAttribute("height")).toBe("96");
    }
    // x labels once, under the last panel only
    expect(container.querySelectorAll('[data-part="trend-chart-x"]')).toHaveLength(7);
  });

  it("puts the panel's max at the top and zero on the baseline, with only the max labelled", () => {
    const { container } = chart({ panels: panels([0, 132, 66, 87, 128, 112, 64]) });
    const [runs] = plots(container);
    if (!runs) throw new Error("no plot");
    const ys = points(runs).map((el) => num(el, "y") + 3);
    const baseline = runs.querySelector('[data-part="trend-chart-baseline"]');
    expect(baseline).not.toBeNull();
    expect(ys[0]).toBe(num(baseline as Element, "y1"));
    expect(ys[1]).toBeLessThan(ys[2] as number);
    expect(ys[2]).toBe(Math.round(((ys[0] as number) + (ys[1] as number)) / 2));
    // the y axis is the max alone
    expect(runs.querySelectorAll('[data-part="trend-chart-max"]')).toHaveLength(1);
    expect(runs.querySelector('[data-part="trend-chart-max"]')?.textContent).toBe("132");
    expect(runs.querySelector("line[data-part=grid]")).toBeNull();
  });

  it("draws the current point and the segment into it as current", () => {
    const { container } = chart();
    for (const p of plots(container)) {
      const kinds = points(p).map((el) => el.getAttribute("data-kind"));
      expect(kinds).toEqual([
        "normal",
        "normal",
        "normal",
        "normal",
        "normal",
        "normal",
        "current",
      ]);
      const segs = segments(p).map((el) => el.getAttribute("data-kind"));
      expect(segs).toEqual(["normal", "normal", "normal", "normal", "normal", "current"]);
    }
  });

  it("leaves a gap where a value is null: no point, no segment across it", () => {
    const { container } = chart({ panels: panels(F.gapRuns, F.gapTokens) });
    for (const p of plots(container)) {
      const idx = points(p).map((el) => el.getAttribute("data-index"));
      expect(idx).toEqual(["0", "1", "4", "5", "6"]);
      // 0–1 and 4–5–6: three segments, none touching 2 or 3
      expect(segments(p).map((el) => el.getAttribute("data-from"))).toEqual(["0", "4", "5"]);
    }
  });

  it("draws all zeros as the flat zero state with the empty line", () => {
    const zeros = [0, 0, 0, 0, 0, 0, 0];
    const { container } = chart({ panels: panels(zeros, zeros) });
    const root = container.querySelector('[data-part="trend-chart"]');
    expect(root?.getAttribute("data-state")).toBe("empty");
    expect(screen.getByText(F.empty)).toBeTruthy();
    for (const p of plots(container)) {
      const base = num(p.querySelector('[data-part="trend-chart-baseline"]') as Element, "y1");
      for (const el of points(p)) expect(num(el, "y") + 3).toBe(base);
      expect(p.querySelector('[data-part="trend-chart-max"]')).toBeNull();
    }
  });

  it("draws no empty line while any value is above zero", () => {
    chart();
    expect(screen.queryByText(F.empty)).toBeNull();
  });

  it("is 72 high per panel at the dense step", () => {
    const { container } = render(
      <DesignProvider locale="zh">
        <DensityContext.Provider value="dense">
          <TrendChart label={F.label} x={F.x} panels={panels()} />
        </DensityContext.Provider>
      </DesignProvider>,
    );
    for (const p of plots(container)) expect(p.getAttribute("height")).toBe("72");
  });

  it("titles each panel with its label and its latest value", () => {
    const { container } = chart();
    const heads = [...container.querySelectorAll('[data-part="trend-chart-head"]')];
    expect(heads.map((h) => h.textContent)).toEqual(["运行64", "Token152万"]);
  });
});

describe("TrendChart accessibility", () => {
  it("is one named group whose panels are images with a summary", () => {
    chart();
    const group = screen.getByRole("group", { name: F.label });
    const imgs = within(group).getAllByRole("img");
    expect(imgs.map((i) => i.getAttribute("aria-label"))).toEqual([
      "运行：最高 11-06 的 132，最新 11-11 的 64",
      "Token：最高 11-09 的 340万，最新 11-11 的 152万",
    ]);
  });

  it("summarises in English under the en locale, and says when a panel is all zero", () => {
    const zeros = [0, 0, 0, 0, 0, 0, 0];
    wrap(
      <TrendChart label="Usage" x={F.x} panels={panels(F.runs.values, zeros)} current={6} />,
      "en",
    );
    expect(screen.getAllByRole("img").map((i) => i.getAttribute("aria-label"))).toEqual([
      "运行: highest 132 on 11-06, latest 64 on 11-11",
      "Token: all zero",
    ]);
  });

  it("holds every value in a visually hidden table, the current row marked", () => {
    const { container } = chart({
      panels: panels(F.gapRuns, F.tokens.values),
      extraLabel: F.extraLabel,
    });
    const table = container.querySelector("table");
    expect(table?.className).toContain("cb-sr-only");
    const rows = [...(table?.querySelectorAll("tbody tr") ?? [])].map((r) =>
      [...r.children].map((c) => c.textContent),
    );
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual(["11-05", "96", "241万", "估算 ¥9.80"]);
    expect(rows[2]).toEqual(["11-07", "—", "287万", "估算 ¥11.40"]);
    expect(rows[4]).toEqual(["11-09", "128", "340万", "估算 ¥12.30"]);
    expect(rows[6]).toEqual(["11-11（当前）", "64", "152万", "估算 ¥5.90"]);
    const head = [...(table?.querySelectorAll("thead th") ?? [])].map((c) => c.textContent);
    expect(head).toEqual(["时间", "运行", "Token", "估算费用"]);
  });

  it("has no extra column without extra", () => {
    const { container } = wrap(<TrendChart label={F.label} x={F.x} panels={panels()} />);
    const head = [...container.querySelectorAll("thead th")].map((c) => c.textContent);
    expect(head).toEqual(["时间", "运行", "Token"]);
    expect(container.querySelector("tbody tr")?.children).toHaveLength(3);
  });
});

describe("TrendChart interaction", () => {
  const crosshairs = (c: HTMLElement) =>
    [...c.querySelectorAll('[data-part="trend-chart-crosshair"]')].map((el) => num(el, "x1"));

  it("moves one crosshair across both panels with the keyboard and mirrors the tooltip", async () => {
    const user = userEvent.setup();
    const { container } = chart();
    expect(crosshairs(container)).toEqual([]);
    expect(container.querySelector('[data-part="trend-chart-tooltip"]')).toBeNull();

    await user.tab();
    const group = screen.getByRole("group", { name: F.label });
    expect(document.activeElement).toBe(group);
    // focus shows the current point
    let xs = crosshairs(container);
    expect(xs).toHaveLength(2);
    expect(xs[0]).toBe(xs[1]);
    expect(xs[0]).toBeCloseTo((6.5 / 7) * 100, 3);
    const tip = container.querySelector('[data-part="trend-chart-tooltip"]');
    expect(tip?.textContent).toContain("11-11");
    expect(tip?.textContent).toContain("当前");
    expect(tip?.textContent).toContain("64");
    expect(tip?.textContent).toContain("152万");
    expect(tip?.textContent).toContain("估算 ¥5.90");
    expect(live(container)).toBe("11-11（当前） · 运行 64 · Token 152万 · 估算 ¥5.90");
    expect(
      container.querySelector('[data-part="trend-chart-live"]')?.getAttribute("aria-live"),
    ).toBe("polite");

    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    xs = crosshairs(container);
    expect(xs[0]).toBeCloseTo((4.5 / 7) * 100, 3);
    expect(live(container)).toBe("11-09 · 运行 128 · Token 340万 · 估算 ¥12.30");

    await user.keyboard("{Home}");
    expect(crosshairs(container)[0]).toBeCloseTo((0.5 / 7) * 100, 3);
    expect(live(container)).toContain("11-05");
    await user.keyboard("{ArrowLeft}");
    expect(crosshairs(container)[0]).toBeCloseTo((0.5 / 7) * 100, 3);

    await user.keyboard("{End}");
    expect(crosshairs(container)[0]).toBeCloseTo((6.5 / 7) * 100, 3);
    await user.keyboard("{ArrowRight}");
    expect(crosshairs(container)[0]).toBeCloseTo((6.5 / 7) * 100, 3);

    await user.keyboard("{Escape}");
    expect(crosshairs(container)).toEqual([]);
    expect(container.querySelector('[data-part="trend-chart-tooltip"]')).toBeNull();
    expect(live(container)).toBe("");

    // a key after Esc brings it back where it was
    await user.keyboard("{ArrowLeft}");
    expect(crosshairs(container)[0]).toBeCloseTo((5.5 / 7) * 100, 3);
  });

  it("follows the pointer over full-height columns and hides when it leaves", () => {
    const { container } = chart();
    const hits = [...container.querySelectorAll('[data-part="trend-chart-hit"]')];
    expect(hits).toHaveLength(7);
    act(() => {
      fireEvent.pointerEnter(hits[2] as Element, { pointerType: "mouse" });
    });
    expect(crosshairs(container)[0]).toBeCloseTo((2.5 / 7) * 100, 3);
    expect(container.querySelector('[data-part="trend-chart-tooltip"]')?.textContent).toContain(
      "11-07",
    );
    // a pointer's hover is not announced
    expect(live(container)).toBe("");
    const root = container.querySelector('[data-part="trend-chart"]') as Element;
    act(() => {
      fireEvent.pointerLeave(root, { pointerType: "mouse" });
    });
    expect(crosshairs(container)).toEqual([]);
  });

  it("hides a clicked column when the mouse leaves, though the click focused the group", () => {
    const { container } = chart();
    const hits = [...container.querySelectorAll('[data-part="trend-chart-hit"]')];
    const root = container.querySelector('[data-part="trend-chart"]') as HTMLElement;
    act(() => {
      fireEvent.pointerEnter(hits[3] as Element, { pointerType: "mouse" });
      fireEvent.pointerDown(hits[3] as Element, { pointerType: "mouse" });
      root.focus();
      fireEvent.pointerUp(hits[3] as Element, { pointerType: "mouse" });
    });
    expect(document.activeElement).toBe(root);
    expect(crosshairs(container)[0]).toBeCloseTo((3.5 / 7) * 100, 3);
    expect(live(container)).toBe("");
    act(() => {
      fireEvent.pointerLeave(root, { pointerType: "mouse" });
    });
    expect(crosshairs(container)).toEqual([]);
  });

  it("keeps a point reached by keyboard when the pointer leaves", async () => {
    const user = userEvent.setup();
    const { container } = chart();
    await user.tab();
    await user.keyboard("{ArrowLeft}");
    const root = container.querySelector('[data-part="trend-chart"]') as Element;
    act(() => {
      fireEvent.pointerLeave(root, { pointerType: "mouse" });
    });
    expect(crosshairs(container)[0]).toBeCloseTo((5.5 / 7) * 100, 3);
  });

  it("shows a tapped column on touch and keeps it after the finger lifts", () => {
    const { container } = chart();
    const hits = [...container.querySelectorAll('[data-part="trend-chart-hit"]')];
    const root = container.querySelector('[data-part="trend-chart"]') as Element;
    act(() => {
      fireEvent.pointerDown(hits[1] as Element, { pointerType: "touch" });
      fireEvent.pointerLeave(root, { pointerType: "touch" });
    });
    expect(crosshairs(container)[0]).toBeCloseTo((1.5 / 7) * 100, 3);
  });

  it("can open on a given point (the reference set's hover block)", () => {
    const { container } = chart({ defaultActive: F.hover });
    expect(crosshairs(container)[0]).toBeCloseTo((4.5 / 7) * 100, 3);
  });
});

describe("TrendChart props", () => {
  it("has no second y-scale: one format per panel, no axis props", () => {
    expectTypeOf<keyof TrendChartProps>().toEqualTypeOf<
      "label" | "x" | "panels" | "current" | "extra" | "extraLabel" | "empty" | "defaultActive"
    >();
    expectTypeOf<keyof TrendChartPanel>().toEqualTypeOf<"id" | "label" | "values" | "format">();
    const bad: TrendChartProps = {
      label: F.label,
      x: F.x,
      panels: panels(),
      // @ts-expect-error a chart has no second y-axis (admin overview design D1)
      y2: panels()[1],
    };
    expect(bad.label).toBe(F.label);
  });
});
