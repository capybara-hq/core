import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render } from "@testing-library/react";
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

describe("ThinkingRow live and ended (§6.16.5)", () => {
  const md = "**当前状态**：先看 `report.md`。\n\n第二段。";

  it("live: no spinner, the words and the seconds, the tail as rendered Markdown", () => {
    const { container } = wrap(<ThinkingRow seconds={6} text={md} live inRail />);
    expect(container.querySelector('[data-part="spinner"]')).toBeNull();
    expect(container.querySelector('[data-part="tool-line"]')?.textContent).toBe("正在思考 · 6 秒");
    const tail = container.querySelector('[data-part="thinking-tail"]') as HTMLElement;
    expect(tail.querySelector("strong")?.textContent).toBe("当前状态");
    expect(tail.querySelector("code")?.textContent).toBe("report.md");
    expect(tail.textContent).not.toContain("**");
    expect(container.querySelector('[data-part="cursor"]')).not.toBeNull();
    // the tail holds three prose-small lines and fades its top once cut
    const r = rule(".cb-thinking-tail");
    expect(r).toContain("max-height: calc(3 * var(--cb-type-prose-small-line))");
    expect(r).toContain("color: var(--cb-muted)");
    expect(r).toContain("justify-content: flex-end");
    expect(rule('.cb-thinking-tail[data-clipped="true"]')).toContain("mask-image");
  });

  it("ended: collapses to the thought line; opening shows the whole text as Markdown", () => {
    const { container, rerender } = wrap(<ThinkingRow seconds={6} text={md} live inRail />);
    rerender(
      <DesignProvider locale="zh">
        <ThinkingRow seconds={6} text={md} inRail />
      </DesignProvider>,
    );
    const line = container.querySelector('[data-part="tool-line"]') as HTMLElement;
    expect(line.textContent).toBe("思考了 6 秒");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-part="thinking-tail"]')).toBeNull();
    fireEvent.click(line);
    const body = container.querySelector('[data-part="thinking-body"]') as HTMLElement;
    expect(body.querySelector("strong")?.textContent).toBe("当前状态");
    expect(body.textContent).toContain("第二段。");
  });
});
