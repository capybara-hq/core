import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { SandboxRoots } from "@capybara-hq/plugin-sdk";
import { DeviceOpError } from "./types.js";

/** The file that marks a directory as a device directory this program has used. */
export const ROOT_MARKER = ".capybara-device";

/** How long a finished command's output pipes may stay open (held by a background child). */
export const PIPE_GRACE_MS = 200;

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The roots of a device directory: `<dir>/workspace`, `<dir>/skills`, `<dir>/tmp`. */
export function osRoots(dir: string): SandboxRoots {
  return { workspace: join(dir, "workspace"), skills: join(dir, "skills"), tmp: join(dir, "tmp") };
}

/** The device's package caches: `<dir>/cache`, outside the workspace (spec §5.2.1). */
export function cacheRoot(dir: string): string {
  return join(dir, "cache");
}

/** Each cache variable of `dev` / `open` and its folder under the cache root. */
const CACHE_DIRS: readonly (readonly [string, string])[] = [
  ["XDG_CACHE_HOME", "xdg"],
  ["npm_config_cache", "npm"],
  ["npm_config_store_dir", "pnpm-store"],
  ["PIP_CACHE_DIR", "pip"],
  ["UV_CACHE_DIR", "uv"],
  ["CARGO_HOME", "cargo"],
  ["GOMODCACHE", "go-mod"],
  ["GOCACHE", "go-build"],
  ["GRADLE_USER_HOME", "gradle"],
  ["MAVEN_OPTS", "maven"],
  ["PLAYWRIGHT_BROWSERS_PATH", "ms-playwright"],
  ["COREPACK_HOME", "corepack"],
];

/**
 * Makes one cache folder a real directory: a file or a link a sandboxed command put in its place
 * is removed (never followed) and the folder made again. False when it still cannot be made.
 */
function ensureCacheFolder(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (st.isDirectory()) return true;
    // unlink, not rm: rm skips a link whose target is missing.
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The cache variables of `dev` / `open` (spec §5.2.1), each pointing at a folder of `root`
 * (`MAVEN_OPTS` as `-Dmaven.repo.local=<folder>`). With `create`, the folders are made on demand;
 * a folder that cannot be made (a command replaced it with something this program cannot remove)
 * leaves its variable out, so one broken cache never stops the next command. A command's own
 * value wins: callers apply the request's environment after these.
 */
export function cacheEnv(root: string, opts: { create?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, sub] of CACHE_DIRS) {
    const path = join(root, sub);
    if (opts.create === true && !ensureCacheFolder(path)) continue;
    out[name] = name === "MAVEN_OPTS" ? `-Dmaven.repo.local=${path}` : path;
  }
  return out;
}

/**
 * The short socket directory of a device on macOS (spec §5.2.3): `<base>/cap-<first 8 hex of the
 * device's key>`, short enough for Chromium's singleton socket (unix socket paths stop at 104
 * bytes). `base` is `/private/tmp` outside tests.
 */
export function socketDirPath(dirKey: string, base = "/private/tmp"): string {
  return join(base, `cap-${dirKey.slice(0, 8)}`);
}

/**
 * Creates the socket directory (mode 0700), or checks an existing one is a real directory of this
 * user and makes it 0700 again. The check and the mode change go through one descriptor opened
 * without following links, so a link swapped in meanwhile (the shared /tmp is sticky, not
 * private) is refused, never followed. Returns undefined when the path is taken by something else
 * (another user's directory, a file or a link): commands then use the tmp root.
 */
