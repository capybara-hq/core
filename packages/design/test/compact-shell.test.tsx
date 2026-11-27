// The chat-first compact shell (design spec §4.6, §6.55; mobile app plan Task 27, Decisions 17,
// 19, 25, 27): no top bar and no bottom navigation; a floating row with the menu button on a chat
// surface and back on a pushed page; the menu opens the drawer, and the system back closes an open
// overlay before it navigates.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useInsertionEffect } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  DesignProvider,
  type DrawerNavData,
  type DrawerRecent,
  type LinkComponent,
  PageHeader,
  useRegisterScrolledTitle,
  useRegisterShellPage,
} from "../src/index";
import { css, parseCss } from "./css-rules";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "navigation");
  window.history.replaceState(null, "", "/");
});

const sidebar = {
  context: { kind: "work" as const, org: null, primary: [], more: [] },
  activeNav: "",
  account: { name: "grant", menu: [] },
};
const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };

const conversations: DrawerRecent = {
  state: "ready",
  items: [
    {
      id: "c1",
      title: "沙箱内 pnpm 安装失败",
      startedAt: new Date("2026-11-20T10:00:00Z"),
      updatedAt: "2026-11-20T10:00:00Z",
      href: "/chat/c1",
      agent: { name: "Claude" },
      activity: null,
    },
  ],
  onRetry() {},
};

function drawerData(over: Partial<DrawerNavData> = {}): DrawerNavData {
  return {
    sections: [
      { id: "inbox", label: "收件箱", href: "/inbox", icon: "inbox", badge: { count: 3 } },
      { id: "agents", label: "智能体", href: "/agents", icon: "agent" },
      { id: "schedules", label: "定时任务", href: "/schedules", icon: "clock" },
    ],
    more: [
      { id: "skills", label: "技能", href: "/skills", icon: "skills" },
      { id: "connectors", label: "连接器", href: "/connectors", icon: "connector" },
      { id: "devices", label: "设备", href: "/devices", icon: "cpu" },
    ],
    moreLabel: "技能、连接器、设备…",
    recent: conversations,
    allConversations: { label: "全部会话", href: "/conversations" },
    newConversation: { label: "新会话", href: "/" },
    onSearch: () => {},
    account: {
      name: "Grant",
      orgName: "Meta1",
      personalSettingsHref: "/account/profile",
      theme: null,
      status: <span>正常</span>,
      onSignOut: () => {},
    },
    menuBadge: { count: 3 },
    ...over,
  };
}

/** A link that records where it went instead of leaving the page (jsdom cannot navigate). */
function recordingLink(visits: string[]): LinkComponent {
  return ({ href, children, ...rest }) => (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        e.preventDefault();
        visits.push(href);
      }}
    >
      {children}
    </a>
  );
}

type Shell = {
  pathname?: string;
  chatSurface?: boolean;
  drawer?: DrawerNavData | undefined;
  link?: LinkComponent;
  children?: React.ReactNode;
};
const shell = ({ pathname = "/", chatSurface = true, drawer, link, children }: Shell) => (
  <DesignProvider locale="zh" {...(link ? { link } : {})}>
    <AppShell
      sidebar={sidebar}
      commands={[]}
      pathname={pathname}
      chatSurface={chatSurface}
      {...(drawer ? { drawer } : {})}
    >
      {children ?? <div>内容</div>}
    </AppShell>
  </DesignProvider>
);

const bar = () => document.querySelector('[data-part="floating-bar"]') as HTMLElement;
const menuButton = () => within(bar()).queryByRole("button", { name: /^打开菜单/ });
const drawerEl = () => document.querySelector('[data-part="drawer"]') as HTMLElement | null;

/** A compact touch window: the size classes by width and the touch query by `coarse`. */
function touchWindow(width = 390, coarse = true) {
  const sized = matchMediaFor(width).matchMedia;
  vi.stubGlobal("matchMedia", (q: string) => {
    const t = q.trim();
    if (/pointer/.test(t)) {
      const matches = t.includes("not (any-pointer: fine)")
        ? coarse
        : t === "(any-pointer: fine)"
          ? !coarse
          : coarse;
      return { matches, media: q, addEventListener() {}, removeEventListener() {} };
    }
    return sized(q);
  });
}

