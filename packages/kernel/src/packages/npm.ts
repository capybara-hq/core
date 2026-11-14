import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import semver from "semver";
import { type LookupFn, NetDeniedError, type NetPolicy } from "../net/public-address.js";
import { safeFetch } from "../net/safe-fetch.js";

/**
 * Downloads plugin packages from an npm registry (D14 / C21 / C26). The registry URL comes from
 * the config (trusted), but whatever it returns is external input:
 * - every request goes through `packages/kernel/src/net` ({@link safeFetch}) under `cfg.net`
 *   (the kernel passes `marketplaceNetPolicy`: the registry's origin is trusted, any other host
 *   must resolve to public addresses unless `marketplaces.allowPrivateHosts` exempts it, https
 *   tunnels through `net.httpsProxy`, and the connection is pinned to the checked address);
 * - redirects are never followed (a 3xx fails): one registry redirect could otherwise send the
 *   download (and the token) anywhere;
 * - metadata and tarball are counted while read and aborted past their caps;
 * - without `opts` the tarball must be on the registry's origin (the only origin the token goes
 *   to) and is verified against the packument's `dist.integrity` (sha512 SRI); with
 *   `opts.expectedIntegrity` (marketplace imports, T24) only that integrity counts;
 * - `opts.tarballUrl` (a download URL the marketplace gives) must be https (loopback http in tests
 *   under `net.allowInsecureLoopback`), needs `expectedIntegrity`, and never gets the registry
 *   token unless it is on the registry's origin.
 */

/** 下载或校验失败（HTTP 层映射为 `packages.npm_failed`，502）。消息为英文，不含令牌。 */
export class NpmFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NpmFetchError";
  }
}

/** 下载内容与期望的 integrity 不符（`expected` / `actual` 为 `sha512-<base64>`）。 */
export class IntegrityMismatchError extends NpmFetchError {
  constructor(
    message: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(message);
    this.name = "IntegrityMismatchError";
  }
}

/** The package exceeds the size limit (the HTTP layer maps it to `extension.package_too_large`, 413). */
export class PackageTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`the package is larger than ${maxBytes} bytes`);
    this.name = "PackageTooLargeError";
  }
}

export interface NpmFetchConfig {
  registry: string;
  token?: string;
  maxBytes: number;
  /**
   * The network rules of every request (`marketplaceNetPolicy` in the kernel, which trusts the
   * registry's origin). `allowInsecureLoopback` also lets `opts.tarballUrl` use loopback http.
   */
  net: NetPolicy;
  /** Tests only: replaces the DNS lookup. */
  lookup?: LookupFn;
}

/** packument（包元数据）的大小上限：热门包的完整元数据可以有几十 MB，插件包不会这么多。 */
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

// npm 包名（简化，与 plugin-sdk 的规则一致）：可带 scope，小写，≤ 214 字符。
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 回环地址（`localhost`、`127.*`、`::1`）。 */
export const isLoopback = (host: string) => {
  const h = host.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || (isIP(h) === 4 && h.startsWith("127."));
};

/** 读响应体，累计超过 `max` 立即取消并抛 `onTooLarge()`。 */
export async function readCapped(
  res: Response,
  max: number,
  onTooLarge: () => Error,
): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw onTooLarge();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw onTooLarge();
    }
    chunks.push(value);
  }
  if (chunks.length === 1) {
    const c = chunks[0] as Uint8Array;
    return Buffer.from(c.buffer, c.byteOffset, c.byteLength);
  }
  return Buffer.concat(chunks);
}

/**
 * One GET through {@link safeFetch} under `cfg.net` (no redirects, the network rules); a refusal,
 * a network error or a non-2xx answer is an {@link NpmFetchError} with an English message.
 */
export async function npmGet(
  cfg: Pick<NpmFetchConfig, "net" | "lookup">,
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  what: string,
): Promise<Response> {
  let res: Response;
  try {
    res = await safeFetch(
      url.toString(),
      { headers, signal },
      cfg.net,
      cfg.lookup !== undefined ? { lookup: cfg.lookup } : {},
    );
  } catch (e) {
    if (e instanceof NetDeniedError && e.code === "net.redirect") {
      throw new NpmFetchError(`the ${what} responded with a redirect; redirects are not followed`, {
        cause: e,
      });
    }
    throw new NpmFetchError(`cannot fetch the ${what}: ${errMsg(e)}`, { cause: e });
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new NpmFetchError(`the ${what} responded with HTTP ${res.status}`);
  }
  return res;
}

/** `sha512-<base64>` 形式的 SRI；可能有空格分隔的多个，取其中的 sha512。 */
function sha512Of(integrity: string): Buffer | undefined {
  for (const part of integrity.trim().split(/\s+/)) {
    const m = /^sha512-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/.exec(part);
    if (m) {
      const b = Buffer.from(m[1] as string, "base64");
      if (b.length === 64) return b;
    }
  }
  return undefined;
}

function verify(bytes: Uint8Array, integrity: string, label: string): void {
  const want = sha512Of(integrity);
  if (!want) throw new NpmFetchError(`${label} is not a sha512 integrity`);
  const got = createHash("sha512").update(bytes).digest();
  if (!timingSafeEqual(want, got)) {
    throw new IntegrityMismatchError(
      `the downloaded package does not match ${label}`,
      `sha512-${want.toString("base64")}`,
      `sha512-${got.toString("base64")}`,
    );
  }
}

