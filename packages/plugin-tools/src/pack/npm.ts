import { integrityOf } from "../integrity.js";

/** The npm registry the kernel uses by default (`packages.npmRegistry`). */
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** Per request (packument or tarball). */
const NPM_TIMEOUT_MS = 120_000;

/** Why {@link fetchNpmTarball} or {@link downloadPinnedNpmPackage} failed. */
export type NpmPackageErrorKind =
  /** The package or that version is not on the registry. */
  | "unpublished"
  /** The registry's metadata or bytes do not match the pinned sha512. */
  | "integrity"
  /** Network error, HTTP status, or a packument that cannot be read. */
  | "fetch";

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

async function get(url: string, what: string): Promise<Response> {
  try {
    return await fetch(url, {
      headers: { accept: "application/json, application/octet-stream" },
      signal: AbortSignal.timeout(NPM_TIMEOUT_MS),
    });
  } catch (e) {
    throw new NpmPackageError(
      "fetch",
      `cannot fetch ${what} (${url}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * `<pkg>@<version>` from an npm registry: its tarball bytes and the packument's `dist.integrity`
 * (whatever the registry claims; callers compare it with their pin). Throws
 * {@link NpmPackageError}: `unpublished` (404 or no such version), `fetch` (anything else).
 */
export async function fetchNpmTarball(
  pkg: string,
  version: string,
  registry: string = DEFAULT_NPM_REGISTRY,
): Promise<{ bytes: Uint8Array; distIntegrity: string | undefined; tarball: string }> {
  const spec = `${pkg}@${version}`;
  const url = packumentUrl(registry, pkg);
  const res = await get(url, `the packument of ${pkg}`);
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
  const t = await get(tarball, `the tarball of ${spec}`);
  if (!t.ok) {
    throw new NpmPackageError(
      t.status === 404 ? "unpublished" : "fetch",
      `${tarball} answered ${t.status} for the tarball of ${spec}`,
    );
  }
  const bytes = new Uint8Array(await t.arrayBuffer());
  return {
    bytes,
    distIntegrity: typeof dist.integrity === "string" ? dist.integrity : undefined,
    tarball,
  };
}

/**
 * Downloads `<pkg>@<version>` and checks its bytes against the pinned sha512 `integrity`; returns the
 * bytes only when they match (a tampered tarball, or a registry serving other bytes than the pin,
 * throws {@link NpmPackageError} `integrity`). The registry's own `dist.integrity` plays no part:
 * only the bytes are judged.
 */
export async function downloadPinnedNpmPackage(
  pin: { npm: string; version: string; integrity: string },
  registry: string = DEFAULT_NPM_REGISTRY,
): Promise<Uint8Array> {
  const r = await fetchNpmTarball(pin.npm, pin.version, registry);
  const actual = integrityOf(r.bytes);
  if (actual !== pin.integrity) {
    throw new NpmPackageError(
      "integrity",
      `${pin.npm}@${pin.version} from ${r.tarball} has sha512 ${actual}, not the pinned ${pin.integrity}`,
    );
  }
  return r.bytes;
}
