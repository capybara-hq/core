import { act, type RenderResult, render } from "@testing-library/react";
import { type ComponentProps, createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { DesignProvider } from "../src/index";

/** `createElement` takes the children as its third argument. */
type DesignProviderProps = ComponentProps<typeof DesignProvider>;

/**
 * A `window.matchMedia` stand-in for a window `width` CSS px wide (and `height` high): evaluates
 * `min-` / `max-` `width` / `height` features joined by `and` and `,`, each comma part optionally
 * negated by a leading `not all and` (the compact query); other queries do not match.
 * Listeners are kept so a test can resize the window with `resize()`.
 */
export function matchMediaFor(width: number, height = 900) {
  const listeners = new Set<() => void>();
  const state = { width, height };
  const one = (part: string): boolean => {
    const negated = /^not\s+all\s+and\s+/.exec(part);
    if (negated) return !plain(part.slice(negated[0].length));
    return plain(part);
  };
  const plain = (q: string): boolean => {
    const features = [...q.matchAll(/\((min|max)-(width|height):\s*(\d+(?:\.\d+)?)px\)/g)];
    if (features.length === 0) return false;
    return features.every(([, kind, dim, n]) => {
      const v = dim === "width" ? state.width : state.height;
      return kind === "min" ? v >= Number(n) : v <= Number(n);
    });
  };
  const matches = (q: string) =>
    q
      .split(",")
      .map((s) => s.trim())
      .some(one);
  const mm = ((q: string) => ({
    get matches() {
      return matches(q);
    },
    media: q,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  })) as unknown as typeof window.matchMedia;
  return {
    matchMedia: mm,
    /** Resize the window and notify every subscriber. */
    resize(w: number, h = state.height) {
      state.width = w;
      state.height = h;
      for (const fn of [...listeners]) fn();
    },
  };
}

/**
 * Renders `ui` the way a page arrives at a window `width` CSS px wide: stubs `window.matchMedia`
 * with `matchMediaFor(width)`, server-renders inside `DesignProvider locale="zh"`, hydrates that
 * markup and flushes the hydration re-render, so size-class forms are already pruned. `resize`
 * moves the window across classes. The caller restores `window.matchMedia` after the test.
 */
export function renderAtClass(
  width: number,
  ui: ReactElement,
): RenderResult & { resize: (width: number) => void } {
  const mm = matchMediaFor(width);
  window.matchMedia = mm.matchMedia;
  const tree = createElement(DesignProvider, { locale: "zh" } as DesignProviderProps, ui);
  const container = document.createElement("div");
  document.body.append(container);
  container.innerHTML = renderToString(tree);
  const result = render(tree, { container, hydrate: true });
  return { ...result, resize: (w: number) => act(() => mm.resize(w)) };
}
