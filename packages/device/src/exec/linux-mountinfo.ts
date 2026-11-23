import { readFileSync } from "node:fs";
import { posix } from "node:path";

/**
 * Bind mounts and other mounts that re-expose a denied directory, from `/proc/self/mountinfo`
 * (Linux). Landlock grants path hierarchies, so a denied directory D mounted again at M (M off
 * every denied path) is readable through M's ancestors whatever the carve does with D. This module
 * finds every such M so the deny list names it too.
 *
 * The parser and the model are pure (string in, paths out) so they are tested from fixtures on
 * any OS; {@link linuxMountReexposures} is the thin reader. Whenever the answer cannot be told
 * (the file is unreadable or malformed, an escape cannot be decoded, the re-exposures do not
 * settle), the result carries a `problem`: the caller refuses machine project reach with
 * {@link machineReachMountRefusal} instead of guessing. Every other doubt is resolved by denying
 * more (a hidden mount still counts, every candidate mount of a path counts), never less.
 *
 * Residuals: the table is read when the owner ceiling is read, at each operation's start (and at
 * an owner reconcile), so a mount made while an operation runs is seen from the next operation on
 * (the sandboxed command itself cannot mount: Landlock forbids changing the mount topology). File
 * systems that serve another directory under their own device (FUSE such as bindfs, NFS from this
 * machine) are not recognized, nor is an overlay layer named through a symbolic link; an overlay
 * layer is read as a path of this mount namespace, so one mounted from another namespace can only
 * deny more.
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
    if (sep < 6 || fields.length !== sep + 4 || fields.includes("")) throw malformed();
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
      superOptions: (fields[sep + 3] as string).split(",").map(decodeMountinfoField),
    };
  });
}

function inside(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(`${root}/`);
}

const DELETED = " (deleted)";

/**
 * The forms a mount's root may stand for: the kernel appends ` (deleted)` to an unlinked root,
 * which a real name can also end with, so both are kept. A root that is not absolute is `null`:
 * the whole file system.
 */
function rootForms(root: string): (string | null)[] {
  if (!root.startsWith("/")) return [null];
  if (!root.endsWith(DELETED)) return [root];
  return [root, root.slice(0, -DELETED.length) || "/"];
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

export interface MountReexposures {
  /** Every path, off the denied ones, where a denied path or something inside it is visible. */
  readonly paths: readonly string[];
  /** Why the answer is incomplete (the cause, English), or null when it is complete. */
  readonly problem: string | null;
}

/**
 * Where a denied path or something inside it is visible again through another mount.
 *
 * For each denied path P: the mounts that may contain P (resolved from the mount tree: the mount
 * on `/`, then at each level the child mount crossed first, the one with the shortest mount point
 * on P's way, and on it the mounts stacked there; ties are all followed) give P's location in
 * their file system (the mount's root plus the rest of P); every mount whose mount point lies in
 * or at P gives its root, wholly inside P. Every mount of the same file system (`major:minor`)
 * then shows such a location: wholly at its mount point when its root lies inside it, or at
 * `mountPoint + (location - root)` when its root holds it. An overlay mount whose layer lies in or
 * holds P shows P likewise. The paths found are denied in turn until nothing new comes (a fixed
 * point within {@link MOUNT_REEXPOSURE_LIMITS}). Paths in or at a denied path are not repeated.
 *
 * Every mount counts, hidden or not, and every candidate mount of P counts: a doubt denies more.
 */
export function mountReexposures(
  entries: readonly MountEntry[],
  denied: readonly string[],
  limits: MountReexposureLimits = MOUNT_REEXPOSURE_LIMITS,
): MountReexposures {
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
  const overlays = entries.filter((e) => e.fsType === "overlay");

  /** The mounts `path` may be in (more than one only when the tree leaves it open). */
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

  const deniedSet = new Set(denied.map((p) => posix.normalize(p)));
  const isDenied = (p: string) => [...deniedSet].some((d) => inside(p, d));
  const found: string[] = [];
  let pending = [...deniedSet];
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
      const holders = containing(p);
      if (holders.length === 0)
        return { paths: found, problem: `no mount in /proc/self/mountinfo holds ${p}` };
      const own: { dev: string; root: string | null }[] = [];
      for (const m of holders)
        for (const form of rootForms(m.root))
          own.push({
            dev: m.dev,
            root: form === null ? null : posix.join(form, posix.relative(m.mountPoint, p)),
          });
      for (const l of own) addLocation(l.dev, l.root);
      // a mount in or at P shows its content inside P: that content is denied wherever its file
      // system shows it too, unless it holds P itself (an ancestor mounted inside P, whose other
      // content is not P's)
      for (const e of entries)
        if (inside(e.mountPoint, p))
          for (const form of rootForms(e.root))
            if (
              form === null ||
              !own.some((l) => l.dev === e.dev && l.root !== null && inside(l.root, form))
            )
              addLocation(e.dev, form);
      for (const o of overlays)
        for (const layer of overlayLayers(o)) {
          if (!layer.startsWith("/"))
            return {
              paths: found,
              problem: `the overlay mount at ${o.mountPoint} names a layer that is not an absolute path (${layer})`,
            };
          const l = posix.normalize(layer);
          if (inside(l, p)) addLocation(o.dev, "/");
          else if (inside(p, l)) addLocation(o.dev, posix.join("/", posix.relative(l, p)));
        }
    }
    const next = new Set<string>();
    for (const [dev, roots] of locations)
      for (const e of byDev.get(dev) ?? [])
        for (const form of rootForms(e.root))
          for (const r of roots) {
            let shown: string | undefined;
            if (r === null || form === null || inside(form, r)) shown = e.mountPoint;
            else if (inside(r, form)) shown = posix.join(e.mountPoint, posix.relative(form, r));
            if (shown !== undefined && !isDenied(shown)) next.add(shown);
          }
    pending = [];
    for (const p of next) {
      if (p.length > limits.pathLength || found.length >= limits.paths)
        return {
          paths: found,
          problem: "the paths that re-expose a denied directory do not settle",
        };
      if (isDenied(p)) continue;
      deniedSet.add(p);
      found.push(p);
      pending.push(p);
    }
  }
  return { paths: found, problem: null };
}

/**
 * {@link mountReexposures} of this process's mount table: reads `/proc/self/mountinfo` (or
 * `read`, a test seam) as UTF-8 and never throws; an unreadable or undecodable table is a
 * `problem` with no paths.
 */
export function linuxMountReexposures(
  denied: readonly string[],
  read: () => Uint8Array = () => readFileSync("/proc/self/mountinfo"),
): MountReexposures {
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
    return mountReexposures(parseMountinfo(text), denied);
  } catch (e) {
    if (e instanceof MountinfoError)
      return { paths: [], problem: `/proc/self/mountinfo has ${e.message}` };
    throw e;
  }
}

/**
 * The refusal of machine project reach while the mount table leaves open whether a denied
 * directory is visible elsewhere: names the cause and the narrower reach that still works.
 */
export function machineReachMountRefusal(problem: string): string {
  return (
    `Cannot tell whether a mount re-exposes a directory the owner denies (${problem}), so this ` +
    "connection's machine project reach is refused; switch to listed project directories with " +
    "capybara-device ceiling set --project-reach paths (capybara-device policy add projectPaths " +
    "lists them)"
  );
}
