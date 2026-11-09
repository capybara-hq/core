import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DecorationLayer, DesignProvider, SafeModeBanner } from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";

afterEach(cleanup);

/** shell.css without comments, so jsdom applies exactly the primitives' rules (no @layer here). */
const SHELL_CSS = readFileSync(resolve(import.meta.dirname, "../src/styles/shell.css"), "utf8");

function withStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = SHELL_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  document.head.append(style);
  return style;
}

describe("DecorationLayer", () => {
  it("is aria-hidden and passes clicks through", () => {
    const style = withStyles();
    try {
      const { container } = render(
        <DesignProvider locale="zh">
          <DecorationLayer>
            <span data-testid="plain">flare</span>
            <button type="button" data-testid="skip" data-cap-interactive="true">
              skip
            </button>
          </DecorationLayer>
        </DesignProvider>,
      );
      const layer = container.querySelector(".cb-decoration") as HTMLElement;
      expect(layer.getAttribute("aria-hidden")).toBe("true");
      expect(getComputedStyle(layer).pointerEvents).toBe("none");
      const plain = container.querySelector('[data-testid="plain"]') as HTMLElement;
      const skip = container.querySelector("[data-cap-interactive]") as HTMLElement;
      expect(getComputedStyle(plain).pointerEvents).toBe("none");
      expect(getComputedStyle(skip).pointerEvents).toBe("auto");
    } finally {
      style.remove();
    }
  });

  it("covers the viewport above every other layer (z token `decoration`)", () => {
    const rule = /\.cb-decoration \{([^}]*)\}/.exec(SHELL_CSS)?.[1] ?? "";
    expect(rule).toContain("position: fixed");
    expect(rule).toContain("inset: 0");
    expect(rule).toContain("z-index: var(--cb-z-decoration)");
    const tokens = readFileSync(resolve(import.meta.dirname, "../src/styles/tokens.css"), "utf8");
    const z = (name: string) => Number(new RegExp(`--cb-z-${name}: (\\d+);`).exec(tokens)?.[1]);
    for (const other of ["sheet", "dialog", "popover", "toast"])
      expect(z("decoration")).toBeGreaterThan(z(other));
  });

  it("draws no box of its own, nor does the safe mode banner", () => {
    render(
      <DesignProvider locale="zh">
        <DecorationLayer>
          <span>flare</span>
        </DecorationLayer>
        <SafeModeBanner onExit={() => {}} />
      </DesignProvider>,
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});
