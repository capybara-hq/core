import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, ToastProvider, useToast } from "../src/index";
import { css, parseCss } from "./css-rules";

// Toasts on phones (interaction spec §7, D2): at the bottom, above the composer and the keyboard.

afterEach(cleanup);

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

  it("shows one toast at a time", () => {
    expect(decls(COMPACT, ".cb-toast-group:not(:empty) ~ .cb-toast-group")?.display).toBe("none");
    expect(decls(COMPACT, ".cb-toast-group > .cb-toast:not(:first-child)")?.display).toBe("none");
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
