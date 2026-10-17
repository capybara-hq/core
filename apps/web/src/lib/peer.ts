/**
 * 客户端真实地址的可信传递（server.mjs 与 /api 代理路由共用；只用可擦除的 TS 语法，
 * 以便 server.mjs 由 Node 原生类型擦除直接 import）。
 *
 * Next 的路由处理器拿不到 socket 地址，而 Next 自己只在请求「没有」`x-forwarded-for` 时才补上
 * 对端地址（`??=`），客户端伪造的值会原样留下。所以由自定义服务器 server.mjs 在把请求交给
 * Next 之前：删掉客户端发来的全部转发类请求头，把 `x-forwarded-for` 设为 socket 的对端地址，
 * 并打上只有本进程知道的随机标记。代理路由只在标记匹配时才把 `x-forwarded-for` 转给内核；
 * 未经 server.mjs（例如直接 `next dev` / `next start`）时一律不转，内核看到的是 Web 层地址
 * （按 IP 的登录限流退化为共享一个地址，但不能被伪造绕过）。
 *
 * 内核应以 `http.trustProxy: 1` 运行在 Web 层之后（只信任一跳，即本服务）。
 */

/** server.mjs 打的可信标记请求头（转发给内核前删除）。 */
export const PEER_TOKEN_HEADER = "x-capybara-peer-token";
/** 存放本进程随机标记的环境变量（由 server.mjs 启动时生成）。 */
export const PEER_TOKEN_ENV = "CAPYBARA_WEB_PEER_TOKEN";

/** 客户端可以伪造、不得原样转给内核的转发类请求头。 */
export const FORWARDING_HEADERS: readonly string[] = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  PEER_TOKEN_HEADER,
];

/** server.mjs 用：Node IncomingMessage 的最小形状。 */
export interface IncomingLike {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | undefined };
}

/** 交给 Next 之前清理请求头：去掉客户端的转发头，写入真实对端地址与可信标记。 */
export function sanitizeIncoming(req: IncomingLike, token: string): void {
  for (const h of FORWARDING_HEADERS) delete req.headers[h];
  const peer = req.socket.remoteAddress;
  if (peer !== undefined) req.headers["x-forwarded-for"] = peer;
  req.headers[PEER_TOKEN_HEADER] = token;
}

/**
 * 代理路由用：返回可以转给内核的客户端地址；只有请求带着与本进程标记一致的
 * {@link PEER_TOKEN_HEADER} 时才信任其 `x-forwarded-for`（由 server.mjs 写入）。
 */
export function trustedPeer(headers: Headers): string | undefined {
  const token = process.env[PEER_TOKEN_ENV];
  if (token === undefined || token === "") return undefined;
  if (headers.get(PEER_TOKEN_HEADER) !== token) return undefined;
  return headers.get("x-forwarded-for") ?? undefined;
}