describe("the compact frame", () => {
  it("a chat surface: the menu button with the badge, no back, no top bar, no bottom navigation", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    render(shell({ drawer: drawerData() }));
    const menu = menuButton() as HTMLElement;
    expect(menu.getAttribute("aria-label")).toBe("打开菜单，3 项待处理");
    expect(menu.querySelector('[data-part="float-badge"]')?.textContent).toBe("3");
    expect(within(bar()).queryByLabelText("返回")).toBeNull();
    expect(document.querySelector(".cb-shell-bottomnav")).toBeNull();
    expect(document.querySelector('[data-part="top-bar"]')).toBeNull();
    expect(document.querySelector(".cb-shell")?.getAttribute("data-surface")).toBe("chat");
  });

  it("the home renders no trailing floating control (no incognito button, Decision 27)", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    render(shell({ drawer: drawerData() }));
    expect(bar().querySelectorAll("button, a")).toHaveLength(1);
  });

  it("a pushed page: a back button and no menu button", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    render(shell({ pathname: "/inbox", chatSurface: false, drawer: drawerData() }));
    expect(menuButton()).toBeNull();
    expect(within(bar()).getByRole("link", { name: "返回" }).getAttribute("href")).toBe("/");
    expect(document.querySelector(".cb-shell")?.getAttribute("data-surface")).toBe("pushed");
  });

  it("the row is in the server markup and CSS shows it below 600 only; a pushed page starts under it", () => {
    const html = renderToString(shell({ drawer: drawerData() }));
    expect(html).toContain('data-part="floating-bar"');
    const rules = parseCss(css("shell.css"));
    expect(
      rules.find((r) => r.selector === ".cb-shell-float" && r.at === null)?.decls.display,
    ).toBe("none");
    const compact = (sel: string) =>
      rules.find((r) => r.selector === sel && r.at === "not all and (min-width: 600px)")?.decls;
    expect(compact(".cb-shell-float")?.display).toBe("block");
    expect(compact('.cb-shell[data-surface="pushed"] .cb-shell-main')?.["padding-top"]).toBe(
      "var(--cb-float-row)",
    );
  });

  it("a solid bg strip lies under the row, so scrolled text never shows through it (no gradient, spec §1)", () => {
    const strip = parseCss(css("shell.css")).find(
      (r) => r.selector === ".cb-shell-column::before" && r.at === "not all and (min-width: 600px)",
    )?.decls;
    expect(strip?.height).toBe("var(--cb-float-row)");
    expect(strip?.background).toBe("var(--cb-bg)");
    expect(strip?.["pointer-events"]).toBe("none");
    expect(strip?.position).toBe("absolute");
  });

  it("the floating row's size is touch.float on touch (one shell for every pointer)", () => {
    const touch = parseCss(css("touch.css")).find(
      (r) => r.selector === ".cb-shell" && r.at?.includes("pointer: coarse"),
    );
    expect(touch?.decls["--cb-float-size"]).toBe("var(--cb-touch-float)");
  });
});

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

