/**
 * npm release.
 *
 *   pnpm release [--dry-run] [--provenance] [--out <dir>] [--if-bumped-since <git-rev>]
 *
 * Publishes every non-private workspace package whose version is not on the registry yet (plugins as
 * pack-plugin tgz files, libraries through `pnpm pack`), then writes plugin checksums to
 * `<out>/plugins`. Default output: `artifacts/release` at the repo root. Run `pnpm build` first.
 *
 * `--if-bumped-since <rev>` publishes only when some published package's version differs from `<rev>`
 * (the release workflow passes the commit before a push to main, so only a merged "Version Packages" PR
 * publishes; an unknown or all-zero `<rev>` publishes nothing; versions are read from committed trees
 * and uncommitted package.json changes abort). It also refuses the first release
 * (nothing public on the registry yet): that one is only ever published by a manual workflow run.
 *
 * Under GitHub Actions it appends `published=<count>` to $GITHUB_OUTPUT after every publish (the last
 * line wins; always 0 in dry run).
 */
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, releaseGate, runPublish } from "./publish.js";

function usage(msg: string): never {
  console.error(
    `${msg}\nusage: pnpm release [--dry-run] [--provenance] [--out <dir>] [--if-bumped-since <git-rev>]`,
  );
  process.exit(2);
}

function output(published: number): void {
  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut !== undefined && ghOut !== "") appendFileSync(ghOut, `published=${published}\n`);
}

const cwd = process.env.INIT_CWD ?? process.cwd();
let dryRun = false;
let provenance = false;
let since: string | undefined;
let out = join(REPO_ROOT, "artifacts/release");
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (a === "--dry-run") dryRun = true;
  else if (a === "--provenance") provenance = true;
  else if (a === "--out" || a === "--if-bumped-since") {
    const v = args[++i];
    if (v === undefined || v === "") usage(`${a} needs a value`);
    if (a === "--out") out = resolve(cwd, v);
    else since = v;
  } else usage(`unknown option ${a}`);
}

try {
  if (since !== undefined) {
    const gate = releaseGate(since, { expectedHead: process.env.GITHUB_SHA });
    if (!gate.publish) {
      console.log(
        `${gate.reason}: nothing to publish ` +
          `(merge the "Version Packages" PR, or run the release workflow manually)`,
      );
      output(0);
      process.exit(0);
    }
    console.log(`version bumps: ${gate.reason}`);
  }
  output(0);
  const r = await runPublish({
    dryRun,
    provenance,
    out,
    refuseFirstRelease: since !== undefined,
    // Written after every publish, so a run that fails half-way still reports what it published.
    onPublished: (n) => output(dryRun ? 0 : n),
  });
  const verb = dryRun ? "would publish" : "published";
  console.log(`\n${verb} ${r.published.length}, skipped ${r.skipped.length} (already published)`);
} catch (e) {
  console.error(`release failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
