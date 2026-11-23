import { readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";

/**
 * Bind mounts and other mounts that re-expose a denied directory, from `/proc/self/mountinfo`
 * (Linux). Landlock grants path hierarchies, so a denied directory D mounted again at M (M off
 * every denied path) is readable through M's ancestors whatever the carve does with D. This module
 * finds every such M so the deny list names it too.
 *
 * The parser and the model are pure (string in, paths out) so they are tested from fixtures on
 * any OS; {@link linuxMountReexposures} is the thin reader. When the table itself cannot be read
 * as the model needs it (unreadable, malformed, an escape it cannot decode, mounts that do not
 * settle, unknown content holding the device's own directories), the result carries a `problem`
 * and the caller refuses machine project reach with {@link machineReachMountRefusal} instead of
 * guessing. Every other doubt denies more (covered mounts count, mounts of unknown content are
 * denied wholesale), never less.
 *
 * Residuals:
 * - The table is read with the owner ceiling: at each operation's start, and about every second
 *   while operations run (the backend's owner reconcile), where a deny list that changed revokes
 *   the live operations (`grantStillHolds`). A mount made in between is readable until then.
 * - A sandboxed command cannot call mount(2) (Landlock forbids changing the mount topology), but
 *   a lookup under an automount point makes the automounter mount for it: such points are denied
 *   while nothing is mounted on them, except an indirect point that holds a denied path or a
 *   directory the device needs (`/home` as an automount map), whose keys not mounted yet are not
 *   seen.
 * - Separate superblocks showing the same data are not recognized: network file systems (NFS,
 *   CIFS) mounting the same share twice or this machine's own export, FUSE file systems serving
 *   another directory (bindfs), a block device or image mounted twice under different devices.
 * - A file system no longer in the table (kept alive by an open file or an overlay layer after
 *   its mount went away) and snapshots (btrfs, LVM, ZFS: copies, not mounts of the directory) are
 *   not covered.
 * - An overlay layer or loop backing file is resolved in this process's mount namespace; one from
 *   another namespace that does not resolve here denies the overlay's mounts (more, not less).
 */

/** One line of mountinfo (proc(5)), with the path fields decoded. */
export interface MountEntry {
  readonly mountId: number;
  readonly parentId: number;
  /** `major:minor` of the file system: equal on every mount of the same superblock. */
  readonly dev: string;
  /**
   * The mount's root within its file system. Not always a path (`net:[4026531840]` for nsfs): a
   * root that is not absolute stands for the whole file system in the model.
   */
  readonly root: string;
  /** The mount point, relative to this process's root. */
  readonly mountPoint: string;
  readonly fsType: string;
  /** The mount source (`/dev/sda1`, `none`, possibly empty). */
  readonly source: string;
  /** The super options, split on the raw commas, each decoded. */
  readonly superOptions: readonly string[];
}

/** Why mountinfo cannot be read as the model needs it; the message is the cause, in English. */
export class MountinfoError extends Error {}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/**
 * Decodes one mountinfo field: the kernel writes space, tab, newline and backslash (and, in the
 * super options, what a file system escapes itself, such as `,` and `=`) as a backslash and three
 * octal digits. A backslash not followed by three octal digits, a code above `\377` or bytes that
 * are not UTF-8 cannot be decoded.
 */
export function decodeMountinfoField(field: string): string {
  if (!field.includes("\\")) return field;
  const bytes: number[] = [];
  for (let i = 0; i < field.length; ) {
    if (field[i] === "\\") {
      const digits = field.slice(i + 1, i + 4);
      if (!/^[0-7]{3}$/.test(digits))
        throw new MountinfoError(`an escape it cannot decode (${JSON.stringify(field)})`);
      const code = Number.parseInt(digits, 8);
      if (code > 0xff)
        throw new MountinfoError(`an escape it cannot decode (${JSON.stringify(field)})`);
      bytes.push(code);
      i += 4;
    } else {
      const cp = field.codePointAt(i) as number;
      const ch = String.fromCodePoint(cp);
      for (const b of encoder.encode(ch)) bytes.push(b);
      i += ch.length;
    }
  }
  try {
    return utf8.decode(new Uint8Array(bytes));
  } catch {
    throw new MountinfoError(`a field that is not UTF-8 once decoded (${JSON.stringify(field)})`);
  }
}

/**
 * Parses mountinfo text: `id parent major:minor root mountPoint options [optional...] - fsType
 * source superOptions`, one mount per line. Any line that does not have that shape throws
 * {@link MountinfoError}; so does an empty file (every process has a root mount).
 */
export function parseMountinfo(text: string): MountEntry[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new MountinfoError("it lists no mounts");
  return lines.map((line) => {
    const fields = line.split(" ");
    const sep = fields.indexOf("-", 6);
    const malformed = () =>
      new MountinfoError(`a line it cannot parse (${JSON.stringify(line.slice(0, 200))})`);
    // every field but the source has content (an empty source shows as two spaces)
    if (sep < 6 || fields.length !== sep + 4 || fields.some((f, i) => f === "" && i !== sep + 2))
      throw malformed();
    const [id, parent, dev, root, mountPoint] = fields as [string, string, string, string, string];
    if (!/^\d+$/.test(id) || !/^\d+$/.test(parent) || !/^\d+:\d+$/.test(dev)) throw malformed();
    const fsType = decodeMountinfoField(fields[sep + 1] as string);
    const decodedPoint = decodeMountinfoField(mountPoint);
    if (!decodedPoint.startsWith("/") || fsType === "") throw malformed();
    return {
      mountId: Number(id),
      parentId: Number(parent),
      dev,
      root: decodeMountinfoField(root),
      mountPoint: decodedPoint,
      fsType,
      source: decodeMountinfoField(fields[sep + 2] as string),
      superOptions: (fields[sep + 3] as string).split(",").map(decodeMountinfoField),
    };
  });
}

function inside(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(`${root}/`);
}

/** What dentry_path appends to an unlinked root in mountinfo (never part of a real path). */
const DELETED_ROOT = "//deleted";
/** What d_path appends to an unlinked file's path (a loop device's backing file). */
const DELETED_FILE = " (deleted)";

/**
 * A mount's root within its file system, `null` when it is not a path (the whole file system).
 * An unlinked root (`/a//deleted`) stands for the directory it was.
 */
function rootOf(root: string): string | null {
  if (!root.startsWith("/")) return null;
  if (root.endsWith(DELETED_ROOT)) return root.slice(0, -DELETED_ROOT.length) || "/";
  return root;
}

/**
 * The overlay layer directories a mount shows (`lowerdir`, `lowerdir+`, `datadir+`, `upperdir`;
 * not `workdir`, which holds overlayfs's own files): its content is theirs, merged. `lowerdir`
 * separates layers with `:` and escapes a literal `:` or `\` with a backslash.
 */
function overlayLayers(entry: MountEntry): string[] {
  const layers: string[] = [];
  for (const option of entry.superOptions) {
    const eq = option.indexOf("=");
    if (eq < 0) continue;
    const key = option.slice(0, eq);
    const value = option.slice(eq + 1);
    if (key === "lowerdir") {
      let cur = "";
      for (let i = 0; i < value.length; i++) {
        const ch = value[i] as string;
        if (ch === "\\" && i + 1 < value.length) cur += value[++i];
        else if (ch === ":") {
          if (cur !== "") layers.push(cur);
          cur = "";
        } else cur += ch;
      }
      if (cur !== "") layers.push(cur);
    } else if (key === "lowerdir+" || key === "datadir+" || key === "upperdir") {
      layers.push(value.replace(/\\(.)/g, "$1"));
    }
  }
  return layers;
}

/** Automount points that never lead to a user's files (systemd's binfmt_misc automount). */
const HARMLESS_AUTOFS_POINTS: ReadonlySet<string> = new Set(["/proc/sys/fs/binfmt_misc"]);

/** Bounds of the fixed point: beyond them the re-exposures are said not to settle. */
export interface MountReexposureLimits {
  readonly paths: number;
  readonly rounds: number;
  readonly pathLength: number;
}
export const MOUNT_REEXPOSURE_LIMITS: MountReexposureLimits = Object.freeze({
  /** Re-exposed paths at most. */
  paths: 4096,
  /** Rounds at most (each round follows the paths the previous one added). */
  rounds: 32,
  /** The longest path (PATH_MAX). */
  pathLength: 4096,
});

export interface MountReexposureOptions {
  limits?: MountReexposureLimits;
  /**
   * The real path of an absolute path, or null when it does not resolve (missing, unreadable).
   * Default: the path as written (pure).
   */
  realpath?: (path: string) => string | null;
  /**
   * The backing file of loop device N (`/sys/block/loopN/loop/backing_file`), or null when it
   * cannot be read. Default: null (pure), which denies that loop device's mounts.
   */
  loopBackingFile?: (n: number) => string | null;
  /**
   * The directories this device itself needs (its roots, the listed project paths): a mount of
   * unknown content that holds one of them is never denied wholesale (an indirect automount point
   * is left as is; an overlay or loop mount of unknown content is a `problem`).
   */
  keep?: readonly string[];
}

export interface MountReexposures {
  /** Every path, off the denied ones, where a denied path or something inside it may be visible. */
  readonly paths: readonly string[];
  /** Why the answer is incomplete (the cause, English), or null when it is complete. */
  readonly problem: string | null;
}

/** A directory or file whose content a mount shows (an overlay layer, a loop backing file). */
interface ContentSource {
  readonly entry: MountEntry;
  readonly kind: "dir" | "file";
  /** The path as written and its real path. */
  readonly forms: readonly string[];
}

/**
 * Where a denied path or something inside it may be visible again through another mount.
 *
 * Unknown content first, denied without looking further (a doubt denies more): an automount
 * point (autofs) with nothing mounted on it yet, since a lookup under it makes the automounter
 * mount outside this model (a direct or offset point always; an indirect one, such as `/net`,
 * unless it holds a denied path or a {@link MountReexposureOptions.keep} directory, whose keys are
 * the residual; binfmt_misc is harmless); every mount of an overlay whose layer is relative or
 * does not resolve; every mount of a loop device whose backing file cannot be read. When such a
 * mount holds a `keep` directory the answer is a `problem` instead (denying it would deny the
 * device itself).
 *
 * Then, for each denied path P: its location in every file system mounted on P's way (each mount
 * whose mount point is P or an ancestor of it, covered ones included, so content hidden under an
 * over-mount counts: the mount's root plus the rest of P); for a path this function found itself,
 * only the mounts that hold it (the mount on `/`, then at each level the child crossed first, the
 * one with the shortest mount point on its way, and the mounts stacked there; ties all followed).
 * Every mount in or at P gives its root too (content inside P), unless that root holds P itself.
 * Every mount of the same file system (`major:minor`) then shows such a location: wholly at its
 * mount point when its root lies inside it, or at `mountPoint + (location - root)` when its root
 * holds it. An overlay whose layer (real path or as written) lies in or holds P shows P likewise,
 * and a loop device whose backing file lies in P shows it wholly. The paths found are denied in
 * turn until nothing new comes (a fixed point within {@link MOUNT_REEXPOSURE_LIMITS}). Paths in or
 * at a denied path are not repeated.
 */
export function mountReexposures(
  entries: readonly MountEntry[],
  denied: readonly string[],
  options: MountReexposureOptions = {},
): MountReexposures {
  const limits = options.limits ?? MOUNT_REEXPOSURE_LIMITS;
  const realpath = options.realpath ?? ((path: string) => path);
  const loopBackingFile = options.loopBackingFile ?? (() => null);
  const keep = (options.keep ?? []).map((p) => posix.normalize(p));
  const ids = new Set(entries.map((e) => e.mountId));
  const children = new Map<number, MountEntry[]>();
  const starts: MountEntry[] = [];
  for (const e of entries) {
    if (!ids.has(e.parentId) || e.parentId === e.mountId) starts.push(e);
    else {
      const list = children.get(e.parentId) ?? [];
      list.push(e);
      children.set(e.parentId, list);
    }
  }
  const byDev = new Map<string, MountEntry[]>();
  for (const e of entries) {
    const list = byDev.get(e.dev) ?? [];
    list.push(e);
    byDev.set(e.dev, list);
  }

  /** The mounts `path` is in (more than one only when the tree leaves it open). */
  const containing = (path: string): MountEntry[] => {
    const out = new Set<MountEntry>();
    const seen = new Set<number>();
    const descend = (m: MountEntry) => {
      if (seen.has(m.mountId)) return;
      seen.add(m.mountId);
      const kids = (children.get(m.mountId) ?? []).filter((k) => inside(path, k.mountPoint));
      if (kids.length === 0) {
        out.add(m);
        return;
      }
      const shortest = Math.min(...kids.map((k) => k.mountPoint.length));
      for (const k of kids) if (k.mountPoint.length === shortest) descend(k);
    };
    for (const s of starts) if (inside(path, s.mountPoint)) descend(s);
    return [...out];
  };

  const original = [...new Set(denied.map((p) => posix.normalize(p)))];
  const deniedSet = new Set(original);
  const isDenied = (p: string) => [...deniedSet].some((d) => inside(p, d));
  const found: string[] = [];
  const deny = (p: string) => {
    if (isDenied(p)) return false;
    deniedSet.add(p);
    found.push(p);
    return true;
  };
  const holdsKeep = (dev: string) =>
    (byDev.get(dev) ?? []).find((e) => keep.some((k) => inside(k, e.mountPoint)));

  // unknown content: what a mount shows cannot be told, so its mount points are denied
  const sources: ContentSource[] = [];
  const unknown = new Map<string, string>(); // dev -> cause
  const forms = (path: string): string[] | null => {
    if (!path.startsWith("/")) return null;
    const real = realpath(path);
    if (real === null) return null;
    return [...new Set([posix.normalize(path), posix.normalize(real)])];
  };
  for (const e of entries) {
    if (e.fsType === "overlay")
      for (const layer of overlayLayers(e)) {
        const f = forms(layer);
        if (f === null) {
          if (!unknown.has(e.dev))
            unknown.set(
              e.dev,
              `the overlay mount at ${e.mountPoint} has a layer it cannot resolve (${layer})`,
            );
        } else sources.push({ entry: e, kind: "dir", forms: f });
      }
    const loop = /^\/dev\/loop(\d+)(?:p\d+)?$/.exec(e.source);
    if (loop !== null) {
      const backing = loopBackingFile(Number(loop[1]));
      const f =
        backing === null
          ? null
          : forms(
              backing.endsWith(DELETED_FILE) ? backing.slice(0, -DELETED_FILE.length) : backing,
            );
      if (f === null) {
        if (!unknown.has(e.dev))
          unknown.set(
            e.dev,
            `the backing file of ${e.source}, mounted at ${e.mountPoint}, cannot be read`,
          );
      } else sources.push({ entry: e, kind: "file", forms: f });
    }
  }
  for (const [dev, cause] of unknown) {
    const held = holdsKeep(dev);
    if (held !== undefined)
      return {
        paths: found,
        problem: `${cause}, and its mount at ${held.mountPoint} holds this device's own directories`,
      };
    for (const e of byDev.get(dev) ?? []) deny(e.mountPoint);
  }
  for (const e of entries) {
    if (e.fsType !== "autofs" || HARMLESS_AUTOFS_POINTS.has(e.mountPoint)) continue;
    // something mounted on it already is in the table and followed like any mount
    if ((children.get(e.mountId) ?? []).some((k) => k.mountPoint === e.mountPoint)) continue;
    const direct = e.superOptions.includes("direct") || e.superOptions.includes("offset");
    if (!direct && [...original, ...keep].some((p) => inside(p, e.mountPoint))) continue;
    deny(e.mountPoint);
  }

  let pending = [...original];
  for (let round = 0; pending.length > 0; round++) {
    if (round >= limits.rounds)
      return {
        paths: found,
        problem: "the paths that re-expose a denied directory do not settle",
      };
    /** File system locations holding denied content: dev -> roots within it (null: all). */
    const locations = new Map<string, Set<string | null>>();
    const addLocation = (dev: string, root: string | null) => {
      const set = locations.get(dev) ?? new Set();
      set.add(root);
      locations.set(dev, set);
    };
    for (const p of pending) {
      const holders = round === 0 ? entries.filter((e) => inside(p, e.mountPoint)) : containing(p);
      if (holders.length === 0)
        return { paths: found, problem: `no mount in /proc/self/mountinfo holds ${p}` };
      const own: { dev: string; root: string | null }[] = [];
      for (const m of holders) {
        const root = rootOf(m.root);
        own.push({
          dev: m.dev,
          root: root === null ? null : posix.join(root, posix.relative(m.mountPoint, p)),
        });
      }
      for (const l of own) addLocation(l.dev, l.root);
      // a mount in or at P shows its content inside P: that content is denied wherever its file
      // system shows it too, unless it holds P itself (an ancestor mounted inside P, whose other
      // content is not P's)
      for (const e of entries)
        if (inside(e.mountPoint, p)) {
          const root = rootOf(e.root);
          if (
            root === null ||
            !own.some((l) => l.dev === e.dev && l.root !== null && inside(l.root, root))
          )
            addLocation(e.dev, root);
        }
      for (const source of sources)
        for (const form of source.forms) {
          if (inside(form, p)) addLocation(source.entry.dev, source.kind === "dir" ? "/" : null);
          else if (source.kind === "dir" && inside(p, form))
            addLocation(source.entry.dev, posix.join("/", posix.relative(form, p)));
        }
    }
    const next = new Set<string>();
    for (const [dev, roots] of locations)
      for (const e of byDev.get(dev) ?? []) {
        const form = rootOf(e.root);
        for (const r of roots) {
          let shown: string | undefined;
          if (r === null || form === null || inside(form, r)) shown = e.mountPoint;
          else if (inside(r, form)) shown = posix.join(e.mountPoint, posix.relative(form, r));
          if (shown !== undefined && !isDenied(shown)) next.add(shown);
        }
      }
    pending = [];
    for (const p of next) {
      if (p.length > limits.pathLength || found.length >= limits.paths)
        return {
          paths: found,
          problem: "the paths that re-expose a denied directory do not settle",
        };
      if (deny(p)) pending.push(p);
    }
  }
  return { paths: found, problem: null };
}

/** What {@link linuxMountReexposures} reads; each defaults to this machine's file. */
export interface LinuxMountReadOptions {
  /** `/proc/self/mountinfo`. */
  read?: () => Uint8Array;
  /** The real path of a path, or null when it does not resolve. */
  realpath?: (path: string) => string | null;
  /** `/sys/block/loopN/loop/backing_file`, or null when it cannot be read. */
  loopBackingFile?: (n: number) => string | null;
  /** See {@link MountReexposureOptions.keep}. */
  keep?: readonly string[];
}

function nodeRealpath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function nodeLoopBackingFile(n: number): string | null {
  try {
    return readFileSync(`/sys/block/loop${n}/loop/backing_file`, "utf8").replace(/\n$/, "");
  } catch {
    return null;
  }
}

/**
 * {@link mountReexposures} of this process's mount table: reads `/proc/self/mountinfo` as UTF-8,
 * resolves overlay layers and loop backing files on this machine, and never throws; an
 * unreadable or undecodable table is a `problem` with no paths.
 */
export function linuxMountReexposures(
  denied: readonly string[],
  options: LinuxMountReadOptions = {},
): MountReexposures {
  const read = options.read ?? (() => readFileSync("/proc/self/mountinfo"));
  let text: string;
  try {
    const bytes = read();
    try {
      text = utf8.decode(bytes);
    } catch {
      return { paths: [], problem: "/proc/self/mountinfo is not valid UTF-8" };
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      paths: [],
      problem: `/proc/self/mountinfo cannot be read${code ? ` (${code})` : ""}`,
    };
  }
  try {
    return mountReexposures(parseMountinfo(text), denied, {
      realpath: options.realpath ?? nodeRealpath,
      loopBackingFile: options.loopBackingFile ?? nodeLoopBackingFile,
      ...(options.keep ? { keep: options.keep } : {}),
    });
  } catch (e) {
    if (e instanceof MountinfoError)
      return { paths: [], problem: `/proc/self/mountinfo has ${e.message}` };
    throw e;
  }
}

/**
 * The refusal of machine project reach while the mount table leaves open whether a denied
 * directory is visible elsewhere: names the cause, that fixing it restores machine reach, and what
 * the paths reach relies on instead.
 */
export function machineReachMountRefusal(problem: string): string {
  return (
    `Cannot tell whether a mount shows a directory the owner denies somewhere else (${problem}), ` +
    "so this connection's machine project reach is refused; fixing that cause restores it. " +
    "Meanwhile capybara-device ceiling set --project-reach paths reads only the project " +
    "directories you list (capybara-device policy add projectPaths), which you trust not to hold " +
    "a second view of a denied directory"
  );
}
