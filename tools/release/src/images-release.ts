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
  isPrerelease,
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

/** The manifest of the plugins the kernel image bakes in. */
export const BOOTSTRAP_MANIFEST = "packages/kernel/bootstrap.json";

/** What the image gates read from the bootstrap manifest. */
export interface BootstrapGate {
  /** Names of the entries that are not `"source": "npm"` (workspace entries close the gate). */
  workspace: string[];
  /** `name@version` of the npm pins whose version is a prerelease. */
  prereleasePins: string[];
}

/**
 * Reads the bootstrap manifest for the image gates. A manifest it cannot read, or an entry that is
 * not an object, throws: the gates never open on a file they did not understand.
 */
export function readBootstrapGate(root: string): BootstrapGate {
  let plugins: unknown;
  try {
    plugins = (
      JSON.parse(readFileSync(join(root, BOOTSTRAP_MANIFEST), "utf8")) as { plugins?: unknown }
    ).plugins;
  } catch (e) {
    throw new Error(`${BOOTSTRAP_MANIFEST}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(plugins)) throw new Error(`${BOOTSTRAP_MANIFEST}: no plugins list`);
  const gate: BootstrapGate = { workspace: [], prereleasePins: [] };
  plugins.forEach((p: unknown, i) => {
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      throw new Error(`${BOOTSTRAP_MANIFEST}: plugins[${i}] is not an object`);
    }
    const { name, source, version } = p as { name?: unknown; source?: unknown; version?: unknown };
    if (source !== "npm") gate.workspace.push(String(name));
    else if (typeof version !== "string" || isPrerelease(version)) {
      gate.prereleasePins.push(`${String(name)}@${String(version)}`);
    }
  });
  return gate;
}

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
  const { workspace: workspaceBootstrap, prereleasePins } = readBootstrapGate(root);
  const gates = { workspaceBootstrap, prereleasePins };
  if (workspaceBootstrap.length > 0 || (!isPrerelease(version) && prereleasePins.length > 0)) {
    return planImages({ mode, version, npmReleased: false, tags: {}, ...gates });
  }

  // Always this tree's own version: a re-run of an old run rebuilds exactly that version from its
  // own commit, never a newer one.
  const lookup = deps.publishedVersions ?? fetchPublishedVersions;
  // Every public workspace package counts, plugins included (no `--plugins` scope here): "has the
  // first release happened" is true once anything of ours is on npm, and before the split core's
  // plugins/ still lists the packages capybara-hq/plugins publishes. After the split only core's
  // own packages remain.
  const pkgs = discoverWorkspace(root);
  const published = new Map<string, readonly string[]>();
  for (const p of pkgs) if (!p.private) published.set(p.name, await lookup(p.name));
  const npmReleased = !isFirstRelease(pkgs, published);
  // Only this tree's own versions are on npm: the first release, published by this very run.
  const npmOnlyTreeVersions = pkgs.every(
    (p) => p.private || (published.get(p.name) ?? []).every((v) => v === p.version),
  );
  if (mode === "auto" && !npmReleased) {
    return planImages({ mode, version, npmReleased, tags: {}, ...gates });
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
    npmOnlyTreeVersions,
    ...gates,
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
