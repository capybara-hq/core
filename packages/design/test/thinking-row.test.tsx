import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, ThinkingRow } from "../src/index";

afterEach(cleanup);

const css = readFileSync(resolve(import.meta.dirname, "../src/styles/conversation.css"), "utf8");

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule ${selector}`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

const wrap = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

describe("ThinkingRow in a rail", () => {
  it("thinking in rail has no rule", () => {
    const { container } = wrap(<ThinkingRow seconds={3} text="想一想" defaultOpen inRail />);
    const row = container.querySelector(".cb-thinking-row") as HTMLElement;
    expect(row.getAttribute("data-in-rail")).toBe("true");
    expect(container.querySelector('[data-part="thinking-body"]')).not.toBeNull();
    const body = rule('.cb-thinking-row[data-in-rail="true"] .cb-thinking-body');
    expect(body).toContain("border-left: 0");
    expect(body).toContain("padding-left: 0");
    expect(body).toContain("font-size: var(--cb-type-prose-small-size)");
    expect(body).toContain("line-height: var(--cb-type-prose-small-line)");
  });

  it("outside a rail keeps the rule and sets no marker", () => {
    const { container } = wrap(<ThinkingRow seconds={3} text="想一想" defaultOpen />);
    expect(container.querySelector(".cb-thinking-row")?.hasAttribute("data-in-rail")).toBe(false);
  });

  it("the live row carries the marker too", () => {
    const { container } = wrap(<ThinkingRow seconds={1} text="x" live inRail />);
    expect(container.querySelector(".cb-thinking-row")?.getAttribute("data-in-rail")).toBe("true");
  });
});
