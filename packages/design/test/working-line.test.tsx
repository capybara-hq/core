import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationPage, DesignProvider, WorkingLine } from "../src/index";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const css = readFileSync(resolve(import.meta.dirname, "../src/styles/conversation.css"), "utf8");

describe("WorkingLine (spec §6.16.24)", () => {
  it("is a tool line: the walking mark and the four captions, the first one shown", () => {
    const { container } = wrap(<WorkingLine />);
    const line = container.querySelector('[data-part="working-line"]') as HTMLElement;
    expect(line.classList.contains("cb-tool-line")).toBe(true);
    const svg = container.querySelector('[data-part="working-mark"] svg') as SVGElement;
    // the 14×10 bitmap at pixel unit 2, as the sidebar's logo
    expect(svg.getAttribute("width")).toBe("28");
    expect(svg.getAttribute("height")).toBe("20");
    expect(svg.getAttribute("viewBox")).toBe("0 0 28 20");
    expect(svg.querySelector('[data-frame="1"]')?.getAttribute("d")).toMatch(/^M4 16h2v2h-2z/);
    expect(svg.getAttribute("shape-rendering")).toBe("crispEdges");
    // the body and the two leg frames, frame 1 first
    const frames = [...svg.querySelectorAll("[data-frame]")].map((p) =>
      p.getAttribute("data-frame"),
    );
    expect(frames).toEqual(["1", "2"]);
    const captions = [...container.querySelectorAll('[data-part="working-caption"] > span')].map(
      (s) => s.textContent,
    );
    expect(captions).toEqual(["规划中…", "执行中…", "斟酌中…", "整理中…"]);
    // no timer anywhere
    expect(line.textContent).not.toMatch(/\d/);
  });

  it("speaks English", () => {
    const { container } = wrap(<WorkingLine />, "en");
    const captions = [...container.querySelectorAll('[data-part="working-caption"] > span')].map(
      (s) => s.textContent,
    );
    expect(captions).toEqual(["Planning…", "Working…", "Pondering…", "Composing…"]);
  });

  it("is announced once: the status holds the first caption only, never the rotation", () => {
    vi.useFakeTimers();
    const { container } = wrap(<WorkingLine />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("规划中…");
    // the visible line (mark and rotating captions) is hidden from assistive tech
    expect(container.querySelector('[data-part="working-line"]')?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    const before = status.innerHTML;
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    // the rotation is CSS: the DOM (and so what a screen reader hears) never changes
    expect(status.innerHTML).toBe(before);
  });

  it("keeps its live region mounted and fills it when the line starts", () => {
    const { container, rerender } = wrap(<WorkingLine active={false} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    expect(container.querySelector('[data-part="working-line"]')).toBeNull();
    rerender(
      <DesignProvider locale="zh">
        <WorkingLine active />
      </DesignProvider>,
    );
    // the same region, now filled: the change is what a screen reader announces
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("规划中…");
    rerender(
      <DesignProvider locale="zh">
        <WorkingLine active={false} />
      </DesignProvider>,
    );
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("");
  });

  it("walks and rotates only without reduced motion; still draws frame 1 and the first caption", () => {
    // every animation of the line sits inside a no-preference block
    const start = css.indexOf("/* ── Working line");
    const end = css.indexOf("/* ──", start + 10);
    const block = css.slice(start, end === -1 ? undefined : end);
    expect(start).toBeGreaterThan(-1);
    const outside = block.replace(
      /@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*?\n\}/g,
      "",
    );
    expect(outside).not.toMatch(/animation:/);
    expect(block).toMatch(/@media \(prefers-reduced-motion: no-preference\)/);
    // the two leg frames 400 ms apart (an 800 ms cycle), captions every 2.4 s (a 9.6 s cycle)
    expect(block).toContain("800ms");
    expect(block).toContain("9.6s");
    expect(block).toContain("400ms");
    // the still form (reduced motion in the reference set) never animates
    expect(block).toMatch(/:not\(\[data-still="true"\]\)/);
    const { container } = wrap(<WorkingLine still />);
    expect(container.querySelector('[data-part="working-line"]')?.getAttribute("data-still")).toBe(
      "true",
    );
  });
});

describe("ConversationPage working line", () => {
  const base = {
    titleBar: {
      title: "t",
      untitled: "u",
      menu: [],
      properties: { pressed: false, onToggle: () => {} },
      panels: [],
    },
    composer: <div>composer</div>,
    status: { context: "c", version: "v" },
    right: "none" as const,
    onCloseRight: () => {},
  };

  it("draws the line after the thread and before the queue", () => {
    const { container } = wrap(
      <ConversationPage
        {...base}
        thread={<div data-testid="thread">thread</div>}
        working
        queue={<div data-testid="queue">queue</div>}
      />,
    );
    const thread = container.querySelector('[data-part="thread"]') as HTMLElement;
    const order = [...thread.querySelectorAll('[data-testid], [data-part="working-line"]')].map(
      (el) => el.getAttribute("data-testid") ?? el.getAttribute("data-part"),
    );
    expect(order).toEqual(["thread", "working-line", "queue"]);
  });

  it("keeps the line's live region mounted while `working` is false", () => {
    const { container } = wrap(
      <ConversationPage {...base} thread={<div>t</div>} working={false} />,
    );
    expect(container.querySelector('[data-part="working-line"]')).toBeNull();
    expect(container.querySelector('[data-part="working-status"]')?.textContent).toBe("");
  });

  it("draws no line unless asked", () => {
    const { container } = wrap(<ConversationPage {...base} thread={<div>thread</div>} />);
    expect(container.querySelector('[data-part="working-line"]')).toBeNull();
  });
});
