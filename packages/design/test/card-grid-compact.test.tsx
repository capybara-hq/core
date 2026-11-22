import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardGrid, ObjectCard, type ObjectCardProps } from "../src/index";
import { css, parseCss } from "./css-rules";
import { renderAtClass } from "./width";

// CardGrid on compact (design spec §6.34 "Phones", responsive system spec §0 item 4, §2.3, §2.4):
// one rounded card of grouped rows, no buttons in a row, the card's primary and menu in an
// ActionSheet on long press or context menu.

const real = window.matchMedia;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = real;
});

const card = (
  over: Partial<Extract<ObjectCardProps, { title: string }>> = {},
): ObjectCardProps => ({
  avatar: { kind: "preset", id: "capybara" },
  title: "研究助手",
  href: "/agents/a",
  description: "帮你检索资料、整理笔记，并按需生成摘要。",
  meta: ["grant", "仅自己"],
  primary: { label: "开始会话", onSelect: () => {} },
  menu: [
    { label: "设置", href: "/agents/a/settings" },
    { label: "运行记录", href: "/agents/a/runs" },
  ],
  ...over,
});

type Loaded = Extract<ObjectCardProps, { title: string }>;

/** A card without the named props (exactOptionalPropertyTypes: left out, never `undefined`). */
function without(c: ObjectCardProps, ...keys: (keyof Loaded)[]): ObjectCardProps {
  const out = { ...(c as Loaded) };
  for (const k of keys) delete out[k];
  return out;
}

function grid(cards: ObjectCardProps[]) {
  return (
    <CardGrid label="智能体">
      {cards.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed test cards
        <ObjectCard key={i} {...c} />
      ))}
    </CardGrid>
  );
}

const NAMES = ["研究助手", "周报助手", "客服助手"];
const three = () => grid(NAMES.map((n, i) => card({ title: n, href: `/a/${i}` })));

const row = (name: string) =>
  screen.getByRole("link", { name }).closest('[data-part="object-card"]') as HTMLElement;
const sheet = () => document.querySelector<HTMLElement>('[data-part="action-sheet"]');
const sheetItems = () =>
  [...document.querySelectorAll<HTMLElement>('[data-part="action-sheet-item"]')].map((e) =>
    e.textContent?.trim(),
  );

/** A touch pointer event (jsdom has no PointerEvent: a MouseEvent carrying pointerType). */
const touch = (type: string, el: Element, x = 10, y = 10) =>
  fireEvent(
    el,
    Object.assign(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
      {
        pointerType: "touch",
      },
    ),
  );

/** Dispatches a cancelable event and reports whether something prevented its default. */
const prevented = (el: Element, type: "click" | "contextmenu") => {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: type === "click" ? 0 : 2,
  });
  act(() => {
    el.dispatchEvent(e);
  });
  return e.defaultPrevented;
};

