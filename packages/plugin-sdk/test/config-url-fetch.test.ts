import { afterEach, describe, expect, it, vi } from "vitest";
import { configUrlFetch } from "../src/config-url-fetch.js";

function fakeNet() {
  const calls: unknown[][] = [];
  const net = {
    fetch: async (...args: unknown[]) => {
      calls.push(args);
      return new Response("net");
    },
  };
  return { net, calls };
}

describe("configUrlFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubGlobal() {
    const g = vi.fn(async () => new Response("global"));
    vi.stubGlobal("fetch", g);
    return g;
  }

  it.each([
    ["equal", "https://h/v1", "https://h/v1"],
    ["trailing slashes ignored", "https://h/v1/", "https://h/v1"],
    ["in a platform list", "https://h/v1", ["https://a/", "https://h/v1/"]],
  ])("keeps the global fetch for the platform URL (%s)", async (_n, url, platform) => {
    const g = stubGlobal();
    const { net, calls } = fakeNet();
    const f = configUrlFetch(net, { url, platform, orgId: "o1" });
    await f("https://h/v1/x");
    expect(g).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["different path", "https://h/v1/x", "https://h/v1"],
    ["different scheme", "http://h/v1", "https://h/v1"],
    ["no platform value", "https://h/v1", undefined],
  ])("routes an org URL through net.fetch (%s)", async (_n, url, platform) => {
    const g = stubGlobal();
    const { net, calls } = fakeNet();
    const init = { method: "POST" };
    const f = configUrlFetch(net, { url, platform, orgId: "o1" });
    await f("https://h/v1/x", init);
    expect(g).not.toHaveBeenCalled();
    expect(calls).toEqual([["https://h/v1/x", init, { orgId: "o1" }]]);
  });

  it("passes no orgId when there is none", async () => {
    stubGlobal();
    const { net, calls } = fakeNet();
    await configUrlFetch(net, { url: "https://x" })("https://x/a");
    expect(calls[0]?.[2]).toEqual({});
  });

  it("decides from the platform value given when it is called", async () => {
    const g = stubGlobal();
    const { net, calls } = fakeNet();
    // The platform URL changed after the org's value was read: the org value is no longer the
    // platform's, so it goes through the guarded client.
    await configUrlFetch(net, { url: "https://old", platform: "https://new", orgId: "o1" })(
      "https://old/x",
    );
    expect(g).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});
