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

import { timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";

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

/** Environment variable naming the proxies in front of the web tier (see {@link parseTrustProxy}). */
export const TRUST_PROXY_ENV = "CAPYBARA_WEB_TRUST_PROXY";

/**
 * Which hops in front of the web tier are trusted to report the client address in
 * `x-forwarded-for`: none (the socket peer is the client), the nearest `hops` hops, or the hops
 * whose address is in `list`.
 */
export type TrustProxy =
  | { kind: "none" }
  | { kind: "hops"; hops: number }
  | { kind: "cidrs"; list: BlockList };

/**
 * proxy-addr's named ranges (what the kernel's `http.trustProxy` also accepts), so a value that works
 * for the kernel works here too.
 */
const NAMED_RANGES: Readonly<Record<string, readonly string[]>> = {
  loopback: ["127.0.0.1/8", "::1/128"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  uniquelocal: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
};

/**
 * Parses {@link TRUST_PROXY_ENV}: unset or empty trusts nothing; a non-negative integer is a hop
 * count (0 trusts nothing); anything else is a list of IPs / CIDRs, comma-separated or as a JSON
 * array. The list grammar is the kernel's `http.trustProxy` one: an IPv4 prefix may be a dotted
 * netmask (`10.0.0.0/255.0.0.0`), `loopback` / `linklocal` / `uniquelocal` name proxy-addr's ranges,
 * and an IPv4-mapped IPv6 range (`::ffff:10.0.0.0/104`) is the IPv4 range /N-96. A range that trusts
 * every address (/0) is refused. Unlike the kernel there is no `true` (trust everyone) or `false`
 * (use 0). Throws on a malformed value so the server fails at startup instead of silently trusting
 * the wrong hops.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const value = raw?.trim() ?? "";
  if (value === "") return { kind: "none" };
  if (/^\d+$/.test(value)) {
    const hops = Number.parseInt(value, 10);
    return hops === 0 ? { kind: "none" } : { kind: "hops", hops };
  }
  const list = new BlockList();
  for (const entry of listEntries(value)) {
    for (const range of NAMED_RANGES[entry] ?? [entry]) {
      const { ip, bits, family } = parseRange(range, entry);
      list.addSubnet(ip, bits, family);
    }
  }
  return { kind: "cidrs", list };
}

function invalid(entry: string): Error {
  return new Error(
    `${TRUST_PROXY_ENV}: invalid entry "${entry}"; expected a hop count or comma-separated IPs / CIDRs`,
  );
}

/** The entries of a comma-separated or JSON array list (empty entries dropped). */
function listEntries(value: string): string[] {
  if (value.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw invalid(value);
    }
    if (!Array.isArray(parsed) || !parsed.every((e) => typeof e === "string")) {
      throw invalid(value);
    }
    return parsed.map((e) => e.trim()).filter((e) => e !== "");
  }
  return value
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
}

/** Prefix length of a contiguous dotted IPv4 netmask, or undefined. */
function netmaskBits(mask: string): number | undefined {
  if (isIP(mask) !== 4) return undefined;
  const n = mask.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
  const ones = n.toString(2).padStart(32, "0");
  return /01/.test(ones) ? undefined : (ones.match(/1/g) ?? []).length;
}

/** One IP / CIDR entry as a BlockList subnet (IPv4-mapped IPv6 unwrapped to IPv4). */
function parseRange(
  range: string,
  entry: string,
): { ip: string; bits: number; family: "ipv4" | "ipv6" } {
  const [addr = "", prefix, extra] = range.split("/");
  const raw = addr.trim();
  const ip = normalizeIp(raw);
  if (ip === undefined || extra !== undefined) throw invalid(entry);
  const family = isIP(ip) === 6 ? 6 : 4;
  const mapped = family === 4 && isIP(raw) === 6;
  let bits: number | undefined;
  if (prefix === undefined) bits = family === 6 ? 128 : 32;
  else if (/^\d+$/.test(prefix)) bits = Number(prefix) - (mapped ? 96 : 0);
  else if (family === 4 && !mapped) bits = netmaskBits(prefix);
  if (bits === undefined || bits > (family === 6 ? 128 : 32)) throw invalid(entry);
  if (bits === 0 || (bits < 0 && Number(prefix) === 0)) {
    // A /0 range trusts every address: any client could forge X-Forwarded-For.
    throw new Error(
      `${TRUST_PROXY_ENV}: "${entry}" trusts every address; list the proxies' own addresses or CIDRs`,
    );
  }
  // A mapped prefix between /1 and /95 has no IPv4 equivalent.
  if (bits < 0) throw invalid(entry);
  return { ip, bits, family: family === 6 ? "ipv6" : "ipv4" };
}

/** A bare IPv4 / IPv6 address (IPv4-mapped IPv6 unwrapped to IPv4), or undefined if malformed. */
function normalizeIp(value: string): string | undefined {
  const v = value.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v)?.[1];
  if (mapped !== undefined && isIP(mapped) === 4) return mapped;
  return isIP(v) === 0 ? undefined : v;
}

