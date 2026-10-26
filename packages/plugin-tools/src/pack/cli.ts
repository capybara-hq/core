import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CommandDirs } from "../cli-dirs.js";
import { discoverPlugins } from "../discover.js";
import { packBootstrap } from "./bootstrap.js";
import { packPlugin } from "./pack.js";

export const PACK_USAGE =
  "capybara-plugin pack [<dir>...] [--all <root>] [--out <dir>]\n" +
  "       capybara-plugin pack --bootstrap <manifest> [--root <dir>] [--out <dir>]";

/**
 * `capybara-plugin pack`: packs plugin directories into plugin tgz files.
 *
 * - `<dir>...`: the plugin directories to pack;
 * - `--all <root>`: also every plugin of the repository at `<root>` (`<root>/plugins/*`, or `<root>`
 *   itself when it is a plugin);
 * - `--bootstrap <manifest>`: the bootstrap directory an image bakes: every entry of the bootstrap
 *   manifest as `<name>-<version>.tgz`, checked against its pins (workspace entries' `path` is
 *   relative to `--root`, default the current directory);
 * - `--out <dir>`: output directory, default `artifacts/plugins` (`artifacts/bootstrap` with
 *   `--bootstrap`) under the current directory. The last `--out` wins.
 *
 * See {@link CommandDirs} for how paths resolve. Returns the exit code.
 */
export async function packCommand(args: string[], dirs: CommandDirs): Promise<number> {
  const cwd = dirs.invoked;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      all: { type: "string" },
      out: { type: "string" },
      bootstrap: { type: "string" },
      root: { type: "string" },
    },
  });
  const outOf = (fallback: string) =>
    values.out === undefined ? resolve(dirs.cwd, fallback) : resolve(cwd, values.out);
  const shown = (p: string) => {
    const rel = relative(cwd, p);
    return rel === "" ? "." : rel.startsWith("..") ? p : rel;
  };

  if (values.bootstrap !== undefined) {
    if (values.all !== undefined || positionals.length > 0) {
      return usage("--bootstrap takes no plugin directory");
    }
    try {
      const root = values.root === undefined ? dirs.cwd : resolve(cwd, values.root);
      const manifest = resolve(cwd, values.bootstrap);
      for (const p of await packBootstrap(manifest, root, outOf("artifacts/bootstrap"))) {
        console.log(`${shown(p.file)}  ${p.integrity}`);
      }
      return 0;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 1;
    }
  }

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
