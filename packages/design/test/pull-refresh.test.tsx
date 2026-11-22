// Pull to refresh (interaction spec §3, D4): active only in the native mobile shell (the shell's
// declared `kind`, read from window.capybaraShell like the shell environment) on a touch device; a vertical pull past the threshold from the top of every scroller under the finger plays
// the selection haptic and refreshes.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, type NativeHandlers, PULL_THRESHOLD, PullToRefresh } from "../src/index";

const realMatchMedia = window.matchMedia;
const touchMatchMedia = ((q: string) => ({
  matches:
    q.trim() === "(min-width: 600px)" ||
    q.includes("pointer: coarse") ||
    q.includes("not (any-pointer: fine)"),
  media: q,
  addEventListener() {},
  removeEventListener() {},
})) as unknown as typeof window.matchMedia;

/** A native shell's global of the given kind (envelope version 1). */
function installShell(kind: "mobile" | "desktop", capabilities: Record<string, unknown> = {}) {
  Object.assign(window, { capybaraShell: { version: 1, kind, capabilities, on: () => () => {} } });
}

beforeEach(() => {
  window.matchMedia = touchMatchMedia;
  installShell("mobile", { "haptics@1": { impact: async () => {} } });
});
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  Reflect.deleteProperty(window, "capybaraShell");
});

/** The mobile shell's handlers as the web adapter passes them. */
const mobile = (extra: Partial<NativeHandlers> = {}): NativeHandlers => ({
  haptics: vi.fn(),
  ...extra,
});

function setup(native: NativeHandlers | undefined, onRefresh: () => Promise<unknown>) {
  return render(
    <DesignProvider locale="en" {...(native ? { native } : {})}>
      <div data-testid="scroller" style={{ overflowY: "auto" }}>
        <PullToRefresh onRefresh={onRefresh}>
          <div data-testid="pane" style={{ overflowY: "auto" }}>
            <p data-testid="content">rows</p>
          </div>
        </PullToRefresh>
      </div>
    </DesignProvider>,
  );
}

const touch = (y: number, x = 50) => ({ touches: [{ clientY: y, clientX: x }] });
const pullBy = (el: Element, dy: number, dx = 0) => {
  fireEvent.touchStart(el, touch(100));
  fireEvent.touchMove(el, touch(100 + dy, 50 + dx));
  fireEvent.touchEnd(el, { touches: [] });
};
const FAR = PULL_THRESHOLD * 3;
const indicator = () => document.querySelector("[data-part=pull-indicator]");
const live = () => document.querySelector("[data-part=pull-refresh] [role=status]");

describe("PullToRefresh", () => {
  it("is inactive in a browser (no shell global), whatever the handlers", () => {
    Reflect.deleteProperty(window, "capybaraShell");
    const onRefresh = vi.fn(() => Promise.resolve());
    const { container } = setup(mobile(), onRefresh);
    expect(container.querySelector("[data-part=pull-refresh]")).toBeNull();
    pullBy(screen.getByTestId("content"), FAR);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("is inactive in a desktop shell, even one that offers haptics@1", () => {
    installShell("desktop", { "haptics@1": { impact: async () => {} } });
    const onRefresh = vi.fn(() => Promise.resolve());
    const { container } = setup(mobile(), onRefresh);
    expect(container.querySelector("[data-part=pull-refresh]")).toBeNull();
    pullBy(screen.getByTestId("content"), FAR);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("is inactive in the mobile shell on a fine pointer", () => {
    window.matchMedia = realMatchMedia;
    const onRefresh = vi.fn(() => Promise.resolve());
    const { container } = setup(mobile(), onRefresh);
    expect(container.querySelector("[data-part=pull-refresh]")).toBeNull();
    pullBy(screen.getByTestId("content"), FAR);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("is active in the mobile shell on touch without any native handlers", () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const { container } = setup(undefined, onRefresh);
    expect(container.querySelector("[data-part=pull-refresh]")).not.toBeNull();
    pullBy(screen.getByTestId("content"), FAR);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("calls onRefresh with the selection haptic after a pull past the threshold", async () => {
    let settle = () => {};
    const onRefresh = vi.fn(() => new Promise<void>((r) => (settle = r)));
    const haptics = vi.fn();
    setup(mobile({ haptics }), onRefresh);
    pullBy(screen.getByTestId("content"), FAR);
    expect(haptics).toHaveBeenCalledWith("selection");
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(indicator()?.getAttribute("data-pending")).toBe("true");
    expect(live()?.textContent).toBe("Refreshing");
    await act(async () => settle());
    expect(indicator()).toBeNull();
    expect(live()?.textContent).toBe("");
  });

  it("keeps its live region mounted while idle", () => {
    setup(
      mobile(),
      vi.fn(() => Promise.resolve()),
    );
    expect(live()).not.toBeNull();
    expect(live()?.textContent).toBe("");
  });

  it("says release to refresh once the pull passes the threshold", () => {
    setup(
      mobile(),
      vi.fn(() => Promise.resolve()),
    );
    const el = screen.getByTestId("content");
    fireEvent.touchStart(el, touch(100));
    fireEvent.touchMove(el, touch(100 + PULL_THRESHOLD));
    expect(indicator()?.getAttribute("data-ready")).toBeNull();
    expect(indicator()?.textContent).toBe("Pull to refresh");
    fireEvent.touchMove(el, touch(100 + FAR));
    expect(indicator()?.getAttribute("data-ready")).toBe("true");
    expect(indicator()?.textContent).toBe("Release to refresh");
  });

  it("centres the indicator by a translate, not a margin guess", () => {
    setup(
      mobile(),
      vi.fn(() => Promise.resolve()),
    );
    const el = screen.getByTestId("content");
    fireEvent.touchStart(el, touch(100));
    fireEvent.touchMove(el, touch(100 + FAR));
    const style = (indicator() as HTMLElement).style;
    expect(style.transform).toMatch(/translate\(-50%/);
    expect(style.marginLeft).toBe("");
  });

  it("does not refresh for a short pull", () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const haptics = vi.fn();
    setup(mobile({ haptics }), onRefresh);
    pullBy(screen.getByTestId("content"), PULL_THRESHOLD - 10);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(haptics).not.toHaveBeenCalled();
  });

  it("does not refresh when the outer scroller is scrolled down", () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    setup(mobile(), onRefresh);
    screen.getByTestId("scroller").scrollTop = 40;
    pullBy(screen.getByTestId("content"), FAR);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("does not refresh when an inner pane under the finger is scrolled down", () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    setup(mobile(), onRefresh);
    screen.getByTestId("pane").scrollTop = 40;
    pullBy(screen.getByTestId("content"), FAR);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("ignores a mostly horizontal drag", () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    setup(mobile(), onRefresh);
    pullBy(screen.getByTestId("content"), FAR, FAR * 2);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(indicator()).toBeNull();
  });
});
