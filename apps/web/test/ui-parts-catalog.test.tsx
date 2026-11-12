import { DesignProvider, ToastProvider } from "@capybara-hq/design";
import { UI_PART_NAMES } from "@capybara-hq/design/reference";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/dev/catalog";
import { CATALOG_ROUTES, REFERENCE_ROUTES } from "../src/dev/catalog/routes";

// the catalog draws the /schedules calendar page, whose view navigates through the app's router
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/server", () => ({ connection: async () => {} }));

beforeAll(() => {
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
});

afterEach(cleanup);

describe("data-cap-part in /dev/ui", () => {
  it("every catalog part renders in the catalog and reference routes, and nothing else does", {
    timeout: 60_000,
  }, () => {
    const seen = new Set<string>();
    for (const route of [...CATALOG_ROUTES, ...REFERENCE_ROUTES]) {
      render(
        <DesignProvider locale="zh">
          <ToastProvider>
            <Catalog route={route} />
          </ToastProvider>
        </DesignProvider>,
      );
      for (const el of document.querySelectorAll("[data-cap-part]")) {
        for (const t of (el.getAttribute("data-cap-part") ?? "").split(/\s+/)) seen.add(t);
      }
      cleanup();
    }
    // message.assistant is drawn by apps/web's Thread (no design block); its test is
    // conversation-interjections.test.tsx.
    const expected = UI_PART_NAMES.filter((n) => n !== "message.assistant");
    expect([...seen].sort()).toEqual([...expected].sort());
  });
});
