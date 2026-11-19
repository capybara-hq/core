/**
 * A `window.matchMedia` stand-in for a window `width` CSS px wide (and `height` high): evaluates
 * `min-` / `max-` `width` / `height` features joined by `and` and `,`; other queries do not match.
 * Listeners are kept so a test can resize the window with `resize()`.
 */
export function matchMediaFor(width: number, height = 900) {
  const listeners = new Set<() => void>();
  const state = { width, height };
  const one = (q: string): boolean => {
    const features = [...q.matchAll(/\((min|max)-(width|height):\s*(\d+)px\)/g)];
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