describe("back (Decision 19): history, else the last linked path segment, else /", () => {
  const page = (pathname: string, path?: { label: string; href?: string }[]) =>
    shell({
      pathname,
      chatSurface: false,
      children: (
        <PageHeader
          path={
            path ?? [
              { label: "demo", href: "/" },
              { label: "智能体", href: "/agents" },
              { label: "新建" },
            ]
          }
          title="新建"
        />
      ),
    });
  const back = () => bar().querySelector('[data-part="float-btn"]') as HTMLElement;

  it("with history: a button that goes back one entry", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents/new");
    const nav = fakeNavigation();
    const { rerender } = render(page("/agents/new"));
    nav.push("/agents/new/step");
    rerender(page("/agents/new/step"));
    expect(back().tagName).toBe("BUTTON");
    const spy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    await userEvent.click(back());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("without history: the last linked segment above the page", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    render(page("/agents/new"));
    expect(back().tagName).toBe("A");
    expect(back().getAttribute("href")).toBe("/agents");
  });

  it("a first-level page (two segments, no path row drawn) still walks its path from the props", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    render(page("/skills", [{ label: "demo", href: "/home" }, { label: "skills" }]));
    expect(document.querySelector('[data-part="path"]')).toBeNull();
    expect(back().getAttribute("href")).toBe("/home");
  });

  it("with no linked segment: the home", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    render(page("/x", [{ label: "x" }, { label: "y" }]));
    expect(back().getAttribute("href")).toBe("/");
  });

  it("a section's home whose parent segment links to the page itself: back skips it, never a self link", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const account = (current: string) => [
      { label: "~" },
      { label: "account", href: "/account/profile" },
      { label: current },
    ];
    const { rerender } = render(page("/account/profile", account("profile")));
    // a link to the page itself replaces its entry and changes nothing: the person is stuck
    expect(back().getAttribute("href")).toBe("/");
    rerender(page("/account/preferences", account("preferences")));
    expect(back().getAttribute("href")).toBe("/account/profile");
    // the query or hash of the current address does not make the segment another page
    rerender(
      page("/account/profile", [
        { label: "~" },
        { label: "a", href: "/account/profile?x=1" },
        { label: "p" },
      ]),
    );
    expect(back().getAttribute("href")).toBe("/");
  });

  it("a deep link, one push, a pop: the second back goes up the path, not out through the history", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents/new");
    const nav = fakeNavigation(3);
    const { rerender } = render(page("/agents/new"));
    expect(back().getAttribute("href")).toBe("/agents");
    nav.push("/agents/new/step");
    rerender(page("/agents/new/step"));
    expect(back().tagName).toBe("BUTTON");
    nav.traverse(-1, "/agents/new");
    rerender(page("/agents/new"));
    expect(back().tagName).toBe("A");
  });

  it("a push from an insertion effect (Next's router updates the history there) schedules no update in it", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents/new");
    const nav = fakeNavigation();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    function Router({ pathname }: { pathname: string }) {
      useInsertionEffect(() => {
        if (window.location.pathname !== pathname) nav.push(pathname);
      }, [pathname]);
      return page(pathname);
    }
    const { rerender } = render(<Router pathname="/agents/new" />);
    rerender(<Router pathname="/agents/new/step" />);
    await act(async () => {});
    expect(errors.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
      expect.stringContaining("useInsertionEffect must not schedule updates"),
    );
    errors.mockRestore();
    expect(back().tagName).toBe("BUTTON"); // the push still counts: one in-app entry behind
  });

  it("a replace is no entry behind; without the Navigation API back goes up the path", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents/new");
    const nav = fakeNavigation();
    const { rerender } = render(page("/agents/new"));
    nav.replace("/agents/new/step");
    rerender(page("/agents/new/step"));
    expect(back().tagName).toBe("A");
    Reflect.deleteProperty(window, "navigation");
    cleanup();
    const second = render(page("/agents/new"));
    window.history.pushState(null, "", "/agents/new/step");
    second.rerender(page("/agents/new/step"));
    expect(back().tagName).toBe("A");
  });

  it("a page's own back (an open list-detail item) wins over the path", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const onBack = vi.fn();
    function Item() {
      useRegisterShellPage({ onBack });
      return null;
    }
    render(shell({ pathname: "/inbox", chatSurface: false, children: <Item /> }));
    await userEvent.click(within(bar()).getByRole("button", { name: "返回" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("on a chat surface a pushed right area's back replaces the menu button", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    function Pushed() {
      useRegisterShellPage({ onBack: () => {} });
      return null;
    }
    render(shell({ drawer: drawerData(), children: <Pushed /> }));
    expect(menuButton()).toBeNull();
    expect(within(bar()).getByRole("button", { name: "返回" })).toBeTruthy();
  });
});

describe("transitions (re-keyed on chat surfaces)", () => {
  const main = () => document.querySelector("main") as HTMLElement;

  it("chat surface to chat surface never slides", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { rerender } = render(shell({ pathname: "/" }));
    rerender(shell({ pathname: "/chat/c1" }));
    expect(main().getAttribute("data-nav")).toBeNull();
    rerender(shell({ pathname: "/chat/c2" }));
    expect(main().getAttribute("data-nav")).toBeNull();
  });

  it("chat surface to a pushed page slides in; back to a chat surface slides back", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { rerender } = render(shell({ pathname: "/chat/c1" }));
    rerender(shell({ pathname: "/inbox", chatSurface: false }));
    expect(main().getAttribute("data-nav")).toMatch(/^push-/);
    const first = main().getAttribute("data-nav");
    rerender(shell({ pathname: "/inbox/x", chatSurface: false }));
    expect(main().getAttribute("data-nav")).toMatch(/^push-/);
    expect(main().getAttribute("data-nav")).not.toBe(first);
    rerender(shell({ pathname: "/chat/c1" }));
    expect(main().getAttribute("data-nav")).toMatch(/^pop-/);
  });
});

