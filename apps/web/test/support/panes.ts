import { vi } from "vitest";

/**
 * jsdom measures nothing: give every element a width, so a ListDetail (the inbox) draws its two
 * panes. A test of the stack form sets a narrower width itself. Undo with `vi.restoreAllMocks()`.
 */
export function widePanes(width = 1000) {
  return vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
}
