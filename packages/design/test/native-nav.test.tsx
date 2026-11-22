// A native shell's strip navigation (`nav@1`, mobile app spec §6.1; interaction model §10.2–10.4):
// on the iPhone Duo inside the app the strip holds the account avatar and a pill. The AppShell
// hands it the sections with the inbox count, Search (with a palette), the current one, the
// pill's top item (the page's primary on compact, else New conversation) and the account; it
// routes the taps (closing an open sheet first), runs the action, opens the account sheet, and
// hides its own section entries and menu button while the handle is there. No menu button on the
// strip (D12).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  DesignProvider,
  type DrawerNavData,
  type NativeHandlers,
  type NativeNavHandle,
  type NativeSectionId,
  type ShellPrimary,
  useRegisterShellPage,
} from "../src/index";
import { css, parseCss } from "./css-rules";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;

/** A compact touch window (the overlays hold history entries there). */
function touchWindow(width = 390) {
  const sized = matchMediaFor(width).matchMedia;
  vi.stubGlobal("matchMedia", (q: string) => {
    const t = q.trim();
    if (/pointer/.test(t)) {
      const matches = t !== "(any-pointer: fine)";
      return { matches, media: q, addEventListener() {}, removeEventListener() {} };
    }
    return sized(q);
  });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.matchMedia = realMatchMedia;
  document.documentElement.removeAttribute("data-native-nav");
});

const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };
const conversations = { state: "ready" as const, items: [], onRetry() {} };

function drawerData(over: Partial<DrawerNavData> = {}): DrawerNavData {
  return {
    sections: [
      { id: "inbox", label: "收件箱", href: "/inbox", icon: "inbox", badge: { count: 3 } },
      { id: "agents", label: "智能体", href: "/agents", icon: "agent" },
      { id: "schedules", label: "定时任务", href: "/schedules", icon: "clock" },
    ],
    more: [{ id: "skills", label: "技能", href: "/skills", icon: "skills" }],
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
      status: "正常",
      onSignOut: () => {},
    },
    menuBadge: { count: 3 },
    ...over,
  };
}

const sidebar = {
  context: {
    kind: "work" as const,
    org: null,
    primary: [
      { id: "agents", label: "智能体", href: "/agents", icon: "agent" as const },
      { id: "skills", label: "技能", href: "/skills", icon: "skills" as const },
      { id: "schedules", label: "定时任务", href: "/schedules", icon: "clock" as const },
    ],
    more: [{ id: "devices", label: "设备", href: "/devices", icon: "cpu" as const }],
    inbox: { href: "/inbox", count: 3 },
  },
  activeNav: "",
  account: { name: "grant", menu: [{ label: "个人设置", href: "/account/profile" }] },
};

function fakeNav() {
  const select = new Set<(id: NativeSectionId) => void>();
  const action = new Set<() => void>();
  const account = new Set<() => void>();
  const off = vi.fn();
  const sub =
    <L,>(set: Set<L>) =>
    (l: L) => {
      set.add(l);
      return () => {
        off();
        set.delete(l);
      };
    };
  const nav = {
    set: vi.fn<NativeNavHandle["set"]>(),
    onSelect: vi.fn(sub(select)),
    onAction: vi.fn(sub(action)),
    onAccount: vi.fn(sub(account)),
  };
  return {
    nav,
    off,
    listeners: () => select.size + action.size + account.size,
    select(id: NativeSectionId) {
      for (const l of [...select]) l(id);
    },
    action() {
      for (const l of [...action]) l();
    },
    account() {
      for (const l of [...account]) l();
    },
  };
}

/** A page that registers its primary with the shell (as the template does, T0b.9). */
function Primary({ primary }: { primary: ShellPrimary }) {
  useRegisterShellPage({ primary });
  return null;
}

type Extra = {
  onNavigate?: (href: string, options?: { transition?: "none" }) => void;
  native?: NativeHandlers;
  drawer?: DrawerNavData;
  primary?: ShellPrimary;
  search?: boolean;
};
const chatPaths = new Set(["/"]);
function shell(nav: NativeNavHandle | undefined, pathname: string, extra: Extra = {}) {
  return (
    <DesignProvider locale="zh" {...(extra.native ? { native: extra.native } : {})}>
      <AppShell
        sidebar={sidebar}
        status={status}
        pathname={pathname}
        chatSurface={chatPaths.has(pathname)}
        drawer={extra.drawer ?? drawerData()}
        {...(nav ? { nativeNav: nav } : {})}
        {...(extra.onNavigate ? { onNavigate: extra.onNavigate } : {})}
        {...(extra.search
          ? { commands: [{ label: "跳转", items: [{ id: "a", label: "智能体", onSelect() {} }] }] }
          : {})}
      >
        <div>内容</div>
        {extra.primary ? <Primary primary={extra.primary} /> : null}
      </AppShell>
    </DesignProvider>
  );
}

