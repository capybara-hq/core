import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
  PLUGIN_MANIFEST_FILE,
  parseMarketplaceManifest,
  SDK_VERSION,
} from "@capybara-hq/plugin-sdk";
import type { Finding } from "../check/source.js";
import { discoverPlugins } from "../discover.js";
import { integrityOf } from "../integrity.js";
import { packPlugin } from "../pack/pack.js";

export { MARKETPLACE_FILE } from "./file.js";

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
  /**
   * A git revision (`--check --base <rev>`, pull requests): the entries the file had there are
   * published and must still be there, unchanged and in the same order (only appending is
   * allowed; `marketplace-append-only`), and every entry added since must match the tree's pack
   * (`marketplace-integrity`). A file the base does not have constrains nothing.
   */
  base?: string;
}

/** The result of {@link syncMarketplace}. */
export interface SyncMarketplaceResult {
  /** Entries for `(name, version)` pairs the file does not list yet (appended with `write`). */
  added: MarketplaceEntry[];
  /**
   * `marketplace-invalid` (the file does not parse, or would not after appending),
   * `marketplace-integrity` (with a base: an entry added since names another package or integrity
   * than the tree's pack), `marketplace-append-only` (with a base: a published entry changed, moved
   * or went away) and, without `write`, `marketplace-missing` (one per added entry).
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
 * byte for byte; `permissions` display only). A version already listed is not packed or compared:
 * once published, its bytes are the release gate's business (`release --marketplace`), so a later
 * source or toolchain change at the same version is not a finding. With `base`, published entries
 * must be unchanged and first in order, and entries added since must match the tree's packs.
 * Entries of versions no longer in the tree are kept, so a pinned commit lists what it pins and
 * older versions stay importable. The file is written formatted as Biome formats it
 * ({@link formatMarketplaceJson}).
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

  const rawEntries = isObj(raw) && Array.isArray(raw.plugins) ? (raw.plugins as unknown[]) : [];
  /** `name@version` of the entries added since `opts.base` (all of them without a base). */
  let addedSinceBase: Set<string> | undefined;
  if (opts.base !== undefined) {
    const baseEntries = entriesAt(opts.root, opts.file, opts.base);
    findings.push(...appendOnly(baseEntries, rawEntries, opts.file));
    addedSinceBase = new Set(rawEntries.slice(baseEntries.length).map((e) => keyOfRaw(e)));
  }

