// Native menus (mobile app spec §6.3): on a phone inside a shell with `menu@1`, a plain menu (only
// plain actions) opens as the platform's own action sheet, anchored to its trigger; anything else,
// a wider window or a native failure opens the design's own menu.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConvMenu,
  type ConvMenuEntry,
  DesignProvider,
  isPlainMenu,
  Menu,
  type MenuItem,
  type NativeHandlers,
} from "../src/index";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const RECT = { x: 10, y: 20, width: 32, height: 32 };
const withRect = (el: HTMLElement) => {
  el.getBoundingClientRect = () =>
    ({ ...RECT, top: 20, left: 10, right: 42, bottom: 52, toJSON: () => ({}) }) as DOMRect;
  return el;
};

function renderMenu(items: MenuItem[], native: NativeHandlers) {
  render(
    <DesignProvider locale="zh" native={native}>
      <Menu trigger={<button type="button">更多</button>} items={items} label="会话操作" />
    </DesignProvider>,
  );
  return withRect(screen.getByRole("button", { name: "更多" }));
}

/** A promise a test settles itself, and the resolution's flush. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("isPlainMenu", () => {
  it("is true only when every item is a plain action", () => {
    const a = { label: "重命名", onSelect: () => {} };
    expect(isPlainMenu([a, "separator", { ...a, label: "删除", danger: true }])).toBe(true);
    expect(isPlainMenu([a, { ...a, label: "Acme", checked: true }])).toBe(false);
    expect(isPlainMenu([a, { label: "语言", submenu: [a] }])).toBe(false);
    expect(isPlainMenu([a, { label: "设置", href: "/settings" }])).toBe(false);
    expect(isPlainMenu([])).toBe(false);
  });
});

describe("Menu with native.menu", () => {
  const rename = vi.fn();
  const remove = vi.fn();
  const items: MenuItem[] = [
    { label: "删除", danger: true, onSelect: remove },
    { label: "重命名", onSelect: rename },
    { label: "归档", disabled: true, onSelect: () => {} },
  ];

  it("at compact opens the native menu with the items and the trigger's rect; a pick runs it", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    rename.mockClear();
    const d = deferred<string | null>();
    const menu = vi.fn<NonNullable<NativeHandlers["menu"]>>(() => d.promise);
    const trigger = renderMenu(items, { menu });
    await userEvent.setup().click(trigger);
    expect(menu).toHaveBeenCalledTimes(1);
    const input = menu.mock.calls[0]?.[0];
    expect(input?.anchor).toEqual(RECT);
    expect(input?.title).toBe("会话操作");
    // the design's order: danger last
    expect(input?.items.map((i) => [i.label, i.destructive ?? false, i.disabled ?? false])).toEqual(
      [
        ["重命名", false, false],
        ["归档", false, true],
        ["删除", true, false],
      ],
    );
    for (const i of input?.items ?? []) expect(i.id).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    expect(screen.queryByRole("menu")).toBeNull();
    const id = input?.items.find((i) => i.label === "重命名")?.id ?? "";
    await act(async () => d.resolve(id));
    expect(rename).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("one Space press opens one sheet, even when it is dismissed at once", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const menu = vi.fn(async () => null);
    const trigger = renderMenu(items, { menu });
    trigger.focus();
    const user = userEvent.setup();
    await user.keyboard(" ");
    await act(async () => {});
    expect(menu).toHaveBeenCalledTimes(1);
    // a later press opens it again
    await user.keyboard(" ");
    await act(async () => {});
    expect(menu).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["blur", (el: HTMLElement) => fireEvent.blur(el)],
    ["pointerdown", (el: HTMLElement) => fireEvent.pointerDown(el)],
  ])(
    "a Space press whose keyup was lost is forgotten on %s: the next tap opens the sheet",
    async (_name, forget) => {
      window.matchMedia = matchMediaFor(390).matchMedia;
      const menu = vi.fn(async () => null);
      const trigger = renderMenu(items, { menu });
      trigger.focus();
      fireEvent.keyDown(trigger, { key: " " });
      await act(async () => {});
      expect(menu).toHaveBeenCalledTimes(1);
      // the keyup never comes (focus moved, the app went to the background)
      forget(trigger);
      fireEvent.click(trigger);
      await act(async () => {});
      expect(menu).toHaveBeenCalledTimes(2);
    },
  );

  it("a dismissal (null) runs nothing", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    rename.mockClear();
    remove.mockClear();
    const menu = vi.fn(async () => null);
    const trigger = renderMenu(items, { menu });
    await userEvent.setup().click(trigger);
    await act(async () => {});
    expect(menu).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a rejection opens the design's own menu", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const menu = vi.fn(async () => {
      throw new Error("busy");
    });
    const trigger = renderMenu(items, { menu });
    await userEvent.setup().click(trigger);
    expect(await screen.findByRole("menu")).toBeTruthy();
    expect(menu).toHaveBeenCalledTimes(1);
  });

  it("a menu with a checked item, or a wider window, opens the design's own menu", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const menu = vi.fn(async () => null);
    const trigger = renderMenu([...items, { label: "Acme", checked: true, onSelect: () => {} }], {
      menu,
    });
    await userEvent.setup().click(trigger);
    expect(await screen.findByRole("menu")).toBeTruthy();
    expect(menu).not.toHaveBeenCalled();
    cleanup();
    window.matchMedia = matchMediaFor(1200).matchMedia;
    const wide = renderMenu(items, { menu });
    await userEvent.setup().click(wide);
    expect(await screen.findByRole("menu")).toBeTruthy();
    expect(menu).not.toHaveBeenCalled();
  });
});

describe("ConvMenu with native.menu", () => {
  const entries = (onRename: () => void): ConvMenuEntry[] => [
    { kind: "item", id: "rename", label: "重命名", onSelect: onRename },
    { kind: "separator" },
    { kind: "item", id: "delete", label: "删除", tone: "fail", onSelect: () => {} },
  ];
  const renderConv = (list: ConvMenuEntry[], native: NativeHandlers) => {
    render(
      <DesignProvider locale="zh" native={native}>
        <ConvMenu trigger={<button type="button">更多操作</button>} entries={list} />
      </DesignProvider>,
    );
    return withRect(screen.getByRole("button", { name: "更多操作" }));
  };

  it("a resolved id runs that item; tone fail is destructive", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const onRename = vi.fn();
    const menu = vi.fn(async () => "rename");
    const trigger = renderConv(entries(onRename), { menu });
    await userEvent.setup().click(trigger);
    await act(async () => {});
    expect(menu).toHaveBeenCalledWith({
      items: [
        { id: "rename", label: "重命名" },
        { id: "delete", label: "删除", destructive: true },
      ],
      anchor: RECT,
    });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a radio item opens the design's own menu", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const menu = vi.fn(async () => null);
    const list: ConvMenuEntry[] = [
      { kind: "item", id: "a", label: "A", checked: true, onSelect: () => {} },
      { kind: "item", id: "b", label: "B", checked: false, onSelect: () => {} },
    ];
    const trigger = renderConv(list, { menu });
    await userEvent.setup().click(trigger);
    expect(await screen.findByRole("menu")).toBeTruthy();
    expect(menu).not.toHaveBeenCalled();
  });
});
