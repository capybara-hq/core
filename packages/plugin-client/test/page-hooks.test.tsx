import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useNavigate, usePageParams, usePluginQuery } from "../src/index.js";
import { renderWithFakeHost } from "../src/testing/index.js";

afterEach(cleanup);

describe("page hooks", () => {
  it("usePluginQuery resolves from the host and refetches on invalidate", async () => {
    function Probe() {
      const q = usePluginQuery("items", { project: "CAP" });
      return <p>{q.status === "ready" ? JSON.stringify(q.data) : q.status}</p>;
    }
    const r = renderWithFakeHost(<Probe />, {
      slot: "org.page",
      args: { params: {} },
      queries: { items: (p) => [{ id: "1", p }] },
    });
    expect(await screen.findByText('[{"id":"1","p":{"project":"CAP"}}]')).toBeTruthy();
    expect(r.queryCalls("items")).toBe(1);
    r.invalidate(["items"]);
    await screen.findByText('[{"id":"1","p":{"project":"CAP"}}]');
    expect(r.queryCalls("items")).toBe(2);
    r.unmount();
  });

  it("a missing or throwing query reads as error", async () => {
    function Probe() {
      const q = usePluginQuery("nope");
      return <p>{q.status === "error" ? q.error : q.status}</p>;
    }
    const r = renderWithFakeHost(<Probe />, { slot: "org.page", args: { params: {} } });
    expect(await screen.findByText('no fake query "nope"')).toBeTruthy();
    r.unmount();
  });

  it("usePageParams returns the page params", () => {
    function Probe() {
      return <p>{JSON.stringify(usePageParams())}</p>;
    }
    const r = renderWithFakeHost(<Probe />, {
      slot: "org.page",
      args: { params: { a: "1" } },
      params: { a: "1" },
    });
    expect(screen.getByText('{"a":"1"}')).toBeTruthy();
    r.unmount();
  });

  it("useNavigate passes the three shapes and refuses anything else", () => {
    let nav: ReturnType<typeof useNavigate> = () => {};
    function Probe() {
      nav = useNavigate();
      return null;
    }
    const r = renderWithFakeHost(<Probe />, { slot: "org.page", args: { params: {} } });
    nav({ params: { tab: null }, replace: true });
    nav({ page: { id: "board", params: { p: "1" } } });
    nav({ conversation: "c1" });
    expect(r.navigations).toHaveLength(3);
    expect(() => nav({ url: "https://x" } as never)).toThrow(/navigate target/);
    expect(() => nav({ page: { id: "a" }, conversation: "c" } as never)).toThrow(/navigate target/);
    expect(() => nav({ conversation: "c", replace: true } as never)).toThrow(/navigate target/);
    expect(r.navigations).toHaveLength(3);
    r.unmount();
  });
});
