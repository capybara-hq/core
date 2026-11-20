// The native tab bar handle (mobile app spec §6.1): a shell's `nav@1` replaces the web's own bottom
// navigation. The AppShell tells it the four items, the current one and whether a bar belongs on
// screen now (exactly when the web would have shown its own), and routes its taps.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOTTOM_NAV_FIXTURE } from "../src/fixtures/index";
import {
  AppShell,
  type BottomNavItem,
  DesignProvider,
  type NativeHandlers,
  type NativeNavHandle,
  type NativeTabId,
} from "../src/index";
import { css, parseCss } from "./css-rules";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const items = BOTTOM_NAV_FIXTURE.items as BottomNavItem[];
const sidebar = {
  context: {
    kind: "work" as const,
    org: null,
    primary: [{ id: "agents", label: "智能体", href: "/agents", icon: "agent" as const }],
    more: [],
  },
  activeNav: "agents",
  account: { name: "grant", menu: [] },
};
const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };

function fakeNav() {
  const listeners = new Set<(id: NativeTabId) => void>();
  const off = vi.fn();
  const nav = {
    set: vi.fn<NativeNavHandle["set"]>(),
    onSelect: vi.fn((listener: (id: NativeTabId) => void) => {
      listeners.add(listener);
      return () => {
        off();
        listeners.delete(listener);
      };
    }),
  };
  return {
    nav,
    off,
    listeners,
    select(id: NativeTabId) {
      for (const l of [...listeners]) l(id);
    },
  };
}

function shell(
  nav: NativeNavHandle,
  pathname: string,
  extra: { onNavigate?: (href: string) => void; native?: NativeHandlers } = {},
) {
  return (
    <DesignProvider locale="zh" {...(extra.native ? { native: extra.native } : {})}>
      <AppShell
        sidebar={sidebar}
        status={status}
        commands={[]}
        bottomNav={items}
        pathname={pathname}
        nativeNav={nav}
        {...(extra.onNavigate ? { onNavigate: extra.onNavigate } : {})}
      >
        <div>内容</div>
      </AppShell>
    </DesignProvider>
  );
}

const FOUR = [
  { id: "chats", label: "会话" },
  { id: "agents", label: "智能体" },
  { id: "inbox", label: "收件箱", count: 3 },
  { id: "me", label: "我" },
];
const shellEl = () => document.querySelector(".cb-shell") as HTMLElement;

describe("the native tab bar (nav@1)", () => {
  it("CSS drops the web's bottom navigation under data-native-nav, at every width", () => {
    const rules = parseCss(css("shell.css"));
    const rule = rules.find(
      (r) => r.selector === "[data-native-nav] .cb-shell-bottomnav" && r.at === null,
    );
    expect(rule?.decls.display).toBe("none");
  });

  it("on a compact tab root: marks the shell and sets the four items once, visible", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { nav } = fakeNav();
    render(shell(nav, "/conversations"));
    expect(shellEl().hasAttribute("data-native-nav")).toBe(true);
    expect(nav.set).toHaveBeenCalledTimes(1);
    expect(nav.set).toHaveBeenLastCalledWith({ items: FOUR, current: "chats", visible: true });
  });

  it("hides on a pushed route, with the keyboard open and at medium width; no call without a change", async () => {
    const mm = matchMediaFor(390);
    window.matchMedia = mm.matchMedia;
    const { nav } = fakeNav();
    const view = render(shell(nav, "/conversations"));
    expect(nav.set).toHaveBeenCalledTimes(1);
    // an unchanged rerender: no extra call
    view.rerender(shell(nav, "/conversations"));
    expect(nav.set).toHaveBeenCalledTimes(1);
    // a pushed route
    view.rerender(shell(nav, "/agents/new"));
    expect(nav.set).toHaveBeenCalledTimes(2);
    expect(nav.set).toHaveBeenLastCalledWith({ items: FOUR, current: "agents", visible: false });
    // back to a tab root, then the keyboard opens
    view.rerender(shell(nav, "/inbox"));
    expect(nav.set).toHaveBeenLastCalledWith({ items: FOUR, current: "inbox", visible: true });
    await act(async () => {
      shellEl().dataset.keyboard = "open";
    });
    expect(nav.set).toHaveBeenLastCalledWith({ items: FOUR, current: "inbox", visible: false });
    await act(async () => {
      delete shellEl().dataset.keyboard;
    });
    expect(nav.set).toHaveBeenLastCalledWith({ items: FOUR, current: "inbox", visible: true });
    // medium width
    act(() => mm.resize(700));
    expect(nav.set).toHaveBeenLastCalledWith({ items: FOUR, current: "inbox", visible: false });
  });

  it("a native tap navigates to the item's href with a selection haptic; unmount unsubscribes", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    const onNavigate = vi.fn();
    const haptics = vi.fn();
    const view = render(shell(fake.nav, "/conversations", { onNavigate, native: { haptics } }));
    act(() => fake.select("inbox"));
    expect(onNavigate).toHaveBeenCalledWith("/inbox");
    expect(haptics).toHaveBeenCalledWith("selection");
    view.unmount();
    expect(fake.off).toHaveBeenCalledTimes(1);
    expect(fake.listeners.size).toBe(0);
  });

  it("a new but equivalent handle on every parent render sends nothing and never hides the bar", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const fake = fakeNav();
    const onNavigate = vi.fn();
    // a parent that builds the handle inline: a new object per render, the same shell behind it
    const inline = (): NativeNavHandle => ({
      set: (state) => fake.nav.set(state),
      onSelect: (listener) => fake.nav.onSelect(listener),
    });
    const view = render(shell(inline(), "/conversations", { onNavigate }));
    expect(fake.nav.set).toHaveBeenCalledTimes(1);
    view.rerender(shell(inline(), "/conversations", { onNavigate }));
    view.rerender(shell(inline(), "/conversations", { onNavigate }));
    expect(fake.nav.set).toHaveBeenCalledTimes(1);
    // taps still reach the shell, through one live subscription
    expect(fake.listeners.size).toBe(1);
    act(() => fake.select("agents"));
    expect(onNavigate).toHaveBeenCalledWith("/agents");
    // a real change goes to the latest handle
    view.rerender(shell(inline(), "/agents/new", { onNavigate }));
    expect(fake.nav.set).toHaveBeenCalledTimes(2);
    expect(fake.nav.set).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    // unmount: hidden once, unsubscribed
    view.unmount();
    expect(fake.nav.set).toHaveBeenCalledTimes(3);
    expect(fake.nav.set).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    expect(fake.listeners.size).toBe(0);
  });

  it("without a nativeNav the shell carries no data-native-nav", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    render(
      <DesignProvider locale="zh">
        <AppShell sidebar={sidebar} status={status} bottomNav={items} pathname="/conversations">
          <div>内容</div>
        </AppShell>
      </DesignProvider>,
    );
    expect(shellEl().hasAttribute("data-native-nav")).toBe(false);
  });
});
