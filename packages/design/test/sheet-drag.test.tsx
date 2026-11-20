import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomSheet, DesignProvider, Sheet, useDragDismiss } from "../src/index";

// Follow-finger sheets (spec §6.7; mobile layout spec §7.4): synthetic pointer events, a faked
// clock for the release velocity, `transitionend` for the end of a settle.

const SIZE = 400;
let now = 0;

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(SIZE);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(SIZE);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A drag of `to` px along y over `ms`, in four moves, then a release. */
function drag(el: Element, to: number, ms: number, release = true, axisX = false) {
  const at = (d: number) =>
    axisX ? { clientX: 100 + d, clientY: 50 } : { clientX: 50, clientY: 100 + d };
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, ...at(0) });
  for (let i = 1; i <= 4; i++) {
    now += ms / 4;
    fireEvent.pointerMove(el, { pointerId: 1, ...at((to * i) / 4) });
  }
  if (release) fireEvent.pointerUp(el, { pointerId: 1, ...at(to) });
}

function renderBottom(onOpenChange = vi.fn(), body?: React.ReactNode) {
  render(
    <DesignProvider locale="en">
      <BottomSheet open onOpenChange={onOpenChange} title="Filter">
        {body ?? <p>body</p>}
      </BottomSheet>
    </DesignProvider>,
  );
  return {
    onOpenChange,
    sheet: () => document.querySelector('[data-part="sheet"]') as HTMLElement,
    handle: () => document.querySelector('[data-part="sheet-handle"]') as HTMLElement,
    head: () => document.querySelector('[data-part="sheet-head"]') as HTMLElement,
    body: () => document.querySelector('[data-part="bsheet-body"]') as HTMLElement,
  };
}

