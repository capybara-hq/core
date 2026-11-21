import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOP_BAR_FIXTURE } from "../src/fixtures/index";
import { backTarget, DesignProvider, TopBar, withViewTransition } from "../src/index";
import { css, parseCss } from "./css-rules";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

/**
 * A fake Navigation API (jsdom has none): the current entry's index, moved by push / replace /
 * traverse like the browser's, firing `currententrychange`.
 */
function _fakeNavigation(start = 0) {
  const listeners = new Set<() => void>();
  const nav = {
    currentEntry: { index: start },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  Object.defineProperty(window, "navigation", { value: nav, configurable: true });
  const move = (index: number, url: string) => {
    window.history.replaceState(null, "", url);
    nav.currentEntry = { index };
    for (const fn of listeners) fn();
  };
  return {
    push: (url: string) => move(nav.currentEntry.index + 1, url),
    replace: (url: string) => move(nav.currentEntry.index, url),
    traverse: (delta: number, url: string) => {
      move(nav.currentEntry.index + delta, url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
  };
}
afterEach(() => {
  Reflect.deleteProperty(window, "navigation");
});

describe("backTarget", () => {
  it("back without history goes up the path: the last linked segment", () => {
    expect(backTarget([{ href: "/agents" }, {}], false)).toBe("/agents");
    expect(
      backTarget([{ href: "/" }, { href: "/agents" }, { label: "x" } as { href?: string }], false),
    ).toBe("/agents");
  });

  it("back with an in-app history entry is the history", () => {
    expect(backTarget([{ href: "/agents" }, {}], true)).toBe("history");
  });

  it("the last segment is the page itself, even when it carries a link", () => {
    expect(backTarget([{ href: "/admin" }], false)).toBe("/");
    expect(backTarget([{ href: "/" }, { href: "/admin" }], false)).toBe("/");
  });

  it("a path with no link goes home", () => {
    expect(backTarget([{}], false)).toBe("/");
    expect(backTarget([], false)).toBe("/");
  });
});

describe("TopBar", () => {
  const menu = TOP_BAR_FIXTURE.overflow.map((m) => ({
    kind: "item" as const,
    id: m.id,
    label: m.label,
    onSelect: vi.fn(),
    ...(m.danger ? { tone: "fail" as const } : {}),
  }));

  it("a tab root has the title, search and no back", () => {
    zh(<TopBar title="会话" onSearch={() => {}} />);
    const bar = document.querySelector('[data-part="top-bar"]') as HTMLElement;
    expect(bar.getAttribute("data-pushed")).toBe("false");
    expect(bar.querySelector('[data-part="title"]')?.textContent).toBe("会话");
    expect(within(bar).getByRole("button", { name: "搜索" })).toBeTruthy();
    expect(within(bar).queryByRole("link", { name: "返回" })).toBeNull();
    expect(within(bar).queryByRole("button", { name: "返回" })).toBeNull();
  });

  it("the title is not a second heading", () => {
    zh(<TopBar title="会话" />);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("a pushed page with a path target shows a back link to it", () => {
    zh(<TopBar title="检索" back="/conversations" />);
    const back = screen.getByRole("link", { name: "返回" });
    expect(back.getAttribute("href")).toBe("/conversations");
    expect(back.querySelector('[data-icon="chevron-left"]')).not.toBeNull();
  });

  it("back through history goes back one entry", async () => {
    const spy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    zh(<TopBar title="检索" back="history" />);
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("draws the overflow button only when the page has menu entries, and opens the menu", async () => {
    zh(<TopBar title="会话" />);
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
    cleanup();
    zh(<TopBar title="检索" back="/conversations" menu={menu} />);
    const more = screen.getByRole("button", { name: "更多操作" });
    await userEvent.click(more);
    const list = await screen.findByRole("menu");
    expect(
      within(list)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["属性", "智能体地图", "重命名", "复制链接", "删除"]);
  });

  it("puts the destructive item last, after one separator (spec §6.46)", () => {
    const sepBeforeDanger = () => {
      const menuEl = screen.getByRole("menu");
      const kids = [...menuEl.querySelectorAll('[role="menuitem"], [role="separator"]')];
      return {
        roles: kids.map((k) => (k.getAttribute("role") === "separator" ? "|" : k.textContent)),
      };
    };
    zh(<TopBar title="检索" back="/c" menu={menu} menuOpen />);
    expect(sepBeforeDanger().roles).toEqual([
      "属性",
      "智能体地图",
      "重命名",
      "复制链接",
      "|",
      "删除",
    ]);
    cleanup();
    // a menu that already separates it keeps one separator
    const separated = [...menu.slice(0, -1), { kind: "separator" as const }, ...menu.slice(-1)];
    zh(<TopBar title="检索" back="/c" menu={separated} menuOpen />);
    expect(sepBeforeDanger().roles).toEqual([
      "属性",
      "智能体地图",
      "重命名",
      "复制链接",
      "|",
      "删除",
    ]);
  });

  it("draws the overflow items' icons at 16 (spec §6.46)", () => {
    const rule = parseCss(css("conversation-page.css")).find(
      (r) =>
        r.at === null && r.selector === '.cb-cmenu[data-size="touch"] .cb-cmenu-item > .cb-icon',
    );
    expect(rule?.decls.width).toBe("16px");
    expect(rule?.decls.height).toBe("16px");
  });

  it("the open overflow button is pressed", () => {
    zh(<TopBar title="检索" back="/c" menu={menu} menuOpen />);
    expect(screen.getByRole("button", { name: "更多操作" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});

describe("withViewTransition", () => {
  const doc = document as unknown as { startViewTransition?: unknown };
  afterEach(() => {
    delete doc.startViewTransition;
    delete document.documentElement.dataset.cbTransition;
  });

  it("runs the update at once without view transitions (an instant swap)", () => {
    const update = vi.fn();
    withViewTransition(update, "pop");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("runs the update inside a view transition where there is one, naming the direction meanwhile", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const finished = Promise.resolve();
    let seen: string | undefined;
    doc.startViewTransition = vi.fn((cb: () => unknown) => {
      seen = document.documentElement.dataset.cbTransition;
      void cb();
      return { finished };
    });
    const update = vi.fn();
    withViewTransition(update, "pop");
    expect(seen).toBe("pop");
    expect(update).toHaveBeenCalledTimes(1);
    await finished;
    await Promise.resolve();
    expect(document.documentElement.dataset.cbTransition).toBeUndefined();
  });

  it("does nothing animated under prefers-reduced-motion", () => {
    window.matchMedia = ((q: string) => ({
      matches: q === "(prefers-reduced-motion: reduce)",
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    const start = vi.fn();
    doc.startViewTransition = start;
    const update = vi.fn();
    withViewTransition(update, "pop");
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });
});
