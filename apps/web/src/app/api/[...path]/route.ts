/**
 * 同源代理：浏览器只和 Web 源通信（内核的会话 Cookie 只属于当前主机），
 * `/api/*` 原样转发到内核 `CAPYBARA_KERNEL_URL`（默认 http://localhost:8080）。
 * 响应体以流的形式透传、不缓冲，SSE 可用。
 */

export const dynamic = "force-dynamic";

const DEFAULT_KERNEL_URL = "http://localhost:8080";

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

function kernelUrl(): string {
  return (process.env.CAPYBARA_KERNEL_URL ?? DEFAULT_KERNEL_URL).replace(/\/+$/, "");
}

async function proxy(req: Request): Promise<Response> {
  const src = new URL(req.url);
  const target = `${kernelUrl()}${src.pathname}${src.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!DROP_REQUEST.has(key)) headers.set(key, value);
  });

  // 请求体先读完再转发（API 请求体都很小）：Node 的 fetch（undici）对「流式请求体 + 上游 401」
  // 一律报网络错误（fetch 规范里 401 可能需要重发请求体，而流无法重放），登录失败会变成 502。
  // 响应体仍以流透传。
  const body =
    req.method !== "GET" && req.method !== "HEAD" && req.body !== null
      ? await req.arrayBuffer()
      : undefined;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      redirect: "manual",
      signal: req.signal,
      ...(body !== undefined && { body }),
    });
  } catch {
    return Response.json(
      { error: { code: "upstream_unavailable", message: "Kernel is unreachable" } },
      { status: 502 },
    );
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
