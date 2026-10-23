import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./source.js";

/** The repository every published package points at (F4); npm provenance checks it against the build. */
export const REPOSITORY_URL = "git+https://github.com/capybara-hq/core.git";

/** Workspace globs from `pnpm-workspace.yaml` (all one level deep). */
const WORKSPACE_DIRS = ["packages", "apps", "plugins", "tools"];

/**
 * Packages that must stay off npm (F2): the design system, the example plugins, and every app and tool.
 * `dir` is relative to the repo root.
 */
function mustBePrivate(dir: string): boolean {
  return (
    dir === "packages/design" ||
    dir.startsWith("plugins/example-") ||
    dir.startsWith("apps/") ||
    dir.startsWith("tools/")
  );
}

/**
 * Release metadata of the workspace packages under `root`: a package that would be published (not
 * `"private": true`) needs a `description`, a `license` and `repository` = `{ type: "git", url:
 * REPOSITORY_URL, directory: <its dir> }` (npm provenance rejects a publish whose repository does not
 * match); packages that must stay off npm must be private.
 */
export function checkReleaseMetadata(root: string): Finding[] {
  const out: Finding[] = [];
  for (const group of WORKSPACE_DIRS) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(base, e.name, "package.json");
      if (!e.isDirectory() || !existsSync(file)) continue;
      const dir = `${group}/${e.name}`;
      const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const finding = (rule: string, message: string) => out.push({ file, line: 1, rule, message });
      if (pkg.private === true) continue;
      if (mustBePrivate(dir)) {
        finding("release-private", `${dir} must not be published: add "private": true`);
        continue;
      }
      if (typeof pkg.description !== "string" || pkg.description.trim() === "") {
        finding("release-description", `${dir} is published and needs a "description"`);
      }
      if (typeof pkg.license !== "string") {
        finding("release-license", `${dir} is published and needs a "license"`);
      }
      const repo = pkg.repository as Record<string, unknown> | undefined;
      if (
        typeof repo !== "object" ||
        repo === null ||
        repo.type !== "git" ||
        repo.url !== REPOSITORY_URL ||
        repo.directory !== dir
      ) {
        finding(
          "release-repository",
          `${dir} is published and needs "repository": { "type": "git", "url": "${REPOSITORY_URL}", "directory": "${dir}" } (npm provenance requires it)`,
        );
      }
    }
  }
  return out;
}
