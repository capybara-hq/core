import { constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type SandboxRoots, validateSandboxPathShape } from "@capybara-hq/plugin-sdk";
import type { SandboxMode } from "../state.js";
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

/**
 * The data directories of version managers, relative to the home: the OS sandbox sets HOME to the
 * workspace, so their shims would look there and fail ("unknown command: python3. Perhaps you
 * have to reshim?"). mise's follow XDG_DATA_HOME / XDG_CONFIG_HOME when the device's environment
 * sets them.
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
 * Host-side file access. In sandbox mode `path`s are confined to the three roots (real paths,
 * symlinks resolved, refused when they leave a root); in auto mode any clean absolute path is
 * accepted (shape checks only: absolute, no `..` segments, no control characters). Used for the
 * skills root (commands can only read it, so nothing can race it) and by the host executor.
 */
export class HostFiles {
  constructor(
    private readonly roots: SandboxRoots,
    private readonly mode: SandboxMode,
  ) {}

  /**
   * `path` made absolute and normalized; in sandbox mode refused unless it is lexically under a
   * root, in auto mode accepted when its shape is clean.
   */
  lexical(path: string): string {
    if (this.mode === "auto") {
      const errors = validateSandboxPathShape(path);
      if (errors.length > 0) throw policyError(`${path}: ${errors.join("; ")}`);
      return resolve(path);
    }
    if (!isAbsolute(path)) throw policyError(`${path} is not an absolute path`);
    const p = resolve(path);
    if (!this.rootList().some((r) => isUnder(p, r))) {
      throw policyError(`${path} is outside the device's roots (${this.rootList().join(", ")})`);
    }
    return p;
  }

  /**
   * The real path of an existing `path` (null when missing); in sandbox mode refused unless under
   * a root after resolving links.
   */
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

  /**
   * The real path of an existing `path` (symlinks resolved); in sandbox mode refused unless under
   * a root.
   */
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
    if (this.mode === "auto") return real;
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
