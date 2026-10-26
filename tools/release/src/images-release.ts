/**
 * Gathers what `planImages` needs (npm, ghcr.io) and formats the plan as GitHub
 * Actions step outputs. Every lookup is injectable for tests; images-cli.ts wires the real ones.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverWorkspace,
  fetchPublishedVersions,
  isFirstRelease,
} from "@capybara-hq/plugin-tools/release";
import {
  IMAGES,
  type ImageMode,
  type ImagePlan,
  planImages,
  tagState as registryTagState,
  listTags as registryTags,
  type TagState,
} from "./images.js";

/** Repository root (this file is `tools/release/src/images-release.ts`). */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface ImageReleaseDeps {
  mode: ImageMode;
  root?: string;
  /** Versions of an npm package on the registry (default: the npm registry). */
  publishedVersions?: (name: string) => Promise<readonly string[]>;
  tagState?: (image: string, tag: string) => Promise<TagState>;
  listTags?: (image: string) => Promise<string[]>;
  log?: (line: string) => void;
}

export async function planImageRelease(deps: ImageReleaseDeps): Promise<ImagePlan> {
  const { mode } = deps;
  const root = deps.root ?? REPO_ROOT;
  const log = deps.log ?? console.log;
  const manifest = JSON.parse(readFileSync(join(root, "apps/capybara/package.json"), "utf8")) as {
    version?: unknown;
  };
  const version = String(manifest.version);
  if (mode === "dry-run") return planImages({ mode, version, npmReleased: false, tags: {} });

  // Always this tree's own version: a re-run of an old run rebuilds exactly that version from its
  // own commit, never a newer one.
  const lookup = deps.publishedVersions ?? fetchPublishedVersions;
  const pkgs = discoverWorkspace(root);
  const published = new Map<string, readonly string[]>();
  for (const p of pkgs) if (!p.private) published.set(p.name, await lookup(p.name));
  const npmReleased = !isFirstRelease(pkgs, published);
  // Only this tree's own versions are on npm: the first release, published by this very run.
  const npmOnlyTreeVersions = pkgs.every(
    (p) => p.private || (published.get(p.name) ?? []).every((v) => v === p.version),
  );
  if (mode === "auto" && !npmReleased) return planImages({ mode, version, npmReleased, tags: {} });

  const state = deps.tagState ?? registryTagState;
  const list = deps.listTags ?? registryTags;
  const tags: Record<string, TagState> = {};
  const existingTags: string[] = [];
  for (const t of IMAGES) {
    tags[t.image] = await state(t.image, version);
    existingTags.push(...(await list(t.image)));
    log(`${t.image}:${version}: ${tags[t.image]}`);
  }
  return planImages({ mode, version, npmReleased, tags, existingTags, npmOnlyTreeVersions });
}

/** `key=value` lines for $GITHUB_OUTPUT (single-line values only). */
export function imageOutputs(plan: ImagePlan): string {
  const outputs: Record<string, string> = {
    version: plan.version,
    push: String(plan.push),
    latest: String(plan.latest),
    build: String(plan.build.length > 0),
    matrix: JSON.stringify(plan.build),
  };
  return `${Object.entries(outputs)
    .map(([k, v]) => `${k}=${v.replaceAll("\n", " ")}`)
    .join("\n")}\n`;
}