describe("CardGrid at 390", () => {
  it("at 390 cards have no buttons", () => {
    const { container } = renderAtClass(390, three());
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(container.querySelector('[data-class-form="wide"]')).toBeNull();
    // the row's one link keeps the name as its accessible name
    expect(screen.getByRole("link", { name: "研究助手" }).getAttribute("href")).toBe("/a/0");
  });

  it("at 390 the chevron is drawn for a card with href", () => {
    renderAtClass(390, grid([card(), without(card({ title: "只读助手" }), "href")]));
    const chevron = row("研究助手").querySelector('[data-part="object-card-chevron"]');
    expect(chevron).not.toBeNull();
    expect(chevron?.getAttribute("aria-hidden")).toBe("true");
    const items = screen.getAllByRole("listitem");
    expect(items[1]?.querySelector('[data-part="object-card-chevron"]')).toBeNull();
  });

  it("a card without href keeps its one button and opens no sheet", () => {
    renderAtClass(390, grid([without(card(), "href", "menu")]));
    const item = screen.getByRole("listitem");
    expect(within(item).getByRole("button", { name: "开始会话" })).toBeTruthy();
    expect(prevented(item, "contextmenu")).toBe(false);
    expect(sheet()).toBeNull();
  });

  it("a card without href keeps only its primary; its menu items go to the sheet", () => {
    renderAtClass(390, grid([without(card(), "href")]));
    const item = screen.getByRole("listitem");
    expect(
      within(item)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["开始会话"]);
    expect(prevented(item, "contextmenu")).toBe(true);
    expect(within(sheet() as HTMLElement).getByRole("heading").textContent).toBe("研究助手");
    expect(sheetItems()).toEqual(["设置", "运行记录"]);
  });

  it("a card without href or primary keeps its lone item as the button and opens no sheet", () => {
    renderAtClass(
      390,
      grid([
        without(card({ menu: [{ label: "查看", href: "/agents/a/view" }] }), "href", "primary"),
      ]),
    );
    const item = screen.getByRole("listitem");
    expect(within(item).getByRole("link", { name: "查看" })).toBeTruthy();
    expect(prevented(item, "contextmenu")).toBe(false);
    expect(sheet()).toBeNull();
  });

  it("while the primary runs, every sheet item waits", () => {
    // Button rows: ActionSheet draws a link row without its disabled state (an overlays matter).
    renderAtClass(
      390,
      grid([
        card({
          primary: { label: "开始会话", onSelect: () => {}, loading: true },
          menu: [
            { label: "复制", onSelect: () => {} },
            { label: "删除", danger: true, onSelect: () => {} },
          ],
        }),
      ]),
    );
    expect(prevented(screen.getByRole("link", { name: "研究助手" }), "contextmenu")).toBe(true);
    const rows = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-part="action-sheet-item"]'),
    ];
    expect(rows.map((r) => r.textContent?.trim())).toEqual(["开始会话", "复制", "删除"]);
    for (const r of rows) expect(r.disabled).toBe(true);
  });

  it("contextmenu opens the sheet with 开始会话 then the menu items", () => {
    renderAtClass(390, three());
    const link = screen.getByRole("link", { name: "研究助手" });
    expect(prevented(link, "contextmenu")).toBe(true);
    const s = sheet() as HTMLElement;
    expect(s).not.toBeNull();
    expect(within(s).getByRole("heading").textContent).toBe("研究助手");
    expect(sheetItems()).toEqual(["开始会话", "设置", "运行记录"]);
  });

  it("long press opens the same sheet, and its release does not navigate", () => {
    vi.useFakeTimers();
    renderAtClass(390, three());
    const link = screen.getByRole("link", { name: "周报助手" });
    touch("pointerdown", link);
    act(() => vi.advanceTimersByTime(499));
    expect(sheet()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(within(sheet() as HTMLElement).getByRole("heading").textContent).toBe("周报助手");
    expect(sheetItems()).toEqual(["开始会话", "设置", "运行记录"]);
    touch("pointerup", link);
    expect(prevented(link, "click")).toBe(true);
  });

  it("a scroll gesture does not open the sheet", () => {
    vi.useFakeTimers();
    renderAtClass(390, three());
    const link = screen.getByRole("link", { name: "研究助手" });
    touch("pointerdown", link, 10, 10);
    touch("pointermove", link, 10, 30);
    act(() => vi.advanceTimersByTime(600));
    touch("pointerup", link);
    expect(sheet()).toBeNull();
  });

  it("a fast tap right after hydration opens the item", () => {
    vi.useFakeTimers();
    renderAtClass(390, three());
    const link = screen.getByRole("link", { name: "研究助手" });
    touch("pointerdown", link);
    touch("pointerup", link);
    expect(prevented(link, "click")).toBe(false);
    expect(sheet()).toBeNull();
  });

  it("a card without primary or menu opens no sheet", () => {
    renderAtClass(390, grid([without(card(), "primary", "menu")]));
    const link = screen.getByRole("link", { name: "研究助手" });
    expect(prevented(link, "contextmenu")).toBe(false);
    expect(sheet()).toBeNull();
  });

  it("loading keeps the skeleton cards as items of the grid's one list (the row look is CSS)", () => {
    renderAtClass(390, <CardGrid label="智能体" loading={3} />);
    const list = screen.getByRole("list", { name: "智能体" });
    expect(list.className).toBe("cb-card-grid");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    for (const item of items) expect(item.getAttribute("data-skeleton")).toBe("true");
  });
});

