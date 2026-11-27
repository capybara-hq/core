import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, IoBlock, ToolGroup, ToolRow, type ToolRowData } from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);
const rerenderIn = (rerender: (ui: React.ReactElement) => void, ui: React.ReactElement) =>
  rerender(<DesignProvider locale="zh">{ui}</DesignProvider>);

const css = readFileSync(resolve(import.meta.dirname, "../src/styles/display.css"), "utf8");
const conversationCss = readFileSync(
  resolve(import.meta.dirname, "../src/styles/conversation.css"),
  "utf8",
);

const diff = {
  hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "add" as const, text: "a" }] }],
  truncated: false,
};

const write = (over: Partial<ToolRowData> = {}): ToolRowData => ({
  id: "t_write",
  kind: "edit",
  name: "Write",
  keyArg: "docs/report.md",
  status: "streaming",
  progress: { lines: 1, bytes: 2 },
  detail: { diff, live: { preview: true } },
  ...over,
});

const done = (over: Partial<ToolRowData> = {}): ToolRowData =>
  write({ status: "done", durationMs: 10, detail: { diff }, added: 1, removed: 0, ...over });

/** Makes a viewport's content taller than its box (jsdom lays nothing out). */
function overflow(el: Element, tall = true) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: tall ? 600 : 100 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 200 });
}