describe("the drawer from the menu button", () => {
  it("sections in order with the inbox badge, the more level, the recent list, the foot", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    render(shell({ drawer: drawerData() }));
    await userEvent.click(menuButton() as HTMLElement);
    const panel = drawerEl() as HTMLElement;
    const sections = [...panel.querySelectorAll("[data-nav-section]")];
    expect(sections.map((s) => s.getAttribute("data-nav-section"))).toEqual([
      "inbox",
      "agents",
      "schedules",
    ]);
    expect(sections[0]?.querySelector('[data-part="navrow-badge"]')?.textContent).toBe("3");
    expect(within(panel).getByRole("link", { name: /沙箱内 pnpm 安装失败/ })).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "全部会话" }).getAttribute("href")).toBe(
      "/conversations",
    );
    expect(within(panel).getByRole("button", { name: /Grant/ })).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "新会话" }).getAttribute("href")).toBe("/");
    // the more row opens its level inside the same drawer
    await userEvent.click(within(panel).getByRole("button", { name: "更多" }));
    const level = document.querySelector('[data-part="drawer-level"]') as HTMLElement;
    expect(
      within(level)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["技能", "连接器", "设备"]);
    await userEvent.click(within(level).getByRole("button", { name: "返回菜单" }));
    expect(document.querySelector('[data-part="drawer-level"]')).toBeNull();
  });

  it("an org pick in the account sheet closes the sheet and the drawer (T28 review)", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const data = drawerData();
    const account = {
      ...data.account,
      orgMenu: [{ label: "Beta", checked: false, onSelect: () => {} }],
    };
    render(shell({ drawer: { ...data, account } }));
    await userEvent.click(menuButton() as HTMLElement);
    await userEvent.click(within(drawerEl() as HTMLElement).getByRole("button", { name: /Grant/ }));
    await userEvent.click(screen.getByRole("button", { name: /组织/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Beta" }));
    await waitFor(() => expect(document.querySelector('[data-part="account-sheet"]')).toBeNull());
    await waitFor(() => expect(drawerEl()).toBeNull());
  });

  it("a guest's data without schedules renders two sections", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const data = drawerData();
    render(shell({ drawer: { ...data, sections: data.sections.slice(0, 2) } }));
    await userEvent.click(menuButton() as HTMLElement);
    expect(drawerEl()?.querySelectorAll("[data-nav-section]")).toHaveLength(2);
  });

  it("a pick closes the drawer and navigates; a recent conversation is a pick too", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const visits: string[] = [];
    render(shell({ drawer: drawerData(), link: recordingLink(visits) }));
    await userEvent.click(menuButton() as HTMLElement);
    await userEvent.click(within(drawerEl() as HTMLElement).getByRole("link", { name: /收件箱/ }));
    await waitFor(() => expect(drawerEl()).toBeNull());
    expect(visits).toEqual(["/inbox"]);
    await userEvent.click(menuButton() as HTMLElement);
    await userEvent.click(
      within(drawerEl() as HTMLElement).getByRole("link", { name: /沙箱内 pnpm 安装失败/ }),
    );
    await waitFor(() => expect(drawerEl()).toBeNull());
    expect(visits).toEqual(["/inbox", "/chat/c1"]);
  });

  it("search closes the drawer and opens the command palette", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    render(shell({ drawer: drawerData() }));
    await userEvent.click(menuButton() as HTMLElement);
    await userEvent.click(within(drawerEl() as HTMLElement).getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(drawerEl()).toBeNull());
    expect(document.querySelector(".cb-palette, [cmdk-root]")).not.toBeNull();
  });
});

