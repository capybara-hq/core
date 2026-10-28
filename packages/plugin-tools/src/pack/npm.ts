import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";
import { integrityOf } from "../integrity.js";

/** The npm registry the kernel uses by default (`packages.npmRegistry`). */
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** Per request (packument or tarball). */
const NPM_TIMEOUT_MS = 120_000;

/**
 * The largest tarball downloaded: the kernel's `packages.maxBytes` default
 * (`PACKAGES_MAX_BYTES_DEFAULT`, 50 MiB; this subpath does not import the kernel, a test keeps the
 * two equal). A bigger plugin could not be installed by a kernel with the default limit anyway.
 */
export const NPM_TARBALL_MAX_BYTES = 52_428_800;

/**
 * The packument media type npm itself asks for: the abbreviated metadata (versions with `dist`,
 * no readmes), much smaller than the full document; registries that do not know it send JSON.
 */
const PACKUMENT_ACCEPT = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

/** Why {@link fetchNpmTarball} or {@link downloadPinnedNpmPackage} failed. */
export type NpmPackageErrorKind =
  /** The package or that version is not on the registry. */
  | "unpublished"
  /** The registry's metadata or bytes do not match the pinned sha512. */
  | "integrity"
  /** Network error, HTTP status, or a packument that cannot be read. */
  | "fetch"
  /** The tarball is larger than the cap ({@link NPM_TARBALL_MAX_BYTES}): `bootstrap.too_large`. */
  | "too_large"
  /** The tarball's `package/package.json` names another package or version than was asked for. */
  | "mislabelled";

/** Options of {@link fetchNpmTarball} and {@link downloadPinnedNpmPackage}. */
export interface NpmFetchOptions {
  /**
   * Bearer token for a private registry (`CAPYBARA_PACKAGES__NPM_TOKEN`, the kernel's
   * `packages.npmToken`): sent only to the registry's origin, never to a tarball URL elsewhere.
   */
  token?: string;
  /** Tarball size cap in bytes; default {@link NPM_TARBALL_MAX_BYTES}. */
  maxBytes?: number;
}

/** A pinned npm package could not be fetched or does not match its pin. English message. */
export class NpmPackageError extends Error {
  constructor(
    readonly kind: NpmPackageErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "NpmPackageError";
  }
}

/** The packument path of a package: a scoped name is written `@scope%2fname`, as npm does. */
const packumentUrl = (registry: string, pkg: string) =>
  `${registry.replace(/\/+$/, "")}/${pkg.replace("/", "%2f")}`;