function trusts(trust: TrustProxy, addr: string, hop: number): boolean {
  if (trust.kind === "none") return false;
  if (trust.kind === "hops") return hop < trust.hops;
  return trust.list.check(addr, isIP(addr) === 6 ? "ipv6" : "ipv4");
}

/**
 * The client address: starting at the socket peer, walk the `x-forwarded-for` chain from the
 * right while the current hop is trusted (like Fastify / proxy-addr). A malformed entry stops the
 * walk at the last address that could be vouched for, so it can never be forwarded.
 */
export function clientAddress(
  peer: string | undefined,
  xff: string | string[] | undefined,
  trust: TrustProxy,
): string | undefined {
  if (peer === undefined || trust.kind === "none") return peer;
  const raw = Array.isArray(xff) ? xff.join(",") : (xff ?? "");
  const chain = raw.trim() === "" ? [] : raw.split(",").reverse();
  let current = normalizeIp(peer) ?? peer;
  for (let hop = 0; hop < chain.length; hop++) {
    if (!trusts(trust, current, hop)) return current;
    const next = normalizeIp(chain[hop] ?? "");
    if (next === undefined) return current;
    current = next;
  }
  return current;
}

/**
 * 交给 Next 之前清理请求头：去掉客户端的转发头，写入真实对端地址与可信标记。
 * With `trust` set (from {@link TRUST_PROXY_ENV}), the client address is derived from the incoming
 * `x-forwarded-for` chain first; the forwarded value is still a single sanitized address.
 */
export function sanitizeIncoming(
  req: IncomingLike,
  token: string,
  trust: TrustProxy = { kind: "none" },
): void {
  const client = clientAddress(req.socket.remoteAddress, req.headers["x-forwarded-for"], trust);
  for (const h of FORWARDING_HEADERS) delete req.headers[h];
  if (client !== undefined) req.headers["x-forwarded-for"] = client;
  req.headers[PEER_TOKEN_HEADER] = token;
}

/**
 * 代理路由用：返回可以转给内核的客户端地址；只有请求带着与本进程标记一致的
 * {@link PEER_TOKEN_HEADER} 时才信任其 `x-forwarded-for`（由 server.mjs 写入）。
 */
export function trustedPeer(headers: Headers): string | undefined {
  const token = process.env[PEER_TOKEN_ENV];
  if (token === undefined || token === "") return undefined;
  if (!sameToken(headers.get(PEER_TOKEN_HEADER), token)) return undefined;
  return headers.get("x-forwarded-for") ?? undefined;
}

/** 常量时间比较标记（先比字节长度：timingSafeEqual 要求等长，长度本身不是秘密）。 */
function sameToken(got: string | null, expected: string): boolean {
  if (got === null) return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
