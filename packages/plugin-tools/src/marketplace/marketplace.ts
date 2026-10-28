import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSensitivePermissionKey,
  PACKAGES_MAX_BYTES_DEFAULT,
  permissionKeys,
  permissionSetOfPackage,
  readExtensionPackage,
  WARNINGS_KEY_PREFIX,
} from "@capybara-hq/kernel";
import {
  MARKETPLACE_LIMITS,
  type MarketplaceEntry,
  parseMarketplaceManifest,
  SDK_VERSION,
} from "@capybara-hq/plugin-sdk";
import type { Finding } from "../check/source.js";
import { discoverPlugins } from "../discover.js";
import { integrityOf } from "../integrity.js";
import { packPlugin } from "../pack/pack.js";

/** Where a plugin repository keeps its marketplace manifest (relative to the root). */
export const MARKETPLACE_FILE = ".capybara-plugin/marketplace.json";

/** Options of {@link syncMarketplace}. */
export interface SyncMarketplaceOptions {
  /** The repository root (its plugins: `plugins/*`, or the root when it is a plugin). */
  root: string;
  /** The marketplace manifest (absolute). It must exist: its name and owner are the maintainers'. */
  file: string;
  /** Plugin directories relative to `root` (`*` within one segment); default as `discoverPlugins`. */
  plugins?: string;
  /** Append the missing entries to `file` (`--write`); otherwise only report them (`--check`). */
  write: boolean;
}

/** The result of {@link syncMarketplace}. */
export interface SyncMarketplaceResult {
  /** Entries for `(name, version)` pairs the file does not list yet (appended with `write`). */
  added: MarketplaceEntry[];
  /**
   * `marketplace-invalid` (the file does not parse, or would not after appending),
   * `marketplace-integrity` (a listed entry of a version in the tree names another package or
   * integrity than its pack) and, without `write`, `marketplace-missing` (one per added entry).
   */
  findings: Finding[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The marketplace summary of a plugin: its plugin.json description, cut to the summary limit. */
function summaryOf(description: string): string {
  const max = MARKETPLACE_LIMITS.summaryChars;
  return description.length <= max ? description : `${description.slice(0, max - 1)}…`;
}

/** The permission summary of a packed plugin, as the kernel computes it at import (display only). */
async function permissionsOf(
  bytes: Uint8Array,
  hasExtension: boolean,
): Promise<{ keys: string[]; sensitive: string[] }> {
  if (!hasExtension) return { keys: [], sensitive: [] };
  const ext = await readExtensionPackage(bytes, {
    maxBytes: PACKAGES_MAX_BYTES_DEFAULT,
    hostSdkVersion: SDK_VERSION,
  });
  const keys = permissionKeys(permissionSetOfPackage(ext))
    .filter((k) => !k.startsWith(WARNINGS_KEY_PREFIX))
    .sort();
  return { keys, sensitive: keys.filter(isSensitivePermissionKey) };
}

/** An entry's version: `version`, else its npm source's. */
const versionOf = (e: MarketplaceEntry): string | undefined =>
  e.version ?? ("npm" in e.source ? e.source.npm.version : undefined);

/**
 * `capybara-plugin marketplace`: keeps a plugin repository's `marketplace.json` listing every
 * published version of its public plugins (package ecosystem spec §5.2; one entry per
 * `(name, version)`, Decision 7 of phase A3b). Each public plugin (not `"private": true`) is packed
 * reproducibly with {@link packPlugin}; when the file has no entry for its name and version, an
 * entry `{ name, version, summary, homepage?, permissions, source: { npm: { package, version,
 * integrity } } }` is added (`integrity` the pack's sha512, which the release then publishes
 * byte for byte; `permissions` display only). A listed entry for a version in the tree must name the
 * same npm package and integrity: an existing entry is never edited. Entries of versions no longer in
 * the tree are kept, so a pinned commit lists what it pins and older versions stay importable.
 * With `write`, the new entries are appended in plugin order (nothing is written when there is any
 * other finding).
 */
export async function syncMarketplace(
  opts: SyncMarketplaceOptions,
): Promise<SyncMarketplaceResult> {
  const findings: Finding[] = [];
  const at = (rule: string, message: string) =>
    findings.push({ file: opts.file, line: 1, rule, message });
  if (!existsSync(opts.file)) {
    at(
      "marketplace-invalid",
      `${opts.file} does not exist: create it with schemaVersion, name, owner and "plugins": []`,
    );
    return { added: [], findings };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opts.file, "utf8"));
  } catch (e) {
    at("marketplace-invalid", `not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return { added: [], findings };
  }
  const parsed = parseMarketplaceManifest(raw);
  if ("errors" in parsed) {
    at("marketplace-invalid", parsed.errors.join("; "));
    return { added: [], findings };
  }

  const added: MarketplaceEntry[] = [];
  const out = await mkdtemp(join(tmpdir(), "capybara-marketplace-"));
  try {
    for (const dir of discoverPlugins(opts.root, opts.plugins)) {
      const pkgFile = join(dir, "package.json");
      if (!existsSync(pkgFile)) continue;
      const pkg = JSON.parse(await readFile(pkgFile, "utf8")) as Record<string, unknown>;
      if (pkg.private === true) continue;
      const r = await packPlugin(dir, out);
      const bytes = new Uint8Array(await readFile(r.file));
      const integrity = integrityOf(bytes);
      const npm = { package: String(pkg.name), version: r.manifest.version, integrity };
      const listed = parsed.plugins.filter(
        (e) => e.name === r.manifest.name && versionOf(e) === npm.version,
      );
      if (listed.length > 0) {
        for (const e of listed) {
          const src = "npm" in e.source ? e.source.npm : undefined;
          if (src?.package !== npm.package || src.integrity !== npm.integrity) {
            const was =
              src === undefined
                ? `a ${Object.keys(e.source)[0]} source`
                : `npm ${src.package} with integrity ${src.integrity}`;
            at(
              "marketplace-integrity",
              `${r.manifest.name}@${npm.version} is listed as ${was}, but ${dir} packs npm ` +
                `${npm.package} with integrity ${npm.integrity}: a published entry never changes, ` +
                "so bump the plugin's version instead",
            );
          }
        }
        continue;
      }
      const entry: MarketplaceEntry = {
        name: r.manifest.name,
        version: npm.version,
        summary: { en: summaryOf(r.manifest.description) },
        ...(r.manifest.homepage !== undefined && { homepage: r.manifest.homepage }),
        permissions: await permissionsOf(bytes, r.manifest.extension !== undefined),
        source: { npm },
      };
      added.push(entry);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }

  if (!opts.write) {
    for (const e of added) {
      at(
        "marketplace-missing",
        `${e.name}@${e.version} is not listed: run capybara-plugin marketplace --write`,
      );
    }
    return { added, findings };
  }
  if (findings.length > 0 || added.length === 0) return { added, findings };
  const next = isObj(raw) ? { ...raw } : {};
  next.plugins = [...(Array.isArray(next.plugins) ? next.plugins : []), ...added];
  const check = parseMarketplaceManifest(next);
  if ("errors" in check) {
    at("marketplace-invalid", `the new entries do not parse: ${check.errors.join("; ")}`);
    return { added, findings };
  }
  await writeFile(opts.file, `${JSON.stringify(next, null, 2)}\n`);
  return { added, findings };
}
