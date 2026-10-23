import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packPlugin } from "@capybara-hq/pack-plugin";
import {
  isFirstRelease,
  packedManifestIssues,
  planPublish,
  publishedVersionsOf,
  type WorkspacePackage,
} from "./publish-plan.js";

/** Repository root (this file is `tools/release/src/publish.ts`). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Workspace globs from `pnpm-workspace.yaml` (all one level deep). */
const WORKSPACE_DIRS = ["packages", "apps", "plugins", "tools"];

/** Workspace package directories (relative, POSIX) in the working tree. */
function workspaceDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const group of WORKSPACE_DIRS) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(base, e.name, "package.json"))) {
        dirs.push(`${group}/${e.name}`);
      }
    }
  }
  return dirs.sort();
}

function toWorkspacePackage(dir: string, text: string): WorkspacePackage {
  const pkg = JSON.parse(text) as Record<string, unknown>;
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") {
    throw new Error(`${dir}/package.json needs a name and a version`);
  }
  return {
    name: pkg.name,
    version: pkg.version,
    dir,
    private: pkg.private === true,
    isPlugin: dir.startsWith("plugins/"),
  };
}

/** Reads every workspace package.json. Plugins are the packages under `plugins/`. */
export function discoverWorkspace(root: string = REPO_ROOT): WorkspacePackage[] {
  return workspaceDirs(root).map((dir) =>
    toWorkspacePackage(dir, readFileSync(join(root, dir, "package.json"), "utf8")),
  );
}

/** Registry to compare against; npm reads the same variable when publishing. */
export function registryUrl(): string {
  const r = process.env.NPM_CONFIG_REGISTRY ?? process.env.npm_config_registry;
  return (r === undefined || r === "" ? "https://registry.npmjs.org" : r).replace(/\/+$/, "");
}

/**
 * Versions of `name` already on the registry (an anonymous read: every published package is public).
 * 404 means never published. Any other failure stops the release rather than guessing.
 */
export async function fetchPublishedVersions(name: string): Promise<string[]> {
  const url = `${registryUrl()}/${name.replace("/", "%2f")}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`registry lookup for ${name} failed: HTTP ${res.status}`);
  return publishedVersionsOf(await res.json());
}

/** sha512 SRI (`sha512-<base64>`), the form catalogs and app locks pin plugin tgz files with. */
export const integrityOf = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** npm pack's file name: `@scope/name` + version -> `scope-name-<version>.tgz`. */
const tgzName = (name: string, version: string) =>
  `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

/** Runs a command; the release passes `cwd` and expects a non-zero exit to throw. */
export type Exec = (cmd: string, args: string[], cwd: string) => Promise<void>;

/** Runs a command with inherited stdio (its output is the publish log; it never echoes tokens). */
const run: Exec = (cmd, args, cwd) =>
  new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env: process.env });
    child.on("error", rej);
    child.on("exit", (code, signal) =>
      code === 0
        ? res()
        : rej(new Error(`${cmd} ${args.join(" ")} exited with ${signal ?? `code ${code}`}`)),
    );
  });

/** `package/package.json` of an npm tgz, via the system tar. */
function readTgzManifest(tgz: string): Record<string, unknown> {
  return JSON.parse(
    execFileSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" }),
  ) as Record<string, unknown>;
}

/**
 * Guard for automatic (push) releases: the checkout must be exactly the pushed commit (`expectedHead`,
 * i.e. GITHUB_SHA) with no uncommitted changes to any workspace package.json. What gets published is
 * then always the committed main tree, whose versions only change when a reviewed PR (the Version
 * Packages PR) merges; output of a `changeset version` run can never be published (C1).
 */
export function assertCommittedTree(
  opts: { root?: string; expectedHead?: string | undefined } = {},
): void {
  const root = opts.root ?? REPO_ROOT;
  if (opts.expectedHead !== undefined && opts.expectedHead !== "") {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    if (head !== opts.expectedHead) {
      throw new Error(
        `the release checkout is at ${head}, not the pushed commit ${opts.expectedHead}: refusing to publish`,
      );
    }
  }
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--", ...workspaceDirs(root).map((d) => `${d}/package.json`)],
    { cwd: root, encoding: "utf8" },
  ).trim();
  if (dirty !== "") {
    throw new Error(
      `uncommitted package.json changes in the release checkout (publish only committed versions):\n${dirty}`,
    );
  }
}

