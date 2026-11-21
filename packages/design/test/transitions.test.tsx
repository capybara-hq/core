// Push and pop transitions (mobile app spec §7.2, §4.4): the slide is tuned to the platform by
// tokens, a pop the browser already animated (a back gesture: `hasUAVisualTransition`) swaps at
// once, and a move between chat surfaces (or a native shell's tab roots) never slides.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  DesignProvider,
  type NativeNavHandle,
  type NativeTabId,
  withViewTransition,
} from "../src/index";
import { css, parseCss } from "./css-rules";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;
const doc = document as unknown as { startViewTransition?: unknown };
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  delete doc.startViewTransition;
  delete document.documentElement.dataset.cbTransition;
  window.history.replaceState(null, "", "/");
});

const sidebar = {
  context: { kind: "work" as const, org: null, primary: [], more: [] },
  activeNav: "",
  account: { name: "grant", menu: [] },
};
const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };
const items = [
  { id: "chats" as const, label: "会话", href: "/conversations", icon: "chats" as const },
  { id: "agents" as const, label: "智能体", href: "/agents", icon: "agent" as const },
  { id: "inbox" as const, label: "收件箱", href: "/inbox", icon: "inbox" as const },
  { id: "me" as const, label: "我", href: "/me", icon: "user" as const },
];
const shell = (
  pathname: string,
  extra: { nativeNav?: NativeNavHandle; onNavigate?: (href: string) => void } = {},
) => (
  <DesignProvider locale="zh">
    <AppShell sidebar={sidebar} status={status} bottomNav={items} pathname={pathname} {...extra}>
      <div>内容</div>
    </AppShell>
  </DesignProvider>
);
const main = () => document.querySelector("main") as HTMLElement;

/** The browser's popstate for a back to `url`, with `hasUAVisualTransition` as jsdom lacks it. */
function popTo(url: string, uaTransition: boolean) {
  window.history.replaceState(null, "", url);
  const e = new PopStateEvent("popstate");
  Object.defineProperty(e, "hasUAVisualTransition", { value: uaTransition });
  act(() => {
    window.dispatchEvent(e);
  });
}

describe("a pop the browser already animated", () => {
  it("hasUAVisualTransition true: no slide and no view transition (an instant swap)", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const start = vi.fn();
    doc.startViewTransition = start;
    window.history.replaceState(null, "", "/agents/new");
    const { rerender } = render(shell("/agents/new"));
    popTo("/agents", true);
    rerender(shell("/agents"));
    expect(main().getAttribute("data-nav")).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("hasUAVisualTransition false: the web slides back", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents/new");
    const { rerender } = render(shell("/agents/new"));
    popTo("/agents", false);
    rerender(shell("/agents"));
    expect(main().getAttribute("data-nav")).toMatch(/^pop-/);
  });

  it("is consumed once: a later push slides again", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents/new");
    const { rerender } = render(shell("/agents/new"));
    popTo("/agents", true);
    rerender(shell("/agents"));
    window.history.pushState(null, "", "/agents/new");
    rerender(shell("/agents/new"));
    expect(main().getAttribute("data-nav")).toMatch(/^push-/);
  });

  it("a gesture that changed no route does not swallow the next push's slide", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents");
    const { rerender } = render(shell("/agents"));
    // a back within the page (a hash) the browser animated: the route stays
    popTo("/agents#x", true);
    window.history.pushState(null, "", "/agents/new");
    rerender(shell("/agents/new"));
    expect(main().getAttribute("data-nav")).toMatch(/^push-/);
  });
});

describe("moves on one level never slide", () => {
  const chat = (pathname: string, chatSurface: boolean) => (
    <DesignProvider locale="zh">
      <AppShell sidebar={sidebar} status={status} pathname={pathname} chatSurface={chatSurface}>
        <div>内容</div>
      </AppShell>
    </DesignProvider>
  );

  it("chat surface to chat surface, also right after a pop (the chat-first shell)", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { rerender } = render(chat("/inbox", false));
    rerender(chat("/chat/c1", true));
    expect(main().getAttribute("data-nav")).toMatch(/^pop-/);
    rerender(chat("/", true));
    expect(main().getAttribute("data-nav")).toBeNull();
  });

  it("root to root through the native tab bar (nativeNav.onSelect)", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const listeners = new Set<(id: NativeTabId) => void>();
    const nativeNav: NativeNavHandle = {
      set: vi.fn(),
      onSelect: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    let view: ReturnType<typeof render> | null = null;
    const onNavigate = (href: string) => view?.rerender(shell(href, { nativeNav, onNavigate }));
    view = render(shell("/conversations", { nativeNav, onNavigate }));
    act(() => {
      for (const l of [...listeners]) l("inbox");
    });
    expect(main().getAttribute("data-nav")).toBeNull();
    act(() => {
      for (const l of [...listeners]) l("agents");
    });
    expect(main().getAttribute("data-nav")).toBeNull();
  });
});

