import semver from "semver";

/**
 * Catalog version order (package ecosystem spec §5.3), shared by every catalog path: semver,
 * ignoring build metadata; two versions that differ only in build metadata (`1.0.0` and
 * `1.0.0+git.abc`, a re-import whose content changed at the same version) are ordered by import
 * time. Range matching ignores build metadata too and includes prereleases (`0.0.0-git.g…`).
 */

/** A version with its import time (the tie-break between versions equal but for build metadata). */
export interface ImportedVersion {
  version: string;
  importedAt?: Date | string | null;
}

type Versioned = string | ImportedVersion;

const versionOf = (v: Versioned): string => (typeof v === "string" ? v : v.version);
const timeOf = (v: Versioned): number | undefined => {
  if (typeof v === "string" || v.importedAt === undefined || v.importedAt === null) {
    return undefined;
  }
  return new Date(v.importedAt).getTime();
};

/**
 * Compares two versions: semver without build metadata, then (when both have one) import time.
 * Negative when `a` is older.
 */
export function compareVersions(a: Versioned, b: Versioned): number {
  const c = semver.compare(versionOf(a), versionOf(b));
  if (c !== 0) return c;
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta === undefined || tb === undefined || ta === tb) return 0;
  return ta < tb ? -1 : 1;
}

/** Newest first (for `Array.prototype.sort`). */
export const newestFirst = (a: Versioned, b: Versioned): number => compareVersions(b, a);

/** The same release: equal once build metadata is dropped. */
export const sameRelease = (a: string, b: string): boolean => semver.compare(a, b) === 0;

/** `version` satisfies `range` (build metadata ignored, prereleases included). */
export const satisfiesRange = (version: string, range: string): boolean =>
  semver.satisfies(version, range, { includePrerelease: true });

/** The newest of `versions` satisfying `range` (see {@link compareVersions}), undefined when none does. */
export function maxSatisfying<T extends Versioned>(
  versions: readonly T[],
  range: string,
): T | undefined {
  let best: T | undefined;
  for (const v of versions) {
    if (!satisfiesRange(versionOf(v), range)) continue;
    if (best === undefined || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

/**
 * `version` with build metadata appended (`1.0.0` + `git.abc` -> `1.0.0+git.abc`; a version that
 * already has build metadata gets it extended: `1.0.0+b1` -> `1.0.0+b1.git.abc`).
 */
export const withBuild = (version: string, build: string): string =>
  version.includes("+") ? `${version}.${build}` : `${version}+${build}`;
