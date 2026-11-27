// Push and pop transitions (mobile app spec §7.2, §4.4): the slide is tuned to the platform by
// tokens, a pop the browser already animated (a back gesture: `hasUAVisualTransition`) swaps at
// once, and a move between chat surfaces (or a native shell's tab roots) never slides.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell, DesignProvider, withViewTransition } from "../src/index";
import { goBack, SETTLE_LIMIT_MS } from "../src/shell/floating-bar";
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
/** The chat surfaces (the home and a conversation) are one level; every other page is pushed. */
const chatSurface = (pathname: string) => pathname === "/" || pathname.startsWith("/chat/");
const shell = (pathname: string) => (
  <DesignProvider locale="zh">
    <AppShell sidebar={sidebar} pathname={pathname} chatSurface={chatSurface(pathname)}>
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
    popTo("/", true);
    rerender(shell("/"));
    expect(main().getAttribute("data-nav")).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("hasUAVisualTransition false: the web slides back", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents/new");
    const { rerender } = render(shell("/agents/new"));
    popTo("/", false);
    rerender(shell("/"));
    expect(main().getAttribute("data-nav")).toMatch(/^pop-/);
  });

  it("is consumed once: a later push slides again", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/agents/new");
    const { rerender } = render(shell("/agents/new"));
    popTo("/", true);
    rerender(shell("/"));
    window.history.pushState(null, "", "/agents/new");
    rerender(shell("/agents/new"));
    expect(main().getAttribute("data-nav")).toMatch(/^push-/);
  });

  it("a gesture that changed no route does not swallow the next push's slide", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    window.history.replaceState(null, "", "/");
    const { rerender } = render(shell("/"));
    // a back within the page (a hash) the browser animated: the route stays
    popTo("/#x", true);
    window.history.pushState(null, "", "/agents/new");
    rerender(shell("/agents/new"));
    expect(main().getAttribute("data-nav")).toMatch(/^push-/);
  });
});

describe("a pop the back button animates with a view transition", () => {
  it("sets no CSS slide, so the page does not slide in again once the transition ends", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    let finish: () => void = () => {};
    let update: Promise<unknown> = Promise.resolve();
    doc.startViewTransition = vi.fn((cb: () => unknown) => {
      update = Promise.resolve(cb());
      return { finished: new Promise<void>((r) => (finish = r)) };
    });
    window.history.replaceState(null, "", "/");
    const { rerender } = render(shell("/"));
    window.history.pushState(null, "", "/inbox");
    rerender(shell("/inbox"));
    expect(main().getAttribute("data-nav")).toMatch(/^push-/);
    // the back button: the route changes inside the view transition's update
    withViewTransition(() => {
      window.history.replaceState(null, "", "/");
      rerender(shell("/"));
    }, "pop");
    await act(async () => {
      await update;
    });
    expect(document.documentElement.dataset.cbTransition).toBe("pop");
    expect(main().getAttribute("data-nav")).toBeNull();
    await act(async () => {
      finish();
    });
    expect(document.documentElement.dataset.cbTransition).toBeUndefined();
    expect(main().getAttribute("data-nav")).toBeNull();
  });
});

describe("goBack settles on the new route, not on a frame", () => {
  // Inside a view transition's update the browser renders no frame until the update settles, so
  // a requestAnimationFrame never runs there: model that with a frame that never comes.
  const realRaf = window.requestAnimationFrame;
  afterEach(() => {
    window.requestAnimationFrame = realRaf;
    vi.useRealTimers();
  });
  const noFrames = () => {
    window.requestAnimationFrame = (() => 0) as typeof window.requestAnimationFrame;
  };

  it("resolves once the shell commits the route the back landed on", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    noFrames();
    window.history.replaceState(null, "", "/");
    const { rerender } = render(shell("/"));
    window.history.pushState(null, "", "/inbox");
    rerender(shell("/inbox"));
    // the router: a popstate renders the page the history now points at
    const onPop = () => act(() => rerender(shell(window.location.pathname)));
    window.addEventListener("popstate", onPop, { once: true });
    const t0 = performance.now();
    await goBack();
    expect(window.location.pathname).toBe("/");
    expect(performance.now() - t0).toBeLessThan(SETTLE_LIMIT_MS / 2);
  });

  it("resolves after the popstate when the back changed no route", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    noFrames();
    window.history.replaceState(null, "", "/agents");
    render(shell("/agents"));
    window.history.pushState(null, "", "/agents#x");
    const t0 = performance.now();
    await goBack();
    expect(window.location.hash).toBe("");
    expect(performance.now() - t0).toBeLessThan(SETTLE_LIMIT_MS / 2);
  });

  it("still resolves at the bound when no popstate comes", async () => {
    vi.useFakeTimers();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    let settled = false;
    void goBack().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(SETTLE_LIMIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    back.mockRestore();
  });
});

describe("moves on one level never slide", () => {
  const chat = (pathname: string, chatSurface: boolean) => (
    <DesignProvider locale="zh">
      <AppShell sidebar={sidebar} pathname={pathname} chatSurface={chatSurface}>
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

  it("the slides run only on compact without reduced motion, in nested queries every engine reads", () => {
    // `(not (min-width: 600px)) and (…)` is Media Queries 4 range syntax (Safari 16.4+): the
    // compact query nests inside the motion query instead.
    expect(source).not.toMatch(/@media \(not \(min-width: 600px\)\)/);
    const at = source.indexOf("@media (prefers-reduced-motion: no-preference) {");
    expect(at).toBeGreaterThan(-1);
    const nested = source.slice(at).match(/^@media[^{]*\{\s*@media ([^{]*)\{/);
    expect(nested?.[1]?.trim()).toBe("not all and (min-width: 600px)");
    expect(source.indexOf('.cb-shell-main[data-nav="push-0"]', at)).toBeGreaterThan(at);
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
