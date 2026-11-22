import { act } from "@testing-library/react";
import { vi } from "vitest";

/** Whether media query `q` matches a window `width` px wide (min-/max-width, `not all and`). */
const matchesAt = (q: string, width: number) => {
  const plain = (s: string) => {
    const features = [...s.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
    return (
      features.length > 0 &&
      features.every(([, k, n]) => (k === "min" ? width >= Number(n) : width <= Number(n)))
    );
  };
  return q
    .split(",")
    .map((s) => s.trim())
    .some((part) => {
      const neg = /^not\s+all\s+and\s+/.exec(part);
      return neg ? !plain(part.slice(neg[0].length)) : plain(part);
    });
};

/**
 * Stubs `window.matchMedia` for a window `width` px wide; the returned `setWidth` changes the width
 * and fires every subscribed `change` listener, as a real window resize does.
 */
export function stubWindowWidth(width: number) {
  let current = width;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (q: string) => ({
    get matches() {
      return matchesAt(q, current);
    },
    media: q,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return {
    setWidth(next: number) {
      current = next;
      act(() => {
        for (const fn of [...listeners]) fn();
      });
    },
  };
}
