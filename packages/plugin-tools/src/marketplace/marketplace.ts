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
  type PluginDescription,
  parseMarketplaceManifest,
  parsePluginManifest,
  pluginDescription,
  SDK_VERSION,
} from "@capybara-hq/plugin-sdk";
import type { Finding } from "../check/source.js";
import { discoverPlugins } from "../discover.js";
import { integrityOf } from "../integrity.js";
import { packPlugin } from "../pack/pack.js";
import { compareSemver, parseSemver } from "../release/semver.js";

export { MARKETPLACE_FILE } from "./file.js";

/** Options of {@link syncMarketplace}. */
export interface SyncMarketplaceOptions {
  /** The repository root (its plugins: `plugins/*`, or the root when it is a plugin). */
  root: string;
  /** The marketplace manifest (absolute). It must exist: its name and owner are the maintainers'. */
  file: string;
  /** Plugin directories relative to `root` (`*` within one segment); default as `discoverPlugins`. */
  plugins?: string;
  /** Write the plugins' entries into `file` (`--write`); otherwise only report them (`--check`). */
  write: boolean;
  /**
   * A git revision (`--check --base <rev>`, pull requests): the entries the file had there are
   * published. An entry of a version the base lists must keep its source and integrity
   * (`marketplace-integrity`); an entry of a version the base does not list must be newer than
   * every version the base lists for that plugin (`marketplace-version-decrease`) and, when it is
   * the tree's version, match the tree's pack (`marketplace-integrity`). A file the base does not
   * have constrains nothing.
   */
  base?: string;
}

