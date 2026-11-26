import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, DIFF_LINE_MAX_CHARS, DiffBlock, type DiffData } from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const lines = (n: number, kind: "ctx" | "add" = "ctx") =>
  Array.from({ length: n }, (_, i) => ({ kind, text: `line ${i + 1}` }));
const diff = (over: Partial<DiffData> = {}): DiffData => ({
  hunks: [{ oldStart: 1, newStart: 1, lines: lines(3) }],
  truncated: false,
  ...over,
});

/** Gives the live viewport a layout jsdom lacks: a fixed height and a content height. */
function layout(el: Element, o: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: o.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: o.clientHeight });
}

describe("DiffBlock live (§6.16.10)", () => {
  it("draws the caret on the last line only", () => {
    const { container } = wrap(<DiffBlock diff={diff()} live />);
    const all = [...container.querySelectorAll('[data-part="diff-line"]')];
    expect(container.querySelectorAll('[data-part="diff-caret"]')).toHaveLength(1);
    expect(all.at(-1)?.querySelector('[data-part="diff-caret"]')).not.toBeNull();
    expect(container.querySelector('[data-part="diff"]')?.hasAttribute("data-live")).toBe(true);
    expect(container.querySelector("[aria-live]")).toBeNull();
  });

  it("draws no caret and no live viewport when not live", () => {
    const { container } = wrap(<DiffBlock diff={diff()} />);
    expect(container.querySelector('[data-part="diff-caret"]')).toBeNull();
    expect(container.querySelector('[data-part="diff"]')?.hasAttribute("data-live")).toBe(false);
  });

  it("closes with the pending line and its count, and keeps the caret above it", () => {
    const { container } = wrap(<DiffBlock diff={diff()} live pending={1234} />);
    const pending = container.querySelector('[data-part="diff-pending"]');
    expect(pending?.textContent).toContain("后面 1,234 行待对齐");
    expect(pending?.querySelector('[data-part="diff-caret"]')).toBeNull();
    expect(container.querySelector('[data-part="diff"]')?.lastElementChild).toBe(pending);
  });

  it("words the pending line in English", () => {
    const { container } = wrap(<DiffBlock diff={diff()} live pending={2} />, "en");
    expect(container.querySelector('[data-part="diff-pending"]')?.textContent).toContain(
      "2 more lines not reached yet",
    );
  });

  it("draws no pending line at zero", () => {
    const { container } = wrap(<DiffBlock diff={diff()} live pending={0} />);
    expect(container.querySelector('[data-part="diff-pending"]')).toBeNull();
  });

  it("gutter pending hides the numbers and adds the footer", () => {
    const { container } = wrap(
      <DiffBlock
        diff={diff({
          hunks: [
            {
              oldStart: 0,
              newStart: 0,
              lines: [
                { kind: "del", text: "old" },
                { kind: "add", text: "new" },
              ],
            },
          ],
        })}
        live
        gutter="pending"
      />,
    );
    const gutters = [...container.querySelectorAll('[data-part="diff-gutter"]')];
    expect(gutters).toHaveLength(2);
    expect(gutters.every((g) => g.textContent === "")).toBe(true);
    expect(container.querySelector('[data-part="diff-foot"]')?.textContent).toBe("行号待定");
  });

  it("the writing form says it is a preview", () => {
    const { container } = wrap(<DiffBlock diff={diff()} live preview />, "en");
    expect(container.querySelector('[data-part="diff-foot"]')?.textContent).toBe("Preview");
    // numbered from 1
    expect(container.querySelector('[data-part="diff-gutter"]')?.textContent).toBe("1");
  });

  it("long live text opens with the earlier line from the kept tail", () => {
    const { container } = wrap(
      <DiffBlock
        diff={diff({
          hunks: [{ oldStart: 1205, newStart: 1205, lines: lines(6) }],
          truncated: true,
          totalLines: 1210,
        })}
        live
        preview
      />,
    );
    const first = container.querySelector('[data-part="diff"]')?.firstElementChild;
    expect(first?.getAttribute("data-part")).toBe("diff-earlier");
    expect(first?.textContent).toContain("前面 1,204 行");
    // the live tail draws no truncation line
    expect(container.querySelector('[data-part="diff-cut"]')).toBeNull();
  });

  it("cuts a very long line before it reaches the page", () => {
    const long = "x".repeat(1_000_000);
    const { container } = wrap(
      <DiffBlock
        diff={diff({ hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "add", text: long }] }] })}
      />,
    );
    const text = container.querySelector(".cb-diff-text")?.textContent ?? "";
    expect(DIFF_LINE_MAX_CHARS).toBe(2000);
    expect(text.length).toBe(DIFF_LINE_MAX_CHARS);
  });

  it("never splits a surrogate pair at the cut", () => {
    const text = `${"x".repeat(DIFF_LINE_MAX_CHARS - 1)}😀tail`;
    const { container } = wrap(
      <DiffBlock
        diff={diff({ hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "add", text }] }] })}
      />,
    );
    const shown = container.querySelector(".cb-diff-text")?.textContent ?? "";
    expect(shown).toBe("x".repeat(DIFF_LINE_MAX_CHARS - 1));
    // no lone high surrogate at the end
    expect(/[\uD800-\uDBFF]$/.test(shown)).toBe(false);
  });

  it("keeps the caret outside the text, so an over-wide line's ellipsis never hides it", () => {
    const { container } = wrap(<DiffBlock diff={diff()} live />);
    const caret = container.querySelector('[data-part="diff-caret"]');
    expect(caret?.closest(".cb-diff-text")).toBeNull();
    expect(caret?.parentElement?.lastElementChild).toBe(caret);
  });

  it("stays at the bottom when only the pending or earlier line changes", () => {
    const at = (pending: number, totalLines?: number) => (
      <DesignProvider locale="zh">
        <DiffBlock
          diff={diff(totalLines === undefined ? {} : { truncated: true, totalLines })}
          live
          pending={pending}
        />
      </DesignProvider>
    );
    const { container, rerender } = render(at(5));
    const view = container.querySelector('[data-part="diff"]') as HTMLElement;
    layout(view, { scrollHeight: 300, clientHeight: 100 });
    rerender(at(4));
    expect(view.scrollTop).toBe(300);
    layout(view, { scrollHeight: 320, clientHeight: 100 });
    rerender(at(4, 10));
    expect(view.scrollTop).toBe(320);
  });

  it("follows the tail until the reader scrolls up, and again once back at the bottom", () => {
    const { container, rerender } = wrap(<DiffBlock diff={diff()} live />);
    const view = container.querySelector('[data-part="diff"]') as HTMLElement;
    const grow = (n: number) =>
      rerender(
        <DesignProvider locale="zh">
          <DiffBlock diff={diff({ hunks: [{ oldStart: 1, newStart: 1, lines: lines(n) }] })} live />
        </DesignProvider>,
      );

    layout(view, { scrollHeight: 500, clientHeight: 100 });
    grow(10);
    expect(view.scrollTop).toBe(500);

    // the reader scrolls up: following stops
    view.scrollTop = 200;
    fireEvent.scroll(view);
    layout(view, { scrollHeight: 800, clientHeight: 100 });
    grow(20);
    expect(view.scrollTop).toBe(200);

    // back at the bottom: following resumes
    view.scrollTop = 700;
    fireEvent.scroll(view);
    layout(view, { scrollHeight: 900, clientHeight: 100 });
    grow(25);
    expect(view.scrollTop).toBe(900);
  });
});