describe("a bottom sheet", () => {
  it("dismisses on a drag past 40 % of its height, once the travel has ended", () => {
    const s = renderBottom();
    drag(s.head(), SIZE * 0.5, 1000);
    expect(s.sheet().getAttribute("data-drag")).toBe("settling");
    expect(s.sheet().style.transform).toBe(`translateY(${SIZE}px)`);
    expect(s.onOpenChange).not.toHaveBeenCalled();
    fireEvent.transitionEnd(s.sheet());
    expect(s.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("follows the finger while dragging, scrim fading by the dragged share", () => {
    const s = renderBottom();
    drag(s.head(), SIZE * 0.25, 1000, false);
    expect(s.sheet().getAttribute("data-drag")).toBe("dragging");
    expect(s.sheet().style.transform).toBe(`translateY(${SIZE * 0.25}px)`);
    const scrim = document.querySelector('[data-part="bsheet-scrim"]') as HTMLElement;
    expect(scrim.style.opacity).toBe("0.75");
  });

  it("never moves past its rest position", () => {
    const s = renderBottom();
    drag(s.head(), 40, 1000, false);
    fireEvent.pointerMove(s.head(), { pointerId: 1, clientX: 50, clientY: 40 });
    expect(s.sheet().style.transform).toBe("translateY(0px)");
  });

  it("settles back from a 20 % slow drag: settling, then idle", () => {
    const s = renderBottom();
    drag(s.handle(), SIZE * 0.2, 2000);
    expect(s.sheet().getAttribute("data-drag")).toBe("settling");
    expect(s.sheet().style.transform).toBe("translateY(0px)");
    fireEvent.transitionEnd(s.sheet());
    expect(s.sheet().getAttribute("data-drag")).toBe("idle");
    expect(s.onOpenChange).not.toHaveBeenCalled();
  });

  it("dismisses a short fast flick (above 0.5 px/ms)", () => {
    const s = renderBottom();
    drag(s.head(), SIZE * 0.2, 100);
    fireEvent.transitionEnd(s.sheet());
    expect(s.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does nothing for a drag that starts in a body scrolled below its top", () => {
    const s = renderBottom();
    s.body().scrollTop = 30;
    drag(s.body(), SIZE * 0.6, 1000);
    expect(s.sheet().getAttribute("data-drag")).toBe("idle");
    expect(s.onOpenChange).not.toHaveBeenCalled();
  });

  it("drags from the body while its scroll is at the top, downward only", () => {
    const s = renderBottom();
    drag(s.body(), -SIZE * 0.5, 1000);
    expect(s.sheet().getAttribute("data-drag")).toBe("idle");
    drag(s.body(), SIZE * 0.5, 1000);
    expect(s.sheet().getAttribute("data-drag")).toBe("settling");
  });

  it("leaves a click on the close button alone (below the drag slop)", () => {
    const s = renderBottom();
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.pointerDown(close, { pointerId: 1, button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerMove(close, { pointerId: 1, clientX: 5, clientY: 8 });
    fireEvent.pointerUp(close, { pointerId: 1, clientX: 5, clientY: 8 });
    expect(s.sheet().getAttribute("data-drag")).toBe("idle");
  });

  it("still closes on Esc and focus returns to the opener", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const Harness = () => {
      const [open, setOpen] = useState(true);
      return (
        <DesignProvider locale="en">
          <BottomSheet open={open} onOpenChange={setOpen} title="Filter">
            <p>body</p>
          </BottomSheet>
        </DesignProvider>
      );
    };
    render(<Harness />);
    expect(document.activeElement).not.toBe(opener);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(document.querySelector('[data-part="sheet"]')).toBeNull();
    opener.remove();
  });

  it("closes on a click on the scrim", async () => {
    const s = renderBottom();
    const scrim = document.querySelector('[data-part="bsheet-scrim"]') as HTMLElement;
    // Radix listens for outside presses from the next task on
    await new Promise((r) => setTimeout(r, 0));
    await userEvent.setup({ pointerEventsCheck: 0 }).click(scrim);
    expect(s.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("settles back from a drag just below 40 % and dismisses just above it", () => {
    const s = renderBottom();
    drag(s.head(), SIZE * 0.39, 4000);
    expect(s.sheet().style.transform).toBe("translateY(0px)");
    fireEvent.transitionEnd(s.sheet());
    expect(s.onOpenChange).not.toHaveBeenCalled();
    drag(s.head(), SIZE * 0.41, 4000);
    expect(s.sheet().style.transform).toBe(`translateY(${SIZE}px)`);
  });

  it("settles back when the release speed is just below 0.5 px/ms, dismisses above it", () => {
    const s = renderBottom();
    drag(s.head(), 90, 200); // 0.45 px/ms, 22 % of the height
    expect(s.sheet().style.transform).toBe("translateY(0px)");
    fireEvent.transitionEnd(s.sheet());
    drag(s.head(), 110, 200); // 0.55 px/ms
    expect(s.sheet().style.transform).toBe(`translateY(${SIZE}px)`);
  });

  it("springs back on pointercancel, even past 40 %", () => {
    const s = renderBottom();
    drag(s.head(), SIZE * 0.6, 4000, false);
    fireEvent.pointerCancel(s.head(), { pointerId: 1, clientX: 50, clientY: 100 + SIZE * 0.6 });
    expect(s.sheet().getAttribute("data-drag")).toBe("settling");
    expect(s.sheet().style.transform).toBe("translateY(0px)");
    fireEvent.transitionEnd(s.sheet());
    expect(s.onOpenChange).not.toHaveBeenCalled();
  });

  describe("on touch, from the body", () => {
    /** A touch drag along y in four moves; returns the move events' defaultPrevented flags. */
    function touchDrag(
      el: Element,
      to: number,
      ms: number,
      end: "end" | "cancel" | "none" = "end",
    ) {
      const t = (d: number) => [{ identifier: 1, target: el, clientX: 50, clientY: 100 + d }];
      fireEvent.touchStart(el, { touches: t(0), changedTouches: t(0) });
      const prevented: boolean[] = [];
      for (let i = 1; i <= 4; i++) {
        now += ms / 4;
        const ev = createEvent.touchMove(el, {
          touches: t((to * i) / 4),
          changedTouches: t((to * i) / 4),
          cancelable: true,
        });
        el.dispatchEvent(ev);
        prevented.push(ev.defaultPrevented);
      }
      if (end === "end") fireEvent.touchEnd(el, { touches: [], changedTouches: t(to) });
      if (end === "cancel") fireEvent.touchCancel(el, { touches: [], changedTouches: t(to) });
      return prevented;
    }

    it("claims a downward pan at scroll top (preventing the browser's pan) and dismisses", () => {
      const s = renderBottom();
      const prevented = touchDrag(s.body(), SIZE * 0.5, 1000);
      expect(prevented.at(-1)).toBe(true);
      expect(s.sheet().getAttribute("data-drag")).toBe("settling");
      fireEvent.transitionEnd(s.sheet());
      expect(s.onOpenChange).toHaveBeenCalledWith(false);
    });

    it("leaves an upward pan, and a pan from a scrolled body, to the browser", () => {
      const s = renderBottom();
      // (the dialog's scroll lock may prevent touchmoves itself, so only the sheet's state counts)
      touchDrag(s.body(), -80, 1000);
      expect(s.sheet().getAttribute("data-drag")).toBe("idle");
      expect(s.sheet().style.transform).toBe("");
      s.body().scrollTop = 20;
      touchDrag(s.body(), 200, 1000);
      expect(s.sheet().getAttribute("data-drag")).toBe("idle");
      expect(s.sheet().style.transform).toBe("");
    });

    it("springs back on touchcancel", () => {
      const s = renderBottom();
      touchDrag(s.body(), SIZE * 0.6, 4000, "cancel");
      expect(s.sheet().style.transform).toBe("translateY(0px)");
      fireEvent.transitionEnd(s.sheet());
      expect(s.onOpenChange).not.toHaveBeenCalled();
    });

    it("does not double-handle the touch's own pointer events from the body", () => {
      const s = renderBottom();
      fireEvent.pointerDown(s.body(), {
        pointerId: 3,
        pointerType: "touch",
        clientX: 5,
        clientY: 5,
      });
      fireEvent.pointerMove(s.body(), {
        pointerId: 3,
        pointerType: "touch",
        clientX: 5,
        clientY: 300,
      });
      expect(s.sheet().getAttribute("data-drag")).toBe("idle");
    });
  });
  it("closes on the close button", () => {
    const s = renderBottom();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(s.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("snaps without a settling state under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }));
    const s = renderBottom();
    drag(s.head(), SIZE * 0.2, 2000);
    expect(s.sheet().getAttribute("data-drag")).toBe("idle");
    expect(s.sheet().style.transform).toBe("");
    drag(s.head(), SIZE * 0.5, 1000);
    expect(s.sheet().getAttribute("data-drag")).toBe("idle");
    expect(s.onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("a side sheet", () => {
  function renderSide(draggable?: boolean) {
    const onOpenChange = vi.fn();
    render(
      <DesignProvider locale="en">
        <Sheet
          open
          onOpenChange={onOpenChange}
          title="Run"
          {...(draggable === undefined ? {} : { draggable })}
        >
          <p>body</p>
        </Sheet>
      </DesignProvider>,
    );
    return {
      onOpenChange,
      sheet: document.querySelector(".cb-sheet") as HTMLElement,
      head: document.querySelector(".cb-sheet-head") as HTMLElement,
    };
  }

  it("does not drag by default (an ordinary admin Sheet stays put)", () => {
    const { sheet, head, onOpenChange } = renderSide();
    drag(head, SIZE * 0.6, 1000, true, true);
    expect(sheet.hasAttribute("data-drag")).toBe(false);
    expect(sheet.style.transform).toBe("");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("keeps Radix's data-state when draggable", () => {
    const { sheet } = renderSide(true);
    expect(sheet.getAttribute("data-state")).toBe("open");
    expect(sheet.getAttribute("data-drag")).toBe("idle");
  });

  it("draggable: follows the finger to the right and closes past 40 % of its width", () => {
    const { sheet, head, onOpenChange } = renderSide(true);
    drag(head, SIZE * 0.25, 1000, false, true);
    expect(sheet.getAttribute("data-drag")).toBe("dragging");
    expect(sheet.style.transform).toBe(`translateX(${SIZE * 0.25}px)`);
    fireEvent.pointerUp(head, { pointerId: 1, clientX: 100 + SIZE * 0.25, clientY: 50 });
    fireEvent.transitionEnd(sheet);
    expect(onOpenChange).not.toHaveBeenCalled();
    drag(head, SIZE * 0.5, 1000, true, true);
    fireEvent.transitionEnd(sheet);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("useDragDismiss toward the start edge", () => {
  function Probe({ onDismiss }: { onDismiss(): void }) {
    const d = useDragDismiss({ axis: "x", size: () => SIZE, onDismiss, direction: -1 });
    return (
      <div data-testid="p" {...d.panelProps} {...d.handleProps}>
        {d.state}
      </div>
    );
  }
  it("a drag to the left dismisses, one to the right does not start", () => {
    const onDismiss = vi.fn();
    render(<Probe onDismiss={onDismiss} />);
    const el = screen.getByTestId("p");
    drag(el, SIZE * 0.5, 1000, true, true);
    expect(el.getAttribute("data-drag")).toBe("idle");
    drag(el, -SIZE * 0.5, 1000, true, true);
    expect(el.style.transform).toBe(`translateX(${-SIZE}px)`);
    fireEvent.transitionEnd(el);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
