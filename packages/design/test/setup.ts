// jsdom 缺少 Radix / cmdk 依赖的若干浏览器 API。
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
// Lexical (the composer's editor) scrolls its selection into view through the Range's boxes.
const emptyRect = () => new DOMRect(0, 0, 0, 0);
Range.prototype.getBoundingClientRect ??= emptyRect;
Range.prototype.getClientRects ??= () =>
  Object.assign([], { item: () => null }) as unknown as DOMRectList;
// By default no media query matches except ClassForms' wide query: a test window is a wide one
// (ClassForms mounts the medium / expanded copy, useClassForm is "wide"), while every other query
// (size classes, touch, reduced motion) stays false. Tests override window.matchMedia (see
// renderAtClass in width.ts for a window of a given width).
window.matchMedia ??= ((query: string) => ({
  matches: query.trim() === "(min-width: 600px)",
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof window.matchMedia;
