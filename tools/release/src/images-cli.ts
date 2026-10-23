/**
 * Plans the image release (see images.ts) and, under GitHub Actions, writes the plan to $GITHUB_OUTPUT.
 *
 *   pnpm release:images --mode auto|manual|dry-run
 *
 * Reads the tag from apps/capybara/package.json. `auto` asks npm whether the first release has happened
 * and, like `manual`, asks ghcr.io which image tags exist (GITHUB_TOKEN from the environment, when set,
 * for packages that are not public). Outputs: version, push, latest, build (any image to build) and
 * matrix (JSON list of the image targets to build).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGES, type ImageMode, planImages, type TagState, tagState } from "./images.js";
import { discoverWorkspace, fetchPublishedVersions, REPO_ROOT } from "./publish.js";
import { isFirstRelease } from "./publish-plan.js";

const MODES: readonly ImageMode[] = ["auto", "manual", "dry-run"];

function usage(msg: string): never {
  console.error(`${msg}\nusage: pnpm release:images --mode auto|manual|dry-run`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--mode") usage("expected --mode <mode>");
const mode = args[1] as ImageMode;
if (!MODES.includes(mode)) usage(`unknown mode ${args[1]}`);

try {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "apps/capybara/package.json"), "utf8"),
  ) as { version?: unknown };
  const version = String(manifest.version);

  let npmReleased = false;
  const tags: Record<string, TagState> = {};
  if (mode === "auto") {
    const pkgs = discoverWorkspace();
    const published = new Map<string, readonly string[]>();
    for (const p of pkgs)
      if (!p.private) published.set(p.name, await fetchPublishedVersions(p.name));
    npmReleased = !isFirstRelease(pkgs, published);
  }
  if (mode === "manual" || (mode === "auto" && npmReleased)) {
    for (const t of IMAGES) {
      tags[t.image] = await tagState(t.image, version, { githubToken: process.env.GITHUB_TOKEN });
      console.log(`${t.image}:${version}: ${tags[t.image]}`);
    }
  }

  const plan = planImages({ mode, version, npmReleased, tags });
  console.log(plan.reason);
  const outputs: Record<string, string> = {
    version: plan.version,
    push: String(plan.push),
    latest: String(plan.latest),
    build: String(plan.build.length > 0),
    matrix: JSON.stringify(plan.build),
  };
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`);
  console.log(lines.join("\n"));
  const out = process.env.GITHUB_OUTPUT;
  if (out !== undefined && out !== "") appendFileSync(out, `${lines.join("\n")}\n`);
} catch (e) {
  console.error(`image release plan failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
