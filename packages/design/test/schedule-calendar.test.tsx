import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEDULE_CALENDAR_FIXTURE as F } from "../src/fixtures/index";
import { DesignProvider, ScheduleCalendar, type ScheduleCalendarProps } from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";

// ScheduleCalendar (spec §6.40; scheduled tasks calendar design §4, §6, §7, §8): the week time
// grid, the month grid and the phone agenda, from plain props; no clock and no zone of its own.

afterEach(cleanup);

function props(over: Partial<ScheduleCalendarProps> = {}): ScheduleCalendarProps {
  return {
    range: "week",
    days: F.week.days,
    today: F.today,
    now: F.now,
    timeZone: F.timeZone,
    items: F.week.items,
    collapsed: [],
    rangeLabel: F.week.rangeLabel,
    footnote: F.footnote,
    onSelect: vi.fn(),
    onNavigate: vi.fn(),
    onRange: vi.fn(),
    onDay: vi.fn(),
    ...over,
  };
}

function cal(over: Partial<ScheduleCalendarProps> = {}, locale: "zh" | "en" = "zh") {
  const p = props(over);
  const r = render(
    <DesignProvider locale={locale}>
      <ScheduleCalendar {...p} />
    </DesignProvider>,
  );
  return { ...r, p };
}

const grid = (c: HTMLElement) =>
  c.querySelector('[data-part="schedule-calendar-grid"]') as HTMLElement;
const agenda = (c: HTMLElement) =>
  c.querySelector('[data-part="schedule-calendar-agenda"]') as HTMLElement;
const parts = (c: Element, part: string) => [
  ...c.querySelectorAll<HTMLElement>(`[data-part="${part}"]`),
];
/** The open 「+N」 Popover (a portal), named by its day. */
async function popover(day: string): Promise<HTMLElement> {
  const groups = await screen.findAllByRole("group", { name: day });
  const pop = groups.find((g) => g.dataset.part === "schedule-calendar-popover");
  if (!pop) throw new Error(`no popover for ${day}`);
  return pop;
}
const live = (c: HTMLElement) =>
  c.querySelector('[data-part="schedule-calendar-live"]')?.textContent ?? "";

