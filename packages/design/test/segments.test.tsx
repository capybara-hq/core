import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, ListDetail, SEGMENT_QUERIES, useViewportSegments } from "../src/index";
import { css, parseCss } from "./css-rules";

type Win = Window & { viewport?: unknown };
const A = { x: 0, y: 0, width: 400, height: 800 };
const B = { x: 420, y: 0, width: 500, height: 800 };

function setSegments(segments: unknown[] | undefined) {
  (window as Win).viewport = segments ? { segments } : undefined;
}

const listeners = new Map<string, Set<() => void>>();
beforeEach(() => {
  listeners.clear();
  vi.stubGlobal(
    "matchMedia",
    (q: string) =>
      ({
        media: q,
        matches: false,
        addEventListener: (_: string, fn: () => void) => {
          if (!listeners.has(q)) listeners.set(q, new Set());
          listeners.get(q)?.add(fn);
        },
        removeEventListener: (_: string, fn: () => void) => listeners.get(q)?.delete(fn),
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

  it("re-reads on a media change and drops its listeners on unmount", () => {
    const { result, unmount } = renderHook(() => useViewportSegments());
    expect(result.current).toBeNull();
    expect([...listeners.keys()].sort()).toEqual([...SEGMENT_QUERIES].sort());
    act(() => {
      setSegments([A, B]);
      for (const set of listeners.values()) for (const fn of set) fn();
    });
    expect(result.current).toEqual([A, B]);
    unmount();
    for (const set of listeners.values()) expect(set.size).toBe(0);
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

  it("keeps the list, the detail and data-open working side by side", () => {
    setSegments([A, B]);
    const { rerender } = render(region());
    const section = screen.getByRole("region", { name: "Inbox" });
    expect(section.getAttribute("data-open")).toBe("false");
    rerender(
      <DesignProvider locale="en">
        <ListDetail
          list={<p>LIST</p>}
          detail={<p>DETAIL</p>}
          onBack={() => {}}
          listMin={320}
          detailMin={360}
          label="Inbox"
        />
      </DesignProvider>,
    );
    expect(section.getAttribute("data-open")).toBe("true");
    expect(screen.getByText("LIST")).toBeTruthy();
    expect(screen.getByText("DETAIL")).toBeTruthy();
  });

  it("anchors the second segment's track from the trailing edge and overrides the stack form", () => {
    const rules = parseCss(css("templates.css"));
    const h = rules.filter((r) => r.at === "(horizontal-viewport-segments: 2)");
    const v = rules.filter((r) => r.at === "(vertical-viewport-segments: 2)");
    const grid = (rs: typeof h) => rs.find((r) => r.selector === ".cb-listdetail[data-fit]");
    const cols = grid(h)?.decls["grid-template-columns"] ?? "";
    expect(cols.startsWith("minmax(0, 1fr)")).toBe(true);
    expect(cols).toContain("env(viewport-segment-width 1 0)");
    expect(cols).not.toContain("env(viewport-segment-width 0 0)");
    expect(grid(h)?.decls["column-gap"]).toContain("env(viewport-segment-left 1 0)");
    const rows = grid(v)?.decls["grid-template-rows"] ?? "";
    expect(rows).toContain("env(viewport-segment-height 1 0)");
    expect(rows).toContain("env(viewport-segment-top 0 1)");
    for (const rs of [h, v]) {
      const shown = rs.find(
        (r) => r.selector === ".cb-listdetail[data-fit][data-open" + "] > .cb-listdetail-list",
      );
      expect(shown?.decls.display).toBe("block");
      const detail = rs.find(
        (r) => r.selector === ".cb-listdetail[data-fit][data-open" + "] > .cb-listdetail-detail",
      );
      expect(detail?.decls.display).toBe("flex");
    }
    // A divided region gets its padding back in both forms (the stack zeroes it).
    expect(
      v.some((r) => r.selector.includes('[data-divided="true"]') && r.decls["padding-inline"]),
    ).toBe(true);
    expect(
      h.some((r) => r.selector.includes('[data-divided="true"]') && r.decls["padding-inline"]),
    ).toBe(true);
    // The segment rules come after the stack rules, so they win at equal specificity.
    const source = css("templates.css");
    expect(source.indexOf("(horizontal-viewport-segments: 2)")).toBeGreaterThan(
      source.indexOf("@container cb-ld (max-width: 679px)"),
    );
  });

  it("the stylesheets use exactly the exported segment queries", () => {
    for (const f of ["templates.css", "conversation-page.css"]) {
      const used = new Set(css(f).match(/\((?:horizontal|vertical)-viewport-segments: \d\)/g));
      expect(used.size).toBeGreaterThan(0);
      for (const q of used) expect(SEGMENT_QUERIES as readonly string[]).toContain(q);
    }
  });

  it("the conversation page: right area anchored trailing, thread never capped to segment 1", () => {
    const source = css("conversation-page.css");
    expect(source).toContain("(not (horizontal-viewport-segments: 2))");
    const rules = parseCss(source);
    const h = rules.filter((r) => r.at === "(horizontal-viewport-segments: 2)");
    const v = rules.filter((r) => r.at === "(vertical-viewport-segments: 2)");
    const by = (rs: typeof h, sel: string) => rs.find((r) => r.selector === sel)?.decls ?? {};
    expect(by(h, ".cb-conv-page .cb-conv-main").flex).toBe("1 1 0");
    for (const sel of [
      ".cb-conv-page .cb-conv-panel",
      ".cb-conv-page .cb-conv-cols > .cb-properties",
    ]) {
      expect(by(h, sel).flex).toBe("0 0 env(viewport-segment-width 1 0)");
      expect(by(h, sel)["margin-left"]).toContain("env(viewport-segment-left 1 0)");
    }
    expect(by(v, ".cb-conv-page .cb-conv-main").flex).toBe("1 1 0");
    expect(by(v, ".cb-conv-page .cb-conv-panel").flex).toBe("0 0 env(viewport-segment-height 1 0)");
    expect(by(v, ".cb-conv-page .cb-conv-cols > .cb-properties").flex).toBe(
      "0 0 env(viewport-segment-height 1 0)",
    );
  });
});
