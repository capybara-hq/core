import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(s.sheet().getAttribute("data-state")).toBe("settling");
    expect(s.sheet().style.transform).toBe(`translateY(${SIZE}px)`);
    expect(s.onOpenChange).not.toHaveBeenCalled();
    fireEvent.transitionEnd(s.sheet());
    expect(s.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("follows the finger while dragging, scrim fading by the dragged share", () => {
    const s = renderBottom();
    drag(s.head(), SIZE * 0.25, 1000, false);
    expect(s.sheet().getAttribute("data-state")).toBe("dragging");
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
    expect(s.sheet().getAttribute("data-state")).toBe("settling");
    expect(s.sheet().style.transform).toBe("translateY(0px)");
    fireEvent.transitionEnd(s.sheet());
    expect(s.sheet().getAttribute("data-state")).toBe("idle");
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
    expect(s.sheet().getAttribute("data-state")).toBe("idle");
    expect(s.onOpenChange).not.toHaveBeenCalled();
  });

  it("drags from the body while its scroll is at the top, downward only", () => {
    const s = renderBottom();
    drag(s.body(), -SIZE * 0.5, 1000);
    expect(s.sheet().getAttribute("data-state")).toBe("idle");
    drag(s.body(), SIZE * 0.5, 1000);
    expect(s.sheet().getAttribute("data-state")).toBe("settling");
  });

  it("leaves a click on the close button alone (below the drag slop)", () => {
    const s = renderBottom();
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.pointerDown(close, { pointerId: 1, button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerMove(close, { pointerId: 1, clientX: 5, clientY: 8 });
    fireEvent.pointerUp(close, { pointerId: 1, clientX: 5, clientY: 8 });
    expect(s.sheet().getAttribute("data-state")).toBe("idle");
  });

  it("still closes on Esc and returns focus", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onOpenChange = vi.fn();
    renderBottom(onOpenChange);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    opener.remove();
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
    expect(s.sheet().getAttribute("data-state")).toBe("idle");
    expect(s.sheet().style.transform).toBe("");
    drag(s.head(), SIZE * 0.5, 1000);
    expect(s.sheet().getAttribute("data-state")).toBe("idle");
    expect(s.onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("a side sheet", () => {
  it("drags to the right by its head and closes past 40 % of its width", () => {
    const onOpenChange = vi.fn();
    render(
      <DesignProvider locale="en">
        <Sheet open onOpenChange={onOpenChange} title="Run">
          <p>body</p>
        </Sheet>
      </DesignProvider>,
    );
    const sheet = document.querySelector(".cb-sheet") as HTMLElement;
    const head = document.querySelector(".cb-sheet-head") as HTMLElement;
    drag(head, SIZE * 0.25, 1000, false, true);
    expect(sheet.getAttribute("data-state")).toBe("dragging");
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
    expect(el.getAttribute("data-state")).toBe("idle");
    drag(el, -SIZE * 0.5, 1000, true, true);
    expect(el.style.transform).toBe(`translateX(${-SIZE}px)`);
    fireEvent.transitionEnd(el);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
