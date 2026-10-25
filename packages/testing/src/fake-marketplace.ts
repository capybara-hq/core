import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the fake marketplace received. */
export interface FakeMarketplaceRequest {
  /** The `If-None-Match` header. */
  etag?: string;
  /** The `Authorization` header. */
  authorization?: string;
}

export interface FakeMarketplace {
  /** The manifest URL `http://127.0.0.1:<port>/marketplace.json`. */
  url: string;
  /** Serves another manifest (a string is served as is, for invalid JSON); the ETag follows it. */
  setManifest(m: unknown): void;
  /** Makes the manifest URL answer 302 to `location` (`null` restores it). */
  setRedirect(location: string | null): void;
  /** The requests received, in order (absent headers omitted). */
  requests: FakeMarketplaceRequest[];
  stop(): Promise<void>;
}

/**
 * A fake marketplace: `GET /marketplace.json` serves the current manifest (`application/json`) with a
 * strong ETag (sha1 of the content); 304 when `If-None-Match` equals it. Other paths 404.
 */
export async function startFakeMarketplace(opts: { manifest: unknown }): Promise<FakeMarketplace> {
  let body = "";
  let etag = "";
  let redirect: string | null = null;
  const setManifest = (m: unknown) => {
    body = typeof m === "string" ? m : JSON.stringify(m);
    etag = `"${createHash("sha1").update(body).digest("hex")}"`;
  };
  setManifest(opts.manifest);
  const requests: FakeMarketplaceRequest[] = [];
  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/marketplace.json") {
      res.writeHead(404).end();
      return;
    }
    const r: FakeMarketplaceRequest = {};
    const inm = req.headers["if-none-match"];
    if (typeof inm === "string") r.etag = inm;
    if (typeof req.headers.authorization === "string") r.authorization = req.headers.authorization;
    requests.push(r);
    if (redirect !== null) {
      res.writeHead(302, { location: redirect }).end();
      return;
    }
    if (inm === etag) {
      res.writeHead(304, { etag }).end();
      return;
    }
    res
      .writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        etag,
      })
      .end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/marketplace.json`,
    setManifest,
    setRedirect: (l) => {
      redirect = l;
    },
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
