/**
 * Same-origin proxy: the browser talks only to the web origin (the kernel's session cookie belongs
 * to the current host), and `/api/*` is forwarded as is to the kernel at `CAPYBARA_KERNEL_URL`
 * (default http://localhost:8080). Response bodies are streamed through without buffering, so SSE
 * works. Request bodies have a size limit (`CAPYBARA_WEB_MAX_BODY_BYTES`, default 1 MiB, the same
 * as the kernel's Fastify bodyLimit); installing / previewing a connector
 * (`POST /api/v1/orgs/:orgId/connectors[/preview]`) may carry an OpenAPI document of up to 2 MB, so
 * like those two kernel routes it is raised to 6 MiB. Extension and plugin package uploads
 * (`POST /api/v1/admin/extensions/packages/file`, `/api/v1/admin/catalog/import/file`) are raised
 * to `CAPYBARA_WEB_MAX_PACKAGE_BYTES` (default 50 MiB) and forwarded while being read, never
 * buffered whole. Client addresses are handled in `lib/peer.ts`.
 */

import {
  configuredMaxBodyBytes,
  configuredMaxPackageBytes,
  kernelUrl,
  limitStream,
  readBody,
  tooLarge,
} from "../../../lib/kernel-proxy";
import { FORWARDING_HEADERS, trustedPeer } from "../../../lib/peer";

export const dynamic = "force-dynamic";

/** 安装 / 预览连接器的请求体上限（与内核 http/app.ts 的 LARGE_BODY_LIMIT 一致）。 */
const CONNECTOR_INSTALL_MAX_BODY_BYTES = 6 * 1024 * 1024;
const CONNECTOR_INSTALL_PATH = /^\/api\/v1\/orgs\/[^/]+\/connectors(?:\/preview)?$/;
/**
 * Upload routes whose request body is streamed through (extension package tgz, plugin package tgz;
 * up to tens of MiB).
 */
const STREAMED_UPLOAD_PATHS = new Set([
  "/api/v1/admin/extensions/packages/file",
  "/api/v1/admin/catalog/import/file",
]);

const upstreamUnavailable = () =>
  Response.json(
    { error: { code: "upstream_unavailable", message: "Kernel is unreachable" } },
    { status: 502 },
  );

/** 不转发给上游的请求头：host 由 fetch 按上游地址重新生成；其余为逐跳头。 */
const DROP_REQUEST = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  // fetch（undici）不支持 Expect: 100-continue，带上会直接抛错。
  "expect",
  // 请求体已读成定长 buffer，长度由 fetch 按实际字节重新计算（客户端的值可能不实）。
  "content-length",
  // 转发类请求头可被客户端伪造，一律不透传；可信的客户端地址另行写入（见 lib/peer.ts）。
  ...FORWARDING_HEADERS,
  // fetch 会自动解压响应却保留 content-encoding 头，透传给浏览器会被二次解压；
  // 不向上游声明可压缩，响应就始终是明文。
  "accept-encoding",
]);

/** 不回传给浏览器的响应头：逐跳头；set-cookie 单独逐条处理。 */
const DROP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "trailer",
  "set-cookie",
]);

function maxBodyBytes(method: string, pathname: string): number {
  const base = configuredMaxBodyBytes();
  return method === "POST" && CONNECTOR_INSTALL_PATH.test(pathname)
    ? Math.max(base, CONNECTOR_INSTALL_MAX_BODY_BYTES)
    : base;
}

async function proxy(req: Request): Promise<Response> {
  const src = new URL(req.url);
  const target = `${kernelUrl()}${src.pathname}${src.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!DROP_REQUEST.has(key)) headers.set(key, value);
  });
  const peer = trustedPeer(req.headers);
  if (peer !== undefined) headers.set("x-forwarded-for", peer);

  let upstream: Response;
  if (req.method === "POST" && STREAMED_UPLOAD_PATHS.has(src.pathname) && req.body !== null) {
    // Large uploads: forward while reading (never buffered whole), count while forwarding, abort
    // over the limit. The cost: when upstream answers 401, undici reports a network error (the
    // stream cannot be replayed), so the browser checks the session before uploading (see
    // lib/admin-extensions.ts).
    const limit = configuredMaxPackageBytes();
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) return tooLarge(limit);
    const limited = limitStream(req.body, limit);
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        redirect: "manual",
        signal: req.signal,
        body: limited.stream,
        duplex: "half",
      } as RequestInit);
    } catch {
      return limited.exceeded() ? tooLarge(limit) : upstreamUnavailable();
    }
  } else {
    // 请求体先读完再转发（API 请求体都很小）：Node 的 fetch（undici）对「流式请求体 + 上游 401」
    // 一律报网络错误（fetch 规范里 401 可能需要重发请求体，而流无法重放），登录失败会变成 502。
    // 响应体仍以流透传。
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (req.method !== "GET" && req.method !== "HEAD" && req.body !== null) {
      const limit = maxBodyBytes(req.method, src.pathname);
      body = await readBody(req, limit);
      if (body === undefined) return tooLarge(limit);
    }
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        redirect: "manual",
        signal: req.signal,
        ...(body !== undefined && { body }),
      });
    } catch {
      return upstreamUnavailable();
    }
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE.has(key)) out.set(key, value);
  });
  // 多个 Set-Cookie 不能合并成一行（Expires 里有逗号），必须逐条 append。
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
