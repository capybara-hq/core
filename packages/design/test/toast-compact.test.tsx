import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, ToastProvider, useToast } from "../src/index";
import { css, parseCss } from "./css-rules";
import { matchMediaFor } from "./width";

// Toasts on phones (interaction spec §7, D2): at the bottom, above the composer and the keyboard.

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

describe("the toast region on compact", () => {
  it("sits at the bottom above the keyboard and the home indicator, off the top", () => {
    const d = decls(COMPACT, ".cb-toast-region");
    expect(d?.top).toBe("auto");
    expect(d?.bottom).toContain("var(--cb-inset-bottom)");
    expect(d?.bottom).toContain("var(--cb-keyboard-inset");
  });

  it("clears the composer and spans the width minus gutters, inside the side insets", () => {
    const d = decls(COMPACT, ".cb-toast-region");
    expect(d?.bottom).toContain("var(--cb-touch-composer)");
    expect(d?.left).toBe("calc(var(--cb-inset-left) + var(--cb-space-4))");
    expect(d?.right).toBe("calc(var(--cb-inset-right) + var(--cb-space-4))");
    expect(d?.width).toBe("auto");
    expect(d?.translate).toBe("none");
  });

  it("shows one toast at a time: the queued ones are hidden", () => {
    expect(decls(COMPACT, '.cb-toast[data-queued="true"]')?.display).toBe("none");
  });

  it("leaves vertical drags to the swipe, not the page pan", () => {
    expect(decls(COMPACT, ".cb-toast")?.["touch-action"]).toBe("pan-x");
  });

  it("keeps the desktop rule at the top center", () => {
    const d = decls(null, ".cb-toast-region");
    expect(d?.top).toBe("var(--cb-space-4)");
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

describe("swipe down to dismiss", () => {
  it("closes the toast when dragged down past the threshold", () => {
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
    act(() => {
      fireEvent.pointerUp(toast, { clientY: 160, pointerType: "touch" });
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
    fireEvent.pointerMove(toast, { clientY: 120, pointerType: "touch" });
    expect(toast.style.transform).toBe("translateY(20px)");
    fireEvent.pointerCancel(toast);
    expect(toast.style.transform).toBe("");
    const close = toast.querySelector("button") as HTMLElement;
    fireEvent.pointerDown(close, { clientY: 100, pointerType: "touch" });
    fireEvent.pointerUp(close, { clientY: 200, pointerType: "touch" });
    expect(screen.queryByText("Saved")).not.toBeNull();
  });

  it("keeps it on a short drag", () => {
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
    fireEvent.pointerUp(toast, { clientY: 110, pointerType: "touch" });
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
