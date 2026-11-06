import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConvMenuEntry,
  DesignProvider,
  filterMenuEntries,
  MENU_FILTER_THRESHOLD,
  menuPlacement,
  Picker,
  type PickerProps,
  QuickActions,
} from "../src/index";
import { SIZES } from "../src/tokens";

/**
 * The composer toolbar menus (spec §6.16.3): anchored to their trigger, below unless the room
 * below is short, the height capped by `layout.menu-max-height` and the room on that side, a
 * filter past ten items, the checked item scrolled into view.
 */
const CAP = SIZES.layout["menu-max-height"];

describe("menuPlacement", () => {
  it("opens below when the menu fits there, up to the cap", () => {
    expect(
      menuPlacement({
        triggerTop: 100,
        triggerBottom: 132,
        viewportHeight: 900,
        contentHeight: 3200,
      }),
    ).toEqual({ side: "bottom", maxHeight: CAP });
    // a short menu that fits below stays below even near the bottom
    expect(
      menuPlacement({
        triggerTop: 700,
        triggerBottom: 732,
        viewportHeight: 900,
        contentHeight: 120,
      }),
    ).toEqual({ side: "bottom", maxHeight: 900 - 732 - 4 - 8 });
  });

  it("flips above when the room below is short and above fits (the conversation page)", () => {
    expect(
      menuPlacement({
        triggerTop: 700,
        triggerBottom: 732,
        viewportHeight: 768,
        contentHeight: 3200,
      }),
    ).toEqual({ side: "top", maxHeight: CAP });
  });

  it("when neither side fits, opens on the side with more room, capped to it", () => {
    expect(
      menuPlacement({
        triggerTop: 180,
        triggerBottom: 212,
        viewportHeight: 400,
        contentHeight: 3200,
      }),
    ).toEqual({ side: "bottom", maxHeight: 400 - 212 - 12 });
    expect(
      menuPlacement({
        triggerTop: 250,
        triggerBottom: 282,
        viewportHeight: 400,
        contentHeight: 3200,
      }),
    ).toEqual({ side: "top", maxHeight: 250 - 12 });
    // never negative
    expect(
      menuPlacement({ triggerTop: 4, triggerBottom: 36, viewportHeight: 40, contentHeight: 300 })
        .maxHeight,
    ).toBe(0);
  });
});

describe("filterMenuEntries", () => {
  const entries: ConvMenuEntry[] = [
    { kind: "label", label: "Anthropic" },
    { kind: "item", id: "a1", label: "opus 5.5", onSelect: () => {} },
    { kind: "item", id: "a2", label: "sonnet 5", onSelect: () => {} },
    { kind: "separator" },
    { kind: "label", label: "OpenAI" },
    { kind: "item", id: "o1", label: "gpt-6", onSelect: () => {} },
    { kind: "note", text: "从下一条消息起生效" },
  ];
  it("keeps the matches under their group labels, and the notes", () => {
    expect(filterMenuEntries(entries, "SON").map((e) => e.kind)).toEqual(["label", "item", "note"]);
    expect(filterMenuEntries(entries, "  ")).toBe(entries);
    expect(filterMenuEntries(entries, "zzz").map((e) => e.kind)).toEqual(["note"]);
  });
});

// ── The components, with 100 entries ─────────────────────────────────────────────────────────

