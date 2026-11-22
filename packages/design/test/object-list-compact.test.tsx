import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectList, ObjectRow, type ObjectRowProps } from "../src/index";
import { css, parseCss } from "./css-rules";
import { renderAtClass } from "./width";

// ObjectList on compact (design spec §6.17 "Grouped list", responsive system spec §2.3, §2.4):
// a row with a link draws no buttons, a row without one keeps its one action button, and the
// row's action and menu open as one ActionSheet on long press or context menu.

const real = window.matchMedia;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = real;
});

const row = (over: Partial<ObjectRowProps> = {}): ObjectRowProps => ({
  mark: { text: "研" },
  name: "研究助手",
  href: "/agents/a",
  description: "查资料、读文件",
  action: { label: "对话", onSelect: () => {} },
  menu: [
    { label: "编辑", onSelect: () => {} },
    { label: "删除", danger: true, onSelect: () => {} },
  ],
  ...over,
});

/** A row without the named props (exactOptionalPropertyTypes: left out, never `undefined`). */
function without(r: ObjectRowProps, ...keys: (keyof ObjectRowProps)[]): ObjectRowProps {
  const out = { ...r };
  for (const k of keys) delete out[k];
  return out;
}

const list = (rows: ObjectRowProps[]) => (
  <ObjectList label="智能体">
    {rows.map((r) => (
      <ObjectRow key={r.name} {...r} />
    ))}
  </ObjectList>
);

const sheet = () => document.querySelector<HTMLElement>('[data-part="action-sheet"]');
const sheetItems = () =>
  [...document.querySelectorAll<HTMLElement>('[data-part="action-sheet-item"]')].map((e) =>
    e.textContent?.trim(),
  );
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
const touch = (type: string, el: Element) =>
  fireEvent(
    el,
    Object.assign(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      {
        pointerType: "touch",
      },
    ),
  );

describe("ObjectRow at 390", () => {
  it("row with href has no buttons at 390", () => {
    renderAtClass(390, list([row()]));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("link", { name: "研究助手" }).getAttribute("href")).toBe("/agents/a");
    const chevron = screen.getByRole("listitem").querySelector('[data-part="object-row-chevron"]');
    expect(chevron?.getAttribute("aria-hidden")).toBe("true");
  });

  it("row without href keeps its action at 390 and a ⋯ naming the row", () => {
    renderAtClass(390, list([without(row(), "href")]));
    const item = screen.getByRole("listitem");
    expect(
      within(item)
        .getAllByRole("button")
        .map((b) => b.textContent || b.getAttribute("aria-label")),
    ).toEqual(["对话", "行操作：研究助手"]);
    expect(item.querySelector('[data-part="object-row-chevron"]')).toBeNull();
    expect(prevented(item, "contextmenu")).toBe(true);
    expect(within(sheet() as HTMLElement).getByRole("heading").textContent).toBe("研究助手");
    expect(sheetItems()).toEqual(["编辑", "删除"]);
  });

  it("contextmenu opens action then menu items", () => {
    renderAtClass(390, list([row()]));
    expect(prevented(screen.getByRole("link", { name: "研究助手" }), "contextmenu")).toBe(true);
    expect(within(sheet() as HTMLElement).getByRole("heading").textContent).toBe("研究助手");
    expect(sheetItems()).toEqual(["对话", "编辑", "删除"]);
  });

  it("long press opens the same sheet and its release does not navigate", () => {
    vi.useFakeTimers();
    renderAtClass(390, list([row(), row({ name: "周报助手", href: "/agents/b" })]));
    const link = screen.getByRole("link", { name: "周报助手" });
    touch("pointerdown", link);
    act(() => vi.advanceTimersByTime(499));
    expect(sheet()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(within(sheet() as HTMLElement).getByRole("heading").textContent).toBe("周报助手");
    touch("pointerup", link);
    expect(prevented(link, "click")).toBe(true);
  });

  it("the list draws one sheet for all its rows", () => {
    renderAtClass(390, list([row(), row({ name: "周报助手", href: "/agents/b" })]));
    prevented(screen.getByRole("link", { name: "研究助手" }), "contextmenu");
    expect(document.querySelectorAll('[data-part="action-sheet"]')).toHaveLength(1);
  });

  it("a row with a lone menu item and no action keeps it as the button and opens no sheet", () => {
    renderAtClass(
      390,
      list([without(row({ menu: [{ label: "查看", href: "/v" }] }), "href", "action")]),
    );
    const item = screen.getByRole("listitem");
    expect(within(item).getByRole("link", { name: "查看" })).toBeTruthy();
    expect(prevented(item, "contextmenu")).toBe(false);
    expect(sheet()).toBeNull();
  });

  it("a row that opens nothing and has no button keeps one ⋯ naming the row, opening the sheet", () => {
    renderAtClass(390, list([without(row(), "href", "action")]));
    const more = screen.getByRole("button", { name: "行操作：研究助手" });
    act(() => {
      fireEvent.click(more);
    });
    expect(sheetItems()).toEqual(["编辑", "删除"]);
  });

  it("the ⋯ opens the sheet; while a menu action runs it is disabled with the spinner", () => {
    renderAtClass(390, list([without(row({ busy: true }), "href", "action")]));
    const more = screen.getByRole("button", { name: "行操作：研究助手" }) as HTMLButtonElement;
    expect(more.disabled).toBe(true);
    expect(more.getAttribute("aria-busy")).toBe("true");
  });

  it("rows that open or have a sheet are pressable; the others stay selectable", () => {
    renderAtClass(
      390,
      list([
        row(),
        without(row({ name: "只读", menu: [] }), "href", "action"),
        without(row({ name: "有菜单" }), "href", "action"),
      ]),
    );
    const [linked, plain, menued] = screen.getAllByRole("listitem");
    expect(linked?.getAttribute("data-press")).toBe("true");
    expect(plain?.getAttribute("data-press")).toBeNull();
    expect(menued?.getAttribute("data-press")).toBe("true");
  });

  it("while the action runs, every sheet item waits", () => {
    renderAtClass(
      390,
      list([row({ action: { label: "对话", onSelect: () => {}, loading: true } })]),
    );
    prevented(screen.getByRole("link", { name: "研究助手" }), "contextmenu");
    const rows = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-part="action-sheet-item"]'),
    ];
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.disabled).toBe(true);
  });
});

