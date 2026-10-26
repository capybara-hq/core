import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { discoverPlugins } from "../discover.js";

/** The one top-level `version: "x"` line of an extension's `defineExtension({...})` manifest. */
const MANIFEST_VERSION_RE = /^( {2}version: ")([^"]+)(",)$/gm;

/**
 * `changeset version` bumps only a plugin's `package.json`, but the packer (and the SDK's
 * package validation) requires the same version in `.capybara-plugin/plugin.json` and in the
 * extension manifest (`src/index.ts`, `version: "x"`). `pnpm version-packages` (what the Version
 * Packages PR runs) calls this right after `changeset version`, before the bootstrap pins are
 * rewritten (`check:bootstrap --write`), since the packed bytes include the version.
 *
 * `pluginDirs` defaults to the plugins {@link discoverPlugins} finds under `root`. Returns the files
 * it changed, relative to `root` (POSIX). Throws when an extension's `src/index.ts`
 * does not have exactly one `  version: "..."` line, so a reformatted manifest fails loudly
 * instead of being left stale.
 */
export function syncPluginVersions(
  root: string,
  pluginDirs: string[] = discoverPlugins(root),
): string[] {
  const changed: string[] = [];
  const rel = (p: string) => relative(root, p).split("\\").join("/");
  for (const dir of pluginDirs) {
    const pkgFile = join(dir, "package.json");
    if (!existsSync(pkgFile)) continue;
    const version = (JSON.parse(readFileSync(pkgFile, "utf8")) as { version?: unknown }).version;
    if (typeof version !== "string") continue;

    const manifestFile = join(dir, ".capybara-plugin/plugin.json");
    const manifestRel = rel(manifestFile);
    if (existsSync(manifestFile)) {
      const text = readFileSync(manifestFile, "utf8");
      const json = JSON.parse(text) as Record<string, unknown>;
      if (json.version !== version) {
        json.version = version;
        writeFileSync(manifestFile, `${JSON.stringify(json, null, 2)}\n`);
        changed.push(manifestRel);
      }
    }

    const srcFile = join(dir, "src/index.ts");
    const srcRel = rel(srcFile);
    if (existsSync(srcFile)) {
      const text = readFileSync(srcFile, "utf8");
      const matches = [...text.matchAll(MANIFEST_VERSION_RE)];
      if (matches.length !== 1) {
        throw new Error(
          `${srcRel}: expected exactly one top-level \`  version: "..."\` line in the extension manifest, found ${matches.length}`,
        );
      }
      if (matches[0]?.[2] !== version) {
        writeFileSync(
          srcFile,
          text.replace(MANIFEST_VERSION_RE, (_m, pre: string, _old: string, post: string) => {
            return `${pre}${version}${post}`;
          }),
        );
        changed.push(srcRel);
      }
    }
  }
  return changed;
}