export interface RunPublishOptions {
  /** Pack everything and run `npm publish --dry-run`; nothing reaches the registry. */
  dryRun: boolean;
  /** Pass `--provenance` (needs GitHub Actions with `id-token: write`). */
  provenance: boolean;
  /** Output directory for the tgz files and the plugin checksums (emptied first). */
  out: string;
  /** Repository root (tests). */
  root?: string;
  /**
   * Refuse the first release (nothing public on the registry yet) and publish nothing: automatic
   * releases set it so the first publish stays a manual `workflow_dispatch` (P-16).
   */
  refuseFirstRelease?: boolean;
  /** Registry lookup (tests). */
  publishedVersions?: (name: string) => Promise<readonly string[]>;
  /** Command runner for `pnpm pack` / `npm publish` (tests). */
  exec?: Exec;
  /** Plugin packer (tests); returns the tgz path. */
  packPluginTgz?: (dir: string, outDir: string) => Promise<string>;
  /** Reads `package/package.json` out of a packed library tgz (tests). */
  readPackedManifest?: (tgz: string) => Record<string, unknown>;
  /** Called after each successful publish with the running count (the CLI writes $GITHUB_OUTPUT). */
  onPublished?: (count: number) => void;
}

/**
 * Publishes every workspace package whose version is not on npm yet, in plan order. After each plugin
 * publish it rewrites `<out>/plugins/SHA512SUMS` (hex, `sha512sum -c` format) and
 * `<out>/plugins/integrity.json` (SRI), so a release that fails half-way still leaves the checksums of
 * what it did publish.
 */
export async function runPublish(
  opts: RunPublishOptions,
): Promise<{ published: string[]; skipped: string[] }> {
  const root = opts.root ?? REPO_ROOT;
  const out = resolve(opts.out);
  const lookup = opts.publishedVersions ?? fetchPublishedVersions;
  const exec = opts.exec ?? run;
  const packTgz =
    opts.packPluginTgz ?? (async (dir: string, o: string) => (await packPlugin(dir, o)).file);
  const readManifest = opts.readPackedManifest ?? readTgzManifest;
  const pkgs = discoverWorkspace(root);
  const published = new Map<string, readonly string[]>();
  for (const p of pkgs) if (!p.private) published.set(p.name, await lookup(p.name));

  if (opts.refuseFirstRelease === true && isFirstRelease(pkgs, published)) {
    console.log(
      "nothing is on the registry yet: the first release is published only by running the " +
        "release workflow manually (workflow_dispatch)",
    );
    return { published: [], skipped: [] };
  }

  const steps = planPublish(pkgs, published);
  const planned = new Set(steps.map((s) => s.name));
  const skipped = pkgs
    .filter((p) => !p.private && !planned.has(p.name))
    .map((p) => `${p.name}@${p.version}`)
    .sort();
  for (const s of skipped) console.log(`skip    ${s} (already on the registry)`);
  for (const s of steps)
    console.log(`publish ${s.name}@${s.version} (${s.kind}, ${s.dir}, tag ${s.tag})`);
  if (steps.length === 0) {
    console.log("nothing to publish");
    return { published: [], skipped };
  }

  await rm(out, { recursive: true, force: true });
  const pluginsOut = join(out, "plugins");
  const packagesOut = join(out, "packages");
  await mkdir(pluginsOut, { recursive: true });
  await mkdir(packagesOut, { recursive: true });
  const done: string[] = [];
  const sums: string[] = [];
  const integrity: { name: string; version: string; file: string; integrity: string }[] = [];
  for (const step of steps) {
    const dir = join(root, step.dir);
    let file: string;
    if (step.kind === "plugin-tgz") file = await packTgz(dir, pluginsOut);
    else {
      if (!existsSync(join(dir, "dist"))) {
        throw new Error(`${step.dir}/dist is missing: run \`pnpm build\` before releasing`);
      }
      // pnpm pack rewrites `workspace:` ranges and applies publishConfig; npm publish adds provenance.
      await exec("pnpm", ["pack", "--pack-destination", packagesOut], dir);
      file = join(packagesOut, tgzName(step.name, step.version));
      if (!existsSync(file)) throw new Error(`pnpm pack did not produce ${file}`);
      const issues = packedManifestIssues(readManifest(file));
      if (issues.length > 0) throw new Error(`${basename(file)}: ${issues.join("; ")}`);
    }
    const args = ["publish", file, "--access", "public", "--tag", step.tag];
    if (opts.provenance) args.push("--provenance");
    if (opts.dryRun) args.push("--dry-run");
    await exec("npm", args, root);
    done.push(`${step.name}@${step.version}`);
    opts.onPublished?.(done.length);
    if (step.kind === "plugin-tgz") {
      const bytes = await readFile(file);
      sums.push(`${createHash("sha512").update(bytes).digest("hex")}  ${basename(file)}`);
      integrity.push({
        name: step.name,
        version: step.version,
        file: basename(file),
        integrity: integrityOf(bytes),
      });
      await writeFile(join(pluginsOut, "SHA512SUMS"), sums.map((l) => `${l}\n`).join(""));
      await writeFile(
        join(pluginsOut, "integrity.json"),
        `${JSON.stringify(integrity, null, 2)}\n`,
      );
    }
  }
  return { published: done, skipped };
}