describe("withViewTransition { skip }", () => {
  it("skip: true runs the update at once without a view transition", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const start = vi.fn();
    doc.startViewTransition = start;
    const update = vi.fn();
    withViewTransition(update, "pop", { skip: true });
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.cbTransition).toBeUndefined();
  });

  it("skip: false still uses the view transition", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const start = vi.fn((cb: () => unknown) => {
      void cb();
      return { finished: Promise.resolve() };
    });
    doc.startViewTransition = start;
    const update = vi.fn();
    withViewTransition(update, "pop", { skip: false });
    expect(start).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("transition CSS", () => {
  const source = css("shell.css");
  const rules = parseCss(source);
  const keyframes = (name: string) => {
    const m = source.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`));
    return (m?.[1] ?? "").replace(/\s+/g, " ");
  };

  it("push and pop animations run over motion.push with ease.push", () => {
    for (const nav of ["push-0", "push-1", "pop-0", "pop-1"]) {
      const rule = rules.find((r) => r.selector === `.cb-shell-main[data-nav="${nav}"]`);
      expect(rule?.decls.animation, nav).toBe(
        `cb-${nav} var(--cb-motion-push) var(--cb-ease-push)`,
      );
    }
  });

  it("the view-transition pop parallaxes and dims the page underneath, the top page leaves", () => {
    const old = rules.find(
      (r) => r.selector === ':root[data-cb-transition="pop"]::view-transition-old(root)',
    );
    const next = rules.find(
      (r) => r.selector === ':root[data-cb-transition="pop"]::view-transition-new(root)',
    );
    expect(old?.decls.animation).toBe("cb-pop-out var(--cb-motion-push) var(--cb-ease-push) both");
    expect(old?.decls["z-index"]).toBe("1");
    // no plus-lighter blend from the UA: it would add the opaque top page to the page under it
    expect(old?.decls["mix-blend-mode"]).toBe("normal");
    expect(next?.decls["mix-blend-mode"]).toBe("normal");
    expect(next?.decls.animation).toBe(
      "cb-pop-under var(--cb-motion-push) var(--cb-ease-push) both",
    );
    expect(keyframes("cb-pop-under")).toContain("transform: translateX(-30%)");
    expect(keyframes("cb-pop-under")).toContain("filter: brightness(0.9)");
    expect(keyframes("cb-pop-out")).toContain("transform: translateX(100%)");
    // the CSS-only pop brings the page back from the same parallax and dim, fading in early so
    // the shell ground never shows at the end edge
    for (const name of ["cb-pop-0", "cb-pop-1"]) {
      expect(keyframes(name)).toContain("transform: translateX(-30%)");
      expect(keyframes(name)).toContain("filter: brightness(0.9)");
      expect(keyframes(name)).toMatch(/from \{[^}]*opacity: 0;[^}]*\} 40% \{ opacity: 1; \}/);
    }
  });

  it("reduced motion sets no animation on a sliding page", () => {
    const rule = rules.find(
      (r) =>
        r.at === "(prefers-reduced-motion: reduce)" && r.selector === ".cb-shell-main[data-nav]",
    );
    expect(rule?.decls.animation).toBe("none");
  });
});

describe("platform motion tokens", () => {
  const tokens = readFileSync(resolve(import.meta.dirname, "../src/styles/tokens.css"), "utf8");
  const block = (selector: string) => {
    const at = tokens.indexOf(`${selector} {`);
    return at < 0 ? "" : tokens.slice(at, tokens.indexOf("}", at));
  };

  it("the iOS navigation default by default, Material emphasized on Android", () => {
    expect(block(":root")).toContain("--cb-motion-push: 350ms;");
    expect(block(":root")).toContain("--cb-ease-push: cubic-bezier(0.2, 0.9, 0.3, 1);");
    const android = block(':root[data-shell-platform="android"]');
    expect(android).toContain("--cb-motion-push: 300ms;");
    expect(android).toContain("--cb-ease-push: cubic-bezier(0.2, 0, 0, 1);");
  });
});
