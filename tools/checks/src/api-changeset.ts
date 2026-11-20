import { compareSemver, SEMVER_RE } from "@capybara-hq/plugin-tools/release";
import type { Finding } from "./source.js";

/**
 * One published package whose public API is a contract: the api-extractor report generated for it
 * (by `pnpm gen:sdk-api` / `pnpm gen:plugin-client`) and the manifest that carries its version.
 * Both paths are relative to the repository root.
 */
export interface ApiReport {
  /** The package a changeset must bump; it is also the frontmatter key of that changeset. */
  pkg: string;
  report: string;
  manifest: string;
  /**
   * The report line that follows the package version, when the package exports its own version
   * (`SDK_VERSION`): `changeset version` rewrites that line together with package.json, so a report
   * change that is only that line needs no changeset.
   */
  versionLine?: RegExp;
}

/** The package version line the SDK report carries (one capture group: the version). */
const SDK_VERSION_LINE = /^export const SDK_VERSION = "([^"]*)";$/m;

/** Every published package with a committed API report. Add a package here when it starts one. */
export const API_REPORTS: readonly ApiReport[] = [
  {
    pkg: "@capybara-hq/plugin-sdk",
    report: "packages/plugin-sdk/api/plugin-sdk.api.md",
    manifest: "packages/plugin-sdk/package.json",
    versionLine: SDK_VERSION_LINE,
  },
  {
    pkg: "@capybara-hq/plugin-client",
    report: "packages/plugin-client/api/plugin-client.api.md",
    manifest: "packages/plugin-client/package.json",
  },
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a changeset's frontmatter (between the leading `---` lines) names `pkg`. */
export function changesetBumps(content: string, pkg: string): boolean {
  const key = new RegExp(`^\\s*(["']?)${escapeRegExp(pkg)}\\1\\s*:`);
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return false;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") return false;
    if (key.test(line)) return true;
  }
  return false;
}

/** Whether `head` is a higher semver than `base`. */
function raised(v: { base: string; head: string }): boolean {
  return SEMVER_RE.test(v.base) && SEMVER_RE.test(v.head) && compareSemver(v.head, v.base) > 0;
}

/** The two reports differ only in the version line, which now names `version`. */
function onlyVersionLine(
  versionLine: RegExp,
  reports: { base: string; head: string },
  version: string,
): boolean {
  if (versionLine.exec(reports.head)?.[1] !== version) return false;
  const strip = (r: string) => r.replace(versionLine, "");
  return strip(reports.base) === strip(reports.head);
}

/**
 * PR check: when the API report of a published package changed, some changeset added in the same
 * diff must bump that package (frontmatter only; a mention in the body doesn't count).
 *
 * `changedFiles` and the keys of `addedChangesets` are repo-relative paths. `reportAtBase: false`
 * (the report does not exist at the base commit) skips the check: the PR that introduces the
 * report has no earlier API to compare against.
 *
 * Versions set without a changeset (`versions`: the package's version at the base and now) also
 * pass when the version was raised (a Version Packages PR: `changeset version` consumed the
 * changeset), or, for a package that exports its version in the report, when the only change to
 * the report is that line following package.json (`reports`, `entry.versionLine`), such as the
 * first release set by hand to `0.1.0-rc.0` over an unreleased `0.1.0`.
 */
export function checkApiChangeset(
  entry: ApiReport,
  changedFiles: readonly string[],
  addedChangesets: ReadonlyMap<string, string>,
  opts: {
    reportAtBase?: boolean;
    versions?: { base: string; head: string };
    reports?: { base: string; head: string };
  } = {},
): Finding[] {
  if (opts.reportAtBase === false) return [];
  if (!changedFiles.includes(entry.report)) return [];
  const v = opts.versions;
  if (v !== undefined && v.base !== v.head) {
    if (raised(v)) return [];
    if (
      entry.versionLine !== undefined &&
      opts.reports !== undefined &&
      onlyVersionLine(entry.versionLine, opts.reports, v.head)
    ) {
      return [];
    }
  }
  for (const content of addedChangesets.values()) {
    if (changesetBumps(content, entry.pkg)) return [];
  }
  return [
    {
      file: entry.report,
      line: 1,
      rule: "api-changeset",
      message:
        `the public API of "${entry.pkg}" changed but no changeset added in this diff bumps ` +
        `"${entry.pkg}"; run pnpm changeset and select ${entry.pkg}`,
    },
  ];
}
