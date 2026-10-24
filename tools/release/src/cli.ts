/**
 * npm release.
 *
 *   pnpm release [--dry-run] [--provenance] [--out <dir>] [--auto]
 *
 * Publishes every non-private workspace package whose version is not on the registry yet (plugins as
 * pack-plugin tgz files, libraries through `pnpm pack`), then writes plugin checksums to
 * `<out>/plugins`. Default output: `artifacts/release` at the repo root. Run `pnpm build` first.
 *
 * `--auto` is the push-to-main mode (R8): the checkout must be exactly GITHUB_SHA (when set) with no
 * uncommitted package.json changes, and the first release (nothing public on the registry yet) is
 * refused: that one is only ever published by a manual workflow run (P-16). Otherwise it publishes
 * whatever committed versions are missing from npm, so a run that replaced a cancelled one still
 * publishes what the cancelled run would have.
 *
 * Under GitHub Actions it appends `published=<count>` to $GITHUB_OUTPUT after every publish (the last
 * line wins; always 0 in dry run).
 */
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertCommittedTree, REPO_ROOT, runPublish } from "./publish.js";

function usage(msg: string): never {
  console.error(`${msg}\nusage: pnpm release [--dry-run] [--provenance] [--out <dir>] [--auto]`);
  process.exit(2);
}

function output(published: number): void {
  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut !== undefined && ghOut !== "") appendFileSync(ghOut, `published=${published}\n`);
}

const cwd = process.env.INIT_CWD ?? process.cwd();
let dryRun = false;
let provenance = false;
let auto = false;
let out = join(REPO_ROOT, "artifacts/release");
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (a === "--dry-run") dryRun = true;
  else if (a === "--provenance") provenance = true;
  else if (a === "--auto") auto = true;
  else if (a === "--out") {
    const v = args[++i];
    if (v === undefined || v === "") usage("--out needs a directory");
    out = resolve(cwd, v);
  } else usage(`unknown option ${a}`);
}

try {
  if (auto) assertCommittedTree({ expectedHead: process.env.GITHUB_SHA });
  output(0);
  const r = await runPublish({
    dryRun,
    provenance,
    out,
    refuseFirstRelease: auto,
    // Written after every publish, so a run that fails half-way still reports what it published.
    onPublished: (n) => output(dryRun ? 0 : n),
  });
  const verb = dryRun ? "would publish" : "published";
  console.log(`\n${verb} ${r.published.length}, skipped ${r.skipped.length} (already published)`);
} catch (e) {
  console.error(`release failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
