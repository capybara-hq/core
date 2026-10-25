import { afterEach, describe, expect, it } from "vitest";
import { startFakeMarketplace } from "../src/index.js";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

describe("startFakeMarketplace", () => {
  it("serves marketplace.json with an ETag; 304 on a matching If-None-Match; setManifest changes the ETag", async () => {
    const c = await startFakeMarketplace({ manifest: { a: 1 } });
    stops.push(c.stop);
    expect(c.url).toMatch(/\/marketplace\.json$/);
    const r1 = await fetch(c.url);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ a: 1 });
    const etag = r1.headers.get("etag") ?? "";
    expect(etag).toMatch(/^".+"$/);
    const r2 = await fetch(c.url, { headers: { "if-none-match": etag } });
    expect(r2.status).toBe(304);
    c.setManifest({ a: 2 });
    const r3 = await fetch(c.url, { headers: { "if-none-match": etag } });
    expect(r3.status).toBe(200);
    expect(r3.headers.get("etag")).not.toBe(etag);
    expect(c.requests).toEqual([{}, { etag }, { etag }]);
  });

  it("serves a string as is (for invalid manifests)", async () => {
    const c = await startFakeMarketplace({ manifest: "{not json" });
    stops.push(c.stop);
    expect(await (await fetch(c.url)).text()).toBe("{not json");
  });
});
