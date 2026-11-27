import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  unlink,
  utimes,
} from "node:fs/promises";
import { isAbsolute, join, normalize, posix } from "node:path";
import {
  DEVICE_SERVICE_INSTALL_KEY_RE,
  DEVICE_SERVICE_INSTALL_SEAL,
} from "@capybara-hq/plugin-sdk";
import { realDirectory } from "./supervisor.js";

// The machine-wide cache of device service installs (capybara-hq/plugins#311): what a service
// installs once and then only runs (a browser of about 400 MB) is kept per OS user and scope (the
// deployment, the platform, the architecture and the launcher's install variant), service and
// install key (DEVICE_SERVICE_INSTALL_KEY_FILE, the browser revision), not per device and plugin
// version. Layout under the root (0700, this user's):
//
//   s/<pid>-<start>-<digits>/        an install in progress, private to one start: short and
//                                    digits only, because the macOS sandbox spells a write root
//                                    out in every write rule (case folded) and caps the rule length,
//                                    so it fits wherever the device's own workspace path fits
//   <sha256 of the scope>/<service>/
//     locks/<n>                       the lock: generation files ({@link InstallCache.locked})
//     entries/<key>@<rand>/           a published install, sealed, never written again
//     manifests/<key>                 "v1:<sha256> <entry>": the entry a key names and its digest
//     leases/<entry>~<pid>-<start>~<rand>   a service of that process runs on the entry
//     trash/                          what the sweep took out, deleted outside the lock
//
// A start with a published entry gets it read only once its tree matches the manifest (verified
// at every reuse: a mismatching entry is dropped and installed again, never used). A start
// without one gets a fresh staging directory, writable; when that service exits sealed, its tree
// is checked ({@link treeDigest}: every link resolved inside it, no hard link, no special file),
// digested and renamed into place under a fresh name under the lock, so a reader only ever sees a
// complete entry and no entry in use is ever replaced in place. Concurrent first installs on
// several devices each stage their own; the first to publish wins and the others are discarded.
//
// Processes are named by pid and start time, so a reused pid never keeps a dead holder's lock,
// lease or staging directory alive. Removals are best effort and happen outside the lock: an
// entry nobody can delete (mode 000, user immutable flags) never blocks a start.
//
// Assumption (the SDK's DEVICE_SERVICE_INSTALL_KEY_FILE): the unsealed install is the service's
// own trusted code running no untrusted input; a child it detached from its process group could
// still write through an open descriptor after the digest, which the next reuse's verification
// catches.

/** A manifest: the format, the tree digest and the entry it names. */
const MANIFEST_RE = /^(v1:[0-9a-f]{64}) ([a-z0-9][a-z0-9._+-]{0,127}@[0-9a-f]{12})$/;

/** How many unused keys a service keeps per scope (the newest by last use), besides the leased. */
export const INSTALL_CACHE_KEEP = 2;

/** How long a start waits for the lock a live process holds before it fails. */
export const INSTALL_CACHE_LOCK_WAIT_MS = 60_000;

/** The staging directory under the root (`s/` in the layout above). */
export const STAGING = "s";

/** How many links one link target may pass through while it is resolved inside the tree. */
const MAX_LINK_HOPS = 40;

/** A process as the cache names it: its pid and start time (seconds since the epoch). */
export interface ProcessToken {
  pid: number;
  start: number;
}

export interface InstallCacheOptions {
  /** The machine-wide root (`~/capybara-device/.install-cache`): made 0700 when missing. */
  root: string;
  /** The deployment the device belongs to ({@link installCacheScope}): shared only within it. */
  scope: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** This process (default: its pid and start time). */
  self?: ProcessToken;
  /** Whether that process still runs (default: the pid runs and started at that time). */
  isLive?: (p: ProcessToken) => boolean;
  /** A test seam: runs after a staged tree was digested, before it is published under the lock. */
  beforePublish?: () => Promise<void>;
}

/** One start's install directory, until its service exits ({@link InstallCache.acquire}). */
export interface InstallLease {
  dir: string;
  sealed: boolean;
  /**
   * Called once the service's process is gone: a sealed lease is let go; an unsealed one's
   * staging directory is published when the service sealed it, else removed. Never rejects.
   */
  release(): Promise<void>;
}

/** A tree that must never be published or used (a link out of it, a hard link, a special file). */
export class InstallTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallTreeError";
  }
}

