/**
 * Pure planning for the npm release: which workspace packages get published, in which order and how.
 * No I/O here; `publish.ts` discovers the workspace and asks the registry. Used by core's release
 * (`pnpm release`) and by any plugin repository (`capybara-plugin release`).
 */
import { compareSemver, isPrerelease, parseSemver, SEMVER_RE } from "./semver.js";

/** A workspace package as the release sees it (`dir` is relative to the repo root, POSIX separators). */
export interface WorkspacePackage {
  name: string;
  version: string;
  dir: string;
  private: boolean;
  /** Lives under `plugins/`: published as its plugin tgz (`packPlugin`), not as a pnpm pack of the source tree. */
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
  /** `npm publish --tag`: see `distTagFor`. */
  tag: string;
}

/**
 * The npm dist-tag a version is published under, following the image `latest` rule: a prerelease
 * goes to `next`; a stable version below the highest stable version already on the registry (a
 * backport) goes to `release-<major>.<minor>`, so `latest` never moves back (and npm >= 11, which
 * refuses an untagged publish below `latest`, accepts it); anything else is `latest`. Installing
 * `npm:@capybara-hq/plugin-x` without a version therefore never picks up an rc or a backport.
 */
export function distTagFor(version: string, published: readonly string[]): string {
  if (isPrerelease(version)) return "next";
  const below = published.some(
    (v) => SEMVER_RE.test(v) && !isPrerelease(v) && compareSemver(version, v) < 0,
  );
  if (!below) return "latest";
  const [major, minor] = version.split(".");
  return `release-${major}.${minor}`;
}

/**
 * Library packages that must reach the registry before the ones that depend on them: kernel and testing
 * depend on the SDK, testing depends on the kernel, plugin-tools depends on the SDK and the kernel
 * (testing only peer-depends on it, optionally). Other non-plugin packages follow, then plugins (which
 * only peer-depend on the SDK). Names a repository does not have are skipped.
 */
export const LIBRARY_ORDER = [
  "@capybara-hq/plugin-sdk",
  "@capybara-hq/kernel",
  "@capybara-hq/testing",
  "@capybara-hq/plugin-tools",
];

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
      tag: distTagFor(p.version, published.get(p.name) ?? []),
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

/**
 * Whether publishing `version` promotes a release candidate: `version` is stable and the highest
 * version on the registry is a prerelease of the same major.minor.patch (0.1.0 after 0.1.0-rc.1).
 */
export function isPromotion(version: string, published: readonly string[]): boolean {
  const v = parseSemver(version);
  if (v === undefined || v.pre.length > 0) return false;
  const semvers = published.filter((p) => SEMVER_RE.test(p));
  if (semvers.length === 0) return false;
  const highest = semvers.reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b));
  const h = parseSemver(highest);
  return h !== undefined && h.pre.length > 0 && h.core.join(".") === v.core.join(".");
}

/**
 * The packages a release would promote from a release candidate (see {@link isPromotion}), as
 * `name@version`. Automatic (push) releases refuse them: the promotion, like the first release, is a
 * manual `workflow_dispatch`.
 */
export function promotions(
  pkgs: readonly WorkspacePackage[],
  published: ReadonlyMap<string, readonly string[]>,
): string[] {
  return pkgs
    .filter((p) => !p.private && isPromotion(p.version, published.get(p.name) ?? []))
    .map((p) => `${p.name}@${p.version}`)
    .sort();
}

/**
 * Problems in a library manifest as packed for npm: a leftover `workspace:` range (pnpm pack failed to
 * rewrite it) or the dev-only `@capybara-hq/source` export condition, which points at `src/` that is
 * not shipped (`publishConfig.exports` replaces it).
 */
export function packedManifestIssues(pkg: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const text = JSON.stringify(pkg);
  if (text.includes('"workspace:')) issues.push("has a workspace: dependency range");
  if (text.includes('"@capybara-hq/source"'))
    issues.push('exports the "@capybara-hq/source" condition');
  if (pkg.publishConfig !== undefined) issues.push("still has publishConfig (not applied)");
  return issues;
}
