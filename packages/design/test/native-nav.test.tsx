// A native shell's strip navigation (`nav@1`, mobile app spec §6.1; mobile touch plan Task 30): on
// the iPhone Duo inside the app the sections are a native tab bar in the strip. The AppShell hands
// it the four sections with the inbox count, the current one and the menu button (while compact),
// routes its taps and its menu button, and hides its own section entries and menu button while
// the handle is there.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  DesignProvider,
  type DrawerNavData,
  type NativeHandlers,
  type NativeNavHandle,
  type NativeSectionId,
} from "../src/index";
import { css, parseCss } from "./css-rules";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  document.documentElement.removeAttribute("data-native-nav");
});

const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };
const conversations = {
  state: "ready" as const,
  groups: [],
  moreGroups: false,
  onMoreGroups() {},
  onRetry() {},
  filter: { q: "", state: "all" as const, onChange() {} },
  archived: { count: 0, open: false, onOpenChange() {} },
  onRename: async () => {},
  onArchive: async () => {},
  onDelete: async () => {},
};

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
  const menu = new Set<() => void>();
  const off = vi.fn();
  const nav = {
    set: vi.fn<NativeNavHandle["set"]>(),
    onSelect: vi.fn((l: (id: NativeSectionId) => void) => {
      select.add(l);
      return () => {
        off();
        select.delete(l);
      };
    }),
    onMenu: vi.fn((l: () => void) => {
      menu.add(l);
      return () => {
        off();
        menu.delete(l);
      };
    }),
  };
  return {
    nav,
    off,
    listeners: () => select.size + menu.size,
    select(id: NativeSectionId) {
      for (const l of [...select]) l(id);
    },
    menu() {
      for (const l of [...menu]) l();
    },
  };
}

type Extra = {
  onNavigate?: (href: string, options?: { transition?: "none" }) => void;
  native?: NativeHandlers;
  drawer?: DrawerNavData;
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
      >
        <div>内容</div>
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
const MENU = { label: "打开菜单", count: 3 };
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
  it("sets the four sections, the current one and the menu once on a compact chat surface", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { nav } = fakeNav();
    render(shell(nav, "/"));
    expect(shellEl().hasAttribute("data-native-nav")).toBe(true);
    expect(html().hasAttribute("data-native-nav")).toBe(true);
    expect(nav.set).toHaveBeenCalledTimes(1);
    expect(nav.set).toHaveBeenLastCalledWith({ items: FOUR, current: "chats", menu: MENU });
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
    // the 「技能、连接器、设备…」 row stays
    expect(screen.getByText("技能、连接器、设备…").closest("[data-nav-section]")).toBeNull();
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
    // the account menu's first item: 更多 with the entries that are not strip sections
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

  it("medium sends menu null, a guest's items omit schedules, the route picks current", () => {
    const mm = matchMediaFor(390);
    window.matchMedia = mm.matchMedia;
    const { nav } = fakeNav();
    const guest = drawerData({ sections: drawerData().sections.slice(0, 2) });
    const view = render(shell(nav, "/inbox", { drawer: guest }));
    expect(nav.set).toHaveBeenLastCalledWith({
      items: FOUR.slice(0, 3),
      current: "inbox",
      menu: MENU,
    });
    view.rerender(shell(nav, "/account/preferences", { drawer: guest }));
    expect(nav.set).toHaveBeenLastCalledWith(expect.objectContaining({ current: null }));
    view.rerender(shell(nav, "/conversations", { drawer: guest }));
    expect(nav.set).toHaveBeenLastCalledWith(expect.objectContaining({ current: "chats" }));
    act(() => mm.resize(700));
    expect(nav.set).toHaveBeenLastCalledWith(expect.objectContaining({ menu: null }));
  });

  it("an unchanged rerender and a new equivalent handle send nothing", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    const inline = (): NativeNavHandle => ({
      set: (s) => fake.nav.set(s),
      onSelect: (l) => fake.nav.onSelect(l),
      onMenu: (l) => fake.nav.onMenu(l),
    });
    const view = render(shell(inline(), "/"));
    view.rerender(shell(inline(), "/"));
    view.rerender(shell(inline(), "/"));
    expect(fake.nav.set).toHaveBeenCalledTimes(1);
    expect(fake.listeners()).toBe(2);
  });

  it("clamps a count above navCount and a label above navLabel", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { nav } = fakeNav();
    const long = "长".repeat(40);
    const d = drawerData({
      sections: [
        { id: "inbox", label: long, href: "/inbox", icon: "inbox", badge: { count: 12000 } },
      ],
      menuBadge: { count: 12000 },
    });
    render(shell(nav, "/", { drawer: d }));
    const state = nav.set.mock.calls[0]?.[0];
    expect(state?.items[1]).toEqual({
      id: "inbox",
      label: "长".repeat(32),
      count: 9999,
      countMore: true,
    });
    expect(state?.menu).toEqual({ label: "打开菜单", count: 9999, countMore: true });
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
    // the current section again: its root
    act(() => fake.select("agents"));
    expect(onNavigate).toHaveBeenLastCalledWith("/agents", { transition: "none" });
    act(() => fake.select("chats"));
    expect(onNavigate).toHaveBeenLastCalledWith("/", { transition: "none" });
  });

  it("the strip's menu button toggles the drawer", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    render(shell(fake.nav, "/"));
    expect(document.querySelector('[data-part="nav-drawer"]')).toBeNull();
    act(() => fake.menu());
    expect(document.querySelector('[data-part="nav-drawer"]')).not.toBeNull();
    act(() => fake.menu());
    expect(document.querySelector('[data-part="nav-drawer"]')).toBeNull();
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

  it("unmount unsubscribes both listeners and calls nothing else", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    const view = render(shell(fake.nav, "/"));
    view.unmount();
    expect(fake.off).toHaveBeenCalledTimes(2);
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
