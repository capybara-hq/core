import { type CatalogIndex, parseCatalogIndex } from "@capybara-hq/plugin-sdk";
import { isLoopback, readCapped } from "../packages/npm.js";

/**
 * 拉取一份目录清单（C26）。清单地址来自企业管理员或配置，但响应一律当作恶意输入：
 * - 只认 https（`allowInsecureLoopback` 只供测试，允许回环地址上的 http），地址不能带用户信息；
 * - 不跟随重定向（3xx 直接失败）：否则一次重定向就能把请求（连同令牌）引到别处；
 * - 有超时，响应体边读边计数，超过 `maxBytes` 立即中止；
 * - 按 SDK 的清单 schema 校验，不合法整份拒绝（调用方保留上一份条目）；
 * - 令牌只在请求地址与 `tokenOrigin`（来源主地址的源）同源时发送，镜像在别的源上时不带。
 */

/** 拉取失败（网络、HTTP 状态、重定向、超限、超时）。消息为英文，不含令牌。 */
export class MarketplaceFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MarketplaceFetchError";
  }
}

/** 响应不是合法的清单（JSON 解析或 schema 校验失败）。 */
export class MarketplaceInvalidError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "MarketplaceInvalidError";
  }
}

export interface MarketplaceFetchOptions {
  /** 上次成功拉取的 ETag（发 `If-None-Match`）。 */
  etag?: string | null;
  token?: string;
  /** 令牌只发往这个源（来源主地址的 origin）。 */
  tokenOrigin?: string;
  maxBytes: number;
  timeoutMs: number;
  allowInsecureLoopback?: boolean;
  signal: AbortSignal;
}

export type MarketplaceFetchResult =
  | { status: "not_modified" }
  | { status: "ok"; index: CatalogIndex; etag: string | null };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 清单地址是否可用：https（或测试时回环地址上的 http）、≤ 2000 字符、能解析、不带用户信息。
 * 不可用返回原因（英文），可用返回 null。
 */
export function marketplaceUrlProblem(url: string, allowInsecureLoopback: boolean): string | null {
  if (url.length > 2000) return "the URL is longer than 2000 characters";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a valid URL";
  }
  if (u.username !== "" || u.password !== "") return "the URL must not contain credentials";
  if (u.protocol === "https:") return null;
  if (allowInsecureLoopback && u.protocol === "http:" && isLoopback(u.hostname)) return null;
  return "the URL must use https";
}

/**
 * Fetches and validates one marketplace index. Throws {@link MarketplaceFetchError} or
 * {@link MarketplaceInvalidError}.
 */
export async function fetchMarketplaceIndex(
  url: string,
  o: MarketplaceFetchOptions,
): Promise<MarketplaceFetchResult> {
  const problem = marketplaceUrlProblem(url, o.allowInsecureLoopback === true);
  if (problem !== null) throw new MarketplaceFetchError(`invalid marketplace URL: ${problem}`);
  const target = new URL(url);
  const headers: Record<string, string> = { accept: "application/json" };
  if (o.etag) headers["if-none-match"] = o.etag;
  if (o.token !== undefined && o.tokenOrigin === target.origin) {
    headers.authorization = `Bearer ${o.token}`;
  }
  const signal = AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)]);
  let res: Response;
  try {
    res = await fetch(target, { headers, redirect: "manual", signal });
  } catch (e) {
    throw new MarketplaceFetchError(`cannot fetch the marketplace: ${errMsg(e)}`, { cause: e });
  }
  if (res.status === 304) {
    await res.body?.cancel().catch(() => {});
    return { status: "not_modified" };
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new MarketplaceFetchError(
      `the marketplace responded with a redirect (${res.status}); redirects are not followed`,
    );
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new MarketplaceFetchError(`the marketplace responded with HTTP ${res.status}`);
  }
  let raw: Buffer;
  try {
    raw = await readCapped(
      res,
      o.maxBytes,
      () => new MarketplaceFetchError(`the marketplace is larger than ${o.maxBytes} bytes`),
    );
  } catch (e) {
    if (e instanceof MarketplaceFetchError) throw e;
    throw new MarketplaceFetchError(`cannot read the marketplace: ${errMsg(e)}`, { cause: e });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new MarketplaceInvalidError("the marketplace index is not valid JSON", []);
  }
  const parsed = parseCatalogIndex(json, {
    allowInsecureLoopback: o.allowInsecureLoopback === true,
  });
  if ("errors" in parsed) {
    throw new MarketplaceInvalidError(
      `the marketplace index does not match the catalog index schema: ${parsed.errors.slice(0, 5).join("; ")}`,
      parsed.errors,
    );
  }
  return { status: "ok", index: parsed, etag: res.headers.get("etag") };
}
