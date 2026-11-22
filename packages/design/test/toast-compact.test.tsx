import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, ToastProvider, useToast } from "../src/index";
import { css, parseCss } from "./css-rules";
import { matchMediaFor } from "./width";

// Toasts on phones (interaction spec §7, D2 as amended by the maintainer decision 2026-11-23): at
// the top, docked under the top row, full width between the gutters, sliding down into place.

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
});

const COMPACT = "not all and (min-width: 600px)";
const rules = parseCss(css("overlays.css"));
const decls = (at: string | null, selector: string) =>
  rules.find((r) => r.at === at && r.selector === selector)?.decls;
/** A value with the line breaks the formatter puts inside a long `calc()` / `max()` taken out. */
const flat = (v: string | undefined) => v?.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");

describe("the toast region on compact", () => {
  it("sits at the top under the band and the top row, never at the bottom", () => {
    const d = decls(COMPACT, ".cb-toast-region");
    expect(d?.bottom).toBeUndefined();
    // the band (the safe-area inset, or a mobile shell's controls), the row, then a space.2 gap
    expect(flat(d?.top)).toBe(
      "calc(var(--cb-shell-band, var(--cb-inset-top)) + var(--cb-toast-row) + var(--cb-space-2))",
    );
    // the floating row as the shell draws it below 600: space.2 + touch.float + space.2
    expect(d?.["--cb-toast-row"]).toBe(
      "calc(var(--cb-space-2) + var(--cb-touch-float) + var(--cb-space-2))",
    );
  });

  it("clears the desktop shell's flat title bar, and needs no row where there is no shell", () => {
    const row = flat(
      decls(COMPACT, ':root[data-shell="desktop"] .cb-toast-region')?.["--cb-toast-row"],
    );
    expect(row).toMatch(/^max\(var\(--cb-shell-row\),/);
    expect(row).toContain("var(--cb-touch-float)");
    expect(decls(COMPACT, ":root:not(:has(.cb-shell)) .cb-toast-region")?.["--cb-toast-row"]).toBe(
      "0px",
    );
  });

  it("spans the width minus gutters, inside the side insets", () => {
    const d = decls(COMPACT, ".cb-toast-region");
    expect(d?.left).toBe("calc(var(--cb-inset-left) + var(--cb-space-4))");
    expect(d?.right).toBe("calc(var(--cb-inset-right) + var(--cb-space-4))");
    expect(d?.width).toBe("auto");
    expect(d?.translate).toBe("none");
  });

  it("slides down into place over motion.overlay, and not under reduced motion", () => {
    expect(decls(COMPACT, ".cb-toast")?.animation).toBe(
      "cb-toast-down var(--cb-motion-overlay) ease-out",
    );
    expect(css("overlays.css")).toMatch(
      /@keyframes cb-toast-down \{\s*from \{\s*opacity: 0;\s*transform: translateY\(calc\(-1 \* var\(--cb-space-2\)\)\);/,
    );
    const reduced = rules.filter((r) => r.at === "(prefers-reduced-motion: reduce)");
    expect(
      reduced.some(
        (r) =>
          r.selector.split(",").some((x) => x.trim() === ".cb-toast") &&
          r.decls.animation === "none",
      ),
    ).toBe(true);
  });

  it("shows one toast at a time: the queued ones are hidden", () => {
    expect(decls(COMPACT, '.cb-toast[data-queued="true"]')?.display).toBe("none");
  });

  it("leaves vertical drags to the swipe, not the page pan", () => {
    expect(decls(COMPACT, ".cb-toast")?.["touch-action"]).toBe("pan-x");
  });

  it("keeps the desktop rule at the top center", () => {
    const d = decls(null, ".cb-toast-region");
    expect(flat(d?.top)).toBe("var(--cb-space-4)");
    expect(d?.left).toBe("50%");
  });
});

function Fire() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.success("Saved")}>
      go
    </button>
  );
}