const FOUR = [
  { id: "chats", label: "对话" },
  { id: "inbox", label: "收件箱", count: 3 },
  { id: "agents", label: "智能体" },
  { id: "schedules", label: "定时任务" },
];
const NEW = { id: "new-conversation", label: "新会话", icon: "square-pen" };
const ACCOUNT = { name: "Grant", initial: "G" };
const palette = () => document.querySelector("[cmdk-root]");
const accountSheet = () => document.querySelector('[data-part="account-sheet"]');
const shellEl = () => document.querySelector(".cb-shell") as HTMLElement;
const html = () => document.documentElement;

const rules = parseCss(css("shell.css"));
const hidden = (selector: string, at: string | null = null) =>
  rules.some(
    (r) =>
      r.at === at &&
      r.selector
        .split(",")
        .map((s) => s.trim())
        .includes(selector) &&
      r.decls.display === "none",
  );

describe("the native strip (nav@1)", () => {
  it("set carries action (page primary or 新会话) and account", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { nav } = fakeNav();
    const view = render(shell(nav, "/"));
    expect(shellEl().hasAttribute("data-native-nav")).toBe(true);
    expect(html().hasAttribute("data-native-nav")).toBe(true);
    // once, with no menu (the strip has no menu button, D12)
    expect(nav.set).toHaveBeenCalledTimes(1);
    expect(nav.set).toHaveBeenLastCalledWith({
      items: FOUR,
      current: "chats",
      action: NEW,
      account: ACCOUNT,
    });
    // a page's primary takes the pill's top item (plus by default) while it is registered
    const primary = { id: "new-agent", label: "新建智能体", run: vi.fn() };
    view.rerender(shell(nav, "/agents", { primary }));
    expect(nav.set).toHaveBeenLastCalledWith(
      expect.objectContaining({
        current: "agents",
        action: { id: "new-agent", label: "新建智能体", icon: "plus" },
      }),
    );
    view.rerender(shell(nav, "/agents"));
    expect(nav.set).toHaveBeenLastCalledWith(expect.objectContaining({ action: NEW }));
    // an image avatar goes as an absolute URL
    const withImage = drawerData();
    withImage.account = { ...withImage.account, avatar: { kind: "image", src: "/api/a.png" } };
    view.rerender(shell(nav, "/agents", { drawer: withImage }));
    expect(nav.set).toHaveBeenLastCalledWith(
      expect.objectContaining({
        account: { ...ACCOUNT, avatarUrl: new URL("/api/a.png", window.location.href).href },
      }),
    );
  });

  it("onAction runs the primary, else opens the new conversation", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    const onNavigate = vi.fn();
    const run = vi.fn();
    const view = render(
      shell(fake.nav, "/agents", { onNavigate, primary: { id: "new-agent", label: "新建", run } }),
    );
    act(() => fake.action());
    expect(run).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
    view.rerender(shell(fake.nav, "/agents", { onNavigate }));
    act(() => fake.action());
    expect(run).toHaveBeenCalledTimes(1);
    // like a strip selection: no slide
    expect(onNavigate).toHaveBeenCalledWith("/", { transition: "none" });
  });

  it("onAction follows a link primary through the shell's navigation", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    const onNavigate = vi.fn();
    render(
      shell(fake.nav, "/agents", {
        onNavigate,
        primary: { id: "new-agent", label: "新建", href: "/agents/new" },
      }),
    );
    act(() => fake.action());
    expect(onNavigate).toHaveBeenCalledWith("/agents/new");
  });

  it("an inline primary run re-registers nothing and the tap calls the latest one", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    const calls: number[] = [];
    let renders = 0;
    function Inline({ n }: { n: number }) {
      renders++;
      useRegisterShellPage({ primary: { id: "p", label: "新建", run: () => calls.push(n) } });
      return null;
    }
    const tree = (n: number) => (
      <DesignProvider locale="zh">
        <AppShell
          sidebar={sidebar}
          status={status}
          pathname="/agents"
          drawer={drawerData()}
          nativeNav={fake.nav}
        >
          <Inline n={n} />
        </AppShell>
      </DesignProvider>
    );
    const view = render(tree(1));
    view.rerender(tree(2));
    expect(renders).toBeLessThan(10);
    act(() => fake.action());
    expect(calls).toEqual([2]);
  });

  it("onAccount opens the account sheet", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    render(shell(fake.nav, "/"));
    expect(accountSheet()).toBeNull();
    act(() => fake.account());
    expect(accountSheet()).not.toBeNull();
    expect(document.querySelector('[data-part="nav-drawer"]')).toBeNull();
  });

  it("search item opens the palette", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    render(shell(fake.nav, "/", { search: true }));
    expect(fake.nav.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ items: [...FOUR, { id: "search", label: "搜索" }] }),
    );
    expect(palette()).toBeNull();
    act(() => fake.select("search"));
    expect(palette()).not.toBeNull();
  });

  it("the CSS hides the web's menu button and section entries under data-native-nav", () => {
    expect(hidden("[data-native-nav] [data-nav-section]")).toBe(true);
    expect(hidden("[data-native-nav] .cb-shell-menu-btn")).toBe(true);
    // medium and expanded: the sidebar's other entries go too (mobile layout spec §4.3)
    expect(hidden("[data-native-nav] [data-nav-other]", "(min-width: 600px)")).toBe(true);
    expect(css("shell.css")).not.toContain(".cb-shell-bottomnav");
  });

  it("marks the menu button and the drawer's section rows for the CSS", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { nav } = fakeNav();
    render(shell(nav, "/"));
    const menuBtn = shellEl().querySelector(".cb-shell-menu-btn");
    expect(menuBtn).not.toBeNull();
    act(() => {
      fireEvent.click(menuBtn as Element);
    });
    const rows = [...document.querySelectorAll("[data-nav-section]")].map((r) =>
      r.getAttribute("data-nav-section"),
    );
    expect(rows).toEqual(expect.arrayContaining(["inbox", "agents", "schedules"]));
    // the "Skills, connectors, devices…" row stays
    expect(screen.getByText("更多").closest("[data-nav-section]")).toBeNull();
  });

  it("the sidebar marks its sections and its other entries; the account menu gains 更多", async () => {
    window.matchMedia = matchMediaFor(1000).matchMedia;
    const { nav } = fakeNav();
    render(shell(nav, "/"));
    const side = document.querySelector(".cb-sidebar") as HTMLElement;
    const section = (id: string) => side.querySelector(`[data-nav-section="${id}"]`);
    expect(section("agents")).not.toBeNull();
    expect(section("schedules")).not.toBeNull();
    expect(section("inbox")).not.toBeNull();
    expect(side.querySelector('a[href="/skills"]')?.hasAttribute("data-nav-other")).toBe(true);
    expect(side.querySelector('[data-part="more-toggle"]')?.hasAttribute("data-nav-other")).toBe(
      true,
    );
    // the account menu's first item: More with the entries that are not strip sections
    await userEvent.setup().click(side.querySelector('[data-part="account"]') as HTMLElement);
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["更多", "个人设置"]);
  });

  it("without the strip the account menu has no 更多", async () => {
    window.matchMedia = matchMediaFor(1000).matchMedia;
    render(shell(undefined, "/"));
    const side = document.querySelector(".cb-sidebar") as HTMLElement;
    await userEvent.setup().click(side.querySelector('[data-part="account"]') as HTMLElement);
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["个人设置"]);
  });

  it("a guest's items omit schedules, the route picks current, medium keeps 新会话 (D14)", () => {
    const mm = matchMediaFor(390);
    window.matchMedia = mm.matchMedia;
    const { nav } = fakeNav();
    const guest = drawerData({ sections: drawerData().sections.slice(0, 2) });
    const primary = { id: "p", label: "新建", run() {} };
    const view = render(shell(nav, "/inbox", { drawer: guest, primary }));
    expect(nav.set).toHaveBeenLastCalledWith({
      items: FOUR.slice(0, 3),
      current: "inbox",
      action: { id: "p", label: "新建", icon: "plus" },
      account: ACCOUNT,
    });
    view.rerender(shell(nav, "/account/preferences", { drawer: guest, primary }));
    expect(nav.set).toHaveBeenLastCalledWith(expect.objectContaining({ current: null }));
    view.rerender(shell(nav, "/conversations", { drawer: guest, primary }));
    expect(nav.set).toHaveBeenLastCalledWith(expect.objectContaining({ current: "chats" }));
    // the inner display: the head draws the primary, the pill's top item stays New conversation
    act(() => mm.resize(700));
    expect(nav.set).toHaveBeenLastCalledWith(expect.objectContaining({ action: NEW }));
  });

  it("an unchanged rerender and a new equivalent handle send nothing", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    const inline = (): NativeNavHandle => ({
      set: (s) => fake.nav.set(s),
      onSelect: (l) => fake.nav.onSelect(l),
      onAction: (l) => fake.nav.onAction(l),
      onAccount: (l) => fake.nav.onAccount(l),
    });
    const view = render(shell(inline(), "/"));
    view.rerender(shell(inline(), "/"));
    view.rerender(shell(inline(), "/"));
    expect(fake.nav.set).toHaveBeenCalledTimes(1);
    expect(fake.listeners()).toBe(3);
  });

  it("clamps a count above navCount, labels above navLabel and a name above navAccountName", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { nav } = fakeNav();
    const long = "长".repeat(80);
    const d = drawerData({
      sections: [
        { id: "inbox", label: long, href: "/inbox", icon: "inbox", badge: { count: 12000 } },
      ],
      menuBadge: { count: 12000 },
    });
    d.account = { ...d.account, name: long };
    render(shell(nav, "/", { drawer: d, primary: { id: "bad id!", label: long, run() {} } }));
    // the primary registers in the page's layout effect: the last state carries it
    const state = nav.set.mock.calls.at(-1)?.[0];
    expect(state?.items[1]).toEqual({
      id: "inbox",
      label: "长".repeat(32),
      count: 9999,
      countMore: true,
    });
    // an id outside the id pattern is replaced by a fixed one
    expect(state?.action).toEqual({ id: "primary", label: "长".repeat(32), icon: "plus" });
    expect(state?.account).toEqual({ name: "长".repeat(64), initial: "长" });
  });

  it("a native tap plays a selection haptic and navigates without a slide", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    const onNavigate = vi.fn();
    const haptics = vi.fn();
    const view = render(shell(fake.nav, "/", { onNavigate, native: { haptics } }));
    act(() => fake.select("agents"));
    expect(haptics).toHaveBeenCalledWith("selection");
    expect(onNavigate).toHaveBeenCalledWith("/agents", { transition: "none" });
    view.rerender(shell(fake.nav, "/agents", { onNavigate, native: { haptics } }));
    expect(document.querySelector(".cb-shell-main")?.hasAttribute("data-nav")).toBe(false);
    // the current section again, at its root: no second push of the same URL
    act(() => fake.select("agents"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    // below its root: back to the root
    view.rerender(shell(fake.nav, "/agents/a1", { onNavigate, native: { haptics } }));
    act(() => fake.select("agents"));
    expect(onNavigate).toHaveBeenLastCalledWith("/agents", { transition: "none" });
    act(() => fake.select("chats"));
    expect(onNavigate).toHaveBeenLastCalledWith("/", { transition: "none" });
  });

  it("a strip selection closes the open sheet first (fine pointer: no entries)", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    const onNavigate = vi.fn();
    render(shell(fake.nav, "/", { onNavigate }));
    act(() => fake.account());
    expect(accountSheet()).not.toBeNull();
    act(() => fake.select("inbox"));
    expect(accountSheet()).toBeNull();
    expect(onNavigate).toHaveBeenCalledWith("/inbox", { transition: "none" });
  });

  it("on touch a strip selection with the sheet open pops its entry first, then navigates", async () => {
    touchWindow();
    window.history.replaceState(null, "", "/");
    const fake = fakeNav();
    const at: { href: string; overlay: unknown }[] = [];
    const onNavigate = vi.fn((href: string) => {
      at.push({
        href,
        overlay: (window.history.state as Record<string, unknown> | null)?.cbOverlay,
      });
    });
    render(shell(fake.nav, "/", { onNavigate }));
    act(() => fake.account());
    expect((window.history.state as Record<string, unknown> | null)?.cbOverlay).toBeDefined();
    act(() => fake.select("inbox"));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    expect(at).toEqual([{ href: "/inbox", overlay: undefined }]);
    await waitFor(() => expect(accountSheet()).toBeNull());
  });

  it("the handle going away clears data-native-nav on the shell and <html>", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    const view = render(shell(fake.nav, "/"));
    expect(html().hasAttribute("data-native-nav")).toBe(true);
    view.rerender(shell(undefined, "/"));
    expect(shellEl().hasAttribute("data-native-nav")).toBe(false);
    expect(html().hasAttribute("data-native-nav")).toBe(false);
    expect(fake.listeners()).toBe(0);
    expect(fake.nav.set).toHaveBeenCalledTimes(1);
  });

  it("sends only the lockstep shape: no menu key, an action always", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    render(shell(fake.nav, "/agents", { search: true }));
    for (const [state] of fake.nav.set.mock.calls) {
      expect(Object.keys(state).sort()).toEqual(["account", "action", "current", "items"]);
    }
  });

  it("re-tapping 对话 on the home opens the conversations page (tab re-tap)", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    const onNavigate = vi.fn();
    const view = render(shell(fake.nav, "/", { onNavigate }));
    act(() => fake.select("chats"));
    expect(onNavigate).toHaveBeenLastCalledWith("/conversations", { transition: "none" });
    // from the conversations page or a conversation, Chats goes back to the home
    view.rerender(shell(fake.nav, "/conversations", { onNavigate }));
    act(() => fake.select("chats"));
    expect(onNavigate).toHaveBeenLastCalledWith("/", { transition: "none" });
    view.rerender(shell(fake.nav, "/chat/c1", { onNavigate }));
    act(() => fake.select("chats"));
    expect(onNavigate).toHaveBeenLastCalledWith("/", { transition: "none" });
    expect(onNavigate).toHaveBeenCalledTimes(3);
  });

  it("keeps the action and account within bounds and the avatar to https or own-origin http", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { nav } = fakeNav();
    const d = drawerData();
    d.account = {
      ...d.account,
      name: "",
      avatar: { kind: "image", src: "data:image/png;base64,AA" },
    };
    const view = render(
      shell(nav, "/agents", { drawer: d, primary: { id: "p", label: "", run() {} } }),
    );
    const state = nav.set.mock.calls.at(-1)?.[0];
    // an empty label falls back to the new conversation; an empty name sends no account
    expect(state?.action).toEqual(NEW);
    expect(state).not.toHaveProperty("account");
    const blob = drawerData();
    blob.account = { ...blob.account, avatar: { kind: "image", src: "blob:http://x/1" } };
    view.rerender(shell(nav, "/agents", { drawer: blob }));
    expect(nav.set.mock.calls.at(-1)?.[0].account).toEqual(ACCOUNT);
    // plain http only from the page's own origin; https from anywhere
    const avatarFrom = (src: string) => {
      const d2 = drawerData();
      d2.account = { ...d2.account, avatar: { kind: "image", src } };
      view.rerender(shell(nav, "/agents", { drawer: d2 }));
      return nav.set.mock.calls.at(-1)?.[0].account?.avatarUrl;
    };
    expect(avatarFrom("http://cdn.example/a.png")).toBeUndefined();
    expect(avatarFrom("https://cdn.example/b.png")).toBe("https://cdn.example/b.png");
    const own = `${window.location.origin}/c.png`;
    expect(window.location.protocol).toBe("http:");
    expect(avatarFrom(own)).toBe(own);
  });

  it("the avatar tapped while the account sheet is open closes it", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    render(shell(fake.nav, "/"));
    act(() => fake.account());
    const sheet = accountSheet();
    expect(sheet).not.toBeNull();
    act(() => fake.account());
    expect(accountSheet()).toBeNull();
    act(() => fake.account());
    expect(accountSheet()).not.toBeNull();
  });

  it("unmount unsubscribes the three listeners and calls nothing else", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    const view = render(shell(fake.nav, "/"));
    view.unmount();
    expect(fake.off).toHaveBeenCalledTimes(3);
    expect(fake.listeners()).toBe(0);
    expect(fake.nav.set).toHaveBeenCalledTimes(1);
  });

  it("without a nativeNav the shell carries no data-native-nav and leaves <html> alone", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    // the pre-paint script's mark stays until a handle was there and went
    html().setAttribute("data-native-nav", "");
    render(shell(undefined, "/"));
    expect(shellEl().hasAttribute("data-native-nav")).toBe(false);
    expect(html().hasAttribute("data-native-nav")).toBe(true);
  });
});
