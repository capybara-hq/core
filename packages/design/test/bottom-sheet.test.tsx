import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BottomSheet, DesignProvider, TOUCH_QUERY } from "../src/index";
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
    expect(decls(touch, TOUCH_QUERY, ".cb-bsheet")?.["border-radius"]).toBe(radius);
  });

  it("draws option rows touch.row high and a head without a hairline", () => {
    expect(decls(page, null, ".cb-sheet-option")?.height).toBe("40px");
    expect(decls(touch, TOUCH_QUERY, ".cb-sheet-option")?.height).toBe("var(--cb-touch-row)");
    expect(decls(touch, TOUCH_QUERY, ".cb-bsheet-head")?.["border-bottom"]).toBe("0");
  });

  it("gives the close button the 44 px touch hit size", () => {
    const d = decls(touch, TOUCH_QUERY, ".cb-bsheet-head .cb-icon-btn");
    expect(d?.["min-width"]).toBe("var(--cb-touch-hit)");
    expect(d?.["min-height"]).toBe("var(--cb-touch-hit)");
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