describe("ObjectRow at 1440", () => {
  it("keeps the buttons and opens no sheet", () => {
    renderAtClass(1440, list([row()]));
    const item = screen.getByRole("listitem");
    expect(within(item).getByRole("button", { name: "对话" })).toBeTruthy();
    expect(within(item).getByRole("button", { name: "更多操作" })).toBeTruthy();
    expect(prevented(item, "contextmenu")).toBe(false);
    expect(sheet()).toBeNull();
  });
});

describe("ObjectRow compact styles", () => {
  const rules = parseCss(css("templates.css")).filter(
    (r) => r.at === "not all and (min-width: 600px)",
  );
  const decl = (selector: string) => rules.find((r) => r.selector === selector)?.decls ?? {};

  it("is one rounded card of grouped rows built from the shared values", () => {
    expect(decl("ul.cb-object-list")).toMatchObject({
      border: "var(--cb-grouped-line)",
      "border-radius": "var(--cb-radius-md)",
    });
    const frame = decl("ul.cb-object-list > .cb-object-row");
    expect(frame["min-height"]).toBe("var(--cb-grouped-row-lead)");
    expect(frame.padding).toBe("var(--cb-grouped-pad)");
    const loaded = decl('.cb-object-list > .cb-object-row:not([data-skeleton="true"])');
    expect(loaded["min-height"]).toBe("var(--cb-grouped-row-lead)");
    expect(decl('.cb-object-row[data-press="true"]')["-webkit-touch-callout"]).toBe("none");
    expect(decl('.cb-object-row[data-press="true"]')["user-select"]).toBe("none");
  });

  it("a name and one more line fit the lead: half of it each, so the row is exactly 64", () => {
    const half = "calc(var(--cb-grouped-lead) / 2)";
    const lines = rules.find((r) =>
      r.selector.includes('.cb-object-row:not([data-skeleton="true"]) .cb-object-desc'),
    );
    expect(lines?.selector).toContain(".cb-object-line");
    expect(lines?.selector).toContain(".cb-object-meta");
    expect(lines?.decls["line-height"]).toBe(half);
    expect(decl('.cb-object-row:not([data-skeleton="true"]) .cb-object-text').gap).toBe("0");
  });
});
