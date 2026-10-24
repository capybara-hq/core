/**
 * Plans the image release (see images.ts, images-release.ts) and, under GitHub Actions, writes the plan
 * to $GITHUB_OUTPUT.
 *
 *   pnpm release:images --mode auto|manual|dry-run
 *
 * Reads the tag from apps/capybara/package.json (this tree's own version, the only one it builds).
 * `auto` and `manual` ask npm whether the first release has happened and ghcr.io which tags exist
 * (GITHUB_TOKEN from the environment, when set, for packages that are not public). Outputs: version,
 * push, build (any image to build) and matrix (JSON list of the targets, each with its `latest`).
 */
import { appendFileSync } from "node:fs";
import { type ImageMode, listTags, tagState } from "./images.js";
import { imageOutputs, planImageRelease } from "./images-release.js";

const MODES: readonly ImageMode[] = ["auto", "manual", "dry-run"];

function usage(msg: string): never {
  console.error(`${msg}\nusage: pnpm release:images --mode auto|manual|dry-run`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--mode") usage("expected --mode <mode>");
const mode = args[1] as ImageMode;
if (!MODES.includes(mode)) usage(`unknown mode ${args[1]}`);

const githubToken = process.env.GITHUB_TOKEN;

try {
  const plan = await planImageRelease({
    mode,
    tagState: (image, tag) => tagState(image, tag, { githubToken }),
    listTags: (image) => listTags(image, { githubToken }),
  });
  console.log(plan.reason);
  const lines = imageOutputs(plan);
  process.stdout.write(lines);
  const out = process.env.GITHUB_OUTPUT;
  if (out !== undefined && out !== "") appendFileSync(out, lines);
} catch (e) {
  console.error(`image release plan failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
