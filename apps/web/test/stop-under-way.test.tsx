// @vitest-environment jsdom
// A stop under way (AC5 fix round 1): it ends on the run's end in the log, on release, or after
// the bounded fallback's re-read; an end followed at once by a restart ends it too.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import { STOP_FALLBACK_MS, useStopUnderWay } from "../src/lib/stop";
import { ev, runStarted, userMsg } from "./support/conversation";

const running = [userMsg(1, "go"), runStarted(2)];
const aborted = (seq: number) => ev(seq, "run_aborted", { byAccountId: "a1", reason: "user" });

type Props = { events: ConversationEvent[] };

function mount(fallback: () => Promise<unknown> = () => Promise.resolve()) {
  return renderHook((p: Props) => useStopUnderWay(p.events, fallback), {
    initialProps: { events: running },
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useStopUnderWay", () => {
  it("lasts from begin until the log gains a run's end", () => {
    const { result, rerender } = mount();
    expect(result.current.requested).toBe(false);
    act(() => result.current.begin());
    expect(result.current.requested).toBe(true);
    // an event that ends nothing keeps it
    rerender({ events: [...running, userMsg(3, "more")] });
    expect(result.current.requested).toBe(true);
    rerender({ events: [...running, aborted(3)] });
    expect(result.current.requested).toBe(false);
  });

  it("an end followed at once by a restart ends it: the new run's Stop is free", () => {
    const { result, rerender } = mount();
    act(() => result.current.begin());
    rerender({ events: [...running, aborted(3), userMsg(4, "again"), runStarted(5)] });
    expect(result.current.requested).toBe(false);
  });

  it("release ends it (the request failed)", () => {
    const { result } = mount();
    act(() => result.current.begin());
    act(() => result.current.release());
    expect(result.current.requested).toBe(false);
  });

  it("after the fallback time it re-reads once, then lets Stop be pressed again", async () => {
    let settle: () => void = () => {};
    const fallback = vi.fn(
      () =>
        new Promise<void>((r) => {
          settle = r;
        }),
    );
    const { result } = mount(fallback);
    act(() => result.current.begin());
    await act(async () => await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS - 1));
    expect(fallback).not.toHaveBeenCalled();
    expect(result.current.requested).toBe(true);
    await act(async () => await vi.advanceTimersByTimeAsync(1));
    expect(fallback).toHaveBeenCalledTimes(1);
    // still under way until the re-read settles
    expect(result.current.requested).toBe(true);
    await act(async () => settle());
    expect(result.current.requested).toBe(false);
    // no second re-read
    await act(async () => await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS * 2));
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("a failed re-read still lets Stop be pressed again", async () => {
    const { result } = mount(() => Promise.reject(new Error("offline")));
    act(() => result.current.begin());
    await act(async () => await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS));
    expect(result.current.requested).toBe(false);
  });

  it("an end before the fallback time cancels the re-read", async () => {
    const fallback = vi.fn(() => Promise.resolve());
    const { result, rerender } = mount(fallback);
    act(() => result.current.begin());
    rerender({ events: [...running, aborted(3)] });
    await act(async () => await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS * 2));
    expect(fallback).not.toHaveBeenCalled();
  });
});
