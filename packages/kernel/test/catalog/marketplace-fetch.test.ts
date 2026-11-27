import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fetchMarketplaceArchive,
  fetchMarketplaceManifest,
  MarketplaceFetchError,
} from "../../src/catalog/marketplace-fetch.js";
import type { NetPolicy } from "../../src/net/public-address.js";

const NET: NetPolicy = { allowInsecureLoopback: true, allowPrivateHosts: [], trustedOrigins: [] };
const retry = { attempts: 3, backoffMs: 0 };
const MANIFEST = { schemaVersion: 1, name: "official", plugins: [] };

let server: Server;
let base: string;
/** Statuses to answer, in order; then the manifest. */
let failures: number[] = [];
let calls = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    calls += 1;
    const status = failures.shift();
    if (status !== undefined) res.writeHead(status).end("error code: 502");
    else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(MANIFEST));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/marketplace.json`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const opts = () => ({
  maxBytes: 1_000_000,
  timeoutMs: 5_000,
  net: NET,
  retry,
  signal: new AbortController().signal,
});

describe("fetchMarketplaceManifest retry", () => {
  it("survives one 502 from the upstream host", async () => {
    failures = [502];
    calls = 0;
    const r = await fetchMarketplaceManifest(base, opts());
    expect(r.status).toBe("ok");
    expect(calls).toBe(2);
  });

  it("names the status and that the upstream failed when it keeps failing", async () => {
    failures = [502, 502, 502];
    calls = 0;
    const e = await fetchMarketplaceManifest(base, opts()).catch((x) => x);
    expect(e).toBeInstanceOf(MarketplaceFetchError);
    expect(e.message).toContain("HTTP 502");
    expect(e.message).toContain("upstream");
    expect(calls).toBe(3);
  });
});

describe("fetchMarketplaceArchive", () => {
  it("names the archive URL in a failure", async () => {
    failures = [404];
    const e = await fetchMarketplaceArchive(
      { url: base, integrity: `sha256-${Buffer.alloc(32).toString("base64")}` },
      { maxBytes: 1000, timeoutMs: 5_000, net: NET, retry },
    ).catch((x) => x);
    expect(e.message).toContain(base);
    expect(e.message).toContain("404");
  });
});