const wrap = (ui: ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

function models(onPick = vi.fn(), checked = "p2/model-80"): PickerProps {
  return {
    label: "切换模型",
    value: "model-80",
    groups: ["p1", "p2"].map((p, gi) => ({
      label: p === "p1" ? "Provider One" : "Provider Two",
      items: Array.from({ length: 50 }, (_, i) => {
        const n = gi * 50 + i + 1;
        return {
          id: `${p}/model-${n}`,
          label: `model-${n}`,
          checked: `${p}/model-${n}` === checked,
        };
      }),
    })),
    note: "从下一条消息起生效",
    onPick,
  };
}

let rect = { top: 100, bottom: 132 };
let innerHeight = 900;
const original = {
  rect: HTMLElement.prototype.getBoundingClientRect,
  scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"),
  scrollIntoView: (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView,
};
const scrolled = vi.fn();

beforeEach(() => {
  rect = { top: 100, bottom: 132 };
  innerHeight = 900;
  vi.stubGlobal("innerHeight", innerHeight);
  // the trigger's box, and a list whose whole height is 100 rows
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: 0,
      right: 100,
      width: 100,
      height: rect.bottom - rect.top,
      x: 0,
      y: rect.top,
      toJSON: () => ({}),
    } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("cb-cmenu-list") ? 3200 : 0;
    },
  });
  scrolled.mockReset();
  (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView = function (
    this: HTMLElement,
  ) {
    scrolled(this.textContent);
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  HTMLElement.prototype.getBoundingClientRect = original.rect;
  if (original.scrollHeight)
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", original.scrollHeight);
  (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView = original.scrollIntoView;
});

// Radix names the menu by its trigger (aria-labelledby)
const menu = () => screen.getByRole("menu", { name: "切换模型: model-80" });

describe("an anchored picker menu with 100 models", () => {
  it("opens below with its height capped, the checked model scrolled into view and the note kept", async () => {
    const user = userEvent.setup();
    wrap(<Picker {...models()} />);
    await user.click(screen.getByRole("button", { name: "切换模型: model-80" }));
    const m = menu();
    expect(m.getAttribute("data-anchored")).toBe("true");
    expect(m.getAttribute("data-placement")).toBe("bottom");
    expect(m.style.maxHeight).toBe(`${CAP}px`);
    // the checked model is brought into view on open
    expect(scrolled).toHaveBeenCalledWith(expect.stringContaining("model-80"));
    // the list scrolls; the note stays outside it, visible
    const list = m.querySelector('[data-part="menu-list"]') as HTMLElement;
    expect(within(list).getAllByRole("menuitemradio")).toHaveLength(100);
    const note = m.querySelector('[data-part="menu-note"]') as HTMLElement;
    expect(list.contains(note)).toBe(false);
    // long labels: the whole label is the tooltip
    expect(within(list).getAllByRole("menuitemradio")[0]?.getAttribute("title")).toBe("model-1");
  });

  it("flips above when the trigger sits near the bottom (the conversation page)", async () => {
    rect = { top: 700, bottom: 732 };
    vi.stubGlobal("innerHeight", 768);
    const user = userEvent.setup();
    wrap(<Picker {...models()} />);
    await user.click(screen.getByRole("button", { name: "切换模型: model-80" }));
    expect(menu().getAttribute("data-placement")).toBe("top");
    expect(menu().style.maxHeight).toBe(`${CAP}px`);
  });

  it("caps to the larger side's room when neither side fits", async () => {
    rect = { top: 180, bottom: 212 };
    vi.stubGlobal("innerHeight", 400);
    const user = userEvent.setup();
    wrap(<Picker {...models()} />);
    await user.click(screen.getByRole("button", { name: "切换模型: model-80" }));
    expect(menu().getAttribute("data-placement")).toBe("bottom");
    expect(menu().style.maxHeight).toBe(`${400 - 212 - 12}px`);
  });

  it("has a filter: focus starts there, typing narrows (group labels stay), ↓ moves into the matches, Enter picks", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    wrap(<Picker {...models(onPick)} />);
    await user.click(screen.getByRole("button", { name: "切换模型: model-80" }));
    const filter = await screen.findByRole("textbox", { name: "筛选" });
    await vi.waitFor(() => expect(document.activeElement).toBe(filter));
    await user.keyboard("model-7");
    const items = () =>
      within(menu())
        .getAllByRole("menuitemradio")
        .map((i) => i.textContent);
    // model-7 and model-70…79: one in the first group, the rest in the second
    expect(items()).toEqual([
      "model-7",
      ...Array.from({ length: 10 }, (_, i) => `model-${70 + i}`),
    ]);
    const labels = [...menu().querySelectorAll('[data-part="menu-label"]')].map(
      (l) => l.textContent,
    );
    expect(labels).toEqual(["Provider One", "Provider Two"]);
    // ↓ goes to the first match
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toContain("model-7");
    // back in the filter, a query that matches nothing says so
    await user.click(filter);
    await user.clear(filter);
    await user.keyboard("zzz");
    expect(within(menu()).queryAllByRole("menuitemradio")).toHaveLength(0);
    expect(within(menu()).getByText("没有匹配项")).toBeTruthy();
    // Enter picks the first match and closes
    await user.clear(filter);
    await user.keyboard("model-42{Enter}");
    expect(onPick).toHaveBeenCalledWith("p1/model-42");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it(`ten items or fewer: no filter (the threshold is ${MENU_FILTER_THRESHOLD})`, async () => {
    const user = userEvent.setup();
    const few = models();
    few.groups = [{ items: (few.groups[0]?.items ?? []).slice(0, MENU_FILTER_THRESHOLD) }];
    wrap(<Picker {...few} />);
    await user.click(screen.getByRole("button", { name: "切换模型: model-80" }));
    expect(within(menu()).queryByRole("textbox")).toBeNull();
    expect(within(menu()).getAllByRole("menuitemradio")).toHaveLength(MENU_FILTER_THRESHOLD);
  });
});

describe("the quick actions menu with 100 items", () => {
  it("is anchored and capped, filters, and Enter picks after the menu closed", async () => {
    const onPick = vi.fn();
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `q${i}`, title: `任务 ${i}` }));
    const user = userEvent.setup();
    wrap(<QuickActions items={items} onPick={onPick} />);
    await user.click(screen.getByRole("button", { name: "常用任务" }));
    const m = screen.getByRole("menu", { name: "常用任务" });
    expect(m.getAttribute("data-anchored")).toBe("true");
    expect(m.style.maxHeight).toBe(`${CAP}px`);
    const filter = await screen.findByRole("textbox", { name: "筛选" });
    await vi.waitFor(() => expect(document.activeElement).toBe(filter));
    await user.keyboard("任务 9");
    expect(within(m).getAllByRole("menuitem")).toHaveLength(11);
    await act(async () => {
      await user.keyboard("{Enter}");
    });
    await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith("q9"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
