import { afterEach, describe, expect, it } from "vitest";
import { startFakeCatalog } from "../src/index.js";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

describe("startFakeCatalog", () => {
  it("返回 JSON 与 ETag；带匹配的 If-None-Match 返回 304；setIndex 后 ETag 变化", async () => {
    const c = await startFakeCatalog({ index: { a: 1 } });
    stops.push(c.stop);
    const r1 = await fetch(c.url);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ a: 1 });
    const etag = r1.headers.get("etag") ?? "";
    expect(etag).toMatch(/^".+"$/);
    const r2 = await fetch(c.url, { headers: { "if-none-match": etag } });
    expect(r2.status).toBe(304);
    c.setIndex({ a: 2 });
    const r3 = await fetch(c.url, { headers: { "if-none-match": etag } });
    expect(r3.status).toBe(200);
    expect(r3.headers.get("etag")).not.toBe(etag);
    expect(c.requests).toEqual([{}, { etag }, { etag }]);
  });

  it("字符串原样返回（测不合法的清单）", async () => {
    const c = await startFakeCatalog({ index: "{not json" });
    stops.push(c.stop);
    expect(await (await fetch(c.url)).text()).toBe("{not json");
  });
});
