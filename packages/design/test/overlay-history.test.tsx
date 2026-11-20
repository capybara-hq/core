import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BottomSheet,
  DesignProvider,
  Drawer,
  OVERLAY_HISTORY_MARKER,
  useOverlayHistory,
} from "../src/index";

// Decision 25: opening an overlay on a compact touch window pushes one marked history entry; the
// system back closes the top overlay; any other close pops the entry once.

type Win = { width: number; coarse: boolean };
function stubWindow(w: Win) {
  vi.stubGlobal("matchMedia", (q: string) => {
    const one = (s: string) => {
      const t = s.trim();
      if (t === "(pointer: coarse)") return w.coarse;
      if (t === "(any-pointer: coarse)") return w.coarse;
      if (t === "(any-pointer: fine)") return !w.coarse;
      const max = /\(max-width:\s*(\d+)px\)/.exec(t);
      return max ? w.width <= Number(max[1]) : false;
    };
    // "a, b and (not c)": the touch query; evaluate its three features by hand.
    const matches = q.includes("not (any-pointer: fine)") ? w.coarse : q.split(",").some(one);
    return { matches, media: q, addEventListener() {}, removeEventListener() {} };
  });
}

const markerOf = () => (history.state as Record<string, unknown> | null)?.[OVERLAY_HISTORY_MARKER];
const settled = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  stubWindow({ width: 390, coarse: true });
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Overlays({ initial = false }: { initial?: boolean }) {
  const [drawer, setDrawer] = useState(initial);
  const [sheet, setSheet] = useState(false);
  return (
    <DesignProvider locale="en">
      <button type="button" onClick={() => setDrawer(true)}>
        open-drawer
      </button>
      <Drawer open={drawer} onOpenChange={setDrawer} label="Menu">
        <button type="button" onClick={() => setSheet(true)}>
          open-sheet
        </button>
      </Drawer>
      <BottomSheet open={sheet} onOpenChange={setSheet} title="Settings">
        <button type="button" onClick={() => setSheet(false)}>
          pick
        </button>
      </BottomSheet>
    </DesignProvider>
  );
}

const hasDrawer = () => document.querySelector('[data-part="drawer"]') !== null;
const hasSheet = () => document.querySelector('[data-part="sheet"]') !== null;

describe("useOverlayHistory", () => {
  it("opening a drawer adds exactly one marked entry", async () => {
    const length = history.length;
    render(<Overlays />);
    await userEvent.click(screen.getByText("open-drawer"));
    expect(history.length).toBe(length + 1);
    expect(typeof markerOf()).toBe("string");
  });

  it("a back to the entry without the marker closes the overlay, with no second back", async () => {
    render(<Overlays />);
    await userEvent.click(screen.getByText("open-drawer"));
    const back = vi.spyOn(history, "back");
    act(() => history.back());
    await waitFor(() => expect(hasDrawer()).toBe(false));
    await settled();
    expect(back).toHaveBeenCalledTimes(1);
    expect(markerOf()).toBeUndefined();
  });

  it("closing by Escape calls history.back() once and lands on the entry without the marker", async () => {
    render(<Overlays />);
    await userEvent.click(screen.getByText("open-drawer"));
    const back = vi.spyOn(history, "back");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(hasDrawer()).toBe(false));
    await waitFor(() => expect(markerOf()).toBeUndefined());
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("a sheet over the drawer holds two entries and back closes the top one", async () => {
    render(<Overlays />);
    await userEvent.click(screen.getByText("open-drawer"));
    const drawerEntry = markerOf();
    await userEvent.click(screen.getByText("open-sheet"));
    expect(hasSheet()).toBe(true);
    expect(markerOf()).not.toBe(drawerEntry);
    act(() => history.back());
    await waitFor(() => expect(hasSheet()).toBe(false));
    expect(hasDrawer()).toBe(true);
    expect(markerOf()).toBe(drawerEntry);
    act(() => history.back());
    await waitFor(() => expect(hasDrawer()).toBe(false));
  });

  it("closing the sheet by its own button pops only the sheet's entry", async () => {
    render(<Overlays />);
    await userEvent.click(screen.getByText("open-drawer"));
    const drawerEntry = markerOf();
    await userEvent.click(screen.getByText("open-sheet"));
    await userEvent.click(screen.getByText("pick"));
    await waitFor(() => expect(hasSheet()).toBe(false));
    await waitFor(() => expect(markerOf()).toBe(drawerEntry));
    expect(hasDrawer()).toBe(true);
  });

  it.each([
    ["medium", { width: 700, coarse: true }],
    ["expanded", { width: 1200, coarse: true }],
    ["a fine pointer", { width: 390, coarse: false }],
  ])("pushes nothing on %s", async (_n, w) => {
    stubWindow(w);
    const length = history.length;
    render(<Overlays />);
    await userEvent.click(screen.getByText("open-drawer"));
    expect(hasDrawer()).toBe(true);
    expect(history.length).toBe(length);
    expect(markerOf()).toBeUndefined();
  });

  it("unmounting while open pops its entry", async () => {
    function Probe() {
      useOverlayHistory(true, () => {});
      return null;
    }
    const view = render(<Probe />);
    expect(typeof markerOf()).toBe("string");
    view.unmount();
    await waitFor(() => expect(markerOf()).toBeUndefined());
  });

  it("does not pop an entry the page already left (a pick that navigated)", async () => {
    render(<Overlays />);
    await userEvent.click(screen.getByText("open-drawer"));
    const back = vi.spyOn(history, "back");
    // The page navigates first, then the drawer closes.
    act(() => history.pushState({}, "", "/next"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(hasDrawer()).toBe(false));
    await settled();
    expect(back).not.toHaveBeenCalled();
  });
});
