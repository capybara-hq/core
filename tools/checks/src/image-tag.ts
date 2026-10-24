import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./source.js";

/**
 * The default image tag of the compose deployment. Images are tagged with the version of
 * `apps/capybara` (release.yml), so every `${CAPYBARA_VERSION:-X}` in `docker/compose.yaml` and the
 * commented `# CAPYBARA_VERSION=X` in `docker/.env.example` must name that version: the README quick
 * start runs the compose file of the checkout, and a stale default would pull old images (or images
 * that were never published). `pnpm version-packages` (what the Version Packages PR runs) rewrites
 * them with `syncImageTag`; `check:release-metadata` fails when they drift.
 */
export const IMAGE_TAG_FILES = [
  {
    file: "docker/compose.yaml",
    re: /(\$\{CAPYBARA_VERSION:-)([^}]*)(\})/g,
    /** The compose file must reference the variable at least once (four images). */
    required: true,
  },
  {
    file: "docker/.env.example",
    re: /^(#?[ \t]*CAPYBARA_VERSION=)(.*?)([ \t]*)$/gm,
    required: true,
  },
] as const;

/** The version of apps/capybara, or undefined when the app does not exist (check fixtures). */
export function imageVersion(root: string): string | undefined {
  const file = join(root, "apps/capybara/package.json");
  if (!existsSync(file)) return undefined;
  const v = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
  return typeof v === "string" ? v : undefined;
}

/** Image tag defaults that differ from the apps/capybara version. Skipped when a file is missing. */
export function checkImageTag(root: string): Finding[] {
  const version = imageVersion(root);
  if (version === undefined) return [];
  const out: Finding[] = [];
  for (const { file: rel, re, required } of IMAGE_TAG_FILES) {
    const file = join(root, rel);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    let seen = 0;
    for (const m of text.matchAll(re)) {
      seen++;
      if (m[2] === version) continue;
      const line = text.slice(0, m.index).split("\n").length;
      out.push({
        file,
        line,
        rule: "release-image-tag",
        message: `${rel} defaults the image tag to "${m[2]}" but apps/capybara (the image tag) is ${version}: run pnpm sync:image-tag`,
      });
    }
    if (required && seen === 0) {
      out.push({
        file,
        line: 1,
        rule: "release-image-tag",
        message: `${rel} has no CAPYBARA_VERSION default to check against apps/capybara (${version})`,
      });
    }
  }
  return out;
}

/** Rewrites the image tag defaults to the apps/capybara version; returns the files it changed. */
export function syncImageTag(root: string): string[] {
  const version = imageVersion(root);
  if (version === undefined) throw new Error(`no apps/capybara/package.json under ${root}`);
  const changed: string[] = [];
  for (const { file: rel, re } of IMAGE_TAG_FILES) {
    const file = join(root, rel);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const next = text.replace(re, (_m, pre: string, _old: string, post: string) => {
      return `${pre}${version}${post}`;
    });
    if (next !== text) {
      writeFileSync(file, next);
      changed.push(rel);
    }
  }
  return changed;
}