/** The result of {@link syncMarketplace}. */
export interface SyncMarketplaceResult {
  /** New entries: plugins not listed at their current version (written with `write`). */
  added: MarketplaceEntry[];
  /** `name@version` of the other entries of the tree's plugins (dropped with `write`). */
  removed: string[];
  /**
   * `name@version` of listed entries whose `summary` / `displayName` differ from plugin.json
   * (rewritten with `write`; source and integrity never change).
   */
  refreshed: string[];
  /**
   * `marketplace-invalid` (the file does not parse, or would not after writing),
   * `marketplace-integrity` and `marketplace-version-decrease` (with a base, see
   * {@link SyncMarketplaceOptions.base}) and, without `write`, `marketplace-missing` (one per
   * plugin whose current version is not listed, or not as its only entry) and
   * `marketplace-display-stale` (a listed entry's summary / displayName differ from plugin.json).
   */
  findings: Finding[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The marketplace summary text: a description cut to the summary limit. */
function cut(text: string): string {
  const max = MARKETPLACE_LIMITS.summaryChars;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The marketplace summary of a plugin: its plugin.json description (`{ en, zh? }`), each cut. */
function summaryOf(description: PluginDescription): { en: string; zh?: string } {
  const d = pluginDescription(description);
  return { en: cut(d.en), ...(d.zh !== undefined && { zh: cut(d.zh) }) };
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

/** What `write` does to one plugin's entries: the entry it keeps or adds, and the versions it drops. */
interface PluginUpdate {
  name: string;
  version: string;
  /** The entry the plugin ends up with (an existing raw entry, or a new one). */
  entry: unknown;
  isNew: boolean;
  dropped: string[];
  /** The listed entry's summary / displayName differed from plugin.json and were rewritten. */
  refreshed: boolean;
}

/** The display fields an entry copies from plugin.json. */
interface Display {
  summary: { en: string; zh?: string };
  displayName?: { zh: string; en: string };
}

/** The display fields of a plugin's source plugin.json; undefined when it does not parse. */
function displayOf(json: unknown): Display | undefined {
  const m = parsePluginManifest(json);
  if ("errors" in m) return undefined;
  return {
    summary: summaryOf(m.description),
    ...(m.displayName !== undefined && { displayName: m.displayName }),
  };
}

/**
 * `raw` with its `summary` and `displayName` set to `d` (in place, `displayName` right after
 * `summary` when it is new, removed when plugin.json has none); undefined when they already equal.
 */
function refreshDisplay(raw: unknown, d: Display): Record<string, unknown> | undefined {
  if (!isObj(raw)) return undefined;
  if (
    canonical(raw.summary) === canonical(d.summary) &&
    canonical(raw.displayName) === canonical(d.displayName)
  ) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "displayName") continue;
    out[k] = k === "summary" ? d.summary : v;
    if (k === "summary" && d.displayName !== undefined) out.displayName = d.displayName;
  }
  if (!("summary" in raw)) {
    out.summary = d.summary;
    if (d.displayName !== undefined) out.displayName = d.displayName;
  }
  return out;
}

/**
 * `capybara-plugin marketplace`: keeps a plugin repository's `marketplace.json` listing one entry
 * per public plugin, its current version (plugin component management spec §13.2, replacing the
 * one-entry-per-version rule of the package ecosystem spec §5.2). Each public plugin (not
 * `"private": true`) not listed at its version is packed reproducibly with {@link packPlugin} and
 * gets an entry `{ name, version, summary, displayName?, homepage?, permissions, source: { npm: {
 * package, version, integrity } } }` (`summary` from the plugin.json `description`, a string being
 * `en`; `displayName` copied from plugin.json; `integrity` the pack's sha512, which the release
 * then publishes byte for byte; `permissions` display only). The new entry takes the place of the
 * plugin's first entry (a version that moved), the plugin's other entries are dropped (also those
 * of a file written in the older one-entry-per-version form), and a plugin not listed yet is
 * appended. Entries of plugins not in the tree are kept. A version already listed is not packed or
 * compared: once published, its bytes are the release gate's business (`release --marketplace`),
 * so a later source or toolchain change at the same version is not a finding; only its display
 * fields (`summary`, `displayName`) are refreshed from the source plugin.json. With `base`, see
 * {@link SyncMarketplaceOptions.base}. The file is written formatted as Biome formats it
 * ({@link formatMarketplaceJson}); nothing is written when there is any other finding.
 */
export async function syncMarketplace(
  opts: SyncMarketplaceOptions,
): Promise<SyncMarketplaceResult> {
  const findings: Finding[] = [];
  const at = (rule: string, message: string) =>
    findings.push({ file: opts.file, line: 1, rule, message });
  const none = (): SyncMarketplaceResult => ({ added: [], removed: [], refreshed: [], findings });
  if (!existsSync(opts.file)) {
    at(
      "marketplace-invalid",
      `${opts.file} does not exist: create it with schemaVersion, name, owner and "plugins": []`,
    );
    return none();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opts.file, "utf8"));
  } catch (e) {
    at("marketplace-invalid", `not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return none();
  }
  const parsed = parseMarketplaceManifest(raw);
  if ("errors" in parsed) {
    at("marketplace-invalid", parsed.errors.join("; "));
    return none();
  }

  // The parser keeps the order, so parsed.plugins[i] is rawEntries[i].
  const rawEntries = isObj(raw) && Array.isArray(raw.plugins) ? (raw.plugins as unknown[]) : [];
  /** `name@version` of the entries the base lists (undefined without a base). */
  let baseKeys: Set<string> | undefined;
  if (opts.base !== undefined) {
    const baseEntries = entriesAt(opts.root, opts.file, opts.base);
    findings.push(...publishedRules(baseEntries, rawEntries, opts.file));
    baseKeys = new Set(baseEntries.map(keyOfRaw));
  }

  const updates: PluginUpdate[] = [];
  const out = await mkdtemp(join(tmpdir(), "capybara-marketplace-"));
  try {
    for (const dir of discoverPlugins(opts.root, opts.plugins)) {
      const pkgFile = join(dir, "package.json");
      const manifestFile = join(dir, PLUGIN_MANIFEST_FILE);
      if (!existsSync(pkgFile) || !existsSync(manifestFile)) continue;
      const pkg = JSON.parse(await readFile(pkgFile, "utf8")) as Record<string, unknown>;
      if (pkg.private === true) continue;
      const source = JSON.parse(await readFile(manifestFile, "utf8")) as { name?: unknown };
      // (the display fields of a listed entry are refreshed from this source plugin.json)
      const name = String(source.name);
      const version = String(pkg.version);
      const mine = parsed.plugins.flatMap((e, i) => (e.name === name ? [{ e, i }] : []));
      const listed = mine.filter(({ e }) => versionOf(e) === version);
      const dropped = mine
        .filter(({ e }) => versionOf(e) !== version)
        .map(({ e }) => `${name}@${versionOf(e) ?? "(no version)"}`);
      // A version already listed is published (or about to be): its bytes are the release gate's
      // business, so a later source or toolchain change at the same version is not a finding here.
      // Only an entry added since the base is compared with the tree's pack.
      const toCompare = listed.filter(({ e }) => baseKeys !== undefined && !baseKeys.has(keyOf(e)));
      const kept = listed[0];
      /** Keeps the listed entry: drops the other versions, refreshes its display fields. */
      const keep = (raw: unknown) => {
        const display = displayOf(source);
        const fresh = display === undefined ? undefined : refreshDisplay(raw, display);
        if (dropped.length > 0 || fresh !== undefined) {
          const entry = fresh ?? raw;
          updates.push({ name, version, entry, isNew: false, dropped, refreshed: !!fresh });
        }
      };
      if (kept !== undefined && toCompare.length === 0) {
        keep(rawEntries[kept.i]);
        continue;
      }
      // Packed: the plugin is not listed at its version, or its entry is new since the base.
      const r = await packPlugin(dir, out);
      const bytes = new Uint8Array(await readFile(r.file));
      const npm = {
        package: String(pkg.name),
        version: r.manifest.version,
        integrity: integrityOf(bytes),
      };
      for (const { e } of toCompare) {
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
      if (kept !== undefined) {
        keep(rawEntries[kept.i]);
        continue;
      }
      const entry: MarketplaceEntry = {
        name: r.manifest.name,
        version: npm.version,
        summary: summaryOf(r.manifest.description),
        ...(r.manifest.displayName !== undefined && { displayName: r.manifest.displayName }),
        ...(r.manifest.homepage !== undefined && { homepage: r.manifest.homepage }),
        permissions: await permissionsOf(bytes, r.manifest.extension !== undefined),
        source: { npm },
      };
      updates.push({ name, version, entry, isNew: true, dropped, refreshed: false });
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }

  const added = updates.filter((u) => u.isNew).map((u) => u.entry as MarketplaceEntry);
  const removed = updates.flatMap((u) => u.dropped);
  const refreshed = updates.filter((u) => u.refreshed).map((u) => `${u.name}@${u.version}`);
  if (!opts.write) {
    for (const u of updates) {
      if (u.refreshed) {
        at(
          "marketplace-display-stale",
          `${u.name}@${u.version} has a summary or displayName other than its plugin.json's: ` +
            "run capybara-plugin marketplace --write",
        );
      }
      if (!u.isNew && u.dropped.length === 0) continue;
      const also = u.dropped.map((d) => d.slice(u.name.length + 1)).join(", ");
      at(
        "marketplace-missing",
        u.isNew
          ? `${u.name}@${u.version} is not listed${also === "" ? "" : ` (the marketplace lists ${also})`}: ` +
              "one entry per plugin, its current version; run capybara-plugin marketplace --write"
          : `${u.name}@${u.version} is not the plugin's only entry (also ${also}): ` +
              "one entry per plugin, its current version; run capybara-plugin marketplace --write",
      );
    }
    return { added, removed, refreshed, findings };
  }
  if (findings.length > 0 || updates.length === 0) return { added, removed, refreshed, findings };
  const byName = new Map(updates.map((u) => [u.name, u]));
  const placed = new Set<string>();
  const plugins: unknown[] = [];
  for (const e of rawEntries) {
    const name = isObj(e) ? String(e.name) : "";
    const u = byName.get(name);
    if (u === undefined) {
      plugins.push(e);
    } else if (!placed.has(name)) {
      placed.add(name);
      plugins.push(u.entry);
    }
  }
  for (const u of updates) if (!placed.has(u.name)) plugins.push(u.entry);
  const next = isObj(raw) ? { ...raw } : {};
  next.plugins = plugins;
  const check = parseMarketplaceManifest(next);
  if ("errors" in check) {
    at("marketplace-invalid", `the new entries do not parse: ${check.errors.join("; ")}`);
    return { added, removed, refreshed, findings };
  }
  await writeFile(opts.file, formatMarketplaceJson(next));
  return { added, removed, refreshed, findings };
}

