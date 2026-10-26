import {
  CATALOG_ITEM_NAME_RE,
  isSafePackagePath,
  type MarketplaceEntry,
  type MarketplaceManifest,
  type MarketplaceSource,
  parseMarketplaceManifest,
  SEMVER_VERSION_RE,
} from "@capybara-hq/plugin-sdk";
import { expandGitUrl } from "../git-source.js";
import {
  CLAUDE_COMPONENT_KEYS,
  type ClaudeEntryOverlay,
  cut,
  isObj,
  showName,
} from "./manifest.js";

export { CLAUDE_PLUGIN_FILE } from "./manifest.js";

/**
 * Claude Code's `.claude-plugin/marketplace.json` (spec §5.1, Appendix A; re-checked against the
 * Claude Code marketplace reference on 2026-10-26) read as a Capybara marketplace: each entry
 * becomes a {@link MarketplaceEntry} with a Capybara source, and its component fields and `strict`
 * flag go to a {@link ClaudeEntryOverlay} that the import applies. Claude validates each entry on
 * its own, so an entry Capybara cannot store is skipped with a reason, never fails the marketplace.
 */

/** Claude Code's marketplace manifest in a git repository. */
export const CLAUDE_MARKETPLACE_FILE = ".claude-plugin/marketplace.json";

/** Why an entry of a marketplace could not be stored (shown on the marketplace). */
export type MarketplaceSkipReason =
  | "claude_npm_unpinned"
  | "claude_source_unsupported"
  | "invalid_name"
  | "invalid_entry";

/** Result of {@link parseClaudeMarketplace}. */
export interface ClaudeMarketplace {
  manifest: MarketplaceManifest;
  /** Entry name -> overlay. */
  overlays: Map<string, ClaudeEntryOverlay>;
  skipped: { name: string; reason: MarketplaceSkipReason }[];
}

