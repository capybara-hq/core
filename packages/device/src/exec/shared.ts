import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
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

/** The device and inode of a real directory (never through a link); undefined otherwise. */
function realDirId(path: string): string | undefined {
  try {
    const st = lstatSync(path);
    return st.isDirectory() ? `${st.dev}:${st.ino}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Makes the cache root a real directory and returns its identity. Sandboxed commands may write
 * the root (it is under `<dir>/cache`), so they can replace it with a link to a host folder: a
 * link, a file or anything else in its place is unlinked (never followed) and the root made
 * again, mode 0700. Its real path must then be its parent's real path plus its name (nothing in
 * between resolves elsewhere). Undefined when it cannot be made a real directory.
 */
function ensureCacheRoot(root: string): string | undefined {
  try {
    const st = lstatSync(root);
    // unlink, not rm: rm skips a link whose target is missing, and never recurse into a target.
    if (!st.isDirectory()) unlinkSync(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
  }
  try {
    if (realpathSync(root) !== join(realpathSync(dirname(root)), basename(root))) return undefined;
  } catch {
    return undefined;
  }
  return realDirId(root);
}

/**
 * Makes one cache folder under a verified root: an existing real directory is used, a missing
 * one is made (not recursively, so nothing is made through a link). A file or a link a command
 * put in its place is left alone (never removed, never followed): its variable is left out.
 */
function ensureCacheFolder(path: string): boolean {
  if (realDirId(path) !== undefined) return true;
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    return false;
  }
  return realDirId(path) !== undefined;
}

/**
 * The cache variables of `dev` / `open` (spec §5.2.1), each pointing at a folder of `root`
 * (`MAVEN_OPTS` as `-Dmaven.repo.local=<folder>`). With `create` (on the host, before a
 * sandboxed command), the root is made a real directory first ({@link ensureCacheRoot}) and the
 * folders are made on demand; a folder that cannot be made leaves its variable out, and a root
 * that cannot be made, or that was swapped while the folders were made, leaves every variable
 * out, so a broken cache never stops the next command. A command's
 * own value wins: callers apply the request's environment after these.
 */
export function cacheEnv(root: string, opts: { create?: boolean } = {}): Record<string, string> {
  const create = opts.create === true;
  const rootId = create ? ensureCacheRoot(root) : undefined;
  if (create && rootId === undefined) return {};
  const out: Record<string, string> = {};
  for (const [name, sub] of CACHE_DIRS) {
    const path = join(root, sub);
    if (create && !ensureCacheFolder(path)) continue;
    out[name] = name === "MAVEN_OPTS" ? `-Dmaven.repo.local=${path}` : path;
  }
  // A concurrent command may have swapped the root meanwhile: then trust none of the folders.
  // Accepted narrow race: a swap between ensureCacheRoot and a folder's mkdir makes that one
  // fixed-name folder (mode 0700, empty) in the link's target. Nothing is removed or followed
  // further, and this recheck of the root's device and inode drops every variable.
  if (create && realDirId(root) !== rootId) return {};
  return out;
}

/**
 * The data directories of version managers, relative to the home: the OS sandbox sets HOME to the
 * workspace, so their shims would look there and fail ("unknown command: python3. Perhaps you
 * have to reshim?"). mise's follow XDG_DATA_HOME / XDG_CONFIG_HOME when the device's environment
 * sets them. CARGO_HOME is a package cache ({@link cacheEnv}).
 */
export const TOOL_HOME_DIRS: readonly (readonly [string, string])[] = [
  ["ASDF_DATA_DIR", ".asdf"],
  ["NVM_DIR", ".nvm"],
  ["PYENV_ROOT", ".pyenv"],
  ["RBENV_ROOT", ".rbenv"],
  ["MISE_DATA_DIR", ".local/share/mise"],
  ["MISE_CONFIG_DIR", ".config/mise"],
  ["VOLTA_HOME", ".volta"],
  ["SDKMAN_DIR", ".sdkman"],
  ["RUSTUP_HOME", ".rustup"],
];

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The version manager variables of an OS-sandboxed command ({@link TOOL_HOME_DIRS}): a variable
 * the device's environment `env` sets to an absolute path is passed on; an unset one points at its
 * default directory under the real `home` when that is a directory. The sandbox only reads them
 * (they are never made writable); the secret paths stay denied. asdf's global `.tool-versions`
 * is still found: asdf walks up from the working directory, and the device directory is under the
 * home.
 */
export function toolHomeEnv(
  home: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const xdg = (name: string, rel: string): string => {
    const v = env[name];
    return v !== undefined && isAbsolute(v) ? v : join(home, rel);
  };
  const defaults: Record<string, string> = {
    MISE_DATA_DIR: join(xdg("XDG_DATA_HOME", ".local/share"), "mise"),
    MISE_CONFIG_DIR: join(xdg("XDG_CONFIG_HOME", ".config"), "mise"),
  };
  const out: Record<string, string> = {};
  for (const [name, rel] of TOOL_HOME_DIRS) {
    const set = env[name];
    if (set !== undefined && set !== "") {
      if (isAbsolute(set)) out[name] = set;
      continue;
    }
    const dir = defaults[name] ?? join(home, rel);
    if (isDir(dir)) out[name] = dir;
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
