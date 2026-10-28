import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { discoverPlugins } from "../discover.js";
import { packPlugin } from "./pack.js";

export const PACK_USAGE = "capybara-plugin pack [<dir>...] [--all <root>] [--out <dir>]";

/**
 * `capybara-plugin pack`: packs plugin directories into plugin tgz files.
 *
 * - `<dir>...`: the plugin directories to pack;
 * - `--all <root>`: also every plugin of the repository at `<root>` (`<root>/plugins/*`, or `<root>`
 *   itself when it is a plugin);
 * - `--out <dir>`: output directory, default `artifacts/plugins` under the current directory. The
 *   last `--out` wins.
 *
 * Relative paths resolve against `cwd` (the current directory). Returns the exit code.
 */
export async function packCommand(args: string[], cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      all: { type: "string" },
      out: { type: "string" },
    },
  });
  if (values.help) {
    console.log(`usage: ${PACK_USAGE}`);
    return 0;
  }
  const outOf = (fallback: string) => resolve(cwd, values.out ?? fallback);
  const shown = (p: string) => {
    const rel = relative(cwd, p);
    return rel === "" ? "." : rel.startsWith("..") ? p : rel;
  };

  const plugins = positionals.map((d) => resolve(cwd, d));
  if (values.all !== undefined) {
    const root = resolve(cwd, values.all);
    const found = discoverPlugins(root);
    if (found.length === 0) {
      console.error(`${shown(root)}: no plugin found (no plugins/* and no .capybara-plugin/)`);
      return 1;
    }
    plugins.push(...found.filter((d) => !plugins.includes(d)));
  }
  if (plugins.length === 0) return usage("no plugin directory given");

  const out = outOf("artifacts/plugins");
  let failed = 0;
  for (const dir of plugins) {
    try {
      const r = await packPlugin(dir, out);
      console.log(`${shown(r.file)}  sha256=${r.sha256}`);
      for (const d of r.dropped) {
        console.warn(`${shown(dir)}: warning: "files" entry "${d}" is not in the package`);
      }
    } catch (e) {
      failed++;
      console.error(`${shown(dir)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} plugin(s) failed to pack`);
    return 1;
  }
  return 0;
}

function usage(msg: string): number {
  console.error(`${msg}\nusage: ${PACK_USAGE}`);
  return 2;
}