const SHA_RE = /^[0-9a-f]{40}$/;
const HTTPS_RE = /^https:\/\/\S+$/;
const LOOPBACK_RE =
  /^http:\/\/(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(?::\d{1,5})?(?:\/\S*)?$/;
const SUMMARY_MAX = 280;

type Mapped = { source: MarketplaceSource } | { skip: MarketplaceSkipReason };

/** `./a/b/`, `a/b` -> `a/b`; `.`, `./` -> `.`; null when it leaves the repository. */
function repoRelative(p: string): string | null {
  const rest = p.replace(/^\.\//, "").replace(/\/+$/, "");
  if (rest === "" || rest === ".") return ".";
  return isSafePackagePath(rest) ? rest : null;
}

function mapSource(raw: unknown, pluginRoot: string | null, loopback: boolean): Mapped {
  if (typeof raw === "string") {
    // A bare name resolves under metadata.pluginRoot; anything else needs "./" (or is ".").
    const bare = raw !== "." && !raw.startsWith("./") && !raw.includes("/");
    if (bare && pluginRoot === null) return { skip: "invalid_entry" };
    if (!bare && raw !== "." && !raw.startsWith("./")) return { skip: "invalid_entry" };
    const rel = repoRelative(bare ? `${pluginRoot}/${raw}` : raw);
    if (rel === null) return { skip: "invalid_entry" };
    return { source: { path: rel === "." ? "." : `./${rel}` } };
  }
  if (!isObj(raw) || typeof raw.source !== "string") return { skip: "invalid_entry" };
  const okUrl = (u: string) => HTTPS_RE.test(u) || (loopback && LOOPBACK_RE.test(u));
  const pin = (): { ref?: string; commit?: string } | null => {
    const out: { ref?: string; commit?: string } = {};
    if (raw.ref !== undefined) {
      if (typeof raw.ref !== "string" || raw.ref === "" || raw.ref.length > 256) return null;
      out.ref = raw.ref;
    }
    if (raw.sha !== undefined) {
      if (typeof raw.sha !== "string" || !SHA_RE.test(raw.sha)) return null;
      out.commit = raw.sha;
    }
    return out;
  };
  switch (raw.source) {
    case "github": {
      if (typeof raw.repo !== "string") return { skip: "invalid_entry" };
      const url = expandGitUrl(raw.repo);
      const p = pin();
      if (url === raw.repo || p === null) return { skip: "invalid_entry" };
      return { source: { git: { url, ...p } } };
    }
    case "url":
    case "git-subdir": {
      if (typeof raw.url !== "string" || raw.url === "") return { skip: "invalid_entry" };
      const url = raw.source === "git-subdir" ? expandGitUrl(raw.url) : raw.url;
      if (!okUrl(url)) return { skip: "claude_source_unsupported" };
      const p = pin();
      if (p === null) return { skip: "invalid_entry" };
      if (raw.source === "url") return { source: { git: { url, ...p } } };
      if (typeof raw.path !== "string") return { skip: "invalid_entry" };
      const path = repoRelative(raw.path);
      if (path === null) return { skip: "invalid_entry" };
      return { source: { git: { url, path, ...p } } };
    }
    case "npm":
      return { skip: "claude_npm_unpinned" };
    default:
      // archive (a zip; Capybara reads tgz archives only), command, and anything newer
      return { skip: "claude_source_unsupported" };
  }
}

/**
 * Parses a Claude Code `marketplace.json` value. A top level that is not an object, or has no
 * `name` or `plugins` array, is `{ errors }`; each entry that cannot be stored is in `skipped`.
 * The produced manifest passes `parseMarketplaceManifest` (a root path entry is `{ path: "." }`,
 * as for a single-plugin repository).
 */
export function parseClaudeMarketplace(
  json: unknown,
  o: { allowInsecureLoopback: boolean },
): ClaudeMarketplace | { errors: string[] } {
  if (!isObj(json)) return { errors: ["marketplace.json must be a JSON object"] };
  const errors: string[] = [];
  const name = typeof json.name === "string" ? cut(json.name, 100) : "";
  if (name === "") errors.push("name is required");
  if (!Array.isArray(json.plugins)) errors.push("plugins must be an array");
  if (errors.length > 0) return { errors };
  const metadata = isObj(json.metadata) ? json.metadata : {};
  const rootRaw = typeof metadata.pluginRoot === "string" ? metadata.pluginRoot : null;
  const pluginRoot = rootRaw === null ? null : repoRelative(rootRaw);
  const ownerName =
    isObj(json.owner) && typeof json.owner.name === "string"
      ? cut(json.owner.name, 100) || undefined
      : undefined;
  const descRaw = typeof json.description === "string" ? json.description : metadata.description;
  const description = typeof descRaw === "string" ? cut(descRaw, 1024) : "";

  const plugins: MarketplaceEntry[] = [];
  const overlays = new Map<string, ClaudeEntryOverlay>();
  const skipped: ClaudeMarketplace["skipped"] = [];
  (json.plugins as unknown[]).slice(0, 5000).forEach((raw, i) => {
    if (!isObj(raw) || typeof raw.name !== "string" || raw.name === "") {
      skipped.push({ name: `plugins[${i}]`, reason: "invalid_entry" });
      return;
    }
    const en = raw.name;
    if (!CATALOG_ITEM_NAME_RE.test(en)) {
      skipped.push({ name: showName(en), reason: "invalid_name" });
      return;
    }
    if (overlays.has(en)) {
      skipped.push({ name: en, reason: "invalid_entry" });
      return;
    }
    const mapped = mapSource(raw.source, pluginRoot, o.allowInsecureLoopback);
    if ("skip" in mapped) {
      skipped.push({ name: en, reason: mapped.skip });
      return;
    }
    const summary =
      typeof raw.description === "string" && cut(raw.description, SUMMARY_MAX) !== ""
        ? cut(raw.description, SUMMARY_MAX)
        : `Claude Code plugin ${en}`;
    const entry: MarketplaceEntry = {
      name: en,
      summary: { en: summary },
      ...(typeof raw.version === "string" &&
        SEMVER_VERSION_RE.test(raw.version) &&
        raw.version.length <= 256 && { version: raw.version }),
      ...(typeof raw.homepage === "string" &&
        HTTPS_RE.test(raw.homepage) &&
        raw.homepage.length <= 2000 && { homepage: raw.homepage }),
      source: mapped.source,
    };
    // Each entry is checked on its own (a root path stands in as "./x": the SDK has no root form).
    const probe = parseMarketplaceManifest(
      {
        schemaVersion: 1,
        name: "probe",
        plugins: [
          "path" in entry.source && entry.source.path === "."
            ? { ...entry, source: { path: "./x" } }
            : entry,
        ],
      },
      { allowInsecureLoopback: o.allowInsecureLoopback },
    );
    if ("errors" in probe) {
      skipped.push({ name: en, reason: "invalid_entry" });
      return;
    }
    const components: Record<string, unknown> = {};
    for (const k of CLAUDE_COMPONENT_KEYS) if (raw[k] !== undefined) components[k] = raw[k];
    const author =
      isObj(raw.author) && typeof raw.author.name === "string" ? cut(raw.author.name, 100) : "";
    const publisher = author !== "" ? author : ownerName;
    plugins.push(entry);
    overlays.set(en, {
      strict: raw.strict !== false,
      components,
      ...(publisher !== undefined && { publisher }),
    });
  });

  const manifest: MarketplaceManifest = {
    schemaVersion: 1,
    name,
    ...(ownerName !== undefined && { owner: { name: ownerName } }),
    ...(description !== "" && { description }),
    plugins,
  };
  return { manifest, overlays, skipped };
}
