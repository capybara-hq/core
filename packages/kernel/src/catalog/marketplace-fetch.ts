import { createHash, timingSafeEqual } from "node:crypto";
import { type MarketplaceManifest, parseMarketplaceManifest } from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";
import { ApiError } from "../errors.js";
import { type LookupFn, NetDeniedError, type NetPolicy } from "../net/public-address.js";
import { safeFetch } from "../net/safe-fetch.js";
import { isLoopback, readCapped } from "../packages/npm.js";

/**
 * Fetching a marketplace manifest `marketplace.json` (C26, spec §5.2) and a marketplace's archive
 * sources. The URLs come from an enterprise admin or the config, but responses are always hostile
 * input:
 * - https only (`allowInsecureLoopback`, tests only, allows http on loopback addresses), no user
 *   info in the URL;
 * - every request goes through `net/safeFetch`: the host must resolve to public addresses (or be
 *   exempt by `marketplaces.allowPrivateHosts` / the npm registry origin) and the connection is
 *   pinned to the checked address;
 * - redirects are not followed (a 3xx fails): one redirect could otherwise send the request (and the
 *   token) elsewhere;
 * - a timeout, and the body is counted while read and aborted past `maxBytes`;
 * - the manifest is validated by the SDK's `parseMarketplaceManifest`; an invalid one is refused as
 *   a whole (the caller keeps the previous entries);
 * - the token is sent only when the request URL has the same origin as `tokenOrigin` (the
 *   marketplace's main URL), never to a mirror on another origin.
 */

/** The API error code for a download the network rules refused. */
export type MarketplaceNetCode = "marketplace.private_address" | "marketplace.redirect";

/**
 * The API error for a refused download, or undefined when the refusal is not one of the two
 * marketplace codes (an invalid URL or a DNS failure is an ordinary fetch failure).
 */
export function marketplaceNetCode(e: NetDeniedError): MarketplaceNetCode | undefined {
  if (e.code === "net.private_address") return "marketplace.private_address";
  if (e.code === "net.redirect") return "marketplace.redirect";
  return undefined;
}

/** The network rules for marketplace downloads from the kernel config. */
export function marketplaceNetPolicy(config: KernelConfig): NetPolicy {
  return {
    allowInsecureLoopback: config.marketplaces.allowInsecureLoopback,
    allowPrivateHosts: config.marketplaces.allowPrivateHosts,
    trustedOrigins: [new URL(config.packages.npmRegistry).origin],
  };
}

/**
 * The fetch failed (network, HTTP status, redirect, size, timeout). English message, no token.
 * `code` is set when the network rules refused the request.
 */
export class MarketplaceFetchError extends Error {
  readonly code: MarketplaceNetCode | undefined;
  constructor(message: string, options?: { cause?: unknown; code?: MarketplaceNetCode }) {
    super(message, options);
    this.name = "MarketplaceFetchError";
    this.code = options?.code;
  }
}

/** The response is not a valid manifest (JSON or schema). */
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
  /** The ETag of the last successful fetch (sent as `If-None-Match`). */
  etag?: string | null;
  token?: string;
  /** The token goes only to this origin (the marketplace's main URL). */
  tokenOrigin?: string;
  maxBytes: number;
  timeoutMs: number;
  net: NetPolicy;
  /** Tests only: replaces the DNS lookup. */
  lookup?: LookupFn;
  signal: AbortSignal;
}

export type MarketplaceFetchResult =
  | { status: "not_modified" }
  | { status: "ok"; manifest: MarketplaceManifest; etag: string | null };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Whether a marketplace URL is usable: https (or http on loopback in tests), at most 2000
 * characters, parseable, without user info. Returns the reason (English) or null.
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
 * Fetches and validates one `marketplace.json`. Throws {@link MarketplaceFetchError} or
 * {@link MarketplaceInvalidError}.
 */