describe("drawer search opens the palette (T27 review)", () => {
  it.each([
    ["a fine pointer", false],
    ["a touch window", true],
  ])("on %s the palette stays open and focus lands in its input", async (_n, coarse) => {
    if (coarse) touchWindow();
    else window.matchMedia = matchMediaFor(390).matchMedia;
    render(
      <DesignProvider locale="zh">
        <AppShell
          sidebar={sidebar}
          commands={[{ label: "跳转", items: [{ id: "a", label: "智能体", onSelect: () => {} }] }]}
          pathname="/"
          chatSurface
          drawer={drawerData()}
        >
          <div>内容</div>
        </AppShell>
      </DesignProvider>,
    );
    await userEvent.click(menuButton() as HTMLElement);
    await userEvent.click(within(drawerEl() as HTMLElement).getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(drawerEl()).toBeNull());
    const palette = () => document.querySelector("[cmdk-root]") as HTMLElement | null;
    await waitFor(() => expect(palette()?.contains(document.activeElement)).toBe(true));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(palette()).not.toBeNull();
    expect(document.activeElement?.tagName).toBe("INPUT");
    expect(palette()?.contains(document.activeElement)).toBe(true);
  });
});

describe("back closes overlays first (Decision 25)", () => {
  const settled = () => new Promise<void>((r) => setTimeout(r, 0));

  it("with the drawer open, a popstate closes it and the route stays", async () => {
    touchWindow();
    window.history.replaceState(null, "", "/");
    render(shell({ drawer: drawerData() }));
    await userEvent.click(menuButton() as HTMLElement);
    expect(drawerEl()).not.toBeNull();
    act(() => window.history.back());
    await waitFor(() => expect(drawerEl()).toBeNull());
    await settled();
    expect(window.location.pathname).toBe("/");
  });

  // T27 review (Important): sign out leaves the page, so it runs only once the popped entries'
  // popstate has fired; Switch platform opens the native switcher inside the click (user activation) and
  // keeps the page, so the overlays pop as a close does.
  const openAccount = async () => {
    await userEvent.click(menuButton() as HTMLElement);
    await userEvent.click(within(drawerEl() as HTMLElement).getByRole("button", { name: /Grant/ }));
  };
  const marker = () => (window.history.state as Record<string, unknown> | null)?.cbOverlay;

  it("sign out runs after the drawer's and the sheet's entries are popped", async () => {
    touchWindow();
    window.history.replaceState(null, "", "/");
    const seen: unknown[] = [];
    const onSignOut = vi.fn(() => seen.push(marker()));
    const data = drawerData();
    render(shell({ drawer: { ...data, account: { ...data.account, onSignOut } } }));
    await openAccount();
    const go = vi.spyOn(window.history, "go");
    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));
    // called from the entry under the overlays' (in the click it would still see the sheet's)
    await waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(1));
    expect(seen).toEqual([undefined]);
    expect(go).toHaveBeenCalledWith(-2);
    await waitFor(() => expect(drawerEl()).toBeNull());
  });

  it("切换平台 runs inside the click and the overlays pop as a close does", async () => {
    touchWindow();
    window.history.replaceState(null, "", "/");
    const onSwitchProfile = vi.fn();
    const data = drawerData();
    render(shell({ drawer: { ...data, account: { ...data.account, onSwitchProfile } } }));
    await openAccount();
    const go = vi.spyOn(window.history, "go");
    await userEvent.click(screen.getByRole("button", { name: "切换平台" }));
    expect(onSwitchProfile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(drawerEl()).toBeNull());
    await waitFor(() => expect(go).toHaveBeenCalledWith(-2));
    await waitFor(() => expect(marker()).toBeUndefined());
  });

  it("the account sheet over the drawer: back closes the sheet, then the drawer, then navigates", async () => {
    touchWindow();
    window.history.replaceState(null, "", "/agents");
    window.history.pushState(null, "", "/");
    render(shell({ drawer: drawerData() }));
    await userEvent.click(menuButton() as HTMLElement);
    await userEvent.click(within(drawerEl() as HTMLElement).getByRole("button", { name: /Grant/ }));
    const sheet = () => document.querySelector('[data-part="account-sheet"]');
    expect(sheet()).not.toBeNull();
    act(() => window.history.back());
    await waitFor(() => expect(sheet()).toBeNull());
    expect(drawerEl()).not.toBeNull();
    expect(window.location.pathname).toBe("/");
    act(() => window.history.back());
    await waitFor(() => expect(drawerEl()).toBeNull());
    expect(window.location.pathname).toBe("/");
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
  });
});