describe("swipe up to dismiss", () => {
  it("closes the toast when dragged up past the threshold", () => {
    render(
      <DesignProvider locale="en">
        <ToastProvider>
          <Fire />
        </ToastProvider>
      </DesignProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    const toast = screen.getByText("Saved").closest(".cb-toast") as HTMLElement;
    fireEvent.pointerDown(toast, { clientY: 160, pointerType: "touch" });
    act(() => {
      fireEvent.pointerUp(toast, { clientY: 100, pointerType: "touch" });
    });
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("follows the finger and ignores a drag that starts on the close button", () => {
    render(
      <DesignProvider locale="en">
        <ToastProvider>
          <Fire />
        </ToastProvider>
      </DesignProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    const toast = screen.getByText("Saved").closest(".cb-toast") as HTMLElement;
    fireEvent.pointerDown(toast, { clientY: 100, pointerType: "touch" });
    fireEvent.pointerMove(toast, { clientY: 80, pointerType: "touch" });
    expect(toast.style.transform).toBe("translateY(-20px)");
    // a drag down does not move it: the swipe goes back toward the top edge only
    fireEvent.pointerMove(toast, { clientY: 130, pointerType: "touch" });
    expect(toast.style.transform).toBe("translateY(0px)");
    fireEvent.pointerCancel(toast);
    expect(toast.style.transform).toBe("");
    const close = toast.querySelector("button") as HTMLElement;
    fireEvent.pointerDown(close, { clientY: 200, pointerType: "touch" });
    fireEvent.pointerUp(close, { clientY: 100, pointerType: "touch" });
    expect(screen.queryByText("Saved")).not.toBeNull();
  });

  it("keeps it on a short drag up and on a drag down", () => {
    render(
      <DesignProvider locale="en">
        <ToastProvider>
          <Fire />
        </ToastProvider>
      </DesignProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    const toast = screen.getByText("Saved").closest(".cb-toast") as HTMLElement;
    fireEvent.pointerDown(toast, { clientY: 110, pointerType: "touch" });
    fireEvent.pointerUp(toast, { clientY: 100, pointerType: "touch" });
    expect(screen.queryByText("Saved")).not.toBeNull();
    fireEvent.pointerDown(toast, { clientY: 100, pointerType: "touch" });
    fireEvent.pointerUp(toast, { clientY: 200, pointerType: "touch" });
    expect(screen.queryByText("Saved")).not.toBeNull();
  });
});

function Two() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.success("First")}>
        first
      </button>
      <button type="button" onClick={() => toast.success("Second")}>
        second
      </button>
      <button type="button" onClick={() => toast.error("Broken")}>
        error
      </button>
    </>
  );
}
const toasts = () =>
  render(
    <DesignProvider locale="en">
      <ToastProvider>
        <Two />
      </ToastProvider>
    </DesignProvider>,
  );
const queued = (msg: string) =>
  screen.getByText(msg).closest(".cb-toast")?.getAttribute("data-queued") ?? null;

describe("the toast queue's timers", () => {
  it("on compact a queued toast waits unseen, then gets its full duration once shown", () => {
    vi.useFakeTimers();
    window.matchMedia = matchMediaFor(390).matchMedia;
    toasts();
    fireEvent.click(screen.getByText("first"));
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.click(screen.getByText("second"));
    // first in, first shown: the second waits behind it
    expect(queued("First")).toBeNull();
    expect(queued("Second")).toBe("true");
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByText("First")).toBeNull();
    expect(queued("Second")).toBeNull();
    act(() => vi.advanceTimersByTime(3999));
    expect(screen.queryByText("Second")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Second")).toBeNull();
  });

  it("on compact an error goes first; the shown success waits behind it", () => {
    vi.useFakeTimers();
    window.matchMedia = matchMediaFor(390).matchMedia;
    toasts();
    fireEvent.click(screen.getByText("first"));
    fireEvent.click(screen.getByText("error"));
    expect(queued("Broken")).toBeNull();
    expect(queued("First")).toBe("true");
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByText("First")).not.toBeNull();
  });

  it("from 600 every toast is shown and each starts its timer when it appears", () => {
    vi.useFakeTimers();
    window.matchMedia = matchMediaFor(1280).matchMedia;
    toasts();
    fireEvent.click(screen.getByText("first"));
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.click(screen.getByText("second"));
    expect(queued("Second")).toBeNull();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByText("First")).toBeNull();
    expect(screen.queryByText("Second")).not.toBeNull();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByText("Second")).toBeNull();
  });
});