describe("ScheduleCalendar week", () => {
  it("draws seven Monday-first day columns, the 00–24 axis and the toolbar", () => {
    const { container } = cal();
    const g = grid(container);
    expect(g.getAttribute("role")).toBe("group");
    expect(g.getAttribute("aria-label")).toBe(F.week.rangeLabel);
    const heads = parts(g, "schedule-calendar-day-head").map((h) => h.textContent);
    expect(heads).toEqual([
      "周一11-09",
      "周二11-10",
      "周三11-11",
      "周四11-12",
      "周五11-13",
      "周六11-14",
      "周日11-15",
    ]);
    expect(parts(g, "schedule-calendar-hour").map((h) => h.textContent)).toHaveLength(24);
    expect(parts(g, "schedule-calendar-hour")[9]?.textContent).toBe("09:00");
    // each day is a group named by its full date, with a hidden heading
    const days = within(g)
      .getAllByRole("group")
      .filter((d) => d !== g);
    expect(days.map((d) => d.getAttribute("aria-label"))).toContain("11月12日 周四");
    expect(within(g).getByRole("heading", { name: "11月12日 周四" })).toBeTruthy();
    // today's header is marked
    expect(
      g.querySelector('[data-part="schedule-calendar-day-head"][data-today="true"]')?.textContent,
    ).toBe("周四11-12");
    const tb = container.querySelector('[data-part="schedule-calendar-toolbar"]') as HTMLElement;
    expect(within(tb).getByRole("button", { name: "今天" })).toBeTruthy();
    expect(within(tb).getByRole("button", { name: "上一周" })).toBeTruthy();
    expect(within(tb).getByRole("button", { name: "下一周" })).toBeTruthy();
    expect(within(tb).getByRole("radio", { name: "周" }).getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain(F.footnote);
  });

  it("gives every block its state, icon and full accessible name", () => {
    const { container } = cal();
    const g = grid(container);
    const icon = {
      upcoming: "clock",
      running: "spinner",
      completed: "check",
      failed: "circle-x",
      skipped: "ban",
    };
    for (const it of F.week.items) {
      const b = g.querySelector<HTMLElement>(`[data-key="i:${it.id}"]`);
      if (!b) continue; // in 「+N」
      expect(b.getAttribute("aria-label")).toBe(it.label);
      expect(b.dataset.state).toBe(it.state);
      expect(b.querySelector("svg")?.getAttribute("data-icon")).toBe(icon[it.state]);
    }
    const r10 = g.querySelector('[data-key="i:r10"]') as HTMLElement;
    expect(r10.getAttribute("aria-label")).toBe("数据导出，研究助手，11月11日 周三 14:00，失败");
    // a trial run carries its mark
    expect(g.querySelector('[data-key="i:r13"]')?.textContent).toContain("试运行");
  });

  it("puts up to three overlapping blocks side by side and the rest in 「+N」", async () => {
    const { container, p } = cal();
    const g = grid(container);
    // Tuesday 09:00: three overlapping half hours, three lanes
    const tue = ["r4", "r5", "r6"].map((id) =>
      g.querySelector<HTMLElement>(`[data-key="i:${id}"]`),
    );
    expect(tue.map((b) => b?.style.left)).toEqual(["0%", `${100 / 3}%`, `${200 / 3}%`]);
    // Wednesday 14:00: four overlap: two blocks and 「+2」 in the third place
    expect(g.querySelector('[data-key="i:r9"]')).not.toBeNull();
    expect(g.querySelector('[data-key="i:r10"]')).not.toBeNull();
    expect(g.querySelector('[data-key="i:r11"]')).toBeNull();
    const more = parts(g, "schedule-calendar-more")[0] as HTMLElement;
    expect(more.textContent).toBe("+2");
    expect(more.getAttribute("aria-label")).toBe("另外 2 项，11月11日 周三");
    await userEvent.click(more);
    const pop = await popover("11月11日 周三");
    const buttons = within(pop).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      F.week.items.find((i) => i.id === "r11")?.label,
      F.week.items.find((i) => i.id === "r12")?.label,
    ]);
    // the items carry their states
    expect(buttons.map((b) => b.dataset.state)).toEqual(["completed", "skipped"]);
    await userEvent.click(buttons[0] as HTMLElement);
    expect(p.onSelect).toHaveBeenCalledWith("r11");
    // choosing closes the list
    expect(document.querySelector('[data-part="schedule-calendar-popover"]')).toBeNull();
  });

  it("splits a chain of overlaps into lanes, two blocks and 「+N」 past three", () => {
    const at = (id: string, time: string) => {
      const [h, m] = time.split(":").map(Number) as [number, number];
      return {
        id,
        day: "2026-11-10",
        minute: h * 60 + m,
        time,
        title: id,
        state: "completed" as const,
        label: id,
      };
    };
    const { container } = cal({
      items: [
        at("a", "09:00"),
        at("b", "09:00"),
        at("c", "09:10"),
        at("d", "09:20"),
        at("e", "09:30"),
        at("f", "10:00"),
      ],
    });
    const g = grid(container);
    const shown = parts(g, "schedule-calendar-block").map((b) => [b.dataset.key, b.style.left]);
    expect(shown).toEqual([
      ["i:a", "0%"],
      ["i:b", `${100 / 3}%`],
      ["i:e", "0%"],
      ["i:f", "0%"],
    ]);
    const more = parts(g, "schedule-calendar-more")[0] as HTMLElement;
    expect(more.textContent).toBe("+2");
    expect(more.style.top).toBe(`calc(var(--cb-layout-calendar-hour) * ${550 / 60})`);
    expect(more.style.left).toBe(`${200 / 3}%`);
  });

  it("opens at 07:00, again when early items arrive, never after the person scrolled", () => {
    const early = {
      ...F.week.items[0],
      id: "early",
      minute: 5 * 60 + 30,
      time: "05:30",
    } as (typeof F.week.items)[number];
    const p = props({ loading: true, items: [] });
    const view = (q: ScheduleCalendarProps) => (
      <DesignProvider locale="zh">
        <ScheduleCalendar {...q} />
      </DesignProvider>
    );
    const { container, rerender } = render(view(p));
    const scroll = container.querySelector('[data-part="schedule-calendar-scroll"]') as HTMLElement;
    expect(scroll.scrollTop).toBe(7 * 48);
    rerender(view({ ...p, loading: false, items: [early, ...F.week.items] }));
    // an hour before 05:30
    expect(scroll.scrollTop).toBe(4 * 48);
    scroll.scrollTop = 600;
    fireEvent.scroll(scroll);
    rerender(view({ ...p, loading: false, items: [{ ...early, minute: 120, time: "02:00" }] }));
    expect(scroll.scrollTop).toBe(600);
  });

  it("draws the now line in today's column only, decorative", () => {
    const { container } = cal();
    const now = parts(grid(container), "schedule-calendar-now");
    expect(now).toHaveLength(1);
    expect(now[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(now[0]?.closest('[data-part="schedule-calendar-day"]')?.getAttribute("aria-label")).toBe(
      "11月12日 周四",
    );
    // 10:24 in Asia/Shanghai
    expect(now[0]?.style.top).toBe(`calc(var(--cb-layout-calendar-hour) * ${624 / 60})`);
    cleanup();
    const other = cal({ today: "2026-11-20" });
    expect(parts(grid(other.container), "schedule-calendar-now")).toHaveLength(0);
  });

  it("draws the dense lane only when the week has a collapsed task", () => {
    const { container } = cal();
    expect(parts(grid(container), "schedule-calendar-lane")).toHaveLength(0);
    cleanup();
    const dense = cal({ collapsed: F.week.collapsed });
    const chips = parts(grid(dense.container), "schedule-calendar-chip");
    expect(chips).toHaveLength(4);
    const failed = chips.find((c) => c.dataset.state === "failed") as HTMLElement;
    expect(failed.getAttribute("aria-label")).toBe(
      "数据同步，每小时，11月11日 周三 24 次，其中 2 次失败",
    );
    expect(failed.textContent).toBe("数据同步每小时 · 24 次 · 2 次失败");
    // the name keeps its room: the summary and the failures shrink first, with an ellipsis
    const title = failed.querySelector('[data-part="schedule-calendar-title"]') as HTMLElement;
    const tail = failed.querySelector('[data-part="schedule-calendar-tail"]') as HTMLElement;
    expect(tail.contains(failed.querySelector('[data-part="schedule-calendar-chip-failed"]'))).toBe(
      true,
    );
    const css = readFileSync(
      resolve(import.meta.dirname, "../src/styles/schedule-calendar.css"),
      "utf8",
    );
    expect(title.className).toContain("cb-scal-chip-title");
    expect(css).toMatch(/\.cb-scal-chip-title \{\s*flex: 0 0 auto;\s*max-width: 50%;/);
    expect(css).toMatch(
      /\.cb-scal-tail \{\s*flex: 0 1 auto;\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;/,
    );
    expect(failed.querySelector("svg")?.getAttribute("data-icon")).toBe("circle-x");
  });

  it("marks the selected block and opens a block on click", async () => {
    const { container, p } = cal({ selectedId: F.selectedId });
    const g = grid(container);
    const sel = g.querySelector('[data-key="i:r3"]') as HTMLElement;
    expect(sel.dataset.selected).toBe("true");
    expect(sel.getAttribute("aria-current")).toBe("true");
    await userEvent.click(g.querySelector('[data-key="i:r7"]') as HTMLElement);
    expect(p.onSelect).toHaveBeenCalledWith("r7");
  });

  it("draws the days after a cut as not loaded, with nothing in them", () => {
    const { container } = cal({ notLoadedFrom: "2026-11-13" });
    const g = grid(container);
    const heads = parts(g, "schedule-calendar-day-head");
    expect(heads.filter((h) => h.textContent?.includes("未加载"))).toHaveLength(3);
    expect(g.querySelector('[data-key="i:o2"]')).toBeNull();
    expect(g.querySelector('[data-key="i:o1"]')).not.toBeNull();
  });
});

describe("ScheduleCalendar keyboard", () => {
  it("is one tab stop: the selected item, else today's first, else the first", () => {
    const { container } = cal();
    const g = grid(container);
    const tabbable = [...g.querySelectorAll<HTMLElement>("[data-key]")].filter(
      (b) => b.tabIndex === 0,
    );
    expect(tabbable.map((b) => b.dataset.key)).toEqual(["i:r14"]);
    cleanup();
    const sel = cal({ selectedId: "r7" });
    const t2 = [...grid(sel.container).querySelectorAll<HTMLElement>("[data-key]")].filter(
      (b) => b.tabIndex === 0,
    );
    expect(t2.map((b) => b.dataset.key)).toEqual(["i:r7"]);
  });

  it("moves with the arrows, Home and End; PageUp / PageDown and t navigate", () => {
    const { container, p } = cal();
    const g = grid(container);
    const key = (k: string) => g.querySelector<HTMLElement>(`[data-key="${k}"]`) as HTMLElement;
    const focused = () => (document.activeElement as HTMLElement | null)?.dataset.key;
    key("i:r14").focus();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(focused()).toBe("i:r15");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(focused()).toBe("i:r14");
    // ← the nearest in time on the previous day: Wednesday 09:00
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(focused()).toBe("i:r8");
    // → back to Thursday 09:00, then Friday 09:00, then Sunday (Saturday is empty)
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(focused()).toBe("i:r14");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(focused()).toBe("i:o2");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(focused()).toBe("i:o5");
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(focused()).toBe("i:r1");
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(focused()).toBe("i:o5");
    // the roving stop follows focus
    expect(key("i:o5").tabIndex).toBe(0);
    expect(key("i:r14").tabIndex).toBe(-1);
    fireEvent.keyDown(document.activeElement as Element, { key: "PageDown" });
    expect(p.onNavigate).toHaveBeenLastCalledWith("next");
    fireEvent.keyDown(document.activeElement as Element, { key: "PageUp" });
    expect(p.onNavigate).toHaveBeenLastCalledWith("prev");
    fireEvent.keyDown(document.activeElement as Element, { key: "t" });
    expect(p.onNavigate).toHaveBeenLastCalledWith("today");
  });

  it("keeps the weekday after PageDown once the next range arrives", () => {
    const p = props();
    const next = F.week.days.map((d) => d.replace(/-(\d\d)$/, (_, n) => `-${Number(n) + 7}`));
    const view = (q: ScheduleCalendarProps) => (
      <DesignProvider locale="zh">
        <ScheduleCalendar {...q} />
      </DesignProvider>
    );
    const { container, rerender } = render(view(p));
    const g = grid(container);
    (g.querySelector('[data-key="i:r8"]') as HTMLElement).focus();
    fireEvent.keyDown(document.activeElement as Element, { key: "PageDown" });
    const moved = F.week.items.map((it) => ({
      ...it,
      id: `n${it.id}`,
      day: it.day.replace(/-(\d\d)$/, (_, n) => `-${Number(n) + 7}`),
    }));
    // the days change first (the previous answer still drawn), the items later
    rerender(view({ ...p, days: next, rangeLabel: "2026-11-16 – 11-22" }));
    expect(document.activeElement).toBe(grid(container));
    rerender(view({ ...p, days: next, items: moved, rangeLabel: "2026-11-16 – 11-22" }));
    // Wednesday again
    expect((document.activeElement as HTMLElement).dataset.key).toBe("i:nr8");
  });

  it("moves the tab stop on when the focused item leaves the data", () => {
    const p = props();
    const view = (q: ScheduleCalendarProps) => (
      <DesignProvider locale="zh">
        <ScheduleCalendar {...q} />
      </DesignProvider>
    );
    const { container, rerender } = render(view(p));
    const g = grid(container);
    act(() => (g.querySelector('[data-key="i:o5"]') as HTMLElement).focus());
    expect((g.querySelector('[data-key="i:o5"]') as HTMLElement).tabIndex).toBe(0);
    rerender(view({ ...p, items: F.week.items.filter((i) => i.id !== "o5") }));
    const tabbable = [...g.querySelectorAll<HTMLElement>("[data-key]")].filter(
      (b) => b.tabIndex === 0,
    );
    expect(tabbable.map((b) => b.dataset.key)).toEqual(["i:r14"]);
  });

  it("announces a new range label in the polite live region", () => {
    const p = props();
    const view = (q: ScheduleCalendarProps) => (
      <DesignProvider locale="zh">
        <ScheduleCalendar {...q} />
      </DesignProvider>
    );
    const { container, rerender } = render(view(p));
    const region = container.querySelector('[data-part="schedule-calendar-live"]');
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(live(container)).toBe("");
    act(() => rerender(view({ ...p, rangeLabel: "2026-11-16 – 11-22" })));
    expect(live(container)).toBe("2026-11-16 – 11-22");
    // and back: the first label is announced again
    act(() => rerender(view({ ...p, rangeLabel: F.week.rangeLabel })));
    expect(live(container)).toBe(F.week.rangeLabel);
  });

  it("calls the toolbar's navigation and range callbacks", async () => {
    const { container, p } = cal({
      scope: { value: "mine", onChange: vi.fn(), labels: F.scope },
    });
    const tb = container.querySelector('[data-part="schedule-calendar-toolbar"]') as HTMLElement;
    await userEvent.click(within(tb).getByRole("button", { name: "今天" }));
    await userEvent.click(within(tb).getByRole("button", { name: "下一周" }));
    expect(p.onNavigate).toHaveBeenCalledWith("today");
    expect(p.onNavigate).toHaveBeenCalledWith("next");
    await userEvent.click(within(tb).getByRole("radio", { name: "月" }));
    expect(p.onRange).toHaveBeenCalledWith("month");
    await userEvent.click(within(tb).getByRole("radio", { name: "全组织" }));
    expect(p.scope?.onChange).toHaveBeenCalledWith("all");
  });
});

describe("ScheduleCalendar month", () => {
  const month = (over: Partial<ScheduleCalendarProps> = {}) =>
    cal({
      range: "month",
      days: F.month.days,
      items: F.month.items,
      collapsed: F.month.collapsed,
      rangeLabel: F.month.rangeLabel,
      ...over,
    });

  it("draws 6 × 7 cells, muted outside the month, today's number marked", () => {
    const { container } = month();
    const g = grid(container);
    const cells = parts(g, "schedule-calendar-cell");
    expect(cells).toHaveLength(42);
    expect(cells.filter((c) => c.dataset.outside === "true")).toHaveLength(12);
    expect(
      g.querySelector('[data-part="schedule-calendar-number"][data-today="true"]')?.textContent,
    ).toBe("12");
    // items outside the month are still drawn
    expect(g.querySelector('[data-key="i:m17"]')).not.toBeNull();
    const tb = container.querySelector('[data-part="schedule-calendar-toolbar"]') as HTMLElement;
    expect(within(tb).getByRole("button", { name: "上个月" })).toBeTruthy();
  });

  it("lists three lines a day, the third 「+N 项」 when there are more", async () => {
    const { container, p } = month();
    const g = grid(container);
    const nov5 = cellOf(g, "11月5日 周四");
    expect(parts(nov5, "schedule-calendar-line")).toHaveLength(2);
    const more = parts(nov5, "schedule-calendar-more")[0] as HTMLElement;
    expect(more.textContent).toBe("+3 项");
    await userEvent.click(more);
    const pop = await popover("11月5日 周四");
    // the whole day, not only the hidden three (design §4.4)
    expect(within(pop).getAllByRole("button")).toHaveLength(5);
    // a collapsed task counts toward the three
    const nov10 = cellOf(g, "11月10日 周二");
    expect(parts(nov10, "schedule-calendar-line")).toHaveLength(3);
    expect(parts(nov10, "schedule-calendar-line")[0]?.textContent).toContain("每小时 · 24 次");
    // the day number goes to that day's week
    await userEvent.click(within(nov10).getByRole("button", { name: "11月10日 周二，查看这一周" }));
    expect(p.onDay).toHaveBeenCalledWith("2026-11-10");
  });

  it("draws the days after a cut as not loaded", () => {
    const { container } = month({ notLoadedFrom: "2026-11-20" });
    const g = grid(container);
    expect(cellOf(g, "11月20日 周五").textContent).toContain("未加载");
    expect(g.querySelector('[data-key="i:m15"]')).toBeNull();
    expect(g.querySelector('[data-key="i:m14"]')).not.toBeNull();
  });

  it("moves a week with ↑ / ↓ and through the lines with ← / →", () => {
    const { container } = month();
    const g = grid(container);
    const focused = () => (document.activeElement as HTMLElement | null)?.dataset.key;
    (g.querySelector('[data-key="i:m2"]') as HTMLElement).focus();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(focused()).toBe("i:m3");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(focused()).toBe("i:m2");
    // ↓ the week below: Monday 11-09, its day number then nothing; same place (index 1) = the number? 11-09 has the number only
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(focused()).toBe("d:2026-11-09");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(focused()).toBe("d:2026-11-02");
  });
});

function cellOf(g: HTMLElement, label: string): HTMLElement {
  return parts(g, "schedule-calendar-cell").find(
    (c) => c.getAttribute("aria-label") === label,
  ) as HTMLElement;
}

describe("ScheduleCalendar agenda", () => {
  it("draws the day buttons and the chosen day's rows; range agenda drops the grid", async () => {
    const { container, p } = cal({
      range: "agenda",
      collapsed: F.week.collapsed,
      day: F.agendaDay,
    });
    expect(grid(container)).toBeNull();
    expect(
      container.querySelector('[data-part="schedule-calendar"]')?.getAttribute("data-range"),
    ).toBe("agenda");
    const a = agenda(container);
    const days = parts(a, "schedule-calendar-agenda-day");
    expect(days.map((d) => d.textContent)).toEqual([
      "一9",
      "二10",
      "三11",
      "四12",
      "五13",
      "六14",
      "日15",
    ]);
    expect(days[3]?.getAttribute("aria-pressed")).toBe("true");
    expect(days[3]?.getAttribute("aria-current")).toBe("date");
    // a dot under days with a failed run, named in the label
    expect(
      days.map((d) => d.querySelector('[data-part="schedule-calendar-dot"]') !== null),
    ).toEqual([true, false, true, false, false, false, false]);
    expect(days[0]?.getAttribute("aria-label")).toBe("11月9日 周一，有失败的运行");
    const rows = parts(a, "schedule-calendar-row");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      F.week.collapsed[2]?.label,
      ...["r14", "r15", "o1"].map((id) => F.week.items.find((i) => i.id === id)?.label),
    ]);
    expect(rows[1]?.textContent).toContain("研究助手");
    await userEvent.click(days[1] as HTMLElement);
    expect(p.onDay).toHaveBeenCalledWith("2026-11-10");
    await userEvent.click(rows[2] as HTMLElement);
    expect(p.onSelect).toHaveBeenCalledWith("r15");
    // the toolbar folds 周 / 月 and the scope into one options button
    expect(within(container).getByRole("button", { name: "视图选项" })).toBeTruthy();
  });

  it("pages a month by the week of the chosen day", () => {
    const { container } = cal({
      range: "agenda",
      days: F.month.days,
      items: F.month.items,
      day: "2026-11-05",
    });
    const days = parts(agenda(container), "schedule-calendar-agenda-day");
    expect(days.map((d) => d.textContent)).toEqual([
      "一2",
      "二3",
      "三4",
      "四5",
      "五6",
      "六7",
      "日8",
    ]);
  });

  it("says when the chosen day is not loaded, and draws no dot there", () => {
    const { container } = cal({ range: "agenda", day: "2026-11-11", notLoadedFrom: "2026-11-11" });
    const a = agenda(container);
    expect(a.textContent).toContain("未加载");
    expect(parts(a, "schedule-calendar-row")).toHaveLength(0);
    const days = parts(a, "schedule-calendar-agenda-day");
    expect(days[2]?.querySelector('[data-part="schedule-calendar-dot"]')).toBeNull();
  });

  it("groups the options menu: the range, a separator, the scope", async () => {
    const onChange = vi.fn();
    const { container, p } = cal({
      range: "agenda",
      scope: { value: "mine", onChange, labels: F.scope },
    });
    await userEvent.click(within(container).getByRole("button", { name: "视图选项" }));
    const menu = await screen.findByRole("menu");
    const kids = [...menu.querySelectorAll('[role="menuitemradio"], [role="separator"]')].map(
      (el) => (el.getAttribute("role") === "separator" ? "|" : el.textContent),
    );
    expect(kids).toEqual(["周", "月", "|", "只看我的", "全组织"]);
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "全组织" }));
    expect(onChange).toHaveBeenCalledWith("all");
    expect(p.onRange).not.toHaveBeenCalled();
  });

  it("says when the chosen day has no runs", () => {
    const { container } = cal({ range: "agenda", day: "2026-11-14" });
    expect(agenda(container).textContent).toContain("这天没有运行。");
  });

  it("is drawn next to the grid, and CSS shows it below 640", () => {
    const { container } = cal();
    expect(grid(container)).not.toBeNull();
    expect(agenda(container)).not.toBeNull();
    const css = readFileSync(
      resolve(import.meta.dirname, "../src/styles/schedule-calendar.css"),
      "utf8",
    );
    const narrow = css.slice(css.indexOf("@media (max-width: 639px)"));
    expect(narrow).toMatch(/\.cb-scal-grid \{\s*display: none;/);
    expect(narrow).toMatch(/\.cb-scal-agenda \{\s*display: flex;/);
    expect(css).toMatch(/\.cb-scal\[data-range="agenda"\] \.cb-scal-agenda \{\s*display: flex;/);
  });
});

describe("ScheduleCalendar states", () => {
  it("loading: the grid frame with skeleton blocks in one busy region", () => {
    const { container } = cal({ loading: true, items: [] });
    const g = grid(container);
    expect(g.getAttribute("aria-busy")).toBe("true");
    expect(within(g).getAllByRole("status")).toHaveLength(1);
    expect(g.querySelectorAll('[data-part="skeleton-box"]').length).toBeGreaterThan(0);
    expect(parts(g, "schedule-calendar-block")).toHaveLength(0);
    // the toolbar stays real
    expect(within(container).getAllByRole("button", { name: "今天" })).toHaveLength(1);
  });

  it("empty: a panel EmptyState over the grid body with its action", async () => {
    const onSelect = vi.fn();
    const { container } = cal({
      items: [],
      empty: {
        text: F.empty.text,
        hint: F.empty.hint,
        action: { label: F.empty.action, onSelect },
      },
    });
    const g = grid(container);
    const e = g.querySelector('[data-part="schedule-calendar-empty"]') as HTMLElement;
    expect(e.querySelector('[data-part="empty-state"]')?.getAttribute("data-size")).toBe("panel");
    expect(e.textContent).toContain(F.empty.text);
    expect(e.textContent).toContain(F.empty.hint);
    await userEvent.click(within(e).getByRole("button", { name: F.empty.action }));
    expect(onSelect).toHaveBeenCalled();
    // the grid is still drawn under it
    expect(parts(g, "schedule-calendar-day")).toHaveLength(7);
  });

  it("failed: the load-failed line with the code and 重试, the grid kept", async () => {
    const retry = vi.fn();
    const { container } = cal({ error: { retry, code: F.errorCode } });
    const line = container.querySelector('[data-part="schedule-calendar-error"]') as HTMLElement;
    expect(line.getAttribute("role")).toBe("alert");
    expect(line.textContent).toContain("加载失败");
    expect(line.textContent).toContain(F.errorCode);
    await userEvent.click(within(line).getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalled();
    expect(parts(grid(container), "schedule-calendar-block").length).toBeGreaterThan(0);
  });

  it("refreshing: a spinner beside the range label", () => {
    const { container } = cal({ refreshing: true });
    expect(container.querySelector('[data-part="schedule-calendar-refreshing"]')).not.toBeNull();
  });

  it("speaks English with the en locale", () => {
    const { container } = cal({}, "en");
    const g = grid(container);
    expect(parts(g, "schedule-calendar-day-head")[0]?.textContent).toBe("Mon11-09");
    const days = within(g)
      .getAllByRole("group")
      .filter((d) => d !== g);
    expect(days[3]?.getAttribute("aria-label")).toBe("Thu, Nov 12");
    expect(within(container).getByRole("button", { name: "Previous week" })).toBeTruthy();
  });

  it.each([
    ["week", {}],
    ["week-dense", { collapsed: F.week.collapsed }],
    ["month", { range: "month" as const, days: F.month.days, items: F.month.items }],
    ["agenda", { range: "agenda" as const, day: F.agendaDay }],
    ["loading", { loading: true }],
    ["empty", { items: [], empty: { text: F.empty.text } }],
    ["failed", { error: { retry: () => {}, code: F.errorCode } }],
  ])("%s draws no box inside a box", (_, over) => {
    cal(over as Partial<ScheduleCalendarProps>);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("writes no color literal", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/display/schedule-calendar.tsx"),
      "utf8",
    );
    const css = readFileSync(
      resolve(import.meta.dirname, "../src/styles/schedule-calendar.css"),
      "utf8",
    );
    for (const text of [src, css]) expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
});