describe("CardGrid at 1440", () => {
  it("at 1440 the card keeps its buttons and no contextmenu handling", () => {
    renderAtClass(1440, grid([card()]));
    const item = screen.getByRole("listitem");
    expect(within(item).getByRole("button", { name: "开始会话" })).toBeTruthy();
    expect(within(item).getByRole("button", { name: "更多操作" })).toBeTruthy();
    expect(item.querySelector('[data-part="object-card-chevron"]')).not.toBeNull();
    expect(prevented(screen.getByRole("link", { name: "研究助手" }), "contextmenu")).toBe(false);
    expect(sheet()).toBeNull();
  });

  it("roving focus still works at 1440", () => {
    renderAtClass(1440, three());
    const first = screen.getByRole("link", { name: "研究助手" });
    const second = screen.getByRole("link", { name: "周报助手" });
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "客服助手" }));
  });
});

describe("compact CSS (below 600)", () => {
  const rules = parseCss(css("card-grid.css"));
  const at = (selector: string, query: string | null = "not all and (min-width: 600px)") =>
    Object.assign(
      {},
      ...rules
        .filter((r) => r.at === query && r.selector.split(", ").includes(selector))
        .map((r) => r.decls),
    );

  it("the grid is one rounded card (panel, line-soft, radius.md) with no gap", () => {
    const g = at(".cb-card-grid");
    expect(g["grid-template-columns"]).toBe("1fr");
    expect(g.gap).toBe("0");
    expect(g.border).toBe("1px solid var(--cb-line-soft)");
    expect(g["border-radius"]).toBe("var(--cb-radius-md)");
    expect(g.background).toBe("var(--cb-panel)");
    expect(g.overflow).toBe("hidden");
  });

  it("a row is at least 64 (the 40 avatar and space.3 twice), padded space.3 space.4, no box", () => {
    const r = at(".cb-object-card");
    expect(r["min-height"]).toBe("calc(40px + 2 * var(--cb-space-3))");
    expect(r.padding).toBe("var(--cb-space-3) var(--cb-space-4)");
    expect(r.border).toBe("0");
    expect(r["border-radius"]).toBe("0");
    expect(r["-webkit-touch-callout"]).toBe("none");
  });

  it("the name is 500 and the description one muted line, the meta only without a description", () => {
    expect(at(".cb-object-card .cb-object-card-link")["font-weight"]).toBe("500");
    expect(at(".cb-object-card-desc")["-webkit-line-clamp"]).toBe("1");
    expect(at(".cb-object-card-desc ~ .cb-object-card-foot .cb-object-card-meta").display).toBe(
      "none",
    );
  });

  it("a name with nothing under it spans both lines, centred against the avatar", () => {
    const rule = rules.find(
      (r) => r.at === "not all and (min-width: 600px)" && r.selector.includes(":not(:has("),
    );
    expect(rule?.selector).toContain(".cb-object-card-desc, .cb-object-card-meta:not(:empty)");
    expect(rule?.selector).toContain(".cb-object-card-link");
    expect(rule?.decls["grid-row"]).toBe("1 / span 2");
  });

  it("the compact block uses ClassForms' query, never max-width 599", () => {
    expect(rules.some((r) => r.at === "(max-width: 599px)")).toBe(false);
  });

  it("the chevron shows only below 600; the skeleton draws no button box", () => {
    expect(at(".cb-object-card-chevron", null).display).toBe("none");
    expect(at(".cb-object-card-chevron").display).toBe("block");
    expect(at(".cb-object-card-foot > .cb-skeleton-box").display).toBe("none");
  });
});
