import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** 假清单服务器收到的一次请求。 */
export interface FakeMarketplaceRequest {
  /** `If-None-Match` 请求头。 */
  etag?: string;
  /** `Authorization` 请求头。 */
  authorization?: string;
}

export interface FakeMarketplace {
  /** 清单地址 `http://127.0.0.1:<port>/index.json`。 */
  url: string;
  /** 换一份清单（字符串原样返回，用来测不合法的 JSON）；ETag 随内容变化。 */
  setIndex(i: unknown): void;
  /** 让清单地址返回 302 到 `location`（`null` 恢复正常）。 */
  setRedirect(location: string | null): void;
  /** 收到的请求，按到达顺序（没有的请求头省略）。 */
  requests: FakeMarketplaceRequest[];
  stop(): Promise<void>;
}

/**
 * 假目录清单服务器：`GET /index.json` 返回当前清单（`application/json`），带强 ETag（内容的 sha1）；
 * `If-None-Match` 与当前 ETag 相同时返回 304。其他路径 404。
 */
export async function startFakeMarketplace(opts: { index: unknown }): Promise<FakeMarketplace> {
  let body = "";
  let etag = "";
  let redirect: string | null = null;
  const setIndex = (i: unknown) => {
    body = typeof i === "string" ? i : JSON.stringify(i);
    etag = `"${createHash("sha1").update(body).digest("hex")}"`;
  };
  setIndex(opts.index);
  const requests: FakeMarketplaceRequest[] = [];
  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/index.json") {
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
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/index.json`,
    setIndex,
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
