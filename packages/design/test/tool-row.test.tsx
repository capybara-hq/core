import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesignProvider,
  streamProgressText,
  summarizeTools,
  ToolGroup,
  ToolRow,
  type ToolRowData,
} from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const css = readFileSync(resolve(import.meta.dirname, "../src/styles/conversation.css"), "utf8");

const write = (over: Partial<ToolRowData> = {}): ToolRowData => ({
  id: "t_stream",
  kind: "edit",
  name: "Write",
  keyArg: "reports/report.md",
  status: "streaming",
  progress: { lines: 86, bytes: 2765 },
  ...over,
});

describe("ToolRow streaming (§6.16.9)", () => {
  it("is busy, draws the stream mark and the progress, no spinner and no timer", () => {
    const { container } = wrap(<ToolRow row={write({ startedAt: 0 })} now={12_000} />);
    const r = container.querySelector('[data-part="tool-row"]');
    expect(r?.getAttribute("aria-busy")).toBe("true");
    expect(r?.getAttribute("data-status")).toBe("streaming");
    expect(container.querySelectorAll('[data-part="stream-dot"]')).toHaveLength(3);
    expect(container.querySelector('[data-part="stream-mark"]')?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(container.querySelector(".cb-conv-spin")).toBeNull();
    expect(container.querySelector('[data-part="stream-progress"]')?.textContent).toBe(
      "生成中 · 86 行 · 2.7 KB",
    );
    // no timer: nothing reads like an elapsed time
    expect(container.textContent).not.toMatch(/12 ?秒|12s/);
    // never a live region
    expect(container.querySelector("[aria-live]")).toBeNull();
  });

  it("words the generic form and the size alone, in both languages", () => {
    expect(streamProgressText({ bytes: 1229, generic: true }, "zh")).toBe("生成参数中 · 1.2 KB");
    expect(streamProgressText({ bytes: 1229, generic: true }, "en")).toBe("Writing input · 1.2 KB");
    expect(streamProgressText({ bytes: 214 }, "en")).toBe("Writing · 214 B");
    expect(streamProgressText({ lines: 1, bytes: 12 }, "en")).toBe("Writing · 1 line · 12 B");
    expect(streamProgressText({ lines: 86, bytes: 2765 }, "en")).toBe(
      "Writing · 86 lines · 2.7 KB",
    );
  });

  it("keeps the aligned part's +a −b and offers no actions", () => {
    const { container } = wrap(<ToolRow row={write({ added: 3, removed: 1 })} />);
    expect(container.textContent).toContain("+3 −1");
    expect(container.querySelector('[data-part="tool-link"]')).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("keeps the toggle when it has detail, and opens to the live diff", () => {
    const row = write({
      detail: {
        diff: {
          hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "ctx", text: "a" }] }],
          truncated: false,
        },
        live: { preview: true },
      },
    });
    const { container } = wrap(<ToolRow row={row} open />);
    expect(container.querySelector('[data-part="tool-row"]')?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(container.querySelector('[data-part="diff"]')?.hasAttribute("data-live")).toBe(true);
    expect(container.querySelector('[data-part="diff-caret"]')).not.toBeNull();
  });

  it("a single streaming call draws the mark and its progress on the tool line", () => {
    const { container } = wrap(<ToolGroup rows={[write()]} />);
    const line = container.querySelector('[data-part="tool-line"]');
    expect(line?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[data-part="stream-mark"]')).not.toBeNull();
    expect(container.querySelector(".cb-conv-spin")).toBeNull();
    expect(container.querySelector('[data-part="stream-progress"]')?.textContent).toContain(
      "生成中 · 86 行",
    );
  });

  it("counts as running in a group's header", () => {
    expect(
      summarizeTools(
        [
          { kind: "edit", status: "streaming" },
          { kind: "command", status: "done" },
        ],
        "zh",
      ),
    ).toContain("正在修改文件");
  });

  it("pulses only when motion is allowed (reduced motion draws the mark still)", () => {
    const at = css.indexOf("animation: cb-stream-pulse");
    expect(at).toBeGreaterThan(0);
    const media = css.lastIndexOf("@media (prefers-reduced-motion: no-preference)", at);
    expect(media).toBeGreaterThan(0);
    expect(css.slice(media, at)).not.toContain("\n}\n");
  });

  it("a single streaming call starts no clock (nothing re-renders each second)", () => {
    vi.useFakeTimers();
    try {
      const running = wrap(
        <ToolGroup rows={[write({ id: "t_run", status: "running", startedAt: 0 })]} />,
      );
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      running.unmount();
      vi.clearAllTimers();
      wrap(<ToolGroup rows={[write({ startedAt: 0 })]} />);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a streaming row is never waiting: the mark and the progress, no waiting word", () => {
    const { container } = wrap(<ToolRow row={write({ waiting: "approval" })} />);
    expect(container.querySelector('[data-part="waiting-word"]')).toBeNull();
    expect(container.querySelector('[data-part="stream-mark"]')).not.toBeNull();
    expect(container.querySelector('[data-part="stream-progress"]')).not.toBeNull();
  });

  it("a streaming text output carries the cursor and follows its tail", () => {
    const row = (text: string) =>
      write({
        kind: "tool",
        name: "Agent",
        progress: { lines: 1, bytes: 9 },
        detail: { output: text },
      });
    const { container, rerender } = wrap(<ToolRow row={row("Summarize")} open />);
    const out = container.querySelector('[data-part="tool-output"]') as HTMLElement;
    expect(out.hasAttribute("data-live")).toBe(true);
    expect(out.lastElementChild?.classList.contains("cb-cursor")).toBe(true);
    expect(container.querySelector("[aria-live]")).toBeNull();
    const grow = (text: string, scrollHeight: number) => {
      Object.defineProperty(out, "scrollHeight", { configurable: true, value: scrollHeight });
      Object.defineProperty(out, "clientHeight", { configurable: true, value: 100 });
      rerender(
        <DesignProvider locale="zh">
          <ToolRow row={row(text)} open />
        </DesignProvider>,
      );
    };
    grow("Summarize the", 400);
    expect(out.scrollTop).toBe(400);
    out.scrollTop = 100;
    fireEvent.scroll(out);
    grow("Summarize the report", 600);
    expect(out.scrollTop).toBe(100);
  });
});
