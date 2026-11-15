// @vitest-environment jsdom
import { focusManager, onlineManager, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeQueryClient } from "../src/lib/query/client";

const scan = vi.fn(async () => ({ candidates: [] }));
vi.mock("../src/lib/devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/devices")>()),
  listDeviceProjectCandidates: () => scan(),
}));

const { deviceProjectCandidatesQuery } = await import("../src/lib/query/devices");

afterEach(() => {
  scan.mockClear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

describe("deviceProjectCandidatesQuery", () => {
  // Every scan starts or resumes the device: an open add dialog scans once, whatever the window does.
  it("does not re-scan on window focus or reconnect while the dialog is open", async () => {
    const client = makeQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useQuery(deviceProjectCandidatesQuery("o", "d")), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(scan).toHaveBeenCalledTimes(1);

    // well past the "live" freshness window: the dialog may stay open for minutes
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    try {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await Promise.resolve();
      expect(result.current.isFetching).toBe(false);
      expect(scan).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays fresh for as long as a dialog is open", () => {
    const o = deviceProjectCandidatesQuery("o", "d");
    expect(o.refetchOnWindowFocus).toBe(false);
    expect(o.refetchOnReconnect).toBe(false);
    expect(o.staleTime).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
