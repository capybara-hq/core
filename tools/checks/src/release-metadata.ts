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
 * `"private": true`) needs a `description`, a `license`, an https `homepage` and `repository` =
 * `{ type: "git", url: REPOSITORY_URL, directory: <its dir> }` (npm provenance rejects a publish whose
 * repository does not match); published packages outside `plugins/` also need a `files` allowlist.
 * Packages that must stay off npm must be private. Also runs `checkImageVersions`.
 */
export function checkReleaseMetadata(root: string): Finding[] {
  const out: Finding[] = checkImageVersions(root);
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
      if (typeof pkg.homepage !== "string" || !pkg.homepage.startsWith("https://")) {
        finding("release-homepage", `${dir} is published and needs an https "homepage"`);
      }
      // Plugins are published as the pack-plugin tgz (its contents are fixed); libraries go through
      // pnpm pack, which without an allowlist would ship the whole directory (src, tests, configs).
      if (group !== "plugins" && !(Array.isArray(pkg.files) && pkg.files.length > 0)) {
        finding("release-files", `${dir} is published and needs a "files" allowlist`);
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

/** The image tag source (release.yml tags all four images with its version) and the web app. */
const IMAGE_VERSION_GROUP = ["@capybara-hq/capybara", "@capybara-hq/web"];

/**
 * The images are tagged with the version of `apps/capybara`, but `capybara-web` is built from
 * `apps/web`: a web-only fix must still produce a new image tag. So the two apps share one version
 * (changesets `fixed` group in `.changeset/config.json`) and must never drift apart. Skipped when
 * neither app exists (check fixtures).
 */
export function checkImageVersions(root: string): Finding[] {
  const out: Finding[] = [];
  const cliFile = join(root, "apps/capybara/package.json");
  const webFile = join(root, "apps/web/package.json");
  if (!existsSync(cliFile) && !existsSync(webFile)) return out;
  const version = (f: string) =>
    existsSync(f)
      ? String((JSON.parse(readFileSync(f, "utf8")) as { version?: unknown }).version)
      : "";
  const cli = version(cliFile);
  const web = version(webFile);
  if (cli !== web) {
    out.push({
      file: webFile,
      line: 1,
      rule: "release-image-version",
      message: `apps/web is ${web || "missing"} but apps/capybara (the image tag) is ${cli || "missing"}: they must share one version`,
    });
  }
  const configFile = join(root, ".changeset/config.json");
  const config = existsSync(configFile)
    ? (JSON.parse(readFileSync(configFile, "utf8")) as { fixed?: unknown })
    : {};
  const grouped =
    Array.isArray(config.fixed) &&
    config.fixed.some(
      (g) => Array.isArray(g) && IMAGE_VERSION_GROUP.every((name) => g.includes(name)),
    );
  if (!grouped) {
    out.push({
      file: configFile,
      line: 1,
      rule: "release-image-version",
      message: `.changeset/config.json needs "fixed": [${JSON.stringify(IMAGE_VERSION_GROUP)}] so a web-only change bumps the image tag`,
    });
  }
  return out;
}
