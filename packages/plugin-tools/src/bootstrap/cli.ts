import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatFinding } from "../check/report.js";
import { errorsOf } from "../check/source.js";
import { BOOTSTRAP_EXTRA_FILE, syncBootstrapExtra } from "./check.js";

export const BOOTSTRAP_USAGE =
  "capybara-plugin bootstrap --check|--write [--file <path>] [--root <dir>] [--marketplace <name>] [--out <dir>] [--network]";

/**
 * `capybara-plugin bootstrap`: checks (`--check`) or pins (`--write`) a distribution's extra
 * bootstrap manifest ({@link syncBootstrapExtra}).
 *
 * - `--file <path>`: the manifest, relative to the root (default `bootstrap.extra.json`);
 * - `--root <dir>`: the local clone `git` entries are read from (default: the current directory);
 *   every `git` entry is read from it, so entries of several marketplaces (repositories) are
 *   checked once per repository with `--marketplace`;
 * - `--marketplace <name>`: only the `git` entries of that marketplace (the others untouched);
 * - `--out <dir>` (with `--write`): where the packs `<name>-<version>.tgz` are written, for the
 *   offline directory;
 * - `--network` (with `--check`): `npm` entries must match the registry tarball.
 *
 * Exits 1 on any finding (`bootstrap-extra-invalid`, `bootstrap-extra-integrity`,
 * `bootstrap-extra-path`). Returns the exit code.
 */
export async function bootstrapCommand(args: string[], cwd: string): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h", default: false },
      write: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      file: { type: "string" },
      root: { type: "string" },
      out: { type: "string" },
      marketplace: { type: "string" },
      network: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(`usage: ${BOOTSTRAP_USAGE}`);
    return 0;
  }
  if (values.write === values.check) {
    console.error(`give exactly one of --write and --check\nusage: ${BOOTSTRAP_USAGE}`);
    return 2;
  }
  if (values.out !== undefined && values.check) {
    console.error(`--out goes with --write\nusage: ${BOOTSTRAP_USAGE}`);
    return 2;
  }
  const root = values.root === undefined ? cwd : resolve(cwd, values.root);
  const file = resolve(root, values.file ?? BOOTSTRAP_EXTRA_FILE);
  try {
    const r = await syncBootstrapExtra({
      root,
      file,
      write: values.write,
      network: values.network,
      ...(values.marketplace !== undefined && { marketplace: values.marketplace }),
      ...(values.out !== undefined && { out: resolve(cwd, values.out) }),
    });
    for (const f of r.findings) console.error(formatFinding(f, root));
    const errors = errorsOf(r.findings);
    if (errors.length > 0) {
      console.error(`\n${errors.length} bootstrap finding(s)`);
      return 1;
    }
    if (values.write) {
      for (const n of r.updated) console.log(`pinned ${n}`);
      for (const p of r.packs) console.log(`wrote ${p}`);
      console.log(r.updated.length > 0 ? `wrote ${file}` : "bootstrap manifest is up to date");
    } else {
      console.log("bootstrap manifest is up to date");
    }
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
