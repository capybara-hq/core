/**
 * 嵌入应用的同源代理：`/plugin-ui/<plugin>/<rest>` → 内核 `/plugins/<plugin>/ui/<rest>`。
 *
 * 嵌入页跑在沙箱 iframe（`allow-scripts allow-forms`，不给同源）里，是不透明源；它的凭据只有外层经
 * postMessage 给的嵌入令牌（`Authorization: Bearer`），不靠 Cookie。所以这里：
 * - 只放行 GET / POST（HEAD 由 Next 按 GET 处理），外加 CORS 预检 OPTIONS；
 * - 路径只能落在插件的 `/ui/` 下：插件名按清单规则校验，路径段不得为空、`.` / `..`，解码后不得含 `/`、`\`
 *   或控制字符（防止经编码绕到 `/ui/` 之外）；未声明的路由由内核的插件路由表返回 404；
 * - 请求头走白名单（不转发 Cookie、CSRF 头等）；响应去掉 Set-Cookie；
 * - 每个响应都加安全头（{@link SECURITY_HEADERS}），覆盖插件自己给的同名头；
 * - 响应体以流透传（SSE 可用），请求体上限同 `/api`。
 */

import { configuredMaxBodyBytes, kernelUrl, readBody, tooLarge } from "./kernel-proxy";
import { trustedPeer } from "./peer";

const PREFIX = "/plugin-ui/";
/** 插件名规则（与 SDK 清单一致）；`kernel` 是保留名。 */
const PLUGIN_RE = /^[a-z][a-z0-9-]{1,40}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拒绝控制字符
const BAD_SEGMENT = /[\u0000-\u001f\u007f/\\]/;

/**
 * 嵌入页的 CSP：
 * - `sandbox allow-scripts allow-forms`：即使有人把这个地址直接在顶层打开（不在我们的 iframe 里），
 *   页面也是不透明源，拿不到 Web 源的 Cookie / 存储，也不能以 Web 源的身份调 `/api`；
 * - `frame-ancestors 'self'`：只能被我们自己的网页嵌入；
 * - 资源只来自本源（即经本代理的插件路由）；允许内联脚本 / 样式，插件页面可以是单个 HTML；
 * - `connect-src 'self'`：只能连本源（插件经代理的路由）。本源的 `/api` 对它无用：请求来自不透明源，
 *   SameSite 的会话 Cookie 不会带上、响应没有 CORS 头读不到，嵌入令牌也不被内核 `/api` 接受；
 * - 不允许插件页再嵌 iframe、起 worker、加载插件对象，`base-uri 'none'` 防止改写相对地址。
 */
export const EMBED_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts allow-forms",
].join("; ");

/**
 * 每个 `/plugin-ui/*` 响应都带的头。`Access-Control-Allow-Origin: *` 只在这里给：iframe 是不透明源
 * （Origin 为 `null`），凭据是 Bearer 令牌、不是 Cookie，所以不带 `Allow-Credentials`。
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": EMBED_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "access-control-allow-origin": "*",
};

const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-methods": "GET, POST",
  "access-control-allow-headers": "Authorization, Content-Type, Last-Event-ID",
  "access-control-max-age": "600",
};

/** 转发给内核的请求头（白名单）。 */
const FORWARD_REQUEST = new Set([
  "accept",
  "accept-language",
  "authorization",
  "cache-control",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "last-event-id",
]);

/** 不回传的响应头：逐跳头、Set-Cookie，以及由代理统一设置的安全 / CORS 头。 */
const DROP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "trailer",
  "set-cookie",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
]);

/** 把 `/plugin-ui/<plugin>/<rest>` 解析成内核路径 `/plugins/<plugin>/ui/<rest>`；不合规返回 undefined。 */
export function kernelPathOf(pathname: string): string | undefined {
  if (!pathname.startsWith(PREFIX)) return undefined;
  const [plugin, ...segments] = pathname.slice(PREFIX.length).split("/");
  if (plugin === undefined || !PLUGIN_RE.test(plugin) || plugin === "kernel") return undefined;
  if (segments.length === 0) return undefined;
  for (const seg of segments) {
    if (seg === "") return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return undefined;
    }
    if (decoded === "." || decoded === ".." || BAD_SEGMENT.test(decoded)) return undefined;
  }
  return `/plugins/${plugin}/ui/${segments.join("/")}`;
}

function withSecurity(headers: Headers): Headers {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return headers;
}

const errorResponse = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status, headers: withSecurity(new Headers()) });

const notFound = () => errorResponse(404, "not_found", "Not found");

/** 代理一个 GET / POST 请求（见文件头）。 */
export async function proxyPluginUi(req: Request): Promise<Response> {
  const src = new URL(req.url);
  const path = kernelPathOf(src.pathname);
  if (path === undefined) return notFound();

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (FORWARD_REQUEST.has(key)) headers.set(key, value);
  });
  const peer = trustedPeer(req.headers);
  if (peer !== undefined) headers.set("x-forwarded-for", peer);

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (req.method === "POST") {
    const limit = configuredMaxBodyBytes();
    body = await readBody(req, limit);
    if (body === undefined) return tooLarge(limit, withSecurity(new Headers()));
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${kernelUrl()}${path}${src.search}`, {
      method: req.method,
      headers,
      redirect: "manual",
      signal: req.signal,
      ...(body !== undefined && { body }),
    });
  } catch {
    return errorResponse(502, "upstream_unavailable", "Kernel is unreachable");
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE.has(key)) out.set(key, value);
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: withSecurity(out),
  });
}

/** CORS 预检：嵌入页带 Authorization 头的请求会先发 OPTIONS。路径不合规同样 404。 */
export async function preflightPluginUi(req: Request): Promise<Response> {
  if (kernelPathOf(new URL(req.url).pathname) === undefined) return notFound();
  const headers = withSecurity(new Headers());
  for (const [k, v] of Object.entries(PREFLIGHT_HEADERS)) headers.set(k, v);
  return new Response(null, { status: 204, headers });
}