/** `name@version` of a parsed entry (`?` without a version). */
const keyOf = (e: MarketplaceEntry) => `${e.name}@${versionOf(e) ?? "?"}`;

/** `name@version` of a raw entry (`?` for what is missing). */
function keyOfRaw(e: unknown): string {
  if (!isObj(e)) return "?@?";
  const npm = isObj(e.source) && isObj(e.source.npm) ? e.source.npm : {};
  return `${String(e.name ?? "?")}@${String(e.version ?? npm.version ?? "?")}`;
}

/** JSON with object keys sorted (deep equality regardless of key order). */
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

/** A raw entry's version when it is a plain semver (else undefined: not ordered). */
function semverOfRaw(e: unknown): string | undefined {
  const v = keyOfRaw(e).split("@").pop();
  return v !== undefined && parseSemver(v) !== undefined ? v : undefined;
}

/**
 * The rules on the entries published at the base: `marketplace-integrity`, a version the base
 * lists keeps its source (package and integrity); `marketplace-version-decrease`, a version the
 * base does not list must be newer than every version the base lists for that plugin, and a
 * plugin's newest listed version may not be older than the newest the base lists. Display
 * fields (summary, displayName, permissions, homepage) may change, entries may move, and a
 * plugin's older versions may go (one entry per plugin).
 */
