// The compact shell's reference blocks (design spec §6.45 BottomNav, §6.46 TopBar, §6.48 MePanel):
// every listed state has its block and every size-table row its part, as the fidelity spec
// measures them (the three join ACCEPTED with their side-by-side acceptance).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DesignProvider, ToastProvider } from "@capybara-hq/design";
import {
  missingStates,
  parseSizeTables,
  parseStateLists,
  partSelector,
} from "@capybara-hq/design/reference";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/dev/catalog";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));

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

const spec = readFileSync(resolve(import.meta.dirname, "../../../docs/design/spec.md"), "utf8");
const COMPONENTS = ["bottom-nav", "top-bar", "me-panel"] as const;

function renderBlocks(component: string) {
  return render(
    <DesignProvider locale="zh">
      <ToastProvider>
        <Catalog route={`reference/${component}`} />
      </ToastProvider>
    </DesignProvider>,
  );
}

describe.each(COMPONENTS)("reference/%s", (component) => {
  it("has a block for every listed state", () => {
    const { container } = renderBlocks(component);
    const ids = [...container.querySelectorAll("[data-ref-block]")].map(
      (b) => b.getAttribute("data-ref-block") ?? "",
    );
    expect(missingStates(parseStateLists(spec), ids, [component])).toEqual([]);
  });

  it("has the part of every size-table row in its state's block", () => {
    const { container } = renderBlocks(component);
    const rows = parseSizeTables(spec).find((t) => t.component === component)?.rows ?? [];
    expect(rows.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const r of rows) {
      const block = container.querySelector(`[data-ref-block="${component}-${r.state}"]`);
      const sel = partSelector(r.part);
      const el = block === null ? null : sel === ":scope" ? block : block.querySelector(sel);
      if (el === null) missing.push(`${component}-${r.state} ${r.part} (spec.md:${r.line})`);
    }
    expect(missing).toEqual([]);
  });
});