  const added: MarketplaceEntry[] = [];
  const out = await mkdtemp(join(tmpdir(), "capybara-marketplace-"));
  try {
    for (const dir of discoverPlugins(opts.root, opts.plugins)) {
      const pkgFile = join(dir, "package.json");
      const manifestFile = join(dir, PLUGIN_MANIFEST_FILE);
      if (!existsSync(pkgFile) || !existsSync(manifestFile)) continue;
      const pkg = JSON.parse(await readFile(pkgFile, "utf8")) as Record<string, unknown>;
      if (pkg.private === true) continue;
      const source = JSON.parse(await readFile(manifestFile, "utf8")) as { name?: unknown };
      const name = String(source.name);
      const version = String(pkg.version);
      const listed = parsed.plugins.filter((e) => e.name === name && versionOf(e) === version);
      // A version already listed is published (or about to be): its bytes are the release gate's
      // business, so a later source or toolchain change at the same version is not a finding here.
      // Only an entry added since the base is compared with the tree's pack.
      const toCompare = listed.filter((e) => addedSinceBase?.has(`${e.name}@${versionOf(e)}`));
      if (listed.length > 0 && toCompare.length === 0) continue;
      const r = await packPlugin(dir, out);
      const bytes = new Uint8Array(await readFile(r.file));
      const npm = {
        package: String(pkg.name),
        version: r.manifest.version,
        integrity: integrityOf(bytes),
      };
      for (const e of toCompare) {
        const src = "npm" in e.source ? e.source.npm : undefined;
        if (src?.package !== npm.package || src.integrity !== npm.integrity) {
          const was =
            src === undefined
              ? `a ${Object.keys(e.source)[0]} source`
              : `npm ${src.package} with integrity ${src.integrity}`;
          at(
            "marketplace-integrity",
            `${name}@${npm.version} is added as ${was}, but ${dir} packs npm ${npm.package} ` +
              `with integrity ${npm.integrity}: run capybara-plugin marketplace --write`,
          );
        }
      }
      if (listed.length > 0) continue;
      added.push({
        name: r.manifest.name,
        version: npm.version,
        summary: { en: summaryOf(r.manifest.description) },
        ...(r.manifest.homepage !== undefined && { homepage: r.manifest.homepage }),
        permissions: await permissionsOf(bytes, r.manifest.extension !== undefined),
        source: { npm },
      });
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
  await writeFile(opts.file, formatMarketplaceJson(next));
  return { added, findings };
}

/** `name@version` of a raw entry (`?` for what is missing). */
function keyOfRaw(e: unknown): string {
  if (!isObj(e)) return "?@?";
  const npm = isObj(e.source) && isObj(e.source.npm) ? e.source.npm : {};
  return `${String(e.name ?? "?")}@${String(e.version ?? npm.version ?? "?")}`;
}

/** JSON with object keys sorted (deep equality of entries regardless of key order). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The raw `plugins` of the marketplace file at git revision `base` (`[]` when it has no file). */
function entriesAt(root: string, file: string, base: string): unknown[] {
  let text: string;
  try {
    text = execFileSync(
      "git",
      ["show", `${base}:./${relative(root, file).split("\\").join("/")}`],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "");
    if (/does not exist|exists on disk, but not in/.test(stderr)) return [];
    throw new Error(`cannot read ${file} at ${base}: ${stderr.trim() || String(e)}`);
  }
  const raw = JSON.parse(text) as unknown;
  return isObj(raw) && Array.isArray(raw.plugins) ? raw.plugins : [];
}

/**
 * `marketplace-append-only`: the base's entries are published, so the current list must start with
 * exactly them, in the same order (an entry is never edited, removed or moved; new ones go last).
 */
function appendOnly(base: unknown[], current: unknown[], file: string): Finding[] {
  const out: Finding[] = [];
  base.forEach((b, i) => {
    const c = current[i];
    if (c !== undefined && canonical(c) === canonical(b)) return;
    const key = keyOfRaw(b);
    const moved = current.some((x) => canonical(x) === canonical(b));
    out.push({
      file,
      line: 1,
      rule: "marketplace-append-only",
      message: `${key} is published at the base and ${
        moved ? "moved" : c !== undefined && keyOfRaw(c) === key ? "was edited" : "went away"
      }: published entries never change and new ones are appended at the end`,
    });
  });
  return out;
}

const INDENT = "  ";
/** The formatter's line width (Biome, as the Capybara repositories configure it). */
const LINE_WIDTH = 100;

const isScalar = (v: unknown) => v === null || typeof v !== "object";

/**
 * `marketplace.json` as Biome formats it with a 2-space indent and a 100-column line width: a
 * non-empty object puts each member on its own line; an array of scalars stays on one line when
 * it fits (the trailing comma counted), otherwise one item per line; empty ones are `[]` / `{}`.
 */
export function formatMarketplaceJson(value: unknown): string {
  const render = (v: unknown, depth: number, lead: number, tail: number): string => {
    const pad = INDENT.repeat(depth + 1);
    const close = INDENT.repeat(depth);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      if (v.every(isScalar)) {
        const flat = `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
        if (lead + flat.length + tail <= LINE_WIDTH) return flat;
      }
      const items = v.map(
        (x, i) => `${pad}${render(x, depth + 1, pad.length, i < v.length - 1 ? 1 : 0)}`,
      );
      return `[\n${items.join(",\n")}\n${close}]`;
    }
    if (isObj(v)) {
      const keys = Object.keys(v);
      if (keys.length === 0) return "{}";
      const items = keys.map((k, i) => {
        const head = `${pad}${JSON.stringify(k)}: `;
        return `${head}${render(v[k], depth + 1, head.length, i < keys.length - 1 ? 1 : 0)}`;
      });
      return `{\n${items.join(",\n")}\n${close}}`;
    }
    return JSON.stringify(v);
  };
  return `${render(value, 0, 0, 0)}\n`;
}
