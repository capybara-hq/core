/**
 * 同源代理：浏览器只和 Web 源通信（内核的会话 Cookie 只属于当前主机），
 * `/api/*` 原样转发到内核 `CAPYBARA_KERNEL_URL`（默认 http://localhost:8080）。
 * 响应体以流的形式透传、不缓冲，SSE 可用。请求体有大小上限（`CAPYBARA_WEB_MAX_BODY_BYTES`，
 * 默认 1 MiB，与内核 Fastify 的 bodyLimit 一致）；安装 / 预览连接器（`POST /api/v1/orgs/:orgId/connectors[/preview]`）
 * 可带最大 2 MB 的 OpenAPI 文档，与内核这两个路由一致放宽到 6 MiB。上传插件包与企业目录包
 * （`POST /api/v1/admin/plugins/packages/file`、`/api/v1/admin/directory/import/file`）放宽到 `CAPYBARA_WEB_MAX_PACKAGE_BYTES`（默认 50 MiB），
 * 并且边读边转发、不整个缓冲。客户端地址的处理见 `lib/peer.ts`。
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
/** 流式透传请求体的上传路由（插件包 tgz、企业目录包 tgz / zip，可达几十 MiB）。 */
const STREAMED_UPLOAD_PATHS = new Set([
  "/api/v1/admin/plugins/packages/file",
  "/api/v1/admin/directory/import/file",
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
    // 大文件上传：边读边转发（不整个缓冲），边转发边计数，超限即中止。代价是上游返回 401 时
    // undici 报网络错误（流无法重放）：浏览器端上传前先确认登录有效（见 lib/admin-plugins.ts）。
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
