import { afterEach, describe, expect, it, vi } from "vitest";
import { serverNeedsSetup } from "../src/lib/server-setup";

afterEach(() => vi.unstubAllGlobals());

const answer = (fn: () => Promise<Response>) => {
  const fetch = vi.fn((_url: string, _init?: RequestInit) => fn());
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

describe("serverNeedsSetup (the server-side setup redirect)", () => {
  it("returns the kernel's answer from GET /api/v1/setup, never cached", async () => {
    const fetch = answer(async () => Response.json({ needsSetup: true }));
    expect(await serverNeedsSetup()).toBe(true);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://localhost:8080/api/v1/setup");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
    answer(async () => Response.json({ needsSetup: false }));
    expect(await serverNeedsSetup()).toBe(false);
  });

  it("leaves the decision to the browser when the kernel can't answer", async () => {
    answer(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await serverNeedsSetup()).toBeUndefined();
    answer(async () => Response.json({ error: { code: "unavailable" } }, { status: 503 }));
    expect(await serverNeedsSetup()).toBeUndefined();
    answer(async () => Response.json({}));
    expect(await serverNeedsSetup()).toBeUndefined();
  });
});
