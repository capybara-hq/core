import { createRequire } from "node:module";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { isSafePackagePath } from "@capybara-hq/plugin-sdk";
import { extract as tarExtract, pack as tarPack } from "tar-stream";

/**
 * Unpacking a package tgz (npm pack layout, every entry under `package/`) and reading its
 * `package.json`, shared by the plugin package reader (`catalog/plugin-package.ts`) and the
 * extension package reader (`extensions/package.ts`). The tgz is always hostile input:
 *
 * - at most `maxBytes` compressed (the caller passes `packages.maxBytes`); `zlib.gunzip`'s
 *   `maxOutputLength` caps the **actual** unpacked bytes ({@link PACKAGE_TGZ_LIMITS}.maxUnpackedBytes),
 *   stopping decompression bombs. The package and its content are handled in memory.
 * - the tar is parsed with tar-stream (3.2.2, pinned): in memory only, never the file system (unlike
 *   node-tar's extract, with its history of path traversal / symlink CVEs), header checksums checked,
 *   pax / GNU long names handled; it only hands over raw headers and every decision is made here.
 * - only regular files and directories: symlinks, hard links, devices, fifos are refused; at most
 *   {@link PACKAGE_TGZ_LIMITS}.maxEntries entries; paths under `package/` and safe (plugin-sdk
 *   `isSafePackagePath`: no `..`, `.`, empty segments, backslashes, control characters, drive
 *   letters), deduplicated case-insensitively (they would overwrite each other on a case-insensitive
 *   file system); no `node_modules/`, `*.node`, `binding.gyp`.
 * - `package.json` at most {@link PACKAGE_TGZ_LIMITS}.maxPackageJsonBytes, strict UTF-8 +
 *   `JSON.parse`.
 *
 * Problems throw {@link PackageTgzError}; each reader maps it to its own error.
 */

/** Limits on unpacking and on `package.json`. */
export const PACKAGE_TGZ_LIMITS = {
  /** Total unpacked tar bytes. */
  maxUnpackedBytes: 256 * 1024 * 1024,
  /** Tar entries (directories included). */
  maxEntries: 5000,
  /** Bytes of `package.json`. */
  maxPackageJsonBytes: 1024 * 1024,
} as const;

/**
 * The host's zod version (a plugin package's `peerDependencies.zod` must be satisfied by it: the
 * plugin uses this zod when loaded). Resolved from the kernel's own dependencies, the same package
 * `syncPackage` links for extensions.
 */
export const HOST_ZOD_VERSION: string = (
  createRequire(import.meta.url)("zod/package.json") as { version: string }
).version;

/** The message for a tgz in the pre-0.1.0 format (follows the package's name). */
export const LEGACY_FORMAT_MESSAGE =
  "uses the pre-0.1.0 package format (capybara section / app.yaml); repack it as a plugin with .capybara-plugin/plugin.json (pnpm pack-plugin)";

/** `./skills/x` → `skills/x` (manifest paths start with `./`). */
export const packagePath = (p: string): string => p.replace(/^\.\//, "").replace(/\/+$/, "");

/** A tgz or `package.json` problem; `issues` lists them (English, shown to the admin). */
export class PackageTgzError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues[0] ?? "unknown problem");
    this.name = "PackageTgzError";
    this.issues = issues;
  }
}

/** Unpack limits: `maxBytes` is `packages.maxBytes`; the rest default to {@link PACKAGE_TGZ_LIMITS}. */
export interface PackageTgzLimits {
  maxBytes: number;
  maxUnpackedBytes?: number;
  maxEntries?: number;
}

/** A file in the tgz (path relative to the package root, `package/` removed). */
export interface PackageFile {
  path: string;
  data: Buffer;
}

/** The npm pack prefix of every entry. */
const PREFIX = "package/";