async function get(
  url: string,
  what: string,
  accept: string,
  registry: string,
  token: string | undefined,
): Promise<Response> {
  const headers: Record<string, string> = { accept };
  if (token !== undefined && token !== "" && new URL(url).origin === new URL(registry).origin) {
    headers.authorization = `Bearer ${token}`;
  }
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(NPM_TIMEOUT_MS) });
  } catch (e) {
    throw new NpmPackageError(
      "fetch",
      `cannot fetch ${what} (${url}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * `<pkg>@<version>` from an npm registry: its tarball bytes and the packument's `dist.integrity`
 * (whatever the registry claims; callers compare it with their pin). The packument is asked for in
 * npm's abbreviated form; `opts.token` goes to the registry origin only; the tarball is read up to
 * `opts.maxBytes`. Throws {@link NpmPackageError}: `unpublished` (404 or no such version),
 * `too_large`, `fetch` (anything else). The bytes are not judged here: see
 * {@link downloadPinnedNpmPackage} and {@link assertNpmTarballLabel}.
 */
export async function fetchNpmTarball(
  pkg: string,
  version: string,
  registry: string = DEFAULT_NPM_REGISTRY,
  opts: NpmFetchOptions = {},
): Promise<{ bytes: Uint8Array; distIntegrity: string | undefined; tarball: string }> {
  const spec = `${pkg}@${version}`;
  const url = packumentUrl(registry, pkg);
  const res = await get(url, `the packument of ${pkg}`, PACKUMENT_ACCEPT, registry, opts.token);
  if (res.status === 404) {
    throw new NpmPackageError("unpublished", `${pkg} is not published on ${registry}`);
  }
  if (!res.ok) {
    throw new NpmPackageError("fetch", `${url} answered ${res.status} for the packument of ${pkg}`);
  }
  let doc: { versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown } }> };
  try {
    doc = (await res.json()) as typeof doc;
  } catch {
    throw new NpmPackageError("fetch", `the packument of ${pkg} at ${url} is not valid JSON`);
  }
  const dist = doc.versions?.[version]?.dist;
  if (dist === undefined) {
    throw new NpmPackageError("unpublished", `${spec} is not published on ${registry}`);
  }
  if (typeof dist.tarball !== "string" || !/^https?:\/\//.test(dist.tarball)) {
    throw new NpmPackageError("fetch", `the packument of ${spec} has no tarball URL`);
  }
  const tarball = dist.tarball;
  const t = await get(
    tarball,
    `the tarball of ${spec}`,
    "application/octet-stream",
    registry,
    opts.token,
  );
  if (!t.ok) {
    throw new NpmPackageError(
      t.status === 404 ? "unpublished" : "fetch",
      `${tarball} answered ${t.status} for the tarball of ${spec}`,
    );
  }
  const bytes = await readCapped(t, spec, opts.maxBytes ?? NPM_TARBALL_MAX_BYTES);
  return {
    bytes,
    distIntegrity: typeof dist.integrity === "string" ? dist.integrity : undefined,
    tarball,
  };
}

/**
 * Downloads `<pkg>@<version>` and checks its bytes against the pinned sha512 `integrity`; returns the
 * bytes only when they match (a tampered tarball, or a registry serving other bytes than the pin,
 * throws {@link NpmPackageError} `integrity`), then checks its label
 * ({@link assertNpmTarballLabel}). The registry's own `dist.integrity` plays no part: only the
 * bytes are judged.
 */
export async function downloadPinnedNpmPackage(
  pin: { npm: string; version: string; integrity: string },
  registry: string = DEFAULT_NPM_REGISTRY,
  opts: NpmFetchOptions = {},
): Promise<Uint8Array> {
  const r = await fetchNpmTarball(pin.npm, pin.version, registry, opts);
  const actual = integrityOf(r.bytes);
  if (actual !== pin.integrity) {
    throw new NpmPackageError(
      "integrity",
      `${pin.npm}@${pin.version} from ${r.tarball} has sha512 ${actual}, not the pinned ${pin.integrity}`,
    );
  }
  await assertNpmTarballLabel(r.bytes, pin.npm, pin.version);
  return r.bytes;
}

/**
 * The tarball's `package/package.json` must name `pkg` at `version` (a pin taken from another
 * package's tarball, or a registry serving one under the wrong name); throws
 * {@link NpmPackageError} `mislabelled` otherwise (`fetch` when the bytes are no tgz).
 */
export async function assertNpmTarballLabel(
  bytes: Uint8Array,
  pkg: string,
  version: string,
): Promise<void> {
  const label = await packageJsonOf(bytes, `${pkg}@${version}`);
  if (label.name !== pkg || label.version !== version) {
    throw new NpmPackageError(
      "mislabelled",
      `the tarball of ${pkg}@${version} is labelled ${String(label.name)}@${String(label.version)} in its package.json`,
    );
  }
}

/** The response body, refused past `max` bytes (by its content-length, then while reading). */
async function readCapped(res: Response, spec: string, max: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new NpmPackageError(
      "too_large",
      `bootstrap.too_large: the tarball of ${spec} is larger than ${max} bytes`,
    );
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body !== null) {
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > max) {
        await res.body.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(chunk);
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** `package/package.json` of an npm tarball (`{}` fields when it has none or it does not parse). */
async function packageJsonOf(
  bytes: Uint8Array,
  spec: string,
): Promise<{ name?: unknown; version?: unknown }> {
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: NPM_TARBALL_MAX_BYTES * 8 });
  } catch (e) {
    throw new NpmPackageError(
      "fetch",
      `the tarball of ${spec} is not a gzip file: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const ex = extract();
  let found: Buffer | undefined;
  const done = (async () => {
    for await (const entry of ex) {
      const chunks: Buffer[] = [];
      for await (const c of entry) chunks.push(c as Buffer);
      if (found === undefined && entry.header.name === "package/package.json") {
        found = Buffer.concat(chunks);
      }
    }
  })();
  ex.end(tar);
  try {
    await done;
  } catch (e) {
    throw new NpmPackageError(
      "fetch",
      `the tarball of ${spec} is not a tar file: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (found === undefined) return {};
  try {
    return JSON.parse(found.toString("utf8")) as { name?: unknown; version?: unknown };
  } catch {
    return {};
  }
}
