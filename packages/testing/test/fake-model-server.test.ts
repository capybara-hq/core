import { afterEach, describe, expect, it } from "vitest";
import { startFakeModelServer } from "../src/index.js";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

describe("startFakeModelServer", () => {
  it("emits SSE events in order and records requests", async () => {
    const s = await startFakeModelServer(() => ({
      status: 200,
      sse: [{ event: "a", data: "1" }, { data: "2" }],
    }));
    stop = s.stop;
    const res = await fetch(`${s.url}/v1/x`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test": "y" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toBe("event: a\ndata: 1\n\ndata: 2\n\n");
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]?.path).toBe("/v1/x");
    expect(s.requests[0]?.body).toEqual({ hello: "world" });
    expect(s.requests[0]?.headers["x-test"]).toBe("y");
  });
  it("returns json with status", async () => {
    const s = await startFakeModelServer(() => ({ status: 429, json: { err: 1 } }));
    stop = s.stop;
    const res = await fetch(`${s.url}/z`, { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ err: 1 });
  });
  it("stall sends headers only", async () => {
    const s = await startFakeModelServer(() => ({ stall: true }));
    stop = s.stop;
    const ac = new AbortController();
    const res = await fetch(`${s.url}/z`, { method: "POST", body: "{}", signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    const raced = await Promise.race([
      reader?.read(),
      new Promise((r) => setTimeout(() => r("timeout"), 200)),
    ]);
    expect(raced).toBe("timeout");
    ac.abort();
  });
});
