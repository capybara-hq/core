/**
 * Object storage on the web origin (server.mjs only; erasable TypeScript syntax only, so Node's
 * type stripping can import it directly, like peer.ts).
 *
 * Browsers upload attachments with a presigned POST and download them through presigned GET URLs
 * signed for the object store's public endpoint. When object storage is not reachable from
 * browsers (compose: SeaweedFS is unpublished), the object-store plugin's `publicEndpoint` is the
 * web origin with path-style URLs, and this proxy forwards `/<bucket>/**` (and `/<bucket>` for
 * POST) to the object store:
 *
 * - The path is forwarded exactly (SigV4 signs the canonical path, and path-style S3 reads the
 *   first segment as the bucket). Dot segments and encoded slashes are refused, so a request
 *   can't leave the bucket; nothing outside `/<bucket>/` is proxied (it goes to Next).
 * - The upstream `Host` is the configured public host, never the incoming one: presigned URLs
 *   sign the host they were issued for, and front proxies rewrite Host.
 * - Only GET, HEAD and POST (presigned download / upload); anything else is 405. The bucket
 *   itself (`/<bucket>`, the presigned POST target) takes only POST. This only narrows what
 *   reaches the gateway: what refuses listings (and any other unpresigned request) is the S3
 *   gateway's signature check, since it has no anonymous identity and no bucket policy.
 * - Bodies stream both ways without buffering; uploads above the limit are refused (the object
 *   store also enforces the presigned size range).
 * - Cookies, authorization and forwarding headers are not sent upstream; upstream cookies are not
 *   passed back; every response carries `X-Content-Type-Options: nosniff` and
 *   `Content-Security-Policy: sandbox` (objects are user content on the app's origin).
 *
 * Off unless CAPYBARA_WEB_OBJECT_STORE_URL is set.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export const OBJECT_STORE_URL_ENV = "CAPYBARA_WEB_OBJECT_STORE_URL";
export const OBJECT_STORE_BUCKET_ENV = "CAPYBARA_WEB_OBJECT_STORE_BUCKET";
export const OBJECT_STORE_PUBLIC_HOST_ENV = "CAPYBARA_WEB_OBJECT_STORE_PUBLIC_HOST";
/** Upload size limit for this path (shared with plugin package uploads through /api). */
export const MAX_PACKAGE_BYTES_ENV = "CAPYBARA_WEB_MAX_PACKAGE_BYTES";
const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024;

export interface ObjectStoreProxy {
  /** Upstream origin, e.g. http://seaweedfs-s3:8333. */
  upstream: URL;
  bucket: string;
  /** Host (with port when not the default) the presigned URLs are signed for. */
  publicHost: string;
  maxBodyBytes: number;
}

const ALLOWED_METHODS = ["GET", "HEAD", "POST"];
/** First path segments web serves itself; a bucket with one of these names would shadow them. */
const RESERVED_SEGMENTS = new Set(["api", "_next", "plugin-ui", "zh", "en"]);
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Request headers never forwarded upstream (hop-by-hop, credentials, forwarding, the host). */
const DROP_REQUEST = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
  "authorization",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "x-capybara-peer-token",
]);
/** Response headers never passed back (hop-by-hop and cookies). */
const DROP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
  "x-content-type-options",
  "content-security-policy",
]);
const SAFETY_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox",
};

/**
 * Reads the proxy settings; undefined (off) when CAPYBARA_WEB_OBJECT_STORE_URL is unset or empty.
 * A malformed setting throws, so server.mjs stops at startup instead of serving a broken proxy.
 * CAPYBARA_WEB_OBJECT_STORE_PUBLIC_HOST takes a host (`files.example.com:8443`) or a URL whose
 * host is used (`https://capybara.example.com`).
 */
