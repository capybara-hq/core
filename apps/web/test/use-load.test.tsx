import { act, renderHook, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/lib/api";
import { useLoad } from "../src/lib/use-load";
import { useServerState } from "../src/lib/use-server-state";
import { json } from "./support/api";
import { expectNoFirstPaintFetch, renderServer, serverRoutes } from "./support/server";

describe("useLoad with initial (server-rendered first paint)", () => {
  it("starts ready and does not fetch on mount, even under StrictMode", async () => {
    const load = vi.fn(async () => "fresh");
    const { result } = renderHook(() => useLoad(load, ["o1"], { initial: "server" }), {
      wrapper: StrictMode,
    });
    expect(result.current.state).toEqual({ kind: "ready", data: "server" });
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
  });

  it("fetches when the deps change and on reload()", async () => {
    const load = vi.fn(async (org: string) => `fresh-${org}`);
    const { result, rerender } = renderHook(
      ({ org }) => useLoad(() => load(org), [org], { initial: "server" }),
      { initialProps: { org: "o1" } },
    );
    rerender({ org: "o2" });
    expect(result.current.state).toEqual({ kind: "loading" });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "ready", data: "fresh-o2" }));
    expect(load).toHaveBeenCalledTimes(1);
    rerender({ org: "o1" });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "ready", data: "fresh-o1" }));
    act(() => result.current.reload());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  });

  it("without initial still loads on mount", async () => {
    const load = vi.fn(async () => 1);
    const { result } = renderHook(() => useLoad(load, []));
    expect(result.current.state).toEqual({ kind: "loading" });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "ready", data: 1 }));
  });
});

describe("useServerState", () => {
  it("keeps local changes until the server sends a new initial", () => {
    const first = { n: 1 };
    const { result, rerender } = renderHook(({ initial }) => useServerState(initial), {
      initialProps: { initial: first },
    });
    expect(result.current[0]).toBe(first);
    act(() => result.current[1]({ n: 2 }));
    expect(result.current[0]).toEqual({ n: 2 });
    rerender({ initial: first });
    expect(result.current[0]).toEqual({ n: 2 });
    const next = { n: 3 };
    rerender({ initial: next });
    expect(result.current[0]).toBe(next);
  });

  it("takes an updater, applied to the latest value (several updates in one tick)", () => {
    const { result } = renderHook(({ initial }) => useServerState(initial), {
      initialProps: { initial: { n: 1 } },
    });
    act(() => {
      result.current[1]((v) => ({ n: v.n + 1 }));
      result.current[1]((v) => ({ n: v.n + 1 }));
    });
    expect(result.current[0]).toEqual({ n: 3 });
  });
});

describe("server page test helpers", () => {
  it("serves a page's reads from the server routes, then renders with no browser fetch", async () => {
    const calls = serverRoutes({ "GET /api/v1/things": () => json(200, { n: 4 }) });
    const Page = async () => {
      const { n } = await apiFetch<{ n: number }>("/api/v1/things?x=1");
      return <p>things {n}</p>;
    };
    const element = await Page();
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/things?x=1"]);
    const browser = expectNoFirstPaintFetch();
    renderServer(element);
    expect(screen.getByText("things 4")).toBeTruthy();
    expect(browser).toHaveLength(0);
  });
});
