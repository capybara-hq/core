import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, ListDetail, useViewportSegments } from "../src/index";
import { css, parseCss } from "./css-rules";

type Win = Window & { viewport?: unknown };
const A = { x: 0, y: 0, width: 400, height: 800 };
const B = { x: 420, y: 0, width: 500, height: 800 };

function setSegments(segments: unknown[] | undefined) {
  (window as Win).viewport = segments ? { segments } : undefined;
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    (q: string) =>
      ({
        media: q,
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  window.matchMedia = globalThis.matchMedia;
});
afterEach(() => {
  cleanup();
  setSegments(undefined);
  vi.unstubAllGlobals();
});

const region = () => (
  <DesignProvider locale="en">
    <ListDetail
      list={<p>LIST</p>}
      detail={null}
      onBack={() => {}}
      listMin={320}
      detailMin={360}
      label="Inbox"
    />
  </DesignProvider>
);

describe("useViewportSegments", () => {
  it("returns both segments, and null again after a resize to one segment", () => {
    setSegments([A, B]);
    const { result } = renderHook(() => useViewportSegments());
    expect(result.current).toEqual([A, B]);
    const first = result.current;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(first);
    act(() => {
      setSegments([{ ...A, width: 920 }]);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBeNull();
  });

  it("is null without the API and on the server", () => {
    const { result } = renderHook(() => useViewportSegments());
    expect(result.current).toBeNull();
    setSegments([A, B]);
    expect(renderToString(region())).not.toContain("data-segments");
  });
});

describe("ListDetail on two segments", () => {
  it("mirrors the segments as data-segments and leaves the layout alone without them", () => {
    render(region());
    expect(screen.getByRole("region", { name: "Inbox" }).getAttribute("data-segments")).toBeNull();
    cleanup();
    setSegments([A, B]);
    render(region());
    expect(screen.getByRole("region", { name: "Inbox" }).getAttribute("data-segments")).toBe("2");
  });

  it("places the panes with the segment env() values and overrides the stack form", () => {
    const rules = parseCss(css("templates.css"));
    const h = rules.filter((r) => r.at === "(horizontal-viewport-segments: 2)");
    const v = rules.filter((r) => r.at === "(vertical-viewport-segments: 2)");
    const grid = (rs: typeof h) => rs.find((r) => r.selector === ".cb-listdetail[data-fit]");
    expect(grid(h)?.decls["grid-template-columns"]).toContain("env(viewport-segment-width 0 0)");
    expect(grid(h)?.decls["column-gap"]).toContain("env(viewport-segment-left 1 0)");
    expect(grid(v)?.decls["grid-template-rows"]).toContain("env(viewport-segment-height 0 0)");
    expect(grid(v)?.decls["row-gap"]).toContain("env(viewport-segment-top 0 1)");
    for (const rs of [h, v]) {
      const shown = rs.find(
        (r) => r.selector === ".cb-listdetail[data-fit][data-open] > .cb-listdetail-list",
      );
      expect(shown?.decls.display).toBe("block");
      const detail = rs.find(
        (r) => r.selector === ".cb-listdetail[data-fit][data-open] > .cb-listdetail-detail",
      );
      expect(detail?.decls.display).toBe("flex");
    }
    // The segment rules come after the stack rules, so they win at equal specificity.
    const source = css("templates.css");
    expect(source.indexOf("(horizontal-viewport-segments: 2)")).toBeGreaterThan(
      source.indexOf("@container cb-ld (max-width: 679px)"),
    );
  });

  it("the conversation page's inline right area is not hidden on two segments", () => {
    const source = css("conversation-page.css");
    expect(source).toContain("(not (horizontal-viewport-segments: 2))");
    const rules = parseCss(source);
    expect(
      rules.find(
        (r) =>
          r.at === "(horizontal-viewport-segments: 2)" &&
          r.selector === ".cb-conv-page .cb-conv-panel",
      )?.decls["margin-left"],
    ).toContain("env(viewport-segment-left 1 0)");
  });
});
