/**
 * Plans the image release (see images.ts, images-release.ts) and, under GitHub Actions, writes the plan
 * to $GITHUB_OUTPUT.
 *
 *   pnpm release:images --mode auto|manual|dry-run
 *
 * Reads the tag from apps/capybara/package.json. `auto` asks npm whether the first release has happened
 * and the GitHub API whether GITHUB_SHA is still the head of main; `auto` and `manual` ask ghcr.io
 * which tags exist (GITHUB_TOKEN from the environment, when set, for packages that are not public).
 * Outputs: version, push, latest, build (any image to build) and matrix (JSON list of the targets).
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

/** The head of main through the GitHub API (GITHUB_REPOSITORY, GITHUB_TOKEN with contents: read). */
async function mainHead(): Promise<string> {
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo === undefined || repo === "") throw new Error("GITHUB_REPOSITORY is not set");
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (githubToken !== undefined && githubToken !== "")
    headers.authorization = `Bearer ${githubToken}`;
  const res = await fetch(`${api}/repos/${repo}/git/ref/heads/main`, { headers });
  if (!res.ok) throw new Error(`head of main: HTTP ${res.status}`);
  const sha = ((await res.json()) as { object?: { sha?: unknown } }).object?.sha;
  if (typeof sha !== "string") throw new Error("head of main: no sha in the response");
  return sha;
}

try {
  const plan = await planImageRelease({
    mode,
    sha: process.env.GITHUB_SHA,
    mainHead,
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
