/**
 * Pure planning for the npm release: which workspace packages get published, in which order and how.
 * No I/O here; `publish.ts` discovers the workspace and asks the registry.
 */

/** A workspace package as the release sees it (`dir` is relative to the repo root, POSIX separators). */
export interface WorkspacePackage {
  name: string;
  version: string;
  dir: string;
  private: boolean;
  /** Lives under `plugins/`: published as the pack-plugin tgz, not as a pnpm pack of the source tree. */
  isPlugin: boolean;
}

/**
 * One publish. `pnpm`: `pnpm pack` (rewrites `workspace:` ranges) then `npm publish <tgz>`;
 * `plugin-tgz`: `packPlugin(dir)` then `npm publish <tgz>`.
 */
export interface PublishStep {
  name: string;
  version: string;
  kind: "pnpm" | "plugin-tgz";
  dir: string;
}

/**
 * Library packages that must reach the registry before the ones that depend on them: kernel and testing
 * depend on the SDK, testing depends on the kernel. Other non-plugin packages follow, then plugins
 * (which only peer-depend on the SDK).
 */
const LIBRARY_ORDER = ["@capybara-hq/plugin-sdk", "@capybara-hq/kernel", "@capybara-hq/testing"];

function rank(p: WorkspacePackage): number {
  if (p.isPlugin) return LIBRARY_ORDER.length + 1;
  const i = LIBRARY_ORDER.indexOf(p.name);
  return i < 0 ? LIBRARY_ORDER.length : i;
}

/**
 * The publish plan: every non-private package whose current version is not yet on npm, SDK first, kernel
 * before testing, plugins last (each group by name). `published` maps a package name to the versions the
 * registry already has (missing = never published). Skipping already-published versions makes a rerun of
 * a half-finished release idempotent.
 */
export function planPublish(
  pkgs: readonly WorkspacePackage[],
  published: ReadonlyMap<string, readonly string[]>,
): PublishStep[] {
  return pkgs
    .filter((p) => !p.private && !(published.get(p.name) ?? []).includes(p.version))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((p) => ({
      name: p.name,
      version: p.version,
      kind: p.isPlugin ? "plugin-tgz" : "pnpm",
      dir: p.dir,
    }));
}

/** The versions listed in a registry packument (`GET <registry>/<name>`); anything else counts as none. */
export function publishedVersionsOf(packument: unknown): string[] {
  if (typeof packument !== "object" || packument === null) return [];
  const versions = (packument as { versions?: unknown }).versions;
  if (typeof versions !== "object" || versions === null) return [];
  return Object.keys(versions);
}

/**
 * Published packages whose version differs between two snapshots of the workspace (`before` = the
 * commit before a push). Packages new in `after` or private in `after` don't count: on `main` a version
 * only changes when a "Version Packages" PR merges, which is the signal that a push should publish.
 */
export function versionBumps(
  before: readonly WorkspacePackage[],
  after: readonly WorkspacePackage[],
): string[] {
  const old = new Map(before.map((p) => [p.name, p.version]));
  return after
    .filter((p) => !p.private && old.has(p.name) && old.get(p.name) !== p.version)
    .map((p) => `${p.name}@${old.get(p.name)} -> ${p.version}`)
    .sort();
}

/**
 * True while none of the packages that would be published has any version on the registry: the first
 * release. Automatic (push-triggered) releases refuse to do it; the first publish is a manual
 * `workflow_dispatch` once the prerequisites are confirmed (P-16).
 */
export function isFirstRelease(
  pkgs: readonly WorkspacePackage[],
  published: ReadonlyMap<string, readonly string[]>,
): boolean {
  return pkgs.every((p) => p.private || (published.get(p.name) ?? []).length === 0);
}
