import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BootstrapExtraMarketplace, Logger } from "@capybara-hq/plugin-sdk";
import { GitSourceError, normalGitPath, readGitTreeAndOids } from "../catalog/git-source.js";
import { marketplaceNetPolicy, marketplaceUrlProblem } from "../catalog/marketplace-fetch.js";
import { marketplaceForm } from "../catalog/marketplaces.service.js";
import type { KernelConfig } from "../config/schema.js";
import { ApiError } from "../errors.js";
import {
  fetchNpmPackage,
  IntegrityMismatchError,
  NpmFetchError,
  PackageTooLargeError,
} from "../packages/npm.js";
import { packPackageTgz } from "../packages/tgz.js";
import type {
  BootstrapGitRunEntry,
  MergedBootstrapEntry,
  MergedBootstrapManifest,
} from "./bootstrap-extra.js";

/**
 * Obtaining the packages of a bootstrap run (spec 2026-11-20-bootstrap-extra-manifest §3, §8): the
 * offline directory, npm and git entries, each verified against its pinned sha512 before anything
 * reads it. Shared by the bootstrap step and `capybara bootstrap`.
 */

/** The sha512 integrity (`sha512-<base64>`) of a package's bytes. */
export const integrityOf = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** What {@link resolveBootstrapPackages} needs from the kernel config. */
export interface BootstrapResolveOptions {
  /**
   * The offline directory: every `*.tgz` directly in it is matched to the entries by sha512.
   * Omitted or missing: no offline packages.
   */
  dir?: string;
  config: Pick<KernelConfig, "packages" | "marketplaces" | "net">;
  signal?: AbortSignal;
  log?: Pick<Logger, "warn">;
  /** The npm download (default {@link fetchNpmPackage}; tests replace it). */
  fetch?: typeof fetchNpmPackage;
  /**
   * Entries whose package failing to be obtained is that entry's failure only: the error goes into
   * `failed` (by entry name) and the other entries are still obtained. Every other entry's failure
   * throws, so nothing is written.
   */
  soft?: (e: MergedBootstrapEntry) => boolean;
  failed?: Map<string, ApiError>;
  /**
   * The credential of an extra-manifest marketplace (by name) for its git entries; default: the
   * token `marketplaces.tokens[name]` (never the file or the secrets table) and the manifest's
   * `username`. It is sent only to that marketplace URL's origin.
   */
  gitCredentials?: (marketplace: string) => { token?: string; username?: string };
  /** Filled with the git tree oid of each git entry read from git (by entry name). */
  gitTrees?: Map<string, string>;
}

/**
 * The marketplace a git entry names, its URL expanded as the managed row's (`config:<name>`) is and
 * checked as an admin-added one is (`bootstrap.extra_invalid` otherwise).
 */
export function bootstrapGitMarketplace(
  manifest: Pick<MergedBootstrapManifest, "extra">,
  e: BootstrapGitRunEntry,
  config: Pick<KernelConfig, "marketplaces">,
): BootstrapExtraMarketplace {
  const m = manifest.extra?.marketplaces.find((x) => x.name === e.marketplace);
  const invalid = (why: string) =>
    new ApiError(
      "bootstrap.extra_invalid",
      `Bootstrap plugin ${e.name} ${e.version}: marketplace ${e.marketplace} ${why}`,
    );
  if (m === undefined) throw invalid("is not declared in the extra bootstrap manifest");
  const { form, url } = marketplaceForm(m.url);
  if (form !== "git") throw invalid("is not a git repository");
  const problem = marketplaceUrlProblem(url, config.marketplaces.allowInsecureLoopback);
  if (problem !== null) throw invalid(`has an unusable url: ${problem}`);
  return { ...m, url };
}

/**
 * Obtains every entry's tgz, checked against its pinned sha512: from the offline directory when a
 * file there has that sha512, else (a `source: "npm"` entry) downloaded from the npm registry and
 * verified against the pin (the packument's `dist.integrity` is not consulted), else (a
 * `source: "git"` entry) its marketplace's tree at the pinned commit, the files under `path`
 * re-rooted and packed with `packPackageTgz` (the pin is defined on that pack), refused unless the
 * pack's sha512 is the pin: nothing of an unverified tree is read, translated or imported. The
 * marketplace's token and username go only to its URL's origin. Throws an {@link ApiError} naming
 * the plugin for the first entry it cannot obtain (`bootstrap.missing_file`,
 * `bootstrap.download_failed`, `bootstrap.git_read_failed`, `bootstrap.integrity_mismatch`), except
 * for the `soft` entries (recorded in `failed`, left out of the result).
 */