export function prepareSocketDir(
  path: string,
  uid: number | undefined = process.getuid?.(),
): string | undefined {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) return undefined;
    if ((st.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
    return path;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * The longest prefix of `b` that does not end inside a UTF-8 sequence (a cut buffer's tail is
 * dropped instead of decoding to U+FFFD).
 */
export function utf8Prefix(b: Buffer): Buffer {
  let i = b.length - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && ((b[i] as number) & 0xc0) === 0x80) {
    i--;
    cont++;
  }
  if (i < 0) return b;
  const lead = b[i] as number;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return b.length - i >= need ? b : b.subarray(0, i);
}

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

export function isUnder(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

export function policyError(message: string): DeviceOpError {
  return new DeviceOpError("policy", message);
}

export function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Captures stdout and stderr up to a combined byte budget; the rest is drained and dropped. */
export class OutputCap {
  private readonly chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  private readonly cut = { stdout: false, stderr: false };
  private used = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(stream: "stdout" | "stderr", buf: Buffer): void {
    const room = this.max - this.used;
    if (buf.length <= room) {
      this.chunks[stream].push(buf);
      this.used += buf.length;
      return;
    }
    if (room > 0) this.chunks[stream].push(buf.subarray(0, room));
    this.used = this.max;
    this.truncated = true;
    this.cut[stream] = true;
  }

  text(stream: "stdout" | "stderr"): string {
    const all = Buffer.concat(this.chunks[stream]);
    return (this.cut[stream] ? utf8Prefix(all) : all).toString("utf8");
  }
}

const MARKER_TEXT = "This directory is a capybara-device directory.\n";

/**
 * Creates (or completes) a device directory: the marker and the three roots. Only `login`
 * calls it, so logging in again after the files were lost starts the device afresh.
 */
export function prepareDeviceDir(dir: string): void {
  for (const r of Object.values(osRoots(dir))) mkdirSync(r, { recursive: true });
  const marker = join(dir, ROOT_MARKER);
  if (!existsSync(marker)) writeFileSync(marker, MARKER_TEXT);
}

/**
 * The device directory's marker and roots. Once the marker exists, the directory, the marker
 * or any root vanishing is "gone": nothing is recreated silently (log in again to start afresh).
 */
export class RootGuard {
  /** The marker was seen in this process: its vanishing means the directory was removed. */
  private seen = false;

  constructor(
    private readonly dir: string,
    private readonly roots: SandboxRoots,
  ) {}

  ensure(): "ok" | "gone" {
    const marker = join(this.dir, ROOT_MARKER);
    const rootList = [this.roots.workspace, this.roots.skills, this.roots.tmp];
    if (existsSync(marker)) {
      this.seen = true;
      // A root removed under a marked directory lost its files: never recreate it empty.
      return rootList.every((r) => existsSync(r)) ? "ok" : "gone";
    }
    // login creates the directory, so a missing one was removed after login.
    if (this.seen || !existsSync(this.dir)) return "gone";
    writeFileSync(marker, MARKER_TEXT);
    this.seen = true;
    for (const r of rootList) mkdirSync(r, { recursive: true });
    return "ok";
  }
}

/**
 * Host-side file access under the three roots (real paths, symlinks resolved, refused when they
 * leave a root). Used for the skills root, which commands can only read, so nothing can race it.
 */
export class HostFiles {
  constructor(private readonly roots: SandboxRoots) {}

  /** `path` made absolute and normalized; refused unless it is lexically under a root. */
  lexical(path: string): string {
    if (!isAbsolute(path)) throw policyError(`${path} is not an absolute path`);
    const p = resolve(path);
    if (!this.rootList().some((r) => isUnder(p, r))) {
      throw policyError(`${path} is outside the device's roots (${this.rootList().join(", ")})`);
    }
    return p;
  }

  /** The real path of an existing `path`, refused unless under a root after resolving links; null when missing. */
  async existing(path: string): Promise<string | null> {
    const p = this.lexical(path);
    let real: string;
    try {
      real = await realpath(p);
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
    return this.checkReal(path, real);
  }

  /** The real path of an existing `path` under a root (symlinks resolved); refused otherwise. */
  async inside(path: string, what: string): Promise<string> {
    const p = this.lexical(path);
    let real: string;
    try {
      real = await realpath(p);
    } catch (e) {
      if (isMissing(e)) throw new DeviceOpError("error", `${what} ${path} does not exist`);
      throw e;
    }
    return this.checkReal(path, real);
  }

  private async checkReal(path: string, real: string): Promise<string> {
    const roots = await Promise.all(this.rootList().map((r) => realpath(r).catch(() => r)));
    if (!roots.some((r) => isUnder(real, r))) {
      throw policyError(`${path} resolves to ${real}, outside the device's roots`);
    }
    return real;
  }

  private rootList(): string[] {
    return [this.roots.workspace, this.roots.skills, this.roots.tmp];
  }

  async read(
    path: string,
    maxBytes: number,
  ): Promise<{ data: Uint8Array; truncated: boolean } | null> {
    const real = await this.existing(path);
    if (real === null) return null;
    const fh = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const st = await fh.stat();
      if (st.isDirectory()) return null;
      if (!st.isFile()) throw policyError(`${path} is not a regular file`);
      const want = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(want);
      let off = 0;
      while (off < want) {
        const { bytesRead } = await fh.read(buf, off, want - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      return { data: buf.subarray(0, off), truncated: st.size > maxBytes };
    } finally {
      await fh.close();
    }
  }

  async stat(path: string): Promise<{ size: number; isDir: boolean } | null> {
    const real = await this.existing(path);
    if (real === null) return null;
    const st = await lstat(real);
    return { size: st.size, isDir: st.isDirectory() };
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const target = this.lexical(path);
    const parent = dirname(target);
    // Check the nearest existing ancestor before creating anything beneath it.
    let ancestor = parent;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    await this.inside(ancestor, "path");
    await mkdir(parent, { recursive: true });
    const realParent = await this.inside(parent, "path");
    let file = join(realParent, basename(target));
    const st = await lstat(file).catch((e: unknown) => {
      if (isMissing(e)) return null;
      throw e;
    });
    if (st?.isSymbolicLink()) {
      const real = await realpath(file).catch((e: unknown) => {
        if (isMissing(e)) throw policyError(`${path} is a dangling symbolic link`);
        throw e;
      });
      file = await this.inside(real, "path");
    }
    const fh = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      if (!(await fh.stat()).isFile()) throw policyError(`${path} is not a regular file`);
      await fh.truncate(0);
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
  }
}
