import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { packPackageTgz } from "@capybara-hq/kernel";
import {
  type BootstrapExtraManifest,
  type BootstrapGitEntry,
  parseBootstrapExtraManifest,
} from "@capybara-hq/plugin-sdk";
import type { Finding } from "../check/source.js";
import { integrityOf } from "../integrity.js";
import { fetchNpmTarball } from "../pack/npm.js";
import { registryUrl } from "../release/publish.js";

const exec = promisify(execFile);

/** `bootstrap-extra-invalid`, `bootstrap-extra-integrity` and `bootstrap-extra-path` findings. */
export const BOOTSTRAP_EXTRA_FILE = "bootstrap.extra.json";

export interface BootstrapExtraOptions {
  /** The local clone `git` entries are read from. */
  root: string;
  /** The extra manifest (absolute). */
  file: string;
  write: boolean;
  /** `--write`: where `<name>-<version>.tgz` is written (the offline directory). */
  out?: string;
  /** Also compare `npm` entries with the registry. */
  network?: boolean;
}

export interface BootstrapExtraResult {
  findings: Finding[];
  /** `--write`: the packs written, as `<name>-<version>.tgz`. */
  packs: string[];
  /** `--write`: the entries whose pin changed. */
  updated: string[];
}

const git = async (root: string, args: string[]) =>
  (await exec("git", ["-C", root, ...args], { encoding: "buffer", maxBuffer: 1 << 30 })).stdout;

/**
 * The files under `path` at `commit` in the local repository, relative to `path` (git plumbing,
 * not the kernel's HTTP reader whose URL rules refuse `file://`). The mapping is the kernel's git
 * import: every blob under the directory, paths re-rooted at it; symlinks and submodules refused.
 */
export async function readTree(
  root: string,
  commit: string,
  path: string,
): Promise<Map<string, Uint8Array>> {
  const dir = path.replace(/^\.\//, "").replace(/\/+$/, "");
  // `.` and `./` are the repository root, as in the kernel: no pathspec, nothing to strip
  const atRoot = dir === "" || dir === ".";
  const listing = (
    await git(root, ["ls-tree", "-r", "-z", "--full-tree", commit, ...(atRoot ? [] : ["--", dir])])
  ).toString("utf8");
  const files = new Map<string, Uint8Array>();
  for (const rec of listing.split("\0")) {
    if (rec === "") continue;
    const tab = rec.indexOf("\t");
    const [mode, type, oid] = rec.slice(0, tab).split(" ") as [string, string, string];
    const p = rec.slice(tab + 1);
    if (mode === "120000") throw new Error(`${p} is a symlink`);
    if (type !== "blob") throw new Error(`${p} is a ${type}`);
    files.set(
      atRoot ? p : p.slice(dir.length + 1),
      new Uint8Array(await git(root, ["cat-file", "blob", oid])),
    );
  }
  if (files.size === 0) throw new Error(`no files under ${path}`);
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const message = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0] ?? m;
};

/**
 * Checks (or, with `write`, pins) the extra bootstrap manifest: it parses; each `git` entry's tree
 * at `commit` packs with the kernel's `packPackageTgz` to `integrity`; with `network`, `npm`
 * entries match the registry. `write` sets each `git` entry's `commit` to HEAD, its `version` from
 * `plugin.json` and its `integrity`, and writes the packs into `out`.
 */
export async function syncBootstrapExtra(
  opts: BootstrapExtraOptions,
): Promise<BootstrapExtraResult> {
  const findings: Finding[] = [];
  const result: BootstrapExtraResult = { findings, packs: [], updated: [] };
  const add = (rule: string, msg: string) =>
    findings.push({ file: opts.file, line: 1, rule, message: msg });
  let manifest: BootstrapExtraManifest;
  try {
    const parsed = parseBootstrapExtraManifest(JSON.parse(readFileSync(opts.file, "utf8")));
    if ("errors" in parsed) {
      for (const e of parsed.errors) add("bootstrap-extra-invalid", e);
      return result;
    }
    manifest = parsed.manifest;
  } catch (e) {
    add("bootstrap-extra-invalid", message(e));
    return result;
  }
  let head: string | undefined;
  if (opts.write) {
    try {
      head = (await git(opts.root, ["rev-parse", "HEAD"])).toString("utf8").trim();
    } catch (e) {
      add("bootstrap-extra-path", `cannot read HEAD of ${opts.root}: ${message(e)}`);
      return result;
    }
  }
  const git_ = manifest.plugins.filter((e): e is BootstrapGitEntry => e.source === "git");
  for (const e of git_) {
    const commit = head ?? e.commit;
    let files: Map<string, Uint8Array>;
    try {
      files = await readTree(opts.root, commit, e.path);
    } catch (err) {
      add("bootstrap-extra-path", `${e.name}: cannot read ${e.path} at ${commit}: ${message(err)}`);
      continue;
    }
    const pack = await packPackageTgz(files);
    const integrity = integrityOf(pack);
    if (!opts.write) {
      if (integrity !== e.integrity) {
        add(
          "bootstrap-extra-integrity",
          `${e.name}: ${e.path} at ${e.commit} packs to ${integrity}, not the pinned ${e.integrity}`,
        );
      }
      continue;
    }
    let version: string;
    try {
      const raw = files.get(".capybara-plugin/plugin.json");
      if (raw === undefined) throw new Error("no .capybara-plugin/plugin.json");
      const v = (JSON.parse(Buffer.from(raw).toString("utf8")) as { version?: unknown }).version;
      if (typeof v !== "string") throw new Error("plugin.json has no version");
      version = v;
    } catch (err) {
      add("bootstrap-extra-path", `${e.name}: ${e.path}: ${message(err)}`);
      continue;
    }
    if (e.commit !== commit || e.version !== version || e.integrity !== integrity) {
      result.updated.push(e.name);
    }
    e.commit = commit;
    e.version = version;
    e.integrity = integrity;
    if (opts.out !== undefined) {
      mkdirSync(opts.out, { recursive: true });
      const name = `${e.name}-${version}.tgz`;
      writeFileSync(join(opts.out, name), pack);
      result.packs.push(name);
    }
  }
  if (opts.network) {
    const token = process.env.CAPYBARA_PACKAGES__NPM_TOKEN;
    for (const e of manifest.plugins) {
      if (e.source !== "npm") continue;
      try {
        const r = await fetchNpmTarball(e.npm, e.version, registryUrl(), {
          ...(token !== undefined && token !== "" && { token }),
        });
        const actual = integrityOf(r.bytes);
        if (r.distIntegrity !== e.integrity || actual !== e.integrity) {
          add(
            "bootstrap-extra-integrity",
            `${e.name}: ${e.npm}@${e.version} on the registry is ${actual} (dist ${r.distIntegrity ?? "none"}), not the pinned ${e.integrity}`,
          );
        }
      } catch (err) {
        add("bootstrap-extra-integrity", `${e.name}: ${message(err)}`);
      }
    }
  }
  if (opts.write && findings.length === 0) {
    writeFileSync(opts.file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return result;
}
