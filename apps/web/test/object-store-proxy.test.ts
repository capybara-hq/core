import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  isObjectStorePath,
  type ObjectStoreProxy,
  parseObjectStoreProxy,
  proxyObjectStore,
} from "../src/lib/object-store-proxy";

const PUBLIC_HOST = "capybara.example.com";
const SIGNING_KEY = "upstream-secret";

/** What the fake upstream saw for each request. */
type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

/** HMAC over host + path, standing in for SigV4's signed `host` header and canonical path. */
const sign = (host: string, path: string) =>
  createHmac("sha256", SIGNING_KEY).update(`${host}\n${path}`).digest("hex");

/**
 * Fake S3: records the request, rejects a bad signature (sig query param over Host + path) with
 * 403, echoes the body, and sets headers a proxy must not pass through as-is.
 */
async function startUpstream(seen: Seen[]): Promise<number> {
  return listen(
    createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        const u = new URL(req.url ?? "/", "http://x");
        const sig = u.searchParams.get("sig");
        if (sig !== null && sig !== sign(req.headers.host ?? "", u.pathname)) {
          res.writeHead(403, { "content-type": "application/xml" });
          res.end("<Error>SignatureDoesNotMatch</Error>");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html",
          "set-cookie": "upstream=1",
          etag: '"abc"',
        });
        res.end(body === "" ? "object bytes" : `echo:${body}`);
      });
    }),
  );
}

