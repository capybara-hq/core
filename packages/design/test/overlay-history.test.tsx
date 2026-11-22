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
import { POP_SETTLE_LIMIT_MS } from "../src/overlays/use-overlay-history";

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
      // the compact query is the complement of (min-width: 600px)
      const notMin = /^not all and \(min-width:\s*(\d+)px\)$/.exec(t);
      if (notMin) return w.width < Number(notMin[1]);
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

  // I2: the router rewrites history.state (Next's HistoryUpdater replaceState) while an overlay is
  // open; the decisions come from the module's own stack, not from a marker in the state.
  it("a replaceState while open does not break back-closes", async () => {
    render(<Overlays />);
    await userEvent.click(screen.getByText("open-drawer"));
    act(() => history.replaceState({ __NA: true }, ""));
    act(() => history.back());
    await waitFor(() => expect(hasDrawer()).toBe(false));
  });

  it("a replaceState while open does not stop the close pop", async () => {
    render(<Overlays />);
    await userEvent.click(screen.getByText("open-drawer"));
    act(() => history.replaceState({ __NA: true }, ""));
    const back = vi.spyOn(history, "back");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(hasDrawer()).toBe(false));
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
  });

  // A link pick pops the drawer's entry first and navigates after the pop (mobile touch plan
  // Task 28): the router's push would otherwise still be pending when the traversal runs, so the
  // pick could not pop at all and left a stale entry (an extra back step to the same page).
  function Pick({ onNavigate }: { onNavigate?: (href: string) => void }) {
    const [open, setOpen] = useState(true);
    return (
      <DesignProvider locale="en">
        <Drawer
          open={open}
          onOpenChange={setOpen}
          label="Menu"
          {...(onNavigate ? { onNavigate } : {})}
        >
          <a href="/next" data-drawer-pick="true">
            go
          </a>
          <a href="/new-tab" target="_blank" rel="noreferrer">
            tab
          </a>
        </Drawer>
      </DesignProvider>
    );
  }

  it("a link pick pops the drawer's entry, then navigates after the pop", async () => {
    history.replaceState(null, "", "/prev");
    history.pushState(null, "", "/");
    const visits: { href: string; marker: unknown; path: string }[] = [];
    const onNavigate = vi.fn((href: string) =>
      visits.push({ href, marker: markerOf(), path: location.pathname }),
    );
    render(<Pick onNavigate={onNavigate} />);
    expect(typeof markerOf()).toBe("string");
    await userEvent.click(screen.getByText("go"));
    await waitFor(() => expect(hasDrawer()).toBe(false));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    // navigated from the entry under the drawer's: one back goes to the previous page
    expect(visits).toEqual([{ href: "/next", marker: undefined, path: "/" }]);
    await settled();
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("a modified click or a new-tab link is the browser's own: no pop, no navigate", async () => {
    const onNavigate = vi.fn();
    render(<Pick onNavigate={onNavigate} />);
    const back = vi.spyOn(history, "back");
    const go = vi.spyOn(history, "go");
    const tab = screen.getByText("tab");
    tab.addEventListener("click", (e) => e.preventDefault());
    await userEvent.click(tab);
    await settled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    // the drawer still closes on the pick and pops its entry the ordinary way
    await waitFor(() => expect(hasDrawer()).toBe(false));
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(markerOf()).toBeUndefined());
    await settled();
  });

  it("a pick in a sheet over the drawer pops both entries in one step, then navigates", async () => {
    history.replaceState(null, "", "/");
    function Stack({ onNavigate }: { onNavigate: (href: string) => void }) {
      const [drawer, setDrawer] = useState(true);
      const [sheet, setSheet] = useState(false);
      return (
        <DesignProvider locale="en">
          <Drawer open={drawer} onOpenChange={setDrawer} label="Menu" onNavigate={onNavigate}>
            <button type="button" onClick={() => setSheet(true)}>
              open-sheet
            </button>
            <BottomSheet open={sheet} onOpenChange={setSheet} title="Account">
              <a href="/account/profile" data-drawer-pick="true">
                settings
              </a>
            </BottomSheet>
          </Drawer>
        </DesignProvider>
      );
    }
    const onNavigate = vi.fn((_href: string) => markerOf());
    render(<Stack onNavigate={onNavigate} />);
    const drawerEntry = markerOf();
    await userEvent.click(screen.getByText("open-sheet"));
    expect(markerOf()).not.toBe(drawerEntry);
    const go = vi.spyOn(history, "go");
    await userEvent.click(screen.getByText("settings"));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/account/profile"));
    expect(onNavigate.mock.results[0]?.value).toBeUndefined();
    expect(go).toHaveBeenCalledWith(-2);
    await waitFor(() => expect(hasDrawer()).toBe(false));
    expect(hasSheet()).toBe(false);
  });

  it("without onNavigate a link pick closes the drawer and leaves its entry", async () => {
    render(<Pick />);
    const back = vi.spyOn(history, "back");
    screen.getByText("go").addEventListener("click", (e) => e.preventDefault());
    await userEvent.click(screen.getByText("go"));
    await waitFor(() => expect(hasDrawer()).toBe(false));
    await settled();
    expect(back).not.toHaveBeenCalled();
  });

  // T27 review (Important): a button pick usually navigates in the same tick (a router push); a
  // back() queued then would win over the push and lose the navigation. It leaves its entry, unless
  // it is marked to stay on the page (`data-drawer-pick="stay"`), which pops as usual.
  it("a button pick leaves the drawer's entry: no back() races its navigation", async () => {
    const pushed: string[] = [];
    function ButtonPick() {
      const [open, setOpen] = useState(true);
      return (
        <DesignProvider locale="en">
          <Drawer open={open} onOpenChange={setOpen} label="Menu" onNavigate={() => {}}>
            <button
              type="button"
              data-drawer-pick="true"
              onClick={() => {
                // a router's push commits later than the click (Next pushes in a transition)
                setTimeout(() => {
                  pushed.push("/c/new");
                  history.pushState(null, "", "/c/new");
                }, 0);
              }}
            >
              new
            </button>
          </Drawer>
        </DesignProvider>
      );
    }
    history.replaceState(null, "", "/");
    render(<ButtonPick />);
    const back = vi.spyOn(history, "back");
    const go = vi.spyOn(history, "go");
    await userEvent.click(screen.getByText("new"));
    await waitFor(() => expect(hasDrawer()).toBe(false));
    await waitFor(() => expect(pushed).toEqual(["/c/new"]));
    await settled();
    expect(back).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/c/new");
  });

  it('a button pick marked data-drawer-pick="stay" pops its entry as a close does', async () => {
    function StayPick() {
      const [open, setOpen] = useState(true);
      return (
        <DesignProvider locale="en">
          <Drawer open={open} onOpenChange={setOpen} label="Menu">
            <button type="button" data-drawer-pick="stay">
              stay
            </button>
          </Drawer>
        </DesignProvider>
      );
    }
    render(<StayPick />);
    const back = vi.spyOn(history, "back");
    await userEvent.click(screen.getByText("stay"));
    await waitFor(() => expect(hasDrawer()).toBe(false));
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(markerOf()).toBeUndefined());
    await settled();
  });

  // T28 review: a traversal whose popstate never comes (a count past the real stack, a browser
  // quirk) must not lose the pick nor leave a pending self-pop that swallows the next real back.
  it("a pick still navigates when the pop's popstate never comes, and the next back still closes", async () => {
    history.replaceState(null, "", "/");
    const onNavigate = vi.fn();
    render(<Pick onNavigate={onNavigate} />);
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    await userEvent.click(screen.getByText("go"));
    expect(back).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/next"));
    back.mockRestore();
    cleanup();
    // a real back after that closes the next overlay (no stale self-pop count swallows it)
    render(<Overlays />);
    await userEvent.click(screen.getByText("open-drawer"));
    act(() => history.back());
    await waitFor(() => expect(hasDrawer()).toBe(false));
    await settled();
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("the back after an orphaned pick entry still closes the next drawer first", async () => {
    render(<Overlays />);
    await userEvent.click(screen.getByText("open-drawer"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(hasDrawer()).toBe(false));
    await settled();
    await userEvent.click(screen.getByText("open-drawer"));
    act(() => history.back());
    await waitFor(() => expect(hasDrawer()).toBe(false));
  });
});

// A push while a pop of the module's own is in flight waits for it to land (an overlay that
// replaces another, as a confirmation opened from an action sheet's pick): a browser runs back()
// later, and a push made meanwhile would be the entry that back pops.
describe("useOverlayHistory: a push waits for an in-flight pop", () => {
  function Probe({ open, onClose }: { open: boolean; onClose: () => void }) {
    useOverlayHistory(open, onClose);
    return null;
  }
  function Two({ a, b, closeB = () => {} }: { a: boolean; b: boolean; closeB?: () => void }) {
    return (
      <>
        <Probe open={a} onClose={() => {}} />
        <Probe open={b} onClose={closeB} />
      </>
    );
  }
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the bound pushes it when the pop's popstate never lands, and the next back still closes", async () => {
    const closeB = vi.fn();
    const { rerender } = render(<Two a b={false} closeB={closeB} />);
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    const push = vi.spyOn(history, "pushState");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => rerender(<Two a={false} b closeB={closeB} />));
    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(POP_SETTLE_LIMIT_MS - 1));
    expect(push).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(push).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    back.mockRestore();
    // the lost pop is no longer counted as ours: this back closes B
    act(() => history.back());
    await waitFor(() => expect(closeB).toHaveBeenCalledTimes(1));
  });

  it("an overlay closed before its deferred push pushes nothing", async () => {
    const { rerender } = render(<Two a b={false} />);
    const realBack = history.back.bind(history);
    const held: (() => void)[] = [];
    vi.spyOn(history, "back").mockImplementation(() => held.push(realBack));
    const push = vi.spyOn(history, "pushState");
    await act(async () => rerender(<Two a={false} b />));
    await act(async () => rerender(<Two a={false} b={false} />));
    expect(held).toHaveLength(1);
    act(() => held[0]?.());
    await waitFor(() => expect(markerOf()).toBeUndefined());
    await settled();
    expect(push).not.toHaveBeenCalled();
  });

  it("a release that pops nothing (the page moved on) releases the waiting push at once", async () => {
    const { rerender } = render(<Two a b={false} />);
    const back = vi.spyOn(history, "back");
    const push = vi.spyOn(history, "pushState");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      history.replaceState(null, "", "/other");
      rerender(<Two a={false} b />);
    });
    expect(back).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
    expect(typeof markerOf()).toBe("string");
  });
});