export async function fetchMarketplaceManifest(
  url: string,
  o: MarketplaceFetchOptions,
): Promise<MarketplaceFetchResult> {
  const problem = marketplaceUrlProblem(url, o.net.allowInsecureLoopback);
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
    res = await safeFetch(target.href, { headers, signal }, o.net, {
      ...(o.lookup !== undefined && { lookup: o.lookup }),
    });
  } catch (e) {
    if (e instanceof NetDeniedError) {
      const code = marketplaceNetCode(e);
      throw new MarketplaceFetchError(`cannot fetch the marketplace: ${e.message}`, {
        cause: e,
        ...(code !== undefined && { code }),
      });
    }
    throw new MarketplaceFetchError(`cannot fetch the marketplace: ${errMsg(e)}`, { cause: e });
  }
  if (res.status === 304) {
    await res.body?.cancel().catch(() => {});
    return { status: "not_modified" };
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
    throw new MarketplaceInvalidError("the marketplace manifest is not valid JSON", []);
  }
  const parsed = parseMarketplaceManifest(json, {
    allowInsecureLoopback: o.net.allowInsecureLoopback,
  });
  if ("errors" in parsed) {
    throw new MarketplaceInvalidError(
      `the response is not a valid marketplace.json: ${parsed.errors.slice(0, 5).join("; ")}`,
      parsed.errors,
    );
  }
  return { status: "ok", manifest: parsed, etag: res.headers.get("etag") };
}

/** `sha512-<base64>` / `sha256-<base64>` SRI -> algorithm and digest (undefined otherwise). */
function parseSri(integrity: string): { alg: "sha512" | "sha256"; digest: Buffer } | undefined {
  const m = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity.trim());
  if (!m) return undefined;
  const alg = m[1] as "sha512" | "sha256";
  const digest = Buffer.from(m[2] as string, "base64");
  return digest.length === (alg === "sha512" ? 64 : 32) ? { alg, digest } : undefined;
}

/**
 * Downloads a marketplace `archive` source (a plugin tgz at `url`) under the rules in the file
 * header (https, no redirects, at most `maxBytes`, a timeout) and verifies it against the
 * marketplace's `integrity` (sha512 or sha256 SRI). Failures are API errors: a size over the limit
 * -> `extension.package_too_large`; a digest mismatch -> `marketplace.integrity_mismatch`; a host
 * resolving to a private address -> `marketplace.private_address`; a 3xx -> `marketplace.redirect`;
 * anything else -> `marketplace.fetch_failed`.
 */
export async function fetchMarketplaceArchive(
  archive: { url: string; integrity: string },
  o: {
    maxBytes: number;
    timeoutMs: number;
    net: NetPolicy;
    lookup?: LookupFn;
    signal?: AbortSignal;
  },
): Promise<{ bytes: Uint8Array; integrity: string }> {
  const failed = (m: string) => new ApiError("marketplace.fetch_failed", m);
  const problem = marketplaceUrlProblem(archive.url, o.net.allowInsecureLoopback);
  if (problem !== null) throw failed(`invalid archive URL: ${problem}`);
  const sri = parseSri(archive.integrity);
  if (!sri) throw failed("the archive integrity is not a sha512 or sha256 SRI");
  const timeout = AbortSignal.timeout(o.timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await safeFetch(new URL(archive.url).href, { signal }, o.net, {
      ...(o.lookup !== undefined && { lookup: o.lookup }),
    });
  } catch (e) {
    if (e instanceof NetDeniedError) {
      const code = marketplaceNetCode(e);
      if (code !== undefined) throw new ApiError(code, `Archive download refused: ${e.message}`);
    }
    throw failed(`cannot fetch the archive: ${errMsg(e)}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw failed(`the archive URL responded with HTTP ${res.status}`);
  }
  const tooLarge = new ApiError(
    "extension.package_too_large",
    `the package is larger than ${o.maxBytes} bytes`,
  );
  let bytes: Buffer;
  try {
    bytes = await readCapped(res, o.maxBytes, () => tooLarge);
  } catch (e) {
    if (e === tooLarge) throw e;
    throw failed(`cannot read the archive: ${errMsg(e)}`);
  }
  const got = createHash(sri.alg).update(bytes).digest();
  if (!timingSafeEqual(got, sri.digest)) {
    const prefix = (s: string) => `${s.slice(0, 19)}…`;
    const actual = `${sri.alg}-${got.toString("base64")}`;
    throw new ApiError(
      "marketplace.integrity_mismatch",
      `The package does not match the marketplace (expected ${prefix(archive.integrity)}, got ${prefix(actual)}); installation refused`,
      [{ expected: prefix(archive.integrity), actual: prefix(actual) }],
    );
  }
  return { bytes: new Uint8Array(bytes), integrity: archive.integrity };
}