function publishedRules(base: unknown[], current: unknown[], file: string): Finding[] {
  const out: Finding[] = [];
  const finding = (rule: string, message: string) => out.push({ file, line: 1, rule, message });
  const baseByKey = new Map(base.map((b) => [keyOfRaw(b), b] as const));
  const newest = new Map<string, string>();
  for (const b of base) {
    const v = semverOfRaw(b);
    const name = isObj(b) ? String(b.name) : "?";
    const top = newest.get(name);
    if (v !== undefined && (top === undefined || compareSemver(v, top) > 0)) newest.set(name, v);
  }
  /** `name@version` of the entries reported as `marketplace-version-decrease`. */
  const decreased = new Set<string>();
  for (const c of current) {
    const key = keyOfRaw(c);
    const b = baseByKey.get(key);
    const src = (e: unknown) => (isObj(e) ? e.source : undefined);
    if (b !== undefined) {
      if (canonical(src(c)) !== canonical(src(b))) {
        finding(
          "marketplace-integrity",
          `${key} is published at the base with the source ${canonical(src(b))}, now ` +
            `${canonical(src(c))}: a published version keeps its integrity (bump the version instead)`,
        );
      }
      continue;
    }
    const v = semverOfRaw(c);
    const top = newest.get(isObj(c) ? String(c.name) : "?");
    if (v !== undefined && top !== undefined && compareSemver(v, top) < 0) decreased.add(key);
  }
  // A plugin's newest listed version may not fall below the newest the base lists, also when it
  // moves back to an older version the base lists too (a base in the older form).
  const newestNow = new Map<string, string>();
  for (const c of current) {
    const v = semverOfRaw(c);
    const name = isObj(c) ? String(c.name) : "?";
    const top = newestNow.get(name);
    if (v !== undefined && (top === undefined || compareSemver(v, top) > 0)) newestNow.set(name, v);
  }
  for (const [name, v] of newestNow) {
    const top = newest.get(name);
    if (top !== undefined && compareSemver(v, top) < 0) decreased.add(`${name}@${v}`);
  }
  for (const key of decreased) {
    const name = key.slice(0, key.lastIndexOf("@"));
    finding(
      "marketplace-version-decrease",
      `${key} is older than ${newest.get(name)}, which the base lists: an entry's version may only increase`,
    );
  }
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
