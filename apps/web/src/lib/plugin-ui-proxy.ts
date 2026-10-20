/**
 * 嵌入应用的同源代理：`/plugin-ui/<plugin>/<rest>` → 内核 `/plugins/<plugin>/ui/<rest>`。
 *
 * 嵌入页跑在沙箱 iframe（`allow-scripts allow-forms`，不给同源）里，是不透明源；它的凭据只有外层经
 * postMessage 给的嵌入令牌（`Authorization: Bearer`），不靠 Cookie。所以这里：
 * - 只放行 GET / POST（HEAD 由 Next 按 GET 处理），外加 CORS 预检 OPTIONS；
 * - 路径只能落在插件的 `/ui/` 下：插件名按清单规则校验，路径段不得为空、`.` / `..`，解码后不得含 `/`、`\`
 *   或控制字符（防止经编码绕到 `/ui/` 之外）；未声明的路由由内核的插件路由表返回 404；
 * - 请求头走白名单（不转发 Cookie、CSRF 头等）；`Authorization` 只转发嵌入令牌形状的 Bearer
 *   （不转发 Basic 与 `cap_pat_` / `cap_svc_` 等内核 API 令牌，插件拿不到它们）；
 * - 响应头也走白名单（{@link ALLOW_RESPONSE}）：Set-Cookie、Clear-Site-Data、NEL / Report-To、HSTS、
 *   Accept-CH、Link 等会影响整个 Web 源的头一律不透传；3xx 的 Location 只保留仍在本插件
 *   `/plugin-ui/<plugin>/` 下的；插件没给 Cache-Control 时为 `no-store`；
 * - 每个响应都加安全头（{@link SECURITY_HEADERS}）；
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
 * - `connect-src 'self'` 与 `form-action 'self'`：只能连 / 提交到本源。'self' 是整个 Web 源，也包括 `/api`，
 *   CSP 的源表达式不能只写路径（要写绝对源，而代理拿到的 Host 在反向代理后面不可靠），所以没有收窄到
 *   `/plugin-ui/<plugin>/`。`/api` 对嵌入页仍然无用：
 *   1. 页面是不透明源（sandbox），它发的请求（fetch 与 iframe 内的表单导航）都是跨站请求，
 *      `SameSite=Lax` 的会话 Cookie `cap_at` 不会带上（Lax 只在顶层 GET 导航时带，沙箱又不给 top-navigation）；
 *   2. 内核对 Cookie 认证的非安全方法还要求 `X-Capybara-Csrf` 头，跨源请求带这个头要预检，`/api` 不应答 CORS；
 *   3. `/api` 的响应没有 CORS 头，不透明源读不到；
 *   4. 嵌入令牌当 Bearer 调 `/api` 一律 401（内核鉴权守卫只认 API 令牌）；
 *   本代理也不会把 `cap_pat_` / `cap_svc_` 令牌转给插件；
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

/** 转发给内核的请求头（白名单；`authorization` 另行按 {@link EMBED_BEARER} 判断）。 */
const FORWARD_REQUEST = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "last-event-id",
]);

/**
 * 嵌入令牌形状的 Bearer：`base64url.base64url`（见内核 `ui/embed-token.ts`）。内核 API 令牌（`cap_` 开头）、
 * Basic 等其他凭据都不转发，插件路由拿不到它们。
 */
const EMBED_BEARER = /^Bearer ([A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,128})$/;

/**
 * 回传给浏览器的响应头（白名单）。不含 content-encoding（fetch 已解压，body 是明文）、content-length
 * （流式透传）与 Location（3xx 时单独核对）。安全 / CORS 头由代理统一设置。
 */
const ALLOW_RESPONSE = new Set([
  "content-type",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "vary",
  "content-language",
  "x-accel-buffering",
  "retry-after",
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

/** 3xx 的 Location 是否仍在本插件的 `/plugin-ui/<plugin>/` 下（相对路径、站外、规范化后会变的一律不算）。 */
function locationInPlugin(location: string, plugin: string): boolean {
  if (!location.startsWith(`${PREFIX}${plugin}/`) || location.includes("//")) return false;
  let u: URL;
  try {
    u = new URL(location, "http://x");
  } catch {
    return false;
  }
  if (u.pathname + u.search + u.hash !== location) return false;
  return kernelPathOf(u.pathname)?.startsWith(`/plugins/${plugin}/ui/`) === true;
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
  const auth = req.headers.get("authorization");
  const bearer = auth === null ? undefined : EMBED_BEARER.exec(auth)?.[1];
  if (bearer !== undefined && !bearer.startsWith("cap_"))
    headers.set("authorization", auth as string);
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
    if (ALLOW_RESPONSE.has(key)) out.set(key, value);
  });
  if (!out.has("cache-control")) out.set("cache-control", "no-store");
  const location = upstream.headers.get("location");
  const plugin = path.split("/")[2] as string;
  if (
    upstream.status >= 300 &&
    upstream.status < 400 &&
    location !== null &&
    locationInPlugin(location, plugin)
  ) {
    out.set("location", location);
  }
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