const fail = (issue: string): never => {
  throw new PackageTgzError([issue]);
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const isForbiddenFile = (path: string): string | undefined => {
  const segs = path.split("/");
  if (segs.includes("node_modules")) return `${path}: node_modules/ is not allowed`;
  const base = segs[segs.length - 1] as string;
  if (base === "binding.gyp") return `${path}: binding.gyp is not allowed (native addons)`;
  if (base.endsWith(".node")) return `${path}: native addon (.node) files are not allowed`;
  return undefined;
};

/** Decompresses and parses the tar and returns the files in it (with `package/` removed from paths). Anything non-conforming -> {@link PackageTgzError}. */
async function unpack(
  bytes: Uint8Array,
  opts: { maxBytes: number; maxUnpackedBytes: number; maxEntries: number },
): Promise<PackageFile[]> {
  if (bytes.byteLength > opts.maxBytes) {
    fail(`the package is larger than ${opts.maxBytes} bytes`);
  }
  let tarBuf: Buffer;
  try {
    tarBuf = await promisify(gunzip)(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      {
        maxOutputLength: opts.maxUnpackedBytes,
      },
    );
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError) {
      throw new PackageTgzError([
        `the package is larger than ${opts.maxUnpackedBytes} bytes unpacked`,
      ]);
    }
    throw new PackageTgzError(["the file is not a gzip-compressed tar archive"]);
  }

  const files: PackageFile[] = [];
  const seen = new Set<string>();
  const dirs = new Set<string>();
  let entries = 0;
  const ex = tarExtract();
  ex.end(tarBuf);
  try {
    for await (const entry of ex) {
      const h = entry.header;
      entries++;
      if (entries > opts.maxEntries) fail(`the package has more than ${opts.maxEntries} entries`);
      const raw = String(h.name);
      const type = h.type as string | null;
      if (type !== "file" && type !== "directory") {
        entry.resume();
        fail(`${raw}: ${type ?? "unknown"} entries are not allowed (only regular files)`);
      }
      const name = type === "directory" && raw.endsWith("/") ? raw.slice(0, -1) : raw;
      if (!name.startsWith(PREFIX) && name !== PREFIX.slice(0, -1)) {
        entry.resume();
        fail(`${raw}: every entry must be under package/`);
      }
      const rel = name.slice(PREFIX.length);
      if (type === "directory") {
        entry.resume();
        if (rel !== "" && !isSafePackagePath(rel)) fail(`${raw}: unsafe path`);
        continue;
      }
      if (!isSafePackagePath(rel)) {
        entry.resume();
        fail(`${raw}: unsafe path`);
      }
      const forbidden = isForbiddenFile(rel);
      if (forbidden) {
        entry.resume();
        fail(forbidden);
      }
      const key = rel.toLowerCase();
      if (seen.has(key) || dirs.has(key)) {
        entry.resume();
        fail(`${raw}: duplicate path (paths are compared case-insensitively)`);
      }
      seen.add(key);
      const segs = key.split("/");
      for (let i = 1; i < segs.length; i++) {
        const d = segs.slice(0, i).join("/");
        if (seen.has(d)) fail(`${raw}: path conflicts with file "${d}"`);
        dirs.add(d);
      }
      const chunks: Buffer[] = [];
      for await (const c of entry) chunks.push(c as Buffer);
      // One chunk is used as is (no copy); only several are concatenated
      files.push({
        path: rel,
        data: chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks),
      });
    }
  } catch (e) {
    ex.destroy();
    if (e instanceof PackageTgzError) throw e;
    fail(`the tar archive is malformed: ${errMsg(e)}`);
  }
  return files;
}

const utf8 = (path: string, data: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return fail(`${path} is not valid UTF-8 text`);
  }
};

/**
 * Unpacks a tgz by the rules in the file header, without looking at the content. Invalid ->
 * {@link PackageTgzError}.
 */
export function unpackPackageTgz(
  bytes: Uint8Array,
  limits: PackageTgzLimits,
): Promise<PackageFile[]> {
  return unpack(bytes, {
    maxBytes: limits.maxBytes,
    maxUnpackedBytes: limits.maxUnpackedBytes ?? PACKAGE_TGZ_LIMITS.maxUnpackedBytes,
    maxEntries: limits.maxEntries ?? PACKAGE_TGZ_LIMITS.maxEntries,
  });
}

/**
 * Reads the package's `package.json`: it must exist, be at most
 * {@link PACKAGE_TGZ_LIMITS}.maxPackageJsonBytes and strict UTF-8 JSON. Invalid ->
 * {@link PackageTgzError}. Returns the parse result (shape not validated).
 */
export function parsePackageJsonFile(file: { data: Uint8Array } | undefined): unknown {
  if (!file) return fail("package.json not found in the package");
  if (file.data.byteLength > PACKAGE_TGZ_LIMITS.maxPackageJsonBytes) {
    fail(`package.json is larger than ${PACKAGE_TGZ_LIMITS.maxPackageJsonBytes} bytes`);
  }
  const text = utf8("package.json", file.data);
  try {
    return JSON.parse(text);
  } catch {
    return fail("package.json is not valid JSON");
  }
}

/**
 * Packs files (paths relative to the package root) as an npm-pack style tgz under `package/`,
 * deterministically: sorted paths, mode 0644, mtime 0, so the same files always give the same bytes
 * (and the same package store key). Used for a git plugin with an extension, whose extension is
 * stored and installed as a package like any other. The result is read back with the tgz rules.
 */
export async function packPackageTgz(files: ReadonlyMap<string, Uint8Array>): Promise<Uint8Array> {
  const p = tarPack();
  const chunks: Buffer[] = [];
  const done = (async () => {
    for await (const c of p) chunks.push(c as Buffer);
  })();
  for (const path of [...files.keys()].sort()) {
    const data = Buffer.from(files.get(path) as Uint8Array);
    await new Promise<void>((resolve, reject) =>
      p.entry(
        {
          name: `${PREFIX}${path}`,
          type: "file",
          mode: 0o644,
          mtime: new Date(0),
          size: data.length,
        },
        data,
        (err) => (err ? reject(err) : resolve()),
      ),
    );
  }
  p.finalize();
  await done;
  return new Uint8Array(await promisify(gzip)(Buffer.concat(chunks)));
}
