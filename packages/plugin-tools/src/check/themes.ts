import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import {
  type ParsedTheme,
  PLUGIN_MANIFEST_FILE,
  parseThemeFile,
  THEME_LIMITS,
  themeIdOf,
  validateThemeAssets,
} from "@capybara-hq/plugin-sdk";
import type { Finding } from "./source.js";

const stripDot = (p: string) => p.replace(/^\.\//, "");

/** The theme paths of a plugin (relative, no leading `./`): `manifest.themes`, else `themes/*.json`. */
export function themePathsOf(dir: string): { paths: string[]; listed: boolean } {
  let listed: string[] | undefined;
  try {
    const m = JSON.parse(readFileSync(join(dir, PLUGIN_MANIFEST_FILE), "utf8")) as {
      themes?: { path?: unknown }[];
    };
    if (Array.isArray(m.themes)) {
      listed = m.themes.flatMap((t) => (typeof t?.path === "string" ? [stripDot(t.path)] : []));
    }
  } catch {
    // a missing or broken manifest is the pack check's business
  }
  if (listed !== undefined) return { paths: [...new Set(listed)], listed: true };
  const root = join(dir, "themes");
  const scanned = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => `themes/${e.name}`)
        .sort()
    : [];
  return { paths: scanned, listed: false };
}

/**
 * The theme checks of a plugin (spec §4-§5), reading `manifest.themes` or `themes/*.json`:
 * - `theme-invalid`: a theme file that is missing, over the size limit, not JSON or rejected by
 *   `parseThemeFile`, or more themes than {@link THEME_LIMITS}`.perPlugin`;
 * - `theme-readability`: a theme whose merged scheme fails the readability pairs (`unreadable:`);
 * - `theme-asset`: a font or logo that is missing or invalid (`validateThemeAssets`), and the sum
 *   of the distinct asset sizes over all of the plugin's themes above
 *   {@link THEME_LIMITS}`.assetsBytes` (the limit is per plugin; the SDK checks one theme).
 */
export function checkThemes(pluginDirs: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const dir of pluginDirs) {
    const { paths } = themePathsOf(dir);
    if (paths.length === 0) continue;
    const manifest = join(dir, PLUGIN_MANIFEST_FILE);
    if (paths.length > THEME_LIMITS.perPlugin) {
      findings.push({
        file: manifest,
        line: 1,
        rule: "theme-invalid",
        message: `the plugin has ${paths.length} themes; at most ${THEME_LIMITS.perPlugin} are allowed`,
      });
    }
    const files = new Map<string, Uint8Array>();
    const sizes = new Map<string, number>();
    for (const rel of paths) {
      const file = join(dir, rel);
      const bad = (rule: string, message: string) =>
        findings.push({ file, line: 1, rule, message });
      if (!existsSync(file) || !statSync(file).isFile()) {
        bad("theme-invalid", `theme ./${rel} does not exist`);
        continue;
      }
      if (statSync(file).size > THEME_LIMITS.fileBytes) {
        bad("theme-invalid", `theme file is larger than ${THEME_LIMITS.fileBytes} bytes`);
        continue;
      }
      const r = parseThemeFile(themeIdOf(rel), readFileSync(file, "utf8"));
      if ("errors" in r) {
        for (const e of r.errors) {
          bad(e.startsWith("unreadable:") ? "theme-readability" : "theme-invalid", e);
        }
        continue;
      }
      const used = assetRefs(r);
      for (const ref of used) {
        const key = stripDot(ref);
        const p = posix.normalize(key);
        if (files.has(p) || p.startsWith("..") || p.startsWith("/")) continue;
        const abs = join(dir, p);
        if (existsSync(abs) && statSync(abs).isFile()) files.set(p, readFileSync(abs));
      }
      const { errors } = validateThemeAssets(r, files);
      for (const e of errors) bad("theme-asset", e);
      for (const ref of used) {
        const bytes = files.get(stripDot(ref));
        if (bytes !== undefined) sizes.set(stripDot(ref), bytes.length);
      }
    }
    let total = 0;
    for (const n of sizes.values()) total += n;
    if (total > THEME_LIMITS.assetsBytes) {
      findings.push({
        file: manifest,
        line: 1,
        rule: "theme-asset",
        message: `the plugin's theme assets are larger than ${THEME_LIMITS.assetsBytes} bytes in total (${total}); the limit covers all of the plugin's themes`,
      });
    }
  }
  return findings;
}

/** The asset paths a parsed theme references (fonts, logo mark and favicon). */
export function assetRefs(theme: ParsedTheme): string[] {
  const refs = (theme.fonts ?? []).map((f) => f.file);
  for (const ref of [theme.logo?.mark, theme.logo?.favicon]) if (ref !== undefined) refs.push(ref);
  return refs;
}
