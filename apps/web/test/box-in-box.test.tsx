import { DesignProvider, ToastProvider } from "@capybara-hq/design";
import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/dev/catalog";
import { CATALOG_ROUTES, REFERENCE_ROUTES } from "../src/dev/catalog/routes";

// The box-in-box guard on the /dev/ui catalog (spec §1 "One box is enough", §9.1, acceptance
// item AB): no catalog or reference block draws a boxed design component inside another. The app
// pages are guarded statically by `web-ui-box-in-box` (`pnpm check:web-ui`).

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

function renderRoute(route: string) {
  return render(
    <DesignProvider locale="zh">
      <ToastProvider>
        <Catalog route={route} />
      </ToastProvider>
    </DesignProvider>,
  );
}

describe("/dev/ui draws no box inside a box", () => {
  it.each([...CATALOG_ROUTES, ...REFERENCE_ROUTES])("%s", (route) => {
    renderRoute(route);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});
