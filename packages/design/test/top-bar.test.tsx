import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOP_BAR_FIXTURE } from "../src/fixtures/index";
import {
  AppShell,
  backTarget,
  DesignProvider,
  PageHeader,
  TopBar,
  withViewTransition,
} from "../src/index";
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
function fakeNavigation(start = 0) {
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

describe("the top bar in the shell", () => {
  const sidebar = {
    context: {
      kind: "work" as const,
      org: null,
      primary: [],
      more: [],
    },
    activeNav: "",
    account: { name: "grant", menu: [] },
  };
  const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };

  it("shows the page's name (the PageHeader's h1) and goes up the page's path", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    zh(
      <AppShell
        sidebar={sidebar}
        status={status}
        commands={[]}
        bottomNav={[
          { id: "chats", label: "会话", href: "/conversations", icon: "chats" },
          { id: "agents", label: "智能体", href: "/agents", icon: "agent" },
          { id: "inbox", label: "收件箱", href: "/inbox", icon: "inbox" },
          { id: "me", label: "我", href: "/me", icon: "user" },
        ]}
        pathname="/agents/new"
      >
        <PageHeader
          path={[
            { label: "demo", href: "/" },
            { label: "智能体", href: "/agents" },
            { label: "新建" },
          ]}
          title="新建智能体"
        />
      </AppShell>,
    );
    const bar = document.querySelector('[data-part="top-bar"]') as HTMLElement;
    expect(bar.querySelector('[data-part="title"]')?.textContent).toBe("新建智能体");
    expect(within(bar).getByRole("link", { name: "返回" }).getAttribute("href")).toBe("/agents");
    // the PageHeader's h1 is the page's heading
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
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

describe("push and pop in the shell", () => {
  const sidebar = {
    context: { kind: "work" as const, org: null, primary: [], more: [] },
    activeNav: "",
    account: { name: "grant", menu: [] },
  };
  const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };
  const nav = [
    { id: "chats" as const, label: "会话", href: "/conversations", icon: "chats" as const },
    { id: "agents" as const, label: "智能体", href: "/agents", icon: "agent" as const },
    { id: "inbox" as const, label: "收件箱", href: "/inbox", icon: "inbox" as const },
    { id: "me" as const, label: "我", href: "/me", icon: "user" as const },
  ];
  const shell = (pathname: string) => (
    <DesignProvider locale="zh">
      <AppShell sidebar={sidebar} status={status} bottomNav={nav} pathname={pathname}>
        <div>内容</div>
      </AppShell>
    </DesignProvider>
  );
  const main = () => document.querySelector("main") as HTMLElement;

  it("a push slides in, a pop slides back, a move between tab roots does not slide", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const nav = fakeNavigation();
    const { rerender } = render(shell("/agents"));
    expect(main().getAttribute("data-nav")).toBeNull();
    nav.push("/agents/new");
    rerender(shell("/agents/new"));
    expect(main().getAttribute("data-nav")).toMatch(/^push-/);
    // once the shell has seen a navigation, back goes through the history
    expect(
      document.querySelector('[data-part="top-bar"] button[aria-label="返回"]'),
    ).not.toBeNull();
    rerender(shell("/agents"));
    expect(main().getAttribute("data-nav")).toMatch(/^pop-/);
    rerender(shell("/inbox"));
    expect(main().getAttribute("data-nav")).toBeNull();
  });

  it("two pushes in a row restart the animation (the name alternates)", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { rerender } = render(shell("/agents"));
    rerender(shell("/agents/new"));
    const first = main().getAttribute("data-nav");
    rerender(shell("/agents/new/step"));
    expect(main().getAttribute("data-nav")).not.toBe(first);
    expect(main().getAttribute("data-nav")).toMatch(/^push-/);
  });
});

describe("back never leaves the app", () => {
  const sidebar = {
    context: { kind: "work" as const, org: null, primary: [], more: [] },
    activeNav: "",
    account: { name: "grant", menu: [] },
  };
  const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };
  const nav = [
    { id: "chats" as const, label: "会话", href: "/conversations", icon: "chats" as const },
    { id: "agents" as const, label: "智能体", href: "/agents", icon: "agent" as const },
    { id: "inbox" as const, label: "收件箱", href: "/inbox", icon: "inbox" as const },
    { id: "me" as const, label: "我", href: "/me", icon: "user" as const },
  ];
  const shell = (pathname: string) => (
    <DesignProvider locale="zh">
      <AppShell sidebar={sidebar} status={status} bottomNav={nav} pathname={pathname}>
        <PageHeader
          path={[
            { label: "demo", href: "/" },
            { label: "智能体", href: "/agents" },
            { label: "新建" },
          ]}
          title="新建"
        />
      </AppShell>
    </DesignProvider>
  );
  const back = () =>
    document.querySelector('[data-part="top-bar"] [data-part="back"]') as HTMLElement;

  it("a deep link, one push, a pop: the second back goes up the path, not out through the history", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents/new");
    const nav = fakeNavigation(3);
    const { rerender } = render(shell("/agents/new"));
    // deep link: nothing behind it in the app (the entries before the shell mounted are not ours)
    expect(back().tagName).toBe("A");
    expect(back().getAttribute("href")).toBe("/agents");
    nav.push("/agents/new/step");
    rerender(shell("/agents/new/step"));
    expect(back().tagName).toBe("BUTTON"); // one in-app entry behind: history back
    nav.traverse(-1, "/agents/new");
    rerender(shell("/agents/new"));
    expect(back().tagName).toBe("A"); // back at the deep link: up the path
    expect(back().getAttribute("href")).toBe("/agents");
  });

  it("a replace (router.replace at the start) is no entry behind: back goes up the path", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents/new");
    const nav = fakeNavigation();
    const { rerender } = render(shell("/agents/new"));
    nav.replace("/agents/new/step");
    rerender(shell("/agents/new/step"));
    expect(back().tagName).toBe("A");
    expect(back().getAttribute("href")).toBe("/agents");
  });

  it("a forward after a pop is not a pop: back goes through the history again", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents/new");
    const nav = fakeNavigation();
    const { rerender } = render(shell("/agents/new"));
    nav.push("/agents/new/step");
    rerender(shell("/agents/new/step"));
    nav.traverse(-1, "/agents/new");
    rerender(shell("/agents/new"));
    nav.traverse(1, "/agents/new/step");
    rerender(shell("/agents/new/step"));
    expect(back().tagName).toBe("BUTTON");
  });

  it("without the Navigation API back always goes up the path (a counter cannot tell a push from a replace)", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents/new");
    const { rerender } = render(shell("/agents/new"));
    window.history.pushState(null, "", "/agents/new/step");
    rerender(shell("/agents/new/step"));
    expect(back().tagName).toBe("A");
    expect(back().getAttribute("href")).toBe("/agents");
  });

  it("a hash-only step (an item opened and closed) leaves no entry behind", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents/new");
    const nav = fakeNavigation();
    const { rerender } = render(shell("/agents/new"));
    // open an item (a hash push) and close it (a traverse back): the path never changes
    nav.push("/agents/new#item");
    nav.traverse(-1, "/agents/new");
    // a real push after it
    nav.push("/agents/new/step");
    rerender(shell("/agents/new/step"));
    expect(back().tagName).toBe("BUTTON");
    // and its pop
    nav.traverse(-1, "/agents/new");
    rerender(shell("/agents/new"));
    expect(back().tagName).toBe("A");
  });
});
