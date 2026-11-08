import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, DesignProvider, isTouchPointer, keyboardInset } from "../src/index";

// Phones (spec §4.3, maintainer acceptance 2026-11-09): iOS keeps the layout viewport when the
// keyboard opens, so the shell measures the keyboard (`--cb-keyboard-inset`) and the conversation
// page lifts its column by it; a touch device never gets the composer focused by a tap on a choice.

const sidebar = {
  context: {
    kind: "work" as const,
    org: { name: "Acme", initial: "A", slug: "acme", role: "所有者", menu: [] },
    primary: [{ id: "agents", label: "Agents", href: "/agents", icon: "agent" as const }],
    more: [],
  },
  newConversation: { href: "/" },
  activeNav: "agents",
  account: { name: "grant", menu: [] },
};
const status = { context: "grant@acme:/", version: "0.1.0" };

/** A stub `visualViewport` the test resizes, with the listeners it was given. */
class FakeViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
  set(height: number, offsetTop = 0) {
    this.height = height;
    this.offsetTop = offsetTop;
    this.dispatchEvent(new Event("resize"));
  }
}

const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
const originalMatchMedia = window.matchMedia;
let vv: FakeViewport;

beforeEach(() => {
  vv = new FakeViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.matchMedia = originalMatchMedia;
  if (original) Object.defineProperty(window, "visualViewport", original);
  else Reflect.deleteProperty(window, "visualViewport");
});

const renderShell = () =>
  render(
    <DesignProvider locale="zh">
      <AppShell sidebar={sidebar} status={status}>
        <textarea aria-label="消息" />
      </AppShell>
    </DesignProvider>,
  );

describe("the keyboard inset (spec §4.3)", () => {
  it("is the keyboard's height over the shell's bottom, never below 0", () => {
    expect(keyboardInset({ height: 500, offsetTop: 0 }, 844)).toBe(344);
    // iOS panned the visual viewport: the part it still shows is not covered
    expect(keyboardInset({ height: 500, offsetTop: 100 }, 844)).toBe(244);
    expect(keyboardInset({ height: 844, offsetTop: 0 }, 844)).toBe(0);
    expect(keyboardInset({ height: 900, offsetTop: 0 }, 844)).toBe(0);
  });

  it("the shell carries it while the keyboard is open, and does not scroll the document then", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const { container } = renderShell();
    const shell = container.querySelector(".cb-shell") as HTMLElement;
    Object.defineProperty(window, "scrollY", { configurable: true, value: 40 });
    act(() => vv.set(500, 40));
    expect(shell.style.getPropertyValue("--cb-keyboard-inset")).toBe("304px");
    expect(shell.dataset.keyboard).toBe("open");
    // open: the inset lifts the composer; the document is left alone
    expect(scrollTo).not.toHaveBeenCalled();
    // closed: no inset, and the document goes back to the top (the scroll-back of b84a7cec)
    act(() => vv.set(844, 0));
    expect(shell.style.getPropertyValue("--cb-keyboard-inset")).toBe("0px");
    expect(shell.dataset.keyboard).toBeUndefined();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  it("follows the visual viewport's scroll too, and lets go of its listeners on unmount", () => {
    const remove = vi.spyOn(vv, "removeEventListener");
    const { container, unmount } = renderShell();
    const shell = container.querySelector(".cb-shell") as HTMLElement;
    vv.height = 600;
    vv.offsetTop = 0;
    act(() => {
      vv.dispatchEvent(new Event("scroll"));
    });
    expect(shell.style.getPropertyValue("--cb-keyboard-inset")).toBe("244px");
    unmount();
    expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual(["resize", "scroll"]);
  });

  it("the conversation page lifts its column by it and drops the status bar while it is open", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles/conversation-page.css"), "utf8");
    expect(css).toMatch(/\.cb-conv-page \{[^}]*padding-bottom: var\(--cb-keyboard-inset, 0px\);/);
    expect(css).toMatch(
      /\.cb-shell\[data-keyboard="open"\] \.cb-conv-page \.cb-statusbar \{\s*display: none;/,
    );
  });
});

describe("isTouchPointer", () => {
  const media = (matching: string[]) => {
    window.matchMedia = ((query: string) => ({
      matches: matching.includes(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  };

  it("is true for a coarse primary pointer, or a coarse pointer and no fine one", () => {
    media(["(pointer: coarse)", "(any-pointer: coarse)"]);
    expect(isTouchPointer()).toBe(true);
    media(["(any-pointer: coarse)"]);
    expect(isTouchPointer()).toBe(true);
    // a laptop with a touch screen: the mouse is the primary pointer
    media(["(pointer: fine)", "(any-pointer: fine)", "(any-pointer: coarse)"]);
    expect(isTouchPointer()).toBe(false);
    // a desktop, or nothing known
    media([]);
    expect(isTouchPointer()).toBe(false);
  });
});