/**
 * 下载 `name@version`（`version` 可以是精确版本、dist-tag 或范围，缺省 `latest`），返回 tgz 字节、解析出的版本与
 * 实际校验所用的 integrity。失败抛 {@link NpmFetchError}（含 {@link IntegrityMismatchError}）或
 * {@link PackageTooLargeError}。
 */
export async function fetchNpmPackage(
  cfg: NpmFetchConfig,
  name: string,
  version: string | undefined,
  signal: AbortSignal,
  opts: { expectedIntegrity?: string; tarballUrl?: string } = {},
): Promise<{ bytes: Uint8Array; version: string; integrity: string }> {
  if (typeof name !== "string" || name.length > 214 || !NPM_NAME_RE.test(name)) {
    throw new NpmFetchError(`"${String(name)}" is not a valid npm package name`);
  }
  const registry = new URL(cfg.registry.endsWith("/") ? cfg.registry : `${cfg.registry}/`);
  const authHeaders: Record<string, string> =
    cfg.token !== undefined ? { authorization: `Bearer ${cfg.token}` } : {};
  const tooLarge = () => new PackageTooLargeError(cfg.maxBytes);

  let tarball: URL;
  let resolved: string;
  let integrity: string;
  let tarballHeaders: Record<string, string> = authHeaders;
  if (opts.tarballUrl !== undefined) {
    if (opts.expectedIntegrity === undefined) {
      throw new NpmFetchError("a tarballUrl needs an expectedIntegrity to verify the download");
    }
    if (version === undefined || semver.valid(version) === null) {
      throw new NpmFetchError("a tarballUrl needs an exact version");
    }
    try {
      tarball = new URL(opts.tarballUrl);
    } catch {
      throw new NpmFetchError("the tarball URL is not a valid URL");
    }
    const insecureOk =
      cfg.net.allowInsecureLoopback && tarball.protocol === "http:" && isLoopback(tarball.hostname);
    if (tarball.protocol !== "https:" && !insecureOk) {
      throw new NpmFetchError("the tarball URL must use https");
    }
    // the token goes only to the registry origin
    if (tarball.origin !== registry.origin) tarballHeaders = {};
    resolved = version;
    integrity = opts.expectedIntegrity;
  } else {
    // scope 包名里的 `/` 按 npm 客户端的写法编码为 %2f
    const docUrl = new URL(name.replace("/", "%2f"), registry);
    const res = await npmGet(
      cfg,
      docUrl,
      { ...authHeaders, accept: "application/json" },
      signal,
      "npm registry",
    );
    const raw = await readCapped(
      res,
      MAX_METADATA_BYTES,
      () => new NpmFetchError("the npm package metadata is too large"),
    );
    let doc: {
      "dist-tags"?: Record<string, unknown>;
      versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown } }>;
    };
    try {
      doc = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new NpmFetchError("the npm package metadata is not valid JSON");
    }
    const versions = doc.versions && typeof doc.versions === "object" ? doc.versions : {};
    const tags = doc["dist-tags"] && typeof doc["dist-tags"] === "object" ? doc["dist-tags"] : {};
    const want = version ?? "latest";
    let picked: string | undefined;
    if (Object.hasOwn(versions, want) && semver.valid(want) !== null) picked = want;
    else if (TAG_RE.test(want) && typeof tags[want] === "string" && semver.valid(want) === null) {
      picked = tags[want] as string;
    } else if (semver.validRange(want) !== null) {
      picked =
        semver.maxSatisfying(
          Object.keys(versions).filter((v) => semver.valid(v) !== null),
          want,
        ) ?? undefined;
    }
    const entry =
      picked !== undefined && Object.hasOwn(versions, picked) ? versions[picked] : undefined;
    if (picked === undefined || !entry) {
      throw new NpmFetchError(`npm package ${name} has no version matching "${want}"`);
    }
    const dist = entry.dist ?? {};
    if (typeof dist.tarball !== "string") {
      throw new NpmFetchError(`npm package ${name}@${picked} has no tarball`);
    }
    try {
      tarball = new URL(dist.tarball);
    } catch {
      throw new NpmFetchError(`npm package ${name}@${picked} has an invalid tarball URL`);
    }
    if (tarball.origin !== registry.origin) {
      throw new NpmFetchError(
        `the tarball of ${name}@${picked} is not on the registry origin ${registry.origin}`,
      );
    }
    if (opts.expectedIntegrity !== undefined) integrity = opts.expectedIntegrity;
    else if (typeof dist.integrity === "string") integrity = dist.integrity;
    else throw new NpmFetchError(`npm package ${name}@${picked} has no integrity to verify`);
    resolved = picked;
  }

  const res = await npmGet(cfg, tarball, tarballHeaders, signal, "package tarball");
  const bytes = await readCapped(res, cfg.maxBytes, tooLarge);
  verify(
    bytes,
    integrity,
    opts.expectedIntegrity !== undefined ? "the expected integrity" : "the npm dist.integrity",
  );
  return {
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    version: resolved,
    integrity,
  };
}
