import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatFinding } from "../check/report.js";
import { errorsOf } from "../check/source.js";
import { MARKETPLACE_FILE, syncMarketplace } from "./marketplace.js";

export const MARKETPLACE_USAGE =
  "capybara-plugin marketplace --write|--check [--base <rev>] [--root <dir>] [--file <path>]\n" +
  "                            [--plugins <glob>]";

/**
 * `capybara-plugin marketplace`: writes (`--write`) or checks (`--check`) the repository's
 * marketplace manifest, one entry per public plugin at its current version, against reproducible
 * packs of its public plugins ({@link syncMarketplace}).
 *
 * - `--root <dir>`: the repository (default: the current directory);
 * - `--file <path>`: the manifest, relative to the root (default `.capybara-plugin/marketplace.json`);
 * - `--plugins <glob>`: the plugin directories, relative to the root (default `plugins/*`, or the
 *   root itself when it is a plugin).
 *
 * - `--base <rev>` (with `--check`, on pull requests): an entry's version may only increase over the
 *   versions `<rev>` lists (`marketplace-version-decrease`), a version `<rev>` lists keeps its
 *   integrity, and the entries added since must match the tree's packs (`marketplace-integrity`).
 *
 * `--check` exits 1 on any finding that is not a warning (`marketplace-missing`,
 * `marketplace-display-stale`, `marketplace-integrity`, `marketplace-version-decrease`,
 * `marketplace-invalid`); `--write` writes each plugin's entry (replacing its other versions,
 * refreshing a listed entry's summary and displayName) and exits 1 only on `marketplace-invalid`.
 * Relative paths resolve against `cwd`. Returns the exit code.
 */
export async function marketplaceCommand(args: string[], cwd: string): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h", default: false },
      write: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      root: { type: "string" },
      file: { type: "string" },
      plugins: { type: "string" },
      base: { type: "string" },
    },
  });
  if (values.help) {
    console.log(`usage: ${MARKETPLACE_USAGE}`);
    return 0;
  }
  if (values.write === values.check) {
    console.error(`give exactly one of --write and --check\nusage: ${MARKETPLACE_USAGE}`);
    return 2;
  }
  if (values.base !== undefined && values.write) {
    console.error(`--base goes with --check\nusage: ${MARKETPLACE_USAGE}`);
    return 2;
  }
  const root = values.root === undefined ? cwd : resolve(cwd, values.root);
  const file = resolve(root, values.file ?? MARKETPLACE_FILE);
  try {
    const r = await syncMarketplace({
      root,
      file,
      write: values.write,
      ...(values.plugins !== undefined && { plugins: values.plugins }),
      ...(values.base !== undefined && { base: values.base }),
    });
    for (const f of r.findings) console.error(formatFinding(f, root));
    const errors = errorsOf(r.findings);
    if (errors.length > 0) {
      console.error(`\n${errors.length} marketplace finding(s)`);
      return 1;
    }
    if (values.write) {
      for (const e of r.added) console.log(`added ${e.name}@${e.version}`);
      for (const k of r.removed) console.log(`removed ${k}`);
      for (const k of r.refreshed) console.log(`refreshed ${k}`);
      const changed = r.added.length + r.removed.length + r.refreshed.length > 0;
      console.log(changed ? `wrote ${file}` : "marketplace is up to date");
    } else {
      console.log("marketplace is up to date");
    }
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
