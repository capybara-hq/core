import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
const proto = HTMLElement.prototype;
const PROPS = ["scrollHeight", "offsetTop", "offsetHeight", "clientHeight", "scrollTop"] as const;
const original = {
  rect: proto.getBoundingClientRect,
  props: Object.fromEntries(
    PROPS.map((k) => [
      k,
      Object.getOwnPropertyDescriptor(Element.prototype, k) ??
        Object.getOwnPropertyDescriptor(proto, k),
    ]),
  ),
};
/** What the menu set as the list's scrollTop. */
const scrolledTo = vi.fn();

/** A viewport `height` px high: jsdom has none, floating-ui (Radix) reads it from <html>. */
function viewport(height: number) {
  vi.stubGlobal("innerHeight", height);
  Object.defineProperty(document.documentElement, "clientHeight", {
    configurable: true,
    value: height,
  });
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    value: 1024,
  });
}

beforeEach(() => {
  rect = { top: 100, bottom: 132 };
  viewport(900);
  // the trigger's box; a list 100 rows (3200 px) long showing 300 px; the checked row at 2560
  proto.getBoundingClientRect = function (this: HTMLElement) {
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
  const isList = (el: HTMLElement) => el.classList.contains("cb-cmenu-list");
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isList(this) ? 3200 : 0;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isList(this) ? 300 : 0;
    },
  });
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("data-part") === "menu-item" ? 32 : 0;
    },
  });
  Object.defineProperty(proto, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("aria-checked") === "true" ? 2560 : 0;
    },
  });
  scrolledTo.mockReset();
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get: () => 0,
    set(this: HTMLElement, v: number) {
      if (isList(this)) scrolledTo(v);
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  proto.getBoundingClientRect = original.rect;
  for (const k of PROPS) {
    const d = original.props[k];
    if (d) Object.defineProperty(proto, k, d);
    else delete (proto as unknown as Record<string, unknown>)[k];
  }
  delete (document.documentElement as unknown as Record<string, unknown>).clientHeight;
  delete (document.documentElement as unknown as Record<string, unknown>).clientWidth;
});

// Radix names the menu by its trigger (aria-labelledby)
const menu = () => screen.getByRole("menu", { name: "切换模型: model-80" });
/** The room Radix measured on the menu's side (what the CSS cap reads, live). */
const room = (m: HTMLElement) =>
  (m.parentElement as HTMLElement).style.getPropertyValue("--radix-popper-available-height");

