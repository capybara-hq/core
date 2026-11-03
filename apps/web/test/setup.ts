import { notifyManager } from "@tanstack/react-query";
import { vi } from "vitest";

// The query cache tells its observers at once (the browser defers it to the next task): a
// stream event a test emits inside `act` renders before its assertions, as a reducer did.
notifyManager.setScheduler((cb) => cb());

// `server-only` throws outside a server build; server modules (lib/server/*) are tested here too.
vi.mock("server-only", () => ({}));

// jsdom 缺少 Radix / cmdk 与设计系统依赖的若干浏览器 API（apps/web 的 jsdom 测试共用）。
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
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof window.matchMedia;