describe("tool rows open by themselves while live (§6.16.9)", () => {
  it("a streaming single call shows its live detail without a click, folding back when done", () => {
    const { container, rerender } = wrap(<ToolGroup rows={[write()]} />);
    const line = container.querySelector('[data-part="tool-line"]');
    expect(line?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-part="diff"]')?.hasAttribute("data-live")).toBe(true);
    // the same element through the logged forms: still open while live
    rerenderIn(rerender, <ToolGroup rows={[write({ status: "running", startedAt: 0 })]} now={1} />);
    expect(container.querySelector('[data-part="tool-line"]')).toBe(line);
    expect(line?.getAttribute("aria-expanded")).toBe("true");
    rerenderIn(rerender, <ToolGroup rows={[done()]} />);
    expect(line?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-part="diff"]')).toBeNull();
  });

  it("a row the person opened while live stays open when done", () => {
    const { container, rerender } = wrap(<ToolGroup rows={[write()]} />);
    const line = container.querySelector('[data-part="tool-line"]') as HTMLElement;
    fireEvent.click(line); // collapse
    fireEvent.click(line); // open again: the person's choice
    rerenderIn(rerender, <ToolGroup rows={[done()]} />);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-part="diff"]')).not.toBeNull();
  });

  it("a live row the person collapsed stays collapsed", () => {
    const { container, rerender } = wrap(<ToolGroup rows={[write()]} />);
    const line = container.querySelector('[data-part="tool-line"]') as HTMLElement;
    fireEvent.click(line);
    expect(line.getAttribute("aria-expanded")).toBe("false");
    rerenderIn(rerender, <ToolGroup rows={[write({ progress: { lines: 9, bytes: 90 } })]} />);
    expect(line.getAttribute("aria-expanded")).toBe("false");
    rerenderIn(rerender, <ToolGroup rows={[done()]} />);
    expect(line.getAttribute("aria-expanded")).toBe("false");
  });

  it("a finished call and a running call without live detail stay collapsed", () => {
    wrap(
      <>
        <ToolGroup rows={[done({ id: "a" })]} />
        <ToolGroup
          rows={[
            {
              id: "b",
              kind: "command",
              name: "Bash",
              status: "running",
              startedAt: 0,
              detail: { command: "ls" },
            },
          ]}
          now={1}
        />
      </>,
    );
    for (const b of screen.getAllByRole("button")) {
      expect(b.getAttribute("aria-expanded")).toBe("false");
    }
  });

  it("a running call whose output streams opens and follows it", () => {
    const { container } = wrap(
      <ToolGroup
        rows={[
          {
            id: "b",
            kind: "command",
            name: "Bash",
            status: "running",
            startedAt: 0,
            detail: { command: "make", output: "building…" },
          },
        ]}
        now={1}
      />,
    );
    const out = container.querySelector('[data-part="tool-output"]');
    expect(out?.hasAttribute("data-live")).toBe(true);
    expect(out?.querySelector(".cb-cursor")).toBeNull();
  });

  it("rows inside a live group open by themselves and keep the person's choice", () => {
    const other: ToolRowData = {
      id: "r",
      kind: "read",
      name: "Read",
      status: "done",
      durationMs: 1,
      detail: { output: "x" },
    };
    const { container, rerender } = wrap(<ToolGroup rows={[other, write()]} />);
    const rows = () => [...container.querySelectorAll('[data-part="tool-row"]')];
    expect(rows().map((r) => r.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    rerenderIn(rerender, <ToolGroup rows={[other, done()]} open />);
    expect(rows().map((r) => r.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
  });

  it("a controlled row follows its owner, never by itself", () => {
    const { container } = wrap(<ToolRow row={write()} open={false} />);
    expect(container.querySelector('[data-part="tool-row"]')?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("opening by itself does not animate (only a person's toggle does)", () => {
    const { container } = wrap(<ToolGroup rows={[write()]} />);
    expect(container.querySelector('[data-animate="true"]')).toBeNull();
  });
});

describe("the tool detail viewport (§6.16.9)", () => {
  it("the expand control appears only when the content overflows", () => {
    const { container, rerender } = wrap(<ToolRow row={done()} open />);
    expect(container.querySelector('[data-part="detail-expand"]')).toBeNull();
    overflow(container.querySelector('[data-part="diff"]') as Element);
    rerenderIn(rerender, <ToolRow row={done({ durationMs: 11 })} open />);
    const btn = screen.getByRole("button", { name: "展开" });
    expect(btn.getAttribute("data-part")).toBe("detail-expand");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-controls")).toBe(
      container.querySelector('[data-part="diff"]')?.id,
    );
  });

  it("toggles the tall cap with aria-expanded, and keeps the control while expanded", () => {
    const { container, rerender } = wrap(<ToolRow row={done()} open />);
    const box = container.querySelector('[data-part="diff"]') as HTMLElement;
    overflow(box);
    rerenderIn(rerender, <ToolRow row={done({ durationMs: 11 })} open />);
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(box.hasAttribute("data-expanded")).toBe(true);
    const collapse = screen.getByRole("button", { name: "收起" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    // the content now fits the tall cap: the control stays so the box can fold again
    overflow(box, false);
    rerenderIn(rerender, <ToolRow row={done({ durationMs: 12 })} open />);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(box.hasAttribute("data-expanded")).toBe(false);
    expect(container.querySelector('[data-part="detail-expand"]')).toBeNull();
  });

  it("English names", () => {
    const { container, rerender } = render(
      <DesignProvider locale="en">
        <ToolRow row={done()} open />
      </DesignProvider>,
    );
    overflow(container.querySelector('[data-part="diff"]') as Element);
    rerender(
      <DesignProvider locale="en">
        <ToolRow row={done({ durationMs: 11 })} open />
      </DesignProvider>,
    );
    expect(screen.getByRole("button", { name: "Expand" })).toBeTruthy();
  });

  it("a live box follows its tail in the tall cap too", () => {
    const lines = (n: number) =>
      write({
        progress: { lines: n, bytes: n * 2 },
        detail: {
          diff: {
            hunks: [
              {
                oldStart: 1,
                newStart: 1,
                lines: Array.from({ length: n }, (_, i) => ({
                  kind: "ctx" as const,
                  text: `${i}`,
                })),
              },
            ],
            truncated: false,
          },
          live: { preview: true },
        },
      });
    const { container, rerender } = wrap(<ToolRow row={lines(1)} />);
    const box = container.querySelector('[data-part="diff"]') as HTMLElement;
    overflow(box);
    rerenderIn(rerender, <ToolRow row={lines(2)} />);
    expect(box.scrollTop).toBe(600);
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    Object.defineProperty(box, "scrollHeight", { configurable: true, value: 900 });
    act(() => {
      rerenderIn(rerender, <ToolRow row={lines(3)} />);
    });
    expect(box.scrollTop).toBe(900);
  });

  it("every tool detail box is a viewport: output, command, inputs, live and finished diffs", () => {
    const { container } = wrap(
      <>
        <ToolRow
          row={{
            id: "c",
            kind: "command",
            name: "Bash",
            status: "done",
            durationMs: 1,
            detail: { command: "ls", output: "a" },
          }}
          open
        />
        <ToolRow
          row={{
            id: "g",
            kind: "tool",
            name: "Acme",
            status: "done",
            durationMs: 1,
            detail: { input: [["q", "x"]], output: "{}" },
          }}
          open
        />
        <ToolRow row={done({ id: "d" })} open />
        <ToolRow row={write({ id: "w" })} open />
      </>,
    );
    for (const part of ["tool-command", "tool-output", "kv", "diff"]) {
      const boxes = container.querySelectorAll(`[data-part="${part}"]`);
      expect(boxes.length).toBeGreaterThan(0);
      for (const b of boxes) {
        expect(b.hasAttribute("data-viewport")).toBe(true);
        expect(b.parentElement?.getAttribute("data-part")).toBe("detail-viewport");
      }
    }
  });

  it("the compact height is one token, the expanded cap 70dvh", () => {
    expect(css).toMatch(
      /\.cb-viewport > \[data-viewport\] \{\s*max-height: var\(--cb-layout-tool-detail\);/,
    );
    expect(css).toMatch(/\[data-viewport\]\[data-expanded\] \{\s*max-height: 70dvh;/);
    expect(conversationCss).not.toContain("--cb-layout-tool-output");
    expect(conversationCss).not.toContain("--cb-layout-tool-live");
  });

  it("IoBlock uses the same viewport instead of slicing lines", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const { container, rerender } = wrap(<IoBlock label="OUT" text={text} />);
    expect(screen.getByText(/line 20/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    overflow(container.querySelector('[data-part="io-text"]') as Element);
    rerenderIn(rerender, <IoBlock label="OUT" text={`${text}\n`} />);
    expect(screen.getByRole("button", { name: "展开" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });
});