describe("an anchored picker menu with 100 models", () => {
  it("opens below, its height capped in CSS by the token and Radix's live room, the checked model scrolled into view, the note kept", async () => {
    const user = userEvent.setup();
    wrap(<Picker {...models()} />);
    await user.click(screen.getByRole("button", { name: "切换模型: model-80" }));
    const m = menu();
    expect(m.getAttribute("data-anchored")).toBe("true");
    await vi.waitFor(() => expect(m.getAttribute("data-side")).toBe("bottom"));
    // no fixed height of its own: CSS takes min(token, Radix's room), so it follows a resize
    expect(m.style.maxHeight).toBe("");
    expect(m.style.getPropertyValue("--radix-dropdown-menu-content-available-height")).toBe(
      "var(--radix-popper-available-height)",
    );
    await vi.waitFor(() => expect(room(m)).toBe(`${900 - 132 - 4 - 8}px`));
    // the checked model (at 2560, 32 high) is brought to the list's view (300 high)
    expect(scrolledTo).toHaveBeenCalledWith(2560 + 32 - 300);
    // the list scrolls; the note stays outside it, visible
    const list = m.querySelector('[data-part="menu-list"]') as HTMLElement;
    expect(within(list).getAllByRole("menuitemradio")).toHaveLength(100);
    const note = m.querySelector('[data-part="menu-note"]') as HTMLElement;
    expect(list.contains(note)).toBe(false);
    // long labels: the whole label is the tooltip
    expect(within(list).getAllByRole("menuitemradio")[0]?.getAttribute("title")).toBe("model-1");
  });

  it("the CSS cap is min(layout.menu-max-height, Radix's available height)", () => {
    const css = readFileSync(
      resolve(import.meta.dirname, "../src/styles/conversation-page.css"),
      "utf8",
    );
    const at = css.indexOf('.cb-cmenu[data-anchored="true"] {');
    const rule = css.slice(at, css.indexOf("}", at)).replace(/\s+/g, " ");
    expect(rule).toContain(
      "max-height: min( var(--cb-layout-menu-max-height), var(--radix-dropdown-menu-content-available-height, var(--cb-layout-menu-max-height)) );",
    );
  });

  it("flips above when the trigger sits near the bottom (the conversation page)", async () => {
    rect = { top: 700, bottom: 732 };
    viewport(768);
    const user = userEvent.setup();
    wrap(<Picker {...models()} />);
    await user.click(screen.getByRole("button", { name: "切换模型: model-80" }));
    await vi.waitFor(() => expect(menu().getAttribute("data-side")).toBe("top"));
    await vi.waitFor(() => expect(room(menu())).toBe(`${700 - 4 - 8}px`));
  });

  it("when neither side fits, the side with more room, capped to it", async () => {
    rect = { top: 180, bottom: 212 };
    viewport(400);
    const user = userEvent.setup();
    wrap(<Picker {...models()} />);
    await user.click(screen.getByRole("button", { name: "切换模型: model-80" }));
    await vi.waitFor(() => expect(menu().getAttribute("data-side")).toBe("bottom"));
    await vi.waitFor(() => expect(room(menu())).toBe(`${400 - 212 - 4 - 8}px`));
  });

  it("has a filter: focus starts there, typing narrows (group labels stay), ↓ moves into the matches, Enter picks", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    wrap(<Picker {...models(onPick)} />);
    await user.click(screen.getByRole("button", { name: "切换模型: model-80" }));
    const filter = await screen.findByRole("textbox", { name: "筛选" });
    await vi.waitFor(() => expect(document.activeElement).toBe(filter));
    // the field drives the list and is described by the live count
    const list = menu().querySelector('[data-part="menu-list"]') as HTMLElement;
    expect(filter.getAttribute("aria-controls")).toBe(list.id);
    const count = document.getElementById(filter.getAttribute("aria-describedby") ?? "");
    expect(count?.getAttribute("role")).toBe("status");
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
    expect(count?.textContent).toBe("11 项匹配");
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
    expect(within(menu()).getAllByText("没有匹配项").length).toBeGreaterThan(0);
    expect(count?.textContent).toBe("没有匹配项");
    // Enter picks the first match and closes
    await user.clear(filter);
    await user.keyboard("model-42{Enter}");
    expect(onPick).toHaveBeenCalledWith("p1/model-42");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("after the pointer moved the focus onto an item, typing and Backspace land in the filter again", async () => {
    const user = userEvent.setup();
    wrap(<Picker {...models()} />);
    await user.click(screen.getByRole("button", { name: "切换模型: model-80" }));
    const filter = (await screen.findByRole("textbox", { name: "筛选" })) as HTMLInputElement;
    await vi.waitFor(() => expect(document.activeElement).toBe(filter));
    await user.keyboard("model-1");
    // the pointer grazes the list: Radix focuses the item under it
    const item = within(menu()).getAllByRole("menuitemradio")[2] as HTMLElement;
    await user.hover(item);
    item.focus();
    expect(document.activeElement).toBe(item);
    await user.keyboard("5");
    expect(document.activeElement).toBe(filter);
    expect(filter.value).toBe("model-15");
    // Backspace from the menu itself (the pointer left it) goes back to the filter too
    menu().focus();
    await user.keyboard("{Backspace}");
    expect(document.activeElement).toBe(filter);
    expect(filter.value).toBe("model-1");
  });

  it("Space on a focused item picks it; Space in the filter is text", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    wrap(<Picker {...models(onPick)} />);
    await user.click(screen.getByRole("button", { name: "切换模型: model-80" }));
    const filter = (await screen.findByRole("textbox", { name: "筛选" })) as HTMLInputElement;
    await vi.waitFor(() => expect(document.activeElement).toBe(filter));
    await user.keyboard("model-1 ");
    expect(filter.value).toBe("model-1 ");
    await user.keyboard("{Backspace}{ArrowDown}");
    expect(document.activeElement?.textContent).toContain("model-1");
    await user.keyboard(" ");
    expect(onPick).toHaveBeenCalledWith("p1/model-1");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("↑ on the first item returns to the filter", async () => {
    const user = userEvent.setup();
    wrap(<Picker {...models()} />);
    await user.click(screen.getByRole("button", { name: "切换模型: model-80" }));
    const filter = await screen.findByRole("textbox", { name: "筛选" });
    await vi.waitFor(() => expect(document.activeElement).toBe(filter));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toContain("model-1");
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(filter);
  });

  it("an IME composition's Enter neither picks nor closes", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    wrap(<Picker {...models(onPick)} />);
    await user.click(screen.getByRole("button", { name: "切换模型: model-80" }));
    const filter = await screen.findByRole("textbox", { name: "筛选" });
    await vi.waitFor(() => expect(document.activeElement).toBe(filter));
    fireEvent.keyDown(filter, { key: "Enter", isComposing: true });
    fireEvent.keyDown(filter, { key: "ArrowDown", isComposing: true });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeNull();
    expect(document.activeElement).toBe(filter);
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("p1/model-1");
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
    await vi.waitFor(() => expect(room(m)).toBe(`${900 - 132 - 4 - 8}px`));
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
