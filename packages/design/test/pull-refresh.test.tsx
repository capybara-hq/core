// Pull to refresh (interaction spec §3, D4): active only in a native shell; a pull past the
// threshold from the scroller's top plays the selection haptic and refreshes.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, type NativeHandlers, PULL_THRESHOLD, PullToRefresh } from "../src/index";

afterEach(cleanup);

function setup(native: NativeHandlers | undefined, onRefresh: () => Promise<unknown>) {
  return render(
    <DesignProvider locale="en" {...(native ? { native } : {})}>
      <div data-testid="scroller" style={{ overflowY: "auto" }}>
        <PullToRefresh onRefresh={onRefresh}>
          <p data-testid="content">rows</p>
        </PullToRefresh>
      </div>
    </DesignProvider>,
  );
}

const touch = (y: number) => ({ touches: [{ clientY: y }] });
const pullBy = (el: Element, dy: number) => {
  fireEvent.touchStart(el, touch(100));
  fireEvent.touchMove(el, touch(100 + dy));
  fireEvent.touchEnd(el, { touches: [] });
};
const FAR = PULL_THRESHOLD * 3;

describe("PullToRefresh", () => {
  it("is inactive in a browser", () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const { container } = setup(undefined, onRefresh);
    expect(container.querySelector("[data-part=pull-refresh]")).toBeNull();
    pullBy(screen.getByTestId("content"), FAR);
    expect(screen.queryByRole("status")).toBeNull();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("calls onRefresh with the selection haptic after a pull past the threshold", async () => {
    let settle = () => {};
    const onRefresh = vi.fn(() => new Promise<void>((r) => (settle = r)));
    const haptics = vi.fn();
    setup({ haptics }, onRefresh);
    pullBy(screen.getByTestId("content"), FAR);
    expect(haptics).toHaveBeenCalledWith("selection");
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").getAttribute("data-pending")).toBe("true");
    await act(async () => settle());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not refresh for a short pull", () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const haptics = vi.fn();
    setup({ haptics }, onRefresh);
    pullBy(screen.getByTestId("content"), PULL_THRESHOLD - 10);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(haptics).not.toHaveBeenCalled();
  });

  it("does not refresh when the scroller is scrolled down", () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    setup({ haptics: vi.fn() }, onRefresh);
    screen.getByTestId("scroller").scrollTop = 40;
    pullBy(screen.getByTestId("content"), FAR);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
