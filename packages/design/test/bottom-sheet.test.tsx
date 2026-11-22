import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BottomSheet, DesignProvider, MOBILE_SIZE_QUERY } from "../src/index";
import { css, parseCss } from "./css-rules";

// The bottom sheet's touch form (spec §6.7): the drag behaviour is sheet-drag.test.tsx's; the
// back-closes-first behaviour is overlay-history.test.tsx's.

afterEach(cleanup);

const touch = parseCss(css("touch.css"));
const page = parseCss(css("conversation-page.css"));
const decls = (rules: ReturnType<typeof parseCss>, at: string | null, selector: string) =>
  rules.find((r) => r.at === at && r.selector === selector)?.decls;

describe("the bottom sheet on touch", () => {
  it("rounds its top corners with radius.md (20 on touch), the base rule unchanged", () => {
    const radius = "var(--cb-radius-md) var(--cb-radius-md) 0 0";
    expect(decls(page, null, ".cb-bsheet")?.["border-radius"]).toBe(radius);
    expect(decls(touch, MOBILE_SIZE_QUERY, ".cb-bsheet")?.["border-radius"]).toBe(radius);
  });

  it("draws option rows touch.row high and a head without a hairline (§6.59)", () => {
    expect(decls(page, null, ".cb-sheet-option")?.height).toBe("40px");
    expect(decls(touch, MOBILE_SIZE_QUERY, ".cb-sheet-option")?.height).toBe("var(--cb-touch-row)");
    expect(decls(page, null, ".cb-bsheet-head")?.["border-bottom"]).toBeUndefined();
  });

  it("gives the close button the 44 px hit area through an invisible ring, not a 44 box", () => {
    expect(decls(page, null, ".cb-bsheet-close::after")?.inset).toBe(
      "calc((var(--cb-touch-sheet-close) - var(--cb-touch-hit)) / 2)",
    );
    expect(decls(page, null, ".cb-bsheet-head .cb-btn.cb-bsheet-close")?.width).toBe(
      "var(--cb-touch-sheet-close)",
    );
  });

  it("still draws the handle, the head and the body", () => {
    render(
      <DesignProvider locale="en">
        <BottomSheet open onOpenChange={() => {}} title="Settings">
          <p>body</p>
        </BottomSheet>
      </DesignProvider>,
    );
    for (const part of ["sheet-handle", "sheet-head", "bsheet-body"]) {
      expect(document.querySelector(`[data-part="${part}"]`)).not.toBeNull();
    }
  });
});
