import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { discoverPlugins } from "../discover.js";
import { syncPluginVersions } from "./plugin-versions.js";

export const SYNC_VERSIONS_USAGE =
  "capybara-plugin sync-versions [--root <dir>] [--plugins <glob>]";

/**
 * `capybara-plugin sync-versions`: copies each plugin's `package.json` version into its
 * `.capybara-plugin/plugin.json` and its extension manifest (`src/index.ts`, `  version: "x"`),
 * which the packer requires equal. Run it right after `changeset version` (which bumps only
 * `package.json`), before anything packs. Plugins are found as by `check` (`<root>/plugins/*`,
 * `--plugins <glob>`, or the root itself). Relative paths resolve against `cwd`. Returns the exit
 * code.
 */
export async function syncVersionsCommand(args: string[], cwd: string): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h", default: false },
      root: { type: "string" },
      plugins: { type: "string" },
    },
  });
  if (values.help) {
    console.log(`usage: ${SYNC_VERSIONS_USAGE}`);
    return 0;
  }
  const root = resolve(cwd, values.root ?? ".");
  try {
    const plugins = discoverPlugins(root, values.plugins);
    if (plugins.length === 0) {
      console.error(`${relative(cwd, root) || "."}: no plugin found`);
      return 1;
    }
    const changed = syncPluginVersions(root, plugins);
    console.log(
      changed.length === 0
        ? "plugin versions already match package.json"
        : `plugin versions synced from package.json: ${changed.join(", ")}`,
    );
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