/**
 * The machine-wide cache root of an OS user: beside the default device directories
 * (`~/capybara-device/<device id>`), outside this program's state root (which a service's
 * sandbox may never read) and outside every device directory (which another connection's
 * sandbox denies).
 */
export function defaultInstallCacheRoot(home: string): string {
  return join(home, "capybara-device", ".install-cache");
}

/**
 * The scope of a deployment's installs: its origin and path (`https://host/a` and `https://host/b`
 * are two deployments), the URL as given when it does not parse. One deployment reached by two
 * URLs (an address and a name) keeps two copies.
 */
export function installCacheScope(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/** Whether `key` is a valid install key ({@link DEVICE_SERVICE_INSTALL_KEY_RE}). */
export function validInstallKey(key: string | undefined): key is string {
  return key !== undefined && DEVICE_SERVICE_INSTALL_KEY_RE.test(key);
}

/** When a process started, in seconds since the epoch (undefined when it cannot be read). */
export function processStartTime(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      // field 22 (starttime, in clock ticks since boot) after the parenthesised command name
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
      const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
      return Number.isFinite(ticks) && Number.isFinite(btime)
        ? btime + Math.floor(ticks / 100)
        : undefined;
    } catch {
      return undefined;
    }
  }
  const ps = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    timeout: 5_000,
  });
  if (ps.status !== 0) return undefined;
  const ms = Date.parse(`${ps.stdout.trim()} GMT`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** Whether `p` runs: its pid answers (EPERM counts) and it started at `p.start`. */
function defaultIsLive(p: ProcessToken): boolean {
  try {
    process.kill(p.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const start = processStartTime(p.pid);
  // a start time that cannot be read is no proof of a reused pid: counted as running
  return start === undefined || Math.abs(start - p.start) <= 1;
}

const tokenText = (p: ProcessToken) => `${p.pid}-${p.start}`;
function parseToken(text: string): ProcessToken | undefined {
  const m = /^(\d+)-(\d+)$/.exec(text);
  return m ? { pid: Number(m[1]), start: Number(m[2]) } : undefined;
}

export class InstallCache {
  readonly root: string;
  private readonly isLive: (p: ProcessToken) => boolean;
  private selfToken: ProcessToken | undefined;
  private readonly background = new Set<Promise<void>>();

  constructor(private readonly o: InstallCacheOptions) {
    if (!isAbsolute(o.root)) throw new Error(`The install cache root ${o.root} is not absolute`);
    this.root = normalize(o.root);
    this.isLive = o.isLive ?? defaultIsLive;
    this.selfToken = o.self;
  }

  /**
   * This process's token, read from the same source other processes read it from (a guess from
   * the clock could differ from their reading and make this live holder look gone to them):
   * when it cannot be read the cache is not used ({@link acquire} throws).
   */
  private get self(): ProcessToken {
    if (this.selfToken === undefined) {
      let start: number | undefined;
      for (let i = 0; i < 3 && start === undefined; i++) start = processStartTime(process.pid);
      if (start === undefined)
        throw new Error("The install cache cannot read this process's start time");
      this.selfToken = { pid: process.pid, start };
    }
    return this.selfToken;
  }

  /** Resolves once the deletions started in the background (after publishing) are done. */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
  }

  /** Runs `fn` in the background, best effort, tracked by {@link idle}. */
  private detach(fn: () => Promise<void>): void {
    const p: Promise<void> = fn()
      .catch(() => {})
      .finally(() => this.background.delete(p));
    this.background.add(p);
  }

  /**
   * The install directory of one start of `service` under `key` (and the launcher's install
   * `variant`, the environment it gives the service that decides what it installs): the
   * published entry, read only, when it verifies; else a new staging directory, writable, empty.
   */
  async acquire(
    service: string,
    key: string,
    signal: AbortSignal,
    variant = "",
  ): Promise<InstallLease> {
    if (!validInstallKey(key)) throw new Error(`Invalid install key ${JSON.stringify(key)}`);
    void this.self; // throws before anything is written when this process cannot be named
    const dir = await this.serviceDir(service, variant);
    const manifest = join(dir, "manifests", key);
    // a lease taken under the lock: a sweep never removes an entry a start is about to verify
    const found = await this.locked(dir, signal, async () => {
      await this.sweep(dir, key);
      const recorded = await readManifest(manifest);
      if (recorded === undefined) return undefined;
      const entry = join(dir, "entries", recorded.entry);
      if (!(await isRealDirectory(entry))) return undefined;
      const lease = join(dir, "leases", `${recorded.entry}~${tokenText(this.self)}~${token()}`);
      await writeNew(lease, "");
      // the last use, which the sweep keeps the newest of
      const now = new Date();
      await utimes(manifest, now, now).catch(() => {});
      return { recorded, entry, lease };
    });
    this.detach(() => this.emptyTrash(dir));
    if (found !== undefined) {
      let verdict: "ok" | "drop" | "skip";
      try {
        verdict =
          (await isRegularFile(join(found.entry, DEVICE_SERVICE_INSTALL_SEAL))) &&
          (await treeDigest(found.entry)) === found.recorded.digest
            ? "ok"
            : "drop";
      } catch (e) {
        // a tree that breaks the rules is dropped at once; any other read error (EACCES, EIO)
        // keeps the entry for the others but makes this start install its own copy, and that copy
        // replaces the entry when it is published (publish's `replaces`), so a persistent error
        // costs one download, not one per start
        verdict = e instanceof InstallTreeError || isGone(e) ? "drop" : "skip";
      }
      if (verdict === "ok")
        return {
          dir: found.entry,
          sealed: true,
          release: once(async () => {
            await rm(found.lease, { force: true }).catch(() => {});
          }),
        };
      await rm(found.lease, { force: true }).catch(() => {});
      // the key no longer names the entry (unless it was republished meanwhile); the entry itself
      // goes with the sweep once no running service holds it
      if (verdict === "drop")
        await this.locked(dir, signal, async () => {
          const now = await readManifest(manifest);
          if (now?.entry === found.recorded.entry) await rm(manifest, { force: true });
        });
    }
    const replaces = found?.recorded.entry;
    signal.throwIfAborted();
    const stagingRoot = await realDirectory(this.root, [STAGING]);
    const digits = String(randomBytes(6).readUIntBE(0, 6)).padStart(15, "0");
    const staging = join(stagingRoot, `${tokenText(this.self)}-${digits}`);
    await mkdir(staging, { mode: 0o700 });
    return {
      dir: staging,
      sealed: false,
      release: once(() => this.publish(dir, key, staging, replaces).catch(() => {})),
    };
  }

  /**
   * Publishes a staging directory its service sealed: digested outside the lock (it is private),
   * renamed into place under a fresh name under it unless the key names another published entry
   * already (one other than `replaces`, the entry this start found but could not read). Returns
   * once the manifest names the entry: the deletions (a discarded staging directory, the trash)
   * run in the background, so the service's name is held only for the digest (linear in the
   * install's size, about 1 s per 400 MB on an SSD) and the short critical section; the lock is
   * never held for a deletion.
   */
  private async publish(
    dir: string,
    key: string,
    staging: string,
    replaces: string | undefined,
  ): Promise<void> {
    try {
      let digest: string | undefined;
      try {
        digest = (await isRegularFile(join(staging, DEVICE_SERVICE_INSTALL_SEAL)))
          ? await treeDigest(staging)
          : undefined;
      } catch {
        digest = undefined;
      }
      if (digest === undefined) return;
      await this.o.beforePublish?.();
      const manifest = join(dir, "manifests", key);
      await this.locked(dir, AbortSignal.timeout(INSTALL_CACHE_LOCK_WAIT_MS), async () => {
        const recorded = await readManifest(manifest);
        if (
          recorded !== undefined &&
          recorded.entry !== replaces &&
          (await isRealDirectory(join(dir, "entries", recorded.entry)))
        )
          return; // another start published first: this copy goes
        const entry = `${key}@${token()}`;
        await rename(staging, join(dir, "entries", entry));
        await writeAtomic(manifest, `${digest} ${entry}\n`);
        await this.sweep(dir, key);
      });
    } finally {
      this.detach(async () => {
        await forceRemove(staging);
        await this.emptyTrash(dir);
      });
    }
  }

  /** `<root>/<scope>/<service>` with its parts, made link-free; the root checked private. */
  private async serviceDir(service: string, variant: string): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const st = await lstat(this.root);
    if (
      !st.isDirectory() ||
      (process.getuid !== undefined && st.uid !== process.getuid()) ||
      (st.mode & 0o077) !== 0
    )
      throw new Error(
        `The install cache ${this.root} is not a private directory of this user (0700, not a link); remove it and retry`,
      );
    // the full digest: a deployment chooses its own URL, so its scope must not collide with another
    const scope = createHash("sha256")
      .update(
        JSON.stringify([
          this.o.scope,
          this.o.platform ?? process.platform,
          this.o.arch ?? process.arch,
          variant,
        ]),
      )
      .digest("hex");
    const dir = await realDirectory(this.root, [scope, service]);
    for (const part of ["locks", "entries", "manifests", "leases", "trash"])
      await realDirectory(dir, [part]);
    return dir;
  }

  /**
   * Under the lock, best effort (a failure skips that item, never the start): drops the leases of
   * processes that are gone, and takes out every key
   * (its manifest) that is not `keep`, not among the {@link INSTALL_CACHE_KEEP} most recently
   * used and whose entry no live lease holds; then takes out every entry no manifest names and no
   * live lease holds. Deleted devices cannot be enumerated, so a live lease and recency stand in
   * for "referenced by an install". What is taken out is renamed into `trash/` (deleted after
   * the lock, {@link emptyTrash}).
   */
  private async sweep(dir: string, keep: string): Promise<void> {
    const leased = new Set<string>();
    for (const name of await readdir(join(dir, "leases")).catch(() => [] as string[])) {
      const [entry, owner] = name.split("~");
      const p = owner === undefined ? undefined : parseToken(owner);
      if (entry !== undefined && p !== undefined && this.isLive(p)) leased.add(entry);
      else await rm(join(dir, "leases", name), { force: true }).catch(() => {});
    }
    const keys: { key: string; at: number; entry: string | undefined }[] = [];
    for (const name of await readdir(join(dir, "manifests")).catch(() => [] as string[])) {
      const path = join(dir, "manifests", name);
      if (!validInstallKey(name)) {
        // a temporary file of a writer that is gone (writes happen under the lock)
        await rm(path, { force: true }).catch(() => {});
        continue;
      }
      const at = await lstat(path).then(
        (s) => s.mtimeMs,
        () => 0,
      );
      keys.push({ key: name, at, entry: (await readManifest(path))?.entry });
    }
    keys.sort((a, b) => b.at - a.at);
    const recent = new Set(keys.slice(0, INSTALL_CACHE_KEEP).map((k) => k.key));
    const named = new Set<string>();
    for (const k of keys) {
      if (k.entry !== undefined && (k.key === keep || recent.has(k.key) || leased.has(k.entry))) {
        named.add(k.entry);
        continue;
      }
      await rm(join(dir, "manifests", k.key), { force: true }).catch(() => {});
    }
    for (const name of await readdir(join(dir, "entries")).catch(() => [] as string[]))
      if (!named.has(name) && !leased.has(name)) await this.toTrash(dir, join("entries", name));
  }

  /** Renames `<dir>/<rel>` into `trash/` (fast, under the lock); best effort. */
  private async toTrash(dir: string, rel: string): Promise<void> {
    await rename(join(dir, rel), join(dir, "trash", `${token()}~${rel.replace("/", "-")}`)).catch(
      () => {},
    );
  }

  /**
   * Outside the lock and best effort ({@link forceRemove}): deletes what is in `trash/` and the
   * staging directories of processes that are gone (their owner can never publish them).
   */
  private async emptyTrash(dir: string): Promise<void> {
    for (const name of await readdir(join(dir, "trash")).catch(() => [] as string[]))
      await forceRemove(join(dir, "trash", name));
    const stagingRoot = join(this.root, STAGING);
    for (const name of await readdir(stagingRoot).catch(() => [] as string[])) {
      const m = /^(\d+-\d+)-\d+$/.exec(name);
      const p = m ? parseToken(m[1] as string) : undefined;
      if (p === undefined || !this.isLive(p)) await forceRemove(join(stagingRoot, name));
    }
  }

  /**
   * Runs `fn` holding the service directory's lock. The lock is a sequence of generation files
   * `locks/<n>`, each made whole and exclusively (a temporary file hard linked into place, so no
   * reader ever sees it empty) and never removed while it is the highest: the holder is the
   * process named in the highest one, until it writes `released` there (or its process is gone).
   * A taker links the next generation; of several takers that read the same highest generation
   * exactly one succeeds. A taker that stalled after its read can still link a generation that a
   * later holder already deleted (lower generations are removed by each holder), so every taker
   * reads the generations again after its link and backs off (writing `released` into its own)
   * while any higher one exists: the highest generation is never deleted, and a missing lower one
   * means a holder of a higher one deleted it. A live holder is waited for, with growing pauses,
   * until `signal` aborts or {@link INSTALL_CACHE_LOCK_WAIT_MS} passed.
   */
  private async locked<T>(dir: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const locks = join(dir, "locks");
    const deadline = Date.now() + INSTALL_CACHE_LOCK_WAIT_MS;
    const generations = async () =>
      (await readdir(locks)).filter((n) => /^[1-9]\d{0,15}$/.test(n)).map(Number);
    let pauseMs = 5;
    let mine = 0;
    for (;;) {
      signal.throwIfAborted();
      const top = Math.max(0, ...(await generations()));
      const holder = top === 0 ? undefined : await readSmallFile(join(locks, String(top)));
      const p = holder?.startsWith("holder ") ? parseToken(holder.slice(7)) : undefined;
      if (p === undefined || !this.isLive(p)) {
        if (!(await linkNew(join(locks, String(top + 1)), `holder ${tokenText(this.self)}\n`)))
          continue; // another taker linked it first: read again
        if ((await generations()).some((n) => n > top + 1)) {
          // a stale read: a later holder is (or was) above this generation
          await releaseGeneration(join(locks, String(top + 1)));
          continue;
        }
        mine = top + 1;
        break;
      }
      if (Date.now() >= deadline)
        throw new Error(
          `The install cache lock ${join(locks, String(top))} stays held by process ${p.pid}; retry once it is done`,
        );
      await new Promise((r) => setTimeout(r, pauseMs));
      pauseMs = Math.min(pauseMs * 2, 200);
    }
    try {
      // the lower generations and temporary files are no one's any more
      for (const name of await readdir(locks).catch(() => [] as string[]))
        if (name !== String(mine) && !(/^\d+$/.test(name) && Number(name) > mine))
          await rm(join(locks, name), { force: true }).catch(() => {});
      return await fn();
    } finally {
      await releaseGeneration(join(locks, String(mine)));
    }
  }
}

/**
 * Writes `released` into a generation file, retried; when that keeps failing the file is removed
 * instead (safe with the takers' read-again rule: the next taker links this number anew), so a
 * failed write never leaves the lock held until this process exits.
 */
async function releaseGeneration(path: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await writeAtomic(path, "released\n");
      return;
    } catch {
      // retried, then removed
    }
  }
  await unlink(path).catch(() => {});
}

