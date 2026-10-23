import { spawnSync } from "node:child_process";

export type Remote = { name: string; url: string };

/** Parses `git remote -v` output into unique name/url pairs (fetch URLs). */
export function parseRemotes(output: string): Remote[] {
  const seen = new Map<string, Remote>();
  for (const line of output.split("\n")) {
    const m = /^(\S+)\s+(\S+)(?:\s+\((fetch|push)\))?\s*$/.exec(line.trim());
    if (m?.[1] === undefined || m[2] === undefined) continue;
    if (!seen.has(m[1])) seen.set(m[1], { name: m[1], url: m[2] });
  }
  return [...seen.values()];
}

/**
 * Reads the configured remote URLs as written in the git config. `git remote -v` is not used
 * because it applies `url.<base>.insteadOf` rewrites, which would hide the canonical URL.
 */
export function readRemotes(cwd: string): Remote[] {
  const r = spawnSync("git", ["config", "--get-regexp", "^remote\\..+\\.url$"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) return [];
  const remotes: Remote[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^remote\.(.+)\.url (.+)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) remotes.push({ name: m[1], url: m[2] });
  }
  return remotes;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the remote pointing at github.com/capybara-hq/<repo> (HTTPS or SSH). `fork` is true when
 * that remote is not `origin`, i.e. the person works in a fork clone.
 */
export function findUpstream(
  remotes: Remote[],
  repo: string,
): { remote: string; fork: boolean } | null {
  const re = new RegExp(
    `^(?:https://(?:[^@/]+@)?github\\.com/|git@github\\.com:)capybara-hq/${escapeRegExp(repo)}(?:\\.git)?/?$`,
    "i",
  );
  const matches = remotes.filter((r) => re.test(r.url));
  const hit = matches.find((r) => r.name === "origin") ?? matches[0];
  return hit === undefined ? null : { remote: hit.name, fork: hit.name !== "origin" };
}