/** web's server: the proxy for object-store paths, a marker response for everything else. */
async function startWeb(cfg: ObjectStoreProxy | undefined): Promise<number> {
  return listen(
    createServer((req, res) => {
      if (cfg && isObjectStorePath(cfg, req.url ?? "/")) {
        proxyObjectStore(cfg, req, res);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("next");
    }),
  );
}

type Reply = { status: number; headers: IncomingMessage["headers"]; body: string };

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function setup(extra: Partial<Record<string, string>> = {}) {
  const seen: Seen[] = [];
  const upstreamPort = await startUpstream(seen);
  const cfg = parseObjectStoreProxy({
    CAPYBARA_WEB_OBJECT_STORE_URL: `http://127.0.0.1:${upstreamPort}`,
    CAPYBARA_WEB_OBJECT_STORE_BUCKET: "capybara",
    CAPYBARA_WEB_OBJECT_STORE_PUBLIC_HOST: PUBLIC_HOST,
    ...extra,
  });
  const webPort = await startWeb(cfg);
  return { seen, webPort, cfg };
}

describe("parseObjectStoreProxy", () => {
  it("is off when CAPYBARA_WEB_OBJECT_STORE_URL is unset or empty", () => {
    expect(parseObjectStoreProxy({})).toBeUndefined();
    expect(parseObjectStoreProxy({ CAPYBARA_WEB_OBJECT_STORE_URL: "" })).toBeUndefined();
  });

  it("takes the public host from a host or a URL", () => {
    const base = {
      CAPYBARA_WEB_OBJECT_STORE_URL: "http://seaweedfs-s3:8333",
      CAPYBARA_WEB_OBJECT_STORE_BUCKET: "capybara",
    };
    expect(
      parseObjectStoreProxy({ ...base, CAPYBARA_WEB_OBJECT_STORE_PUBLIC_HOST: "a.example:8443" })
        ?.publicHost,
    ).toBe("a.example:8443");
    expect(
      parseObjectStoreProxy({
        ...base,
        CAPYBARA_WEB_OBJECT_STORE_PUBLIC_HOST: "https://a.example/",
      })?.publicHost,
    ).toBe("a.example");
  });

  it.each([
    [{ CAPYBARA_WEB_OBJECT_STORE_URL: "not a url" }],
    [{ CAPYBARA_WEB_OBJECT_STORE_URL: "ftp://s3:21" }],
    [{ CAPYBARA_WEB_OBJECT_STORE_BUCKET: "" }],
    [{ CAPYBARA_WEB_OBJECT_STORE_BUCKET: "a/b" }],
    [{ CAPYBARA_WEB_OBJECT_STORE_BUCKET: "api" }],
    [{ CAPYBARA_WEB_OBJECT_STORE_PUBLIC_HOST: "" }],
  ])("rejects a malformed setting %j", (override) => {
    const env = {
      CAPYBARA_WEB_OBJECT_STORE_URL: "http://seaweedfs-s3:8333",
      CAPYBARA_WEB_OBJECT_STORE_BUCKET: "capybara",
      CAPYBARA_WEB_OBJECT_STORE_PUBLIC_HOST: PUBLIC_HOST,
      ...override,
    };
    expect(() => parseObjectStoreProxy(env)).toThrow(/CAPYBARA_WEB_OBJECT_STORE_/);
  });
});

describe("isObjectStorePath", () => {
  const cfg = parseObjectStoreProxy({
    CAPYBARA_WEB_OBJECT_STORE_URL: "http://seaweedfs-s3:8333",
    CAPYBARA_WEB_OBJECT_STORE_BUCKET: "capybara",
    CAPYBARA_WEB_OBJECT_STORE_PUBLIC_HOST: PUBLIC_HOST,
  }) as ObjectStoreProxy;

  it.each([
    ["/capybara/kernel/o1/a.txt?X-Amz-Signature=x", true],
    ["/capybara/", true],
    ["/capybara", true],
    ["/capybara?uploads", true],
    ["/", false],
    ["/capybarax/key", false],
    ["/api/v1/setup", false],
    ["/zh/login", false],
  ])("%s -> %s", (path, expected) => {
    expect(isObjectStorePath(cfg, path)).toBe(expected);
  });
});

describe("proxyObjectStore", () => {
  it("streams a POST upload to the exact path and the response back", async () => {
    const { seen, webPort } = await setup();
    const r = await send(
      webPort,
      "POST",
      "/capybara/",
      { "content-type": "multipart/form-data; boundary=x" },
      "form-body",
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe("echo:form-body");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/capybara/", body: "form-body" });
    expect(seen[0]?.headers["content-type"]).toBe("multipart/form-data; boundary=x");
  });

  it("accepts POST at the bucket itself (the presigned POST target) and nothing else there", async () => {
    const { seen, webPort } = await setup();
    const up = await send(webPort, "POST", "/capybara", {}, "form");
    expect(up.status).toBe(200);
    expect(seen[0]?.url).toBe("/capybara");
    for (const method of ["GET", "HEAD"]) {
      const r = await send(webPort, method, "/capybara?list-type=2");
      expect(r.status).toBe(405);
      expect(r.headers.allow).toBe("POST");
    }
    expect(seen).toHaveLength(1);
  });

  it("sets the upstream Host to the public host, so a signature for that host verifies", async () => {
    const { seen, webPort } = await setup();
    const path = "/capybara/kernel/o1/a.txt";
    // The client (or a front proxy) reached web under another host name.
    const r = await send(webPort, "GET", `${path}?sig=${sign(PUBLIC_HOST, path)}`, {
      host: "10.0.0.5:3000",
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe("object bytes");
    expect(seen[0]?.headers.host).toBe(PUBLIC_HOST);
    expect(seen[0]?.url).toBe(`${path}?sig=${sign(PUBLIC_HOST, path)}`);
    // A signature made for any other host does not.
    const bad = await send(webPort, "GET", `${path}?sig=${sign("10.0.0.5:3000", path)}`);
    expect(bad.status).toBe(403);
  });

  it("answers HEAD", async () => {
    const { seen, webPort } = await setup();
    const r = await send(webPort, "HEAD", "/capybara/kernel/o1/a.txt");
    expect(r.status).toBe(200);
    expect(seen[0]?.method).toBe("HEAD");
  });

  it.each(["PUT", "DELETE", "PATCH", "OPTIONS"])("refuses %s with 405", async (method) => {
    const { seen, webPort } = await setup();
    const r = await send(webPort, method, "/capybara/kernel/o1/a.txt", {}, "x");
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("GET, HEAD, POST");
    expect(seen).toHaveLength(0);
  });

  it("does not proxy paths outside the bucket", async () => {
    const { seen, webPort } = await setup();
    for (const path of ["/", "/capybarax", "/other/key", "/?list-type=2"]) {
      const r = await send(webPort, "GET", path);
      expect(r.body).toBe("next");
    }
    expect(seen).toHaveLength(0);
  });

  it("rejects dot segments and encoded slashes that could leave the bucket", async () => {
    const { seen, webPort } = await setup();
    for (const path of [
      "/capybara/../x",
      "/capybara/%2e%2e/x",
      "/capybara/a/./b",
      "/capybara/a%2F..%2Fb",
      "/capybara/a\\b",
    ]) {
      const r = await send(webPort, "GET", path);
      expect(r.status, path).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it("strips cookies, authorization and forwarding headers before forwarding", async () => {
    const { seen, webPort } = await setup();
    await send(webPort, "GET", "/capybara/k", {
      cookie: "capybara_session=secret",
      authorization: "Bearer kernel-token",
      "x-forwarded-for": "1.2.3.4",
      forwarded: "for=1.2.3.4",
      "x-capybara-peer-token": "t",
      "x-amz-meta-ok": "kept",
    });
    const h = seen[0]?.headers ?? {};
    expect(h.cookie).toBeUndefined();
    expect(h.authorization).toBeUndefined();
    expect(h["x-forwarded-for"]).toBeUndefined();
    expect(h.forwarded).toBeUndefined();
    expect(h["x-capybara-peer-token"]).toBeUndefined();
    expect(h["x-amz-meta-ok"]).toBe("kept");
  });

  it("always adds nosniff and CSP sandbox, and drops upstream cookies", async () => {
    const { webPort } = await setup();
    for (const r of [
      await send(webPort, "GET", "/capybara/k"),
      await send(webPort, "GET", "/capybara/k?sig=bad"),
      await send(webPort, "PUT", "/capybara/k"),
    ]) {
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toBe("sandbox");
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
    expect((await send(webPort, "GET", "/capybara/k")).headers.etag).toBe('"abc"');
  });

  it("refuses a declared body above the limit with 413", async () => {
    const { seen, webPort } = await setup({ CAPYBARA_WEB_MAX_PACKAGE_BYTES: "4" });
    const r = await send(webPort, "POST", "/capybara/", {}, "too large");
    expect(r.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("answers 502 when the upstream is down", async () => {
    const cfg = parseObjectStoreProxy({
      CAPYBARA_WEB_OBJECT_STORE_URL: "http://127.0.0.1:1",
      CAPYBARA_WEB_OBJECT_STORE_BUCKET: "capybara",
      CAPYBARA_WEB_OBJECT_STORE_PUBLIC_HOST: PUBLIC_HOST,
    });
    const webPort = await startWeb(cfg);
    const r = await send(webPort, "GET", "/capybara/k");
    expect(r.status).toBe(502);
    expect(r.headers["content-security-policy"]).toBe("sandbox");
  });
});
