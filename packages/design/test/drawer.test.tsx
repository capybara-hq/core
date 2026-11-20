import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, Drawer, DrawerLevel, NavRow } from "../src/index";

const SIZE = 320;
let now = 0;
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(SIZE);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Harness({ onPick }: { onPick?: () => void }) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(false);
  return (
    <DesignProvider locale="en">
      <button type="button" onClick={() => setOpen(true)}>
        trigger
      </button>
      <Drawer open={open} onOpenChange={setOpen} label="Menu">
        {level ? (
          <DrawerLevel title="Skills" backLabel="Back" onBack={() => setLevel(false)}>
            <NavRow label="Connectors" href="/connectors" />
          </DrawerLevel>
        ) : (
          <>
            <NavRow
              icon="inbox"
              label="Inbox"
              href="/inbox"
              {...(onPick ? { onSelect: onPick } : {})}
            />
            <NavRow label="More" trailing="chevron" onSelect={() => setLevel(true)} />
          </>
        )}
      </Drawer>
    </DesignProvider>
  );
}

const drawer = () => document.querySelector('[data-part="drawer"]') as HTMLElement | null;

/** A drag along x of `to` px over `ms`, in four moves, then a release. */
function drag(el: Element, to: number, ms: number) {
  const at = (d: number) => ({ clientX: 200 + d, clientY: 50 });
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, ...at(0) });
  for (let i = 1; i <= 4; i++) {
    now += ms / 4;
    fireEvent.pointerMove(el, { pointerId: 1, ...at((to * i) / 4) });
  }
  fireEvent.pointerUp(el, { pointerId: 1, ...at(to) });
}

describe("Drawer", () => {
  it("is a modal dialog with the label, and draws nothing while closed", async () => {
    render(<Harness />);
    expect(drawer()).toBeNull();
    expect(document.querySelector("[data-part='drawer-edge']")).toBeNull();
    await userEvent.click(screen.getByText("trigger"));
    const d = screen.getByRole("dialog", { name: "Menu" });
    expect(d.getAttribute("aria-modal")).toBe("true");
  });

  it("moves focus to the first row on open and returns it to the trigger on Escape", async () => {
    render(<Harness />);
    const trigger = screen.getByText("trigger");
    trigger.focus();
    await userEvent.click(trigger);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByText("Inbox").closest("a")),
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(drawer()).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on the scrim", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText("trigger"));
    fireEvent.pointerDown(document.querySelector('[data-part="drawer-scrim"]') as Element);
    fireEvent.click(document.querySelector('[data-part="drawer-scrim"]') as Element);
    await waitFor(() => expect(drawer()).toBeNull());
  });

  it("closes on a pick, with focus back on the trigger", async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const trigger = screen.getByText("trigger");
    trigger.focus();
    await userEvent.click(trigger);
    const click = createEvent.click(screen.getByText("Inbox"));
    click.preventDefault();
    fireEvent(screen.getByText("Inbox"), click);
    await waitFor(() => expect(drawer()).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a drag toward the start edge past 40 %, once the travel ended", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText("trigger"));
    drag(drawer() as Element, -SIZE * 0.5, 1000);
    expect(drawer()?.getAttribute("data-drag")).toBe("settling");
    expect(drawer()?.style.transform).toBe(`translateX(${-SIZE}px)`);
    fireEvent.transitionEnd(drawer() as Element);
    await waitFor(() => expect(drawer()).toBeNull());
  });

  it("springs back from a short drag", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText("trigger"));
    drag(drawer() as Element, -SIZE * 0.2, 1000);
    expect(drawer()?.style.transform).toBe("translateX(0px)");
    fireEvent.transitionEnd(drawer() as Element);
    expect(drawer()?.getAttribute("data-drag")).toBe("idle");
    expect(drawer()).not.toBeNull();
  });

  it("snaps closed under reduced motion", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }));
    render(<Harness />);
    await userEvent.click(screen.getByText("trigger"));
    drag(drawer() as Element, -SIZE * 0.5, 1000);
    await waitFor(() => expect(drawer()).toBeNull());
  });

  it("replaces the list with a level and returns with its back row", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText("trigger"));
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(drawer()).not.toBeNull();
    expect(screen.queryByText("Inbox")).toBeNull();
    expect(screen.getByText("Connectors")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Inbox")).toBeTruthy();
    expect(drawer()).not.toBeNull();
  });
});
