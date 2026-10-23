/**
 * Gathers what `planImages` needs (npm, ghcr.io, the head of main) and formats the plan as GitHub
 * Actions step outputs. Every lookup is injectable for tests; images-cli.ts wires the real ones.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IMAGES,
  type ImageMode,
  type ImagePlan,
  planImages,
  tagState as registryTagState,
  listTags as registryTags,
  type TagState,
} from "./images.js";
import { discoverWorkspace, fetchPublishedVersions, REPO_ROOT } from "./publish.js";
import { isFirstRelease } from "./publish-plan.js";

export interface ImageReleaseDeps {
  mode: ImageMode;
  root?: string;
  /** Versions of an npm package on the registry (default: the npm registry). */
  publishedVersions?: (name: string) => Promise<readonly string[]>;
  tagState?: (image: string, tag: string) => Promise<TagState>;
  listTags?: (image: string) => Promise<string[]>;
  /** The commit this run releases (GITHUB_SHA); required by `auto`. */
  sha?: string | undefined;
  /** The current head of main; required by `auto`. */
  mainHead?: () => Promise<string>;
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

  let npmReleased = false;
  let headOfMain: boolean | undefined;
  if (mode === "auto") {
    const lookup = deps.publishedVersions ?? fetchPublishedVersions;
    const pkgs = discoverWorkspace(root);
    const published = new Map<string, readonly string[]>();
    for (const p of pkgs) if (!p.private) published.set(p.name, await lookup(p.name));
    npmReleased = !isFirstRelease(pkgs, published);
    if (!npmReleased) return planImages({ mode, version, npmReleased, tags: {} });
    if (deps.sha === undefined || deps.sha === "" || deps.mainHead === undefined) {
      throw new Error("auto mode needs the released commit (GITHUB_SHA) and the head of main");
    }
    const head = await deps.mainHead();
    headOfMain = head === deps.sha;
    log(`head of main: ${head}, this run: ${deps.sha}`);
    if (!headOfMain) return planImages({ mode, version, npmReleased, tags: {}, headOfMain });
  }

  const state = deps.tagState ?? registryTagState;
  const list = deps.listTags ?? registryTags;
  const tags: Record<string, TagState> = {};
  const existingTags: string[] = [];
  for (const t of IMAGES) {
    tags[t.image] = await state(t.image, version);
    existingTags.push(...(await list(t.image)));
    log(`${t.image}:${version}: ${tags[t.image]}`);
  }
  return planImages({
    mode,
    version,
    npmReleased,
    tags,
    existingTags,
    ...(headOfMain === undefined ? {} : { headOfMain }),
  });
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