describe("head actions and the scrolled title in the compact top row (responsive spec §2.5, §2.6)", () => {
  const pushed = (children: React.ReactNode, onNavigate?: (href: string) => void) => (
    <DesignProvider locale="zh">
      <AppShell
        sidebar={sidebar}
        commands={[]}
        pathname="/agents/a1"
        chatSurface={false}
        {...(onNavigate ? { onNavigate } : {})}
      >
        {children}
      </AppShell>
    </DesignProvider>
  );
  const more = () => within(bar()).getByRole("button", { name: "更多操作" });

  it("head actions join the overflow after the page menu", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const onExport = vi.fn();
    function Page() {
      useRegisterShellPage({
        title: "研究助手",
        menu: [{ kind: "item", id: "rename", label: "重命名", onSelect: () => {} }],
        actions: [
          { label: "导出", onSelect: onExport },
          "separator",
          { label: "删除", danger: true, onSelect: () => {} },
        ],
      });
      return null;
    }
    render(pushed(<Page />));
    await userEvent.click(more());
    const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent);
    expect(items).toEqual(["重命名", "导出", "删除"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "导出" }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("head actions alone make the overflow", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    function Page() {
      useRegisterShellPage({ title: "研究助手", actions: [{ label: "导出", onSelect: () => {} }] });
      return null;
    }
    render(pushed(<Page />));
    await userEvent.click(more());
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["导出"]);
  });

  it("a link action navigates through onNavigate", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const onNavigate = vi.fn();
    function Page() {
      useRegisterShellPage({
        title: "研究助手",
        actions: [{ label: "版本", href: "/agents/a1/v" }],
      });
      return null;
    }
    render(pushed(<Page />, onNavigate));
    await userEvent.click(more());
    await userEvent.click(await screen.findByRole("menuitem", { name: "版本" }));
    expect(onNavigate).toHaveBeenCalledWith("/agents/a1/v");
  });

  it("desktop-only head actions stay out of the touch overflow", async () => {
    touchWindow(390);
    function Page() {
      useRegisterShellPage({
        title: "研究助手",
        actions: [
          { label: "导出", onSelect: () => {} },
          { label: "编辑流程", desktopOnly: true, href: "/agents/a1/flow" },
        ],
      });
      return null;
    }
    render(pushed(<Page />));
    await userEvent.click(more());
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["导出"]);
  });

  it("a submenu whose items are all desktop-only leaves no bare label on touch", async () => {
    touchWindow(390);
    function Page() {
      useRegisterShellPage({
        title: "研究助手",
        actions: [
          { label: "导出", onSelect: () => {} },
          {
            label: "流程",
            submenu: [{ label: "编辑流程", desktopOnly: true, href: "/agents/a1/flow" }],
          },
          { label: "删除", danger: true, onSelect: () => {} },
        ],
      });
      return null;
    }
    render(pushed(<Page />));
    await userEvent.click(more());
    const menu = await screen.findByRole("menu");
    const kinds = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((e) =>
      e.getAttribute("role") === "separator" ? "|" : e.textContent,
    );
    expect(kinds).toEqual(["导出", "删除"]);
    expect(within(menu).queryByText("流程")).toBeNull();
  });

  it("a submenu's run is set apart by separators", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    function Page() {
      useRegisterShellPage({
        title: "研究助手",
        actions: [
          { label: "导出", onSelect: () => {} },
          { label: "语言", submenu: [{ label: "English", onSelect: () => {} }] },
          { label: "删除", danger: true, onSelect: () => {} },
        ],
      });
      return null;
    }
    render(pushed(<Page />));
    await userEvent.click(more());
    const menu = await screen.findByRole("menu");
    const kinds = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((e) =>
      e.getAttribute("role") === "separator" ? "|" : e.textContent,
    );
    expect(kinds).toEqual(["导出", "|", "English", "|", "删除"]);
    expect(within(menu).getByText("语言")).toBeTruthy();
  });

  it("titleAway comes only from the layer that gave the title", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    function Page() {
      useRegisterShellPage({ title: "智能体" });
      useRegisterScrolledTitle(true);
      return null;
    }
    function Item() {
      useRegisterShellPage({ title: "研究助手", onBack: () => {} }, 1);
      return null;
    }
    render(
      pushed(
        <>
          <Page />
          <Item />
        </>,
      ),
    );
    expect(bar().querySelector('[data-part="floating-title"]')).toBeNull();
    expect(document.querySelector(".cb-shell-column")?.hasAttribute("data-title-away")).toBe(false);
  });

  it("titleAway draws the centred title and the hairline mark", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    function Page() {
      useRegisterShellPage({ title: "研究助手", path: [{ label: "智能体", href: "/agents" }] });
      return null;
    }
    function Scrolled() {
      useRegisterScrolledTitle(true);
      return null;
    }
    render(
      pushed(
        <>
          <Page />
          <Scrolled />
        </>,
      ),
    );
    const title = bar().querySelector('[data-part="floating-title"]') as HTMLElement;
    expect(title.textContent).toBe("研究助手");
    expect(title.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".cb-shell-column")?.getAttribute("data-title-away")).toBe(
      "true",
    );
    const compact = (sel: string) =>
      parseCss(css("shell.css")).find(
        (r) => r.selector === sel && r.at === "not all and (min-width: 600px)",
      )?.decls;
    expect(compact('.cb-shell-column[data-title-away="true"]::before')?.["border-bottom"]).toBe(
      "1px solid var(--cb-line-soft)",
    );
    const t = compact(".cb-floating-title");
    expect(t?.position).toBe("absolute");
    expect(t?.["text-align"]).toBe("center");
    expect(t?.["text-overflow"]).toBe("ellipsis");
    expect(t?.["font-weight"]).toBe("500");
  });

  it("no title while titleAway is false", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    function Page({ away }: { away: boolean }) {
      useRegisterShellPage({ title: "研究助手" });
      useRegisterScrolledTitle(away);
      return null;
    }
    const { rerender } = render(pushed(<Page away={false} />));
    expect(bar().querySelector('[data-part="floating-title"]')).toBeNull();
    expect(document.querySelector(".cb-shell-column")?.hasAttribute("data-title-away")).toBe(false);
    rerender(pushed(<Page away />));
    expect(bar().querySelector('[data-part="floating-title"]')?.textContent).toBe("研究助手");
    rerender(pushed(<Page away={false} />));
    expect(bar().querySelector('[data-part="floating-title"]')).toBeNull();
  });
});
