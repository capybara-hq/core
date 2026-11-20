import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHashItem } from "../src/lib/hash-item";

/** The browser's back: jsdom traverses the history and fires `popstate` afterwards. */
async function systemBack(expectedHash: string) {
  await act(async () => {
    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe(expectedHash));
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

describe("useHashItem", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/inbox");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("open pushes an entry and close steps back out of it", async () => {
    const { result } = renderHook(() => useHashItem());
    act(() => result.current.open("b"));
    expect(window.location.hash).toBe("#item=b");
    expect(result.current.id).toBe("b");
    // stubbed: a real traversal fires `popstate` after the test, once jsdom may be gone
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    act(() => result.current.close());
    expect(back).toHaveBeenCalledTimes(1);
    expect(result.current.id).toBeNull();
  });

  it("after the system back closed the item, close() leaves the history alone (stays on the page)", async () => {
    const { result } = renderHook(() => useHashItem());
    act(() => result.current.open("b"));
    await systemBack("");
    expect(result.current.id).toBeNull();
    // stubbed: a real traversal fires `popstate` after the test, once jsdom may be gone
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    act(() => result.current.close());
    expect(back).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/inbox");
    // opening again pushes a fresh entry, and close steps back out of that one
    act(() => result.current.open("c"));
    act(() => result.current.close());
    expect(back).toHaveBeenCalledTimes(1);
  });
});
