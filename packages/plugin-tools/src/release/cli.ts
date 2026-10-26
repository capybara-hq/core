import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CommandDirs } from "../cli-dirs.js";
import { assertCommittedTree, runPublish } from "./publish.js";

export const RELEASE_USAGE =
  "capybara-plugin release [--dry-run] [--provenance] [--out <dir>] [--auto] [--root <dir>]";

/**
 * `capybara-plugin release`: the npm release of a workspace.
 *
 * Publishes every non-private workspace package under `--root` (default: the current directory)
 * whose version is not on the registry yet (plugins, the packages under `plugins/`, as plugin tgz
 * files; libraries through `pnpm pack`), then writes the plugin checksums to `<out>/plugins`.
 * Default output: `<root>/artifacts/release`. Build the libraries first.
 *
 * `--auto` is the push-to-main mode: the checkout must be exactly GITHUB_SHA (when set) with no
 * uncommitted package.json changes, and the first release (nothing public on the registry yet) is
 * refused: that one is only ever published by a manual workflow run. Otherwise it publishes
 * whatever committed versions are missing from npm, so a run that replaced a cancelled one still
 * publishes what the cancelled run would have.
 *
 * Under GitHub Actions it appends `published=<count>` to $GITHUB_OUTPUT after every publish (the
 * last line wins; always 0 in dry run). See {@link CommandDirs} for how paths resolve. Returns the
 * exit code.
 */
export async function releaseCommand(args: string[], dirs: CommandDirs): Promise<number> {
  const cwd = dirs.invoked;
  const { values } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      provenance: { type: "boolean", default: false },
      auto: { type: "boolean", default: false },
      out: { type: "string" },
      root: { type: "string" },
    },
  });
  const root = values.root === undefined ? dirs.cwd : resolve(cwd, values.root);
  const out = values.out === undefined ? join(root, "artifacts/release") : resolve(cwd, values.out);
  const dryRun = values["dry-run"];
  const output = (published: number) => {
    const ghOut = process.env.GITHUB_OUTPUT;
    if (ghOut !== undefined && ghOut !== "") appendFileSync(ghOut, `published=${published}\n`);
  };
  try {
    if (values.auto) assertCommittedTree({ root, expectedHead: process.env.GITHUB_SHA });
    output(0);
    const r = await runPublish({
      dryRun,
      provenance: values.provenance,
      out,
      root,
      refuseFirstRelease: values.auto,
      // Written after every publish, so a run that fails half-way still reports what it published.
      onPublished: (n) => output(dryRun ? 0 : n),
    });
    const verb = dryRun ? "would publish" : "published";
    console.log(`\n${verb} ${r.published.length}, skipped ${r.skipped.length} (already published)`);
    return 0;
  } catch (e) {
    console.error(`release failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
