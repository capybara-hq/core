import { webcrypto } from "node:crypto";
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
// Lexical (the composer's editor) scrolls its selection into view through the Range's boxes.
const emptyRect = () => new DOMRect(0, 0, 0, 0);
Range.prototype.getBoundingClientRect ??= emptyRect;
Range.prototype.getClientRects ??= () =>
  Object.assign([], { item: () => null }) as unknown as DOMRectList;
// By default no media query matches except ClassForms' wide query: pages render their medium /
// expanded form (ClassForms mounts the wide copy), while every other query (size classes, touch,
// reduced motion) stays false. A test that needs another window stubs window.matchMedia itself.
window.matchMedia ??= ((query: string) => ({
  matches: query.trim() === "(min-width: 600px)",
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof window.matchMedia;

// jsdom has neither `crypto.subtle` nor `Blob.arrayBuffer`; the composer hashes a file's bytes
// (SHA-256) before it uploads.
if (globalThis.crypto?.subtle === undefined) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(this);
    });
  };
}
