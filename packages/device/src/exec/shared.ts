import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { SandboxRoots } from "@capybara-hq/plugin-sdk";

/** The file that marks a directory as a device directory this program has used. */
const ROOT_MARKER = ".capybara-device";

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The roots of a device directory: `<dir>/workspace`, `<dir>/skills`, `<dir>/tmp`. */
export function osRoots(dir: string): SandboxRoots {
  return { workspace: join(dir, "workspace"), skills: join(dir, "skills"), tmp: join(dir, "tmp") };
}

/**
 * The data directories of version managers, relative to the home: the OS sandbox sets HOME to the
 * workspace, so their shims would look there and fail ("unknown command: python3. Perhaps you
 * have to reshim?"). mise's follows XDG_DATA_HOME when the device's environment sets it. mise's
 * configuration directory (`~/.config/mise`) is never granted: its `config.toml` may hold tokens
 * (an `[env]` section). A mise-managed tool still runs from the data directory with a project pin
 * or the global `.tool-versions` ({@link TOOL_HOME_FILES}); a global pin kept only in
 * `config.toml` is not seen inside the sandbox.
 */
export const TOOL_HOME_DIRS: readonly (readonly [string, string])[] = [
  ["ASDF_DATA_DIR", ".asdf"],
  ["NVM_DIR", ".nvm"],
  ["PYENV_ROOT", ".pyenv"],
  ["RBENV_ROOT", ".rbenv"],
  ["MISE_DATA_DIR", ".local/share/mise"],
  ["VOLTA_HOME", ".volta"],
  ["SDKMAN_DIR", ".sdkman"],
  ["RUSTUP_HOME", ".rustup"],
];

/**
 * Single files in the home that hold a version manager's global pins, granted read only next to
 * {@link TOOL_HOME_DIRS}: asdf's global `.tool-versions` (mise reads it too). The other managers
 * keep their global version inside their data directory (pyenv and rbenv `version`, nvm
 * `alias/default`, rustup `settings.toml`; mise's `config.toml` is never granted, see
 * {@link TOOL_HOME_DIRS}); a per-project file such as
 * `.nvmrc` is not global. Never a dotfile that could hold a secret.
 */
export const TOOL_HOME_FILES: readonly string[] = [".tool-versions"];

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
 * What a restricted exec on the host gets for its version managers: the {@link toolHomeEnv}
 * variables of the device process (its real `home` and its own environment `env`), the canonical
 * directories they name as read-only roots, and the global pin files ({@link TOOL_HOME_FILES})
 * that exist as regular files, canonical, as read-only files. A directory is left out when it does
 * not exist, is `/`, lies at or under an owner-denied path, or contains one (Landlock cannot hide
 * a denied path inside a granted root); a file is left out when it, or the target of a link it
 * is, lies at or under one. Nothing here is ever made writable. A command in the device's
 * container uses none of this: its home is the image's.
 */
export function restrictedToolHomes(
  home: string,
  env: Record<string, string | undefined>,
  deniedReadRoots: readonly string[],
): { env: Record<string, string>; readRoots: string[]; readFiles: string[] } {
  const vars = toolHomeEnv(home, env);
  const inside = (path: string, root: string) =>
    root === "/" || path === root || path.startsWith(`${root}/`);
  const denied = (paths: string[], contains: boolean) =>
    paths.some((p) => deniedReadRoots.some((d) => inside(p, d) || (contains && inside(d, p))));
  const canonical = (path: string, kind: "dir" | "file"): string | undefined => {
    try {
      const real = realpathSync(path);
      const info = statSync(real);
      return (kind === "dir" ? info.isDirectory() : info.isFile()) ? real : undefined;
    } catch {
      return undefined;
    }
  };
  const readRoots = new Set<string>();
  for (const dir of Object.values(vars)) {
    const path = normalize(dir).replace(/(.)\/+$/, "$1");
    const real = canonical(path, "dir");
    if (real === undefined || real === "/" || denied([path, real], true)) continue;
    readRoots.add(real);
  }
  const readFiles = new Set<string>();
  for (const rel of TOOL_HOME_FILES) {
    const path = join(home, rel);
    const real = canonical(path, "file");
    if (real === undefined || denied([path, real], false)) continue;
    readFiles.add(real);
  }
  return { env: vars, readRoots: [...readRoots], readFiles: [...readFiles] };
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
