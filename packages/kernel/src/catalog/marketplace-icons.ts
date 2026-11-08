import { createHash } from "node:crypto";
import {
  MARKETPLACE_ICON_RE,
  MARKETPLACE_LIMITS,
  type MarketplaceEntry,
  marketplaceEntryIcon,
  PLUGIN_MANIFEST_FILE,
} from "@capybara-hq/plugin-sdk";
import { type LookupFn, NetDeniedError, type NetPolicy } from "../net/public-address.js";
import { safeFetch } from "../net/safe-fetch.js";
import { packagePath } from "../packages/tgz.js";
import { marketplaceUrlProblem } from "./marketplace-fetch.js";
import { iconProblem } from "./plugin-package.js";

/**
 * Marketplace entry icons (maintainer decision 2026-11-08; plugin component management spec §16):
 * the icon a marketplace entry names for its plugin before it is imported. An entry's `icon` is an
 * https URL or a path in a git marketplace's repository (SDK `MarketplaceEntry.icon`). The refresh
 * reads each one (a URL through `net/safeFetch` under the marketplace network rules and
 * `marketplaces.allowedHosts`, never with the marketplace token; a path from the commit it fetched
 * anyway), keeps those that really are an svg / png of at most 64 KiB in `marketplace_icons`, and
 * the admin market list serves them like plugin icons (`sendCatalogIcon`). A failed or invalid
 * icon is only logged: the entry has no icon and the list shows its initial.
 */

/** The timeout of one icon download. */
export const MARKETPLACE_ICON_TIMEOUT_MS = 10_000;
/** At most this many icon URLs are downloaded per refresh (the rest wait for the next one). */
export const MARKETPLACE_ICON_FETCHES_MAX = 100;
/** How long after a failed download an icon URL is tried again (by a later refresh). */
export const MARKETPLACE_ICON_RETRY_MS = 6 * 3600_000;
/** Parallel icon downloads of one refresh. */
export const MARKETPLACE_ICON_CONCURRENCY = 4;
/** The largest icon (the plugin icon limit). */
export const MARKETPLACE_ICON_MAX_BYTES = MARKETPLACE_LIMITS.iconBytes;

/** A stored icon: its content type and sha256 (the address the admin route serves it at). */
export interface CheckedIcon {
  contentType: "image/svg+xml" | "image/png";
  sha256: string;
  data: Uint8Array;
}

/**
 * Whether `data` is an icon the kernel serves, by the extension of `name` (a URL's path or a
 * repository path) and its content, like a plugin icon ({@link iconProblem}): the checked icon, or
 * the problem (English).
 */
export function checkMarketplaceIcon(name: string, data: Uint8Array): CheckedIcon | string {
  if (!MARKETPLACE_ICON_RE.test(name)) return `${name} is not a .svg or .png file`;
  const problem = iconProblem(name, data);
  if (problem !== undefined) return problem;
  return {
    contentType: /\.svg$/i.test(name) ? "image/svg+xml" : "image/png",
    sha256: createHash("sha256").update(data).digest("hex"),
    data,
  };
}

/**
 * Downloads one icon URL under the marketplace network rules (https, public addresses or
 * `allowPrivateHosts`, `net.httpsProxy`, no redirects, {@link MARKETPLACE_ICON_TIMEOUT_MS}, at
 * most {@link MARKETPLACE_ICON_MAX_BYTES}) and checks it: the icon, or why it was not kept. Never
 * throws (an abort of `signal` is a problem too).
 */
export async function fetchMarketplaceIcon(
  url: string,
  o: { net: NetPolicy; signal: AbortSignal; lookup?: LookupFn },
): Promise<CheckedIcon | string> {
  const problem = marketplaceUrlProblem(url, o.net.allowInsecureLoopback);
  if (problem !== null) return `invalid icon URL: ${problem}`;
  const target = new URL(url);
  const signal = AbortSignal.any([o.signal, AbortSignal.timeout(MARKETPLACE_ICON_TIMEOUT_MS)]);
  try {
    const res = await safeFetch(target.href, { signal }, o.net, {
      maxBytes: MARKETPLACE_ICON_MAX_BYTES,
      ...(o.lookup !== undefined && { lookup: o.lookup }),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return `the icon URL responded with HTTP ${res.status}`;
    }
    const data = new Uint8Array(await res.arrayBuffer());
    return checkMarketplaceIcon(target.pathname, data);
  } catch (e) {
    if (e instanceof NetDeniedError) return `icon download refused: ${e.message}`;
    return `cannot fetch the icon: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * The repository paths (relative to the root, without `./`) of the icons a git marketplace's
 * manifest names, read leniently (the manifest is validated afterwards); for a single-plugin repo
 * (no manifest) the root `plugin.json`'s icon. At most `max` paths.
 */
export function gitIconPaths(
  files: Map<string, Uint8Array>,
  manifestPath: string,
  maxIndexBytes: number,
  max: number,
): string[] {
  const json = (raw: Uint8Array | undefined): unknown => {
    if (raw === undefined || raw.byteLength > maxIndexBytes) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return undefined;
    }
  };
  const paths = new Set<string>();
  const manifest = json(files.get(manifestPath)) as { plugins?: unknown } | undefined;
  if (files.has(manifestPath)) {
    if (!Array.isArray(manifest?.plugins)) return [];
    for (const p of manifest.plugins) {
      const icon = (p as { icon?: unknown } | null)?.icon;
      if (typeof icon === "string" && icon.startsWith("./") && MARKETPLACE_ICON_RE.test(icon)) {
        paths.add(icon.slice(2));
      }
      if (paths.size >= max) break;
    }
    return [...paths];
  }
  const icon = (json(files.get(PLUGIN_MANIFEST_FILE)) as { icon?: unknown } | undefined)?.icon;
  return typeof icon === "string" && MARKETPLACE_ICON_RE.test(icon) ? [packagePath(icon)] : [];
}

/**
 * The icons a refresh has to have for `entries` of a marketplace of `form`, as the entries write
 * them (the stored `ref`): repository paths `./…` (git marketplaces only; an http marketplace has
 * no repository) and URLs, each once.
 */
export function wantedIcons(
  entries: Pick<MarketplaceEntry, "icon">[],
  form: "http" | "git",
): { paths: Set<string>; urls: Set<string> } {
  const paths = new Set<string>();
  const urls = new Set<string>();
  for (const e of entries) {
    const icon = marketplaceEntryIcon(e);
    if (icon === null) continue;
    if ("url" in icon) urls.add(icon.url);
    else if (form === "git") paths.add(`./${icon.path}`);
  }
  return { paths, urls };
}

/** The admin route of a stored icon (content addressed: the URL changes with the bytes). */
export const marketplaceIconUrl = (sourceId: string, sha256: string): string =>
  `/api/v1/admin/marketplaces/${encodeURIComponent(sourceId)}/icons/${sha256}`;

/** The org browse route of a stored icon (org admins of `orgId`, like the org browse). */
export const orgMarketplaceIconUrl =
  (orgId: string) =>
  (sourceId: string, sha256: string): string =>
    `/api/v1/orgs/${encodeURIComponent(orgId)}/marketplaces/${encodeURIComponent(sourceId)}/icons/${sha256}`;
