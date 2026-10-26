import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_MANIFEST_FILE } from "@capybara-hq/plugin-sdk";

/** The default plugin glob of a repository with a `plugins/` directory. */
export const DEFAULT_PLUGINS_GLOB = "plugins/*";

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** One glob segment (`*` and `?`, never across `/`) as a regular expression source. */
const segmentRe = (seg: string) => escapeRe(seg).replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");

/**
 * A POSIX path glob (`*` and `?` within one segment; `**` is not supported) as a regular expression
 * that matches the whole path.
 */
export function globToRegExp(glob: string): RegExp {
  const segs = normalizeGlob(glob);
  return new RegExp(`^${segs.map(segmentRe).join("/")}$`);
}

function normalizeGlob(glob: string): string[] {
  const segs = glob
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (segs.some((s) => s.includes("**") || s === "..")) {
    throw new Error(`unsupported plugin glob ${glob}: use * within one path segment, no ** or ..`);
  }
  return segs;
}

/** Directories under `root` matching `glob` (sorted, absolute); `node_modules` never matches. */
export function expandGlob(root: string, glob: string): string[] {
  let dirs = [root];
  for (const seg of normalizeGlob(glob)) {
    const re = new RegExp(`^${segmentRe(seg)}$`);
    const next: string[] = [];
    for (const d of dirs) {
      if (!existsSync(d)) continue;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== "node_modules" && re.test(e.name)) {
          next.push(join(d, e.name));
        }
      }
    }
    dirs = next;
  }
  return dirs.sort();
}

const isPluginDir = (d: string) =>
  existsSync(join(d, "package.json")) || existsSync(join(d, PLUGIN_MANIFEST_FILE));

/**
 * The plugin directories of a repository, as `capybara-plugin pack --all` and `check` find them:
 * with `glob`, the matching directories under `root` that hold a `package.json` or a
 * `.capybara-plugin/plugin.json`; without, `<root>/plugins/*` when `<root>/plugins` exists, else
 * `root` itself when it is a plugin (has `.capybara-plugin/plugin.json`). Sorted, absolute.
 */
export function discoverPlugins(root: string, glob?: string): string[] {
  if (glob !== undefined) return expandGlob(root, glob).filter(isPluginDir);
  if (existsSync(join(root, "plugins"))) {
    return expandGlob(root, DEFAULT_PLUGINS_GLOB).filter(isPluginDir);
  }
  return existsSync(join(root, PLUGIN_MANIFEST_FILE)) ? [root] : [];
}

/**
 * The glob (relative to `root`) that {@link discoverPlugins} uses: `glob` itself, `plugins/*`, or
 * `.` for a single-plugin repository.
 */
export function pluginsGlobOf(root: string, glob?: string): string {
  if (glob !== undefined) return glob;
  return existsSync(join(root, "plugins")) ? DEFAULT_PLUGINS_GLOB : ".";
}