export async function resolveBootstrapPackages(
  manifest: MergedBootstrapManifest,
  o: BootstrapResolveOptions,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  if (manifest.plugins.length === 0) return out;
  const { npmRegistry, npmToken, maxBytes } = o.config.packages;
  const offline = o.dir !== undefined ? await scanOfflineDir(o.dir, maxBytes, o.log) : new Map();
  const fetchPackage = o.fetch ?? fetchNpmPackage;
  const signal = o.signal ?? new AbortController().signal;
  const where = o.dir !== undefined ? o.dir : "the bootstrap directory (config bootstrap.dir)";
  for (const e of manifest.plugins) {
    signal.throwIfAborted();
    try {
      out.set(e.name, await obtain(e));
    } catch (err) {
      if (signal.aborted || !(err instanceof ApiError) || o.soft?.(e) !== true) throw err;
      o.failed?.set(e.name, err);
    }
  }
  return out;

  async function obtain(e: MergedBootstrapEntry): Promise<Uint8Array> {
    const found = offline.get(e.integrity);
    if (found !== undefined) return found;
    if (e.source === "git") return obtainGit(e);
    if (e.source === "workspace") {
      throw new ApiError(
        "bootstrap.missing_file",
        `Bootstrap plugin ${e.name} ${e.version}: no file in ${where} has its pinned sha512 (${e.integrity.slice(0, 19)}…), and a workspace entry cannot be downloaded; put its package tgz (pnpm pack-plugin ${e.path}) in that directory`,
      );
    }
    const registry = registryOrigin(npmRegistry);
    const offlineHint = `to install offline, put the package tgz (npm pack ${e.npm}@${e.version}, any file name) in ${where}`;
    try {
      const r = await fetchPackage(
        {
          registry: npmRegistry,
          ...(npmToken !== undefined && { token: npmToken }),
          maxBytes,
          net: marketplaceNetPolicy(o.config),
        },
        e.npm,
        e.version,
        signal,
        { expectedIntegrity: e.integrity },
      );
      return r.bytes;
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof IntegrityMismatchError) {
        throw new ApiError(
          "bootstrap.integrity_mismatch",
          `Bootstrap plugin ${e.name} ${e.version}: the package ${e.npm}@${e.version} downloaded from ${registry} does not match its pinned sha512 (expected ${e.integrity.slice(0, 19)}…, got ${err.actual.slice(0, 19)}…); refusing to install anything`,
        );
      }
      const reason =
        err instanceof NpmFetchError || err instanceof PackageTooLargeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      throw new ApiError(
        "bootstrap.download_failed",
        `Bootstrap plugin ${e.name} ${e.version}: cannot download ${e.npm}@${e.version} from ${registry} (${reason}); ${offlineHint}, or set packages.npmRegistry to a reachable mirror`,
      );
    }
  }

  async function obtainGit(e: BootstrapGitRunEntry): Promise<Uint8Array> {
    const m = bootstrapGitMarketplace(manifest, e, o.config);
    const u = new URL(m.url);
    const at = `${e.path} at ${e.commit.slice(0, 12)} of marketplace ${m.name} (${u.origin}${u.pathname})`;
    const cred = (o.gitCredentials ?? defaultGitCredentials)(m.name);
    const token = cred.token !== undefined && cred.token !== "" ? cred.token : undefined;
    const dir = normalGitPath(e.path);
    let read: Awaited<ReturnType<typeof readGitTreeAndOids>>;
    try {
      read = await readGitTreeAndOids(
        { url: m.url, commit: e.commit, path: e.path },
        {
          net: marketplaceNetPolicy(o.config),
          maxBytes,
          signal,
          ...(token !== undefined && {
            token,
            tokenOrigin: u.origin,
            ...(cred.username !== undefined && cred.username !== "" && { username: cred.username }),
          }),
          trees: () => [dir],
        },
      );
    } catch (err) {
      if (signal.aborted) throw err;
      // git-source messages never carry the token; redacted all the same, it is a credential
      const reason = errMsg(err);
      const redacted = token !== undefined ? reason.replaceAll(token, "***") : reason;
      // A bootstrap entry pins a commit by its sha: a ref tip is not what it can change to
      const message =
        err instanceof GitSourceError && err.refusedCommit !== undefined
          ? `the host refused to send commit ${err.refusedCommit} by its sha. The commit must be fetchable by its sha (GitHub: always; GitLab, Gitea and other hosts: only when fetching unadvertised commits is allowed, e.g. git's uploadpack.allowReachableSHA1InWant or the host's equivalent), or pin the commit of a tag and keep the tag, or put its pack (capybara-plugin bootstrap --write --out <dir>) in the offline directory, ${where}`
          : `${redacted}; to install offline, put its pack (capybara-plugin bootstrap --write) in ${where}`;
      throw new ApiError(
        "bootstrap.git_read_failed",
        `Bootstrap plugin ${e.name} ${e.version}: cannot read ${at}: ${message}`,
      );
    }
    const pack = await packPackageTgz(read.files);
    const actual = integrityOf(pack);
    if (actual !== e.integrity) {
      throw new ApiError(
        "bootstrap.integrity_mismatch",
        `Bootstrap plugin ${e.name} ${e.version}: ${at} packs to another sha512 than its pin (expected ${e.integrity.slice(0, 19)}…, got ${actual.slice(0, 19)}…); refusing to install anything`,
      );
    }
    const tree = read.trees.get(dir);
    if (tree !== undefined) o.gitTrees?.set(e.name, tree);
    return pack;
  }

  function defaultGitCredentials(name: string): { token?: string; username?: string } {
    const tokens = o.config.marketplaces.tokens;
    const username = manifest.extra?.marketplaces.find((x) => x.name === name)?.username;
    return {
      ...(Object.hasOwn(tokens, name) && { token: tokens[name] }),
      ...(username !== undefined && { username }),
    };
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The registry's origin, for messages (never its credentials or path). */
function registryOrigin(registry: string): string {
  try {
    return new URL(registry).origin;
  } catch {
    return "the configured npm registry";
  }
}

/**
 * The `*.tgz` files directly in `dir` by their sha512 integrity. A missing directory is an empty
 * one; a file larger than `maxBytes` is skipped with a warning.
 */
async function scanOfflineDir(
  dir: string,
  maxBytes: number,
  log: Pick<Logger, "warn"> | undefined,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return out;
    throw err;
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".tgz")) continue;
    const file = join(dir, name);
    const st = await stat(file).catch(() => undefined);
    if (!st?.isFile()) continue;
    if (st.size > maxBytes) {
      log?.warn("bootstrap: a file in the bootstrap directory exceeds packages.maxBytes; skipped", {
        file,
        size: st.size,
        maxBytes,
      });
      continue;
    }
    const bytes = new Uint8Array(await readFile(file));
    const integrity = integrityOf(bytes);
    if (!out.has(integrity)) out.set(integrity, bytes);
  }
  return out;
}
