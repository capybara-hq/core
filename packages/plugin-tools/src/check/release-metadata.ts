import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Finding } from "./source.js";

const RULE = "plugin-release-metadata";

const readJson = (file: string) =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

/** `repository.url` of a package.json (`"repository": "<url>"` or `{ url }`). */
function repositoryUrl(pkg: Record<string, unknown>): string | undefined {
  const r = pkg.repository;
  if (typeof r === "string") return r;
  if (typeof r === "object" && r !== null && typeof (r as { url?: unknown }).url === "string") {
    return (r as { url: string }).url;
  }
  return undefined;
}

/**
 * Release metadata of the plugins a repository publishes (`plugin-release-metadata`): a plugin that
 * would be published (not `"private": true`) needs a `description`, a `license`, an https `homepage`
 * and `"repository": { "type": "git", "url", "directory": <its dir relative to root> }`, where `url`
 * is the root package.json's `repository.url` (npm provenance rejects a publish whose repository
 * does not match the repository that built it; core's plugins name `capybara-hq/core.git`, the
 * plugins repository's `capybara-hq/plugins.git`). A plugin that is the repository root itself
 * has no `directory`. The `example-*` plugins must be private. The plugin tgz carries these fields
 * (`METADATA_FIELDS` of the packer); the libraries' half of the rule is core's
 * `check:release-metadata`.
 */
export function checkPluginReleaseMetadata(plugins: string[], root: string): Finding[] {
  const out: Finding[] = [];
  const rootFile = join(root, "package.json");
  const url = existsSync(rootFile) ? repositoryUrl(readJson(rootFile)) : undefined;
  let rootReported = false;
  for (const dir of plugins) {
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    const pkg = readJson(file);
    if (pkg.private === true) continue;
    const rel = relative(root, dir).split("\\").join("/");
    const label = rel === "" ? String(pkg.name ?? basename(dir)) : rel;
    const finding = (message: string) => out.push({ file, line: 1, rule: RULE, message });
    if (basename(dir).startsWith("example-")) {
      finding(`${label} must not be published: add "private": true (example plugins stay off npm)`);
      continue;
    }
    if (typeof pkg.description !== "string" || pkg.description.trim() === "") {
      finding(`${label} is published and needs a "description"`);
    }
    if (typeof pkg.license !== "string") finding(`${label} is published and needs a "license"`);
    if (typeof pkg.homepage !== "string" || !pkg.homepage.startsWith("https://")) {
      finding(`${label} is published and needs an https "homepage"`);
    }
    if (url === undefined) {
      if (!rootReported) {
        rootReported = true;
        out.push({
          file: rootFile,
          line: 1,
          rule: RULE,
          message:
            'the repository root package.json needs "repository": { "type": "git", "url": … }: ' +
            "every published plugin's repository.url must equal it (npm provenance)",
        });
      }
      continue;
    }
    const repo = pkg.repository as Record<string, unknown> | undefined;
    const ok =
      typeof repo === "object" &&
      repo !== null &&
      repo.type === "git" &&
      repo.url === url &&
      (rel === "" ? repo.directory === undefined : repo.directory === rel);
    if (!ok) {
      const want =
        rel === ""
          ? `{ "type": "git", "url": "${url}" }`
          : `{ "type": "git", "url": "${url}", "directory": "${rel}" }`;
      finding(
        `${label} is published and needs "repository": ${want} (the root package.json's repository; npm provenance requires it)`,
      );
    }
  }
  return out;
}