export function parseObjectStoreProxy(
  env: Record<string, string | undefined>,
): ObjectStoreProxy | undefined {
  const rawUrl = env[OBJECT_STORE_URL_ENV]?.trim();
  if (!rawUrl) return undefined;
  let upstream: URL;
  try {
    upstream = new URL(rawUrl);
  } catch {
    throw new Error(
      `${OBJECT_STORE_URL_ENV} must be an http(s) URL, got ${JSON.stringify(rawUrl)}`,
    );
  }
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(
      `${OBJECT_STORE_URL_ENV} must be an http(s) URL, got ${JSON.stringify(rawUrl)}`,
    );
  }
  const bucket = env[OBJECT_STORE_BUCKET_ENV]?.trim() ?? "";
  if (!BUCKET_RE.test(bucket) || RESERVED_SEGMENTS.has(bucket)) {
    throw new Error(
      `${OBJECT_STORE_BUCKET_ENV} must be the object-store plugin's bucket name (3-63 lowercase letters, digits, "." or "-", not one of ${[...RESERVED_SEGMENTS].join(", ")}), got ${JSON.stringify(bucket)}`,
    );
  }
  const rawHost = env[OBJECT_STORE_PUBLIC_HOST_ENV]?.trim() ?? "";
  let publicHost = rawHost;
  if (rawHost.includes("://")) {
    try {
      publicHost = new URL(rawHost).host;
    } catch {
      publicHost = "";
    }
  }
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(publicHost)) {
    throw new Error(
      `${OBJECT_STORE_PUBLIC_HOST_ENV} must be the host of the object store's public endpoint (normally the web origin, e.g. capybara.example.com), got ${JSON.stringify(rawHost)}`,
    );
  }
  const n = Number(env[MAX_PACKAGE_BYTES_ENV]);
  const maxBodyBytes = Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
  return { upstream, bucket, publicHost, maxBodyBytes };
}

/**
 * Whether a request target (path plus query) belongs to the proxy: an object path `/<bucket>/...`,
 * or the bucket itself (`/<bucket>`, where presigned POST uploads go; only POST is allowed there).
 */
export function isObjectStorePath(cfg: ObjectStoreProxy, target: string): boolean {
  const path = target.split("?")[0] ?? "";
  return path === `/${cfg.bucket}` || target.startsWith(`/${cfg.bucket}/`);
}

/**
 * The bucket itself (no object key), where presigned POST uploads go. Other methods here are
 * refused as a narrowing only; a listing without a valid signature is refused by the gateway
 * (no anonymous identity, no bucket policy), not by this proxy.
 */
function isBucketRoot(cfg: ObjectStoreProxy, target: string): boolean {
  return (target.split("?")[0] ?? "") === `/${cfg.bucket}`;
}

/** Dot segments, encoded slashes / backslashes or backslashes could make the upstream leave the bucket. */
function escapesBucket(target: string): boolean {
  const path = target.split("?")[0] ?? "";
  if (/%2f|%5c|\\/i.test(path)) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  return decoded.split("/").some((s) => s === "." || s === "..");
}

function reply(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SAFETY_HEADERS, "content-type": "text/plain", ...extra });
  res.end();
}

/** Proxies one request whose target passed {@link isObjectStorePath}. */
export function proxyObjectStore(
  cfg: ObjectStoreProxy,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const method = req.method ?? "GET";
  const target = req.url ?? "/";
  if (!ALLOWED_METHODS.includes(method)) {
    req.resume();
    reply(res, 405, { allow: ALLOWED_METHODS.join(", ") });
    return;
  }
  // Narrowing, not the security boundary: unsigned listings fail the gateway's signature check.
  if (isBucketRoot(cfg, target) && method !== "POST") {
    req.resume();
    reply(res, 405, { allow: "POST" });
    return;
  }
  if (escapesBucket(target)) {
    req.resume();
    reply(res, 400);
    return;
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > cfg.maxBodyBytes) {
    req.resume();
    reply(res, 413, { connection: "close" });
    return;
  }

  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined && !DROP_REQUEST.has(k)) headers[k] = v;
  }
  headers.host = cfg.publicHost;

  const send = cfg.upstream.protocol === "https:" ? httpsRequest : httpRequest;
  const upstreamReq = send(
    {
      protocol: cfg.upstream.protocol,
      hostname: cfg.upstream.hostname,
      port: cfg.upstream.port || undefined,
      method,
      path: target,
      headers,
    },
    (up) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (v !== undefined && !DROP_RESPONSE.has(k)) out[k] = v;
      }
      res.writeHead(up.statusCode ?? 502, { ...out, ...SAFETY_HEADERS });
      up.pipe(res);
      up.on("error", () => res.destroy());
    },
  );
  upstreamReq.on("error", () => {
    if (!res.headersSent) reply(res, 502);
    else res.destroy();
  });
  res.on("close", () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });

  // Stream the body, counting bytes for requests without (or with a false) content-length.
  let seen = 0;
  req.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > cfg.maxBodyBytes) {
      upstreamReq.destroy();
      req.unpipe(upstreamReq);
      if (!res.headersSent) reply(res, 413, { connection: "close" });
      req.destroy();
    }
  });
  req.pipe(upstreamReq);
}