/**
 * Creates `path` whole with `text`: a private temporary file hard linked into place (atomic and
 * exclusive; the temporary name goes after). False when `path` exists.
 */
async function linkNew(path: string, text: string): Promise<boolean> {
  const tmp = `${path}~${token()}.tmp`;
  await writeNew(tmp, text);
  try {
    await link(tmp, path);
    return true;
  } catch (e) {
    // ENOENT: a holder's cleanup removed the temporary file meanwhile; read again either way
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return false;
    throw e;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

const token = () => randomBytes(6).toString("hex");

/** `fn` run at most once; later calls get the first call's promise. */
function once(fn: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | undefined;
  return () => {
    done ??= fn();
    return done;
  };
}

function isGone(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Where a link at `rel` (inside the tree) with `target` leads, resolved component by component
 * against the real tree: a link met on the way is followed (at most {@link MAX_LINK_HOPS}), so a
 * chain of in-tree links that climbs out (`b -> ..`, then `e -> d/b/../x`) is caught. Throws
 * {@link InstallTreeError} for an absolute target or one that leaves the tree; a missing
 * component ends the real resolution (the rest is lexical: nothing missing can be a link).
 */
async function checkLink(root: string, rel: string, target: string): Promise<void> {
  const out = () => new InstallTreeError(`${join(root, rel)} links out of the install`);
  if (isAbsolute(target) || target.includes("\0")) throw out();
  const stack: string[] = [];
  let queue = [...posix.dirname(rel).split("/"), ...target.split("/")];
  let hops = 0;
  let real = true;
  while (queue.length > 0) {
    const part = queue.shift() as string;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) throw out();
      stack.pop();
      continue;
    }
    stack.push(part);
    if (!real) continue;
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(join(root, ...stack));
    } catch (e) {
      if (!isGone(e)) throw e;
      real = false;
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    if (++hops > MAX_LINK_HOPS) throw out();
    const next = await readlink(join(root, ...stack));
    if (isAbsolute(next) || next.includes("\0")) throw out();
    stack.pop();
    queue = [...next.split("/"), ...queue];
  }
}

/**
 * The digest of a tree (`v1:<sha256>`), read without following a link: per entry in path order,
 * its kind, path and permission bits, and a file's size and sha256 or a link's target. Throws
 * {@link InstallTreeError} for a link that is absolute or resolves out of the tree
 * ({@link checkLink}), a file with more than one hard link (another name could change it) and
 * anything but a file, directory or link: such a tree is never published or used.
 */
export async function treeDigest(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const names = (await readdir(rel === "" ? root : join(root, rel))).sort();
    for (const name of names) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const abs = join(root, path);
      const st = await lstat(abs);
      const mode = (st.mode & 0o777).toString(8);
      if (st.isSymbolicLink()) {
        const target = await readlink(abs);
        await checkLink(root, path, target);
        lines.push(`l ${JSON.stringify(path)} ${JSON.stringify(target)}`);
      } else if (st.isDirectory()) {
        lines.push(`d ${JSON.stringify(path)} ${mode}`);
        await walk(path);
      } else if (st.isFile()) {
        if (st.nlink > 1) throw new InstallTreeError(`${abs} has another hard link`);
        lines.push(`f ${JSON.stringify(path)} ${mode} ${st.size} ${await fileDigest(abs)}`);
      } else {
        throw new InstallTreeError(`${abs} is not a file, directory or link`);
      }
    }
  };
  await walk("");
  return `v1:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
}

/** The sha256 of a regular file, opened without following a link. */
async function fileDigest(path: string): Promise<string> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new InstallTreeError(`${path} is not a regular file`);
    if (st.nlink > 1) throw new InstallTreeError(`${path} has another hard link`);
    const hash = createHash("sha256");
    for await (const chunk of fh.createReadStream({ autoClose: false, highWaterMark: 1 << 20 }))
      hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    await fh.close();
  }
}

/**
 * Deletes `path`, best effort: when a plain removal fails, every directory below it (never
 * through a link) is made accessible to this user and, on macOS, the user immutable flags are
 * cleared, then it is removed again; a failure after that is left for the next sweep.
 */
export async function forceRemove(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    return;
  } catch {
    // made removable below
  }
  const open = async (p: string): Promise<void> => {
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(p);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    await chmod(p, 0o700).catch(() => {});
    for (const name of await readdir(p).catch(() => [] as string[])) await open(join(p, name));
  };
  if (process.platform === "darwin")
    // -R without -L or -H follows no link
    spawnSync("/usr/bin/chflags", ["-R", "nouchg", path], { stdio: "ignore", timeout: 30_000 });
  await open(path);
  await rm(path, { recursive: true, force: true }).catch(() => {});
}

/** A manifest record (never through a link), or undefined when there is none or it is malformed. */
async function readManifest(path: string): Promise<{ digest: string; entry: string } | undefined> {
  const m = MANIFEST_RE.exec((await readSmallFile(path)) ?? "");
  return m ? { digest: m[1] as string, entry: m[2] as string } : undefined;
}

/** A small record (at most 256 bytes, a regular file, never through a link), trimmed. */
async function readSmallFile(path: string): Promise<string | undefined> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    if (!(await fh.stat()).isFile()) return undefined;
    const buf = Buffer.alloc(257);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > 256) return undefined;
    return buf.subarray(0, bytesRead).toString("utf8").trim();
  } finally {
    await fh.close();
  }
}

/** Creates `path` exclusively (never through a link) with `text`. */
async function writeNew(path: string, text: string): Promise<void> {
  const fh = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await fh.writeFile(text);
  } finally {
    await fh.close();
  }
}

/**
 * Writes `path` through a new temporary file renamed over it; the temporary name (`~<rand>.tmp`)
 * is never a key or a lock generation, so a sweep removes one a crash left behind.
 */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}~${token()}.tmp`;
  try {
    await writeNew(tmp, text);
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}
