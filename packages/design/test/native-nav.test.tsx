// A native shell's navigation (`nav@1`). The chat-first shell has no tab items: until the strip
// rework (mobile touch plan Task 30) the AppShell only marks itself with `data-native-nav` and
// sends the handle nothing.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell, DesignProvider, type NativeNavHandle } from "../src/index";
import { css } from "./css-rules";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const sidebar = {
  context: { kind: "work" as const, org: null, primary: [], more: [] },
  activeNav: "",
  account: { name: "grant", menu: [] },
};
const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };

function fakeNav() {
  return { set: vi.fn<NativeNavHandle["set"]>(), onSelect: vi.fn(() => () => {}) };
}

const shell = (nav?: NativeNavHandle) => (
  <DesignProvider locale="zh">
    <AppShell
      sidebar={sidebar}
      status={status}
      pathname="/"
      chatSurface
      {...(nav ? { nativeNav: nav } : {})}
    >
      <div>内容</div>
    </AppShell>
  </DesignProvider>
);
const shellEl = () => document.querySelector(".cb-shell") as HTMLElement;

describe("the native navigation handle (nav@1), before the strip rework", () => {
  it("the web draws no bottom navigation of its own (chat-first shell)", () => {
    expect(css("shell.css")).not.toContain(".cb-shell-bottomnav");
    expect(css("shell.css")).not.toContain(".cb-bottomnav");
  });

  it("marks the shell and sends the handle nothing", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const nav = fakeNav();
    const view = render(shell(nav));
    expect(shellEl().hasAttribute("data-native-nav")).toBe(true);
    view.unmount();
    expect(nav.set).not.toHaveBeenCalled();
    expect(nav.onSelect).not.toHaveBeenCalled();
  });

  it("without a nativeNav the shell carries no data-native-nav", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    render(shell());
    expect(shellEl().hasAttribute("data-native-nav")).toBe(false);
  });
});
