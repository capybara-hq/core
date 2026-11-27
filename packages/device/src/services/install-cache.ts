import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
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
// installs once and then only runs (a browser of about 400 MB) is kept per OS user, deployment,
// platform, service and install key (DEVICE_SERVICE_INSTALL_KEY_FILE, the browser revision), not
// per device and plugin version. Layout under the root (0700, this user's):
//
//   <scope>-<platform>-<arch>/<service>/
//     .lock                       cross-process lock (pid inside) for publish, drop and sweep
//     entries/<key>/              a published install, sealed, never written again
//     manifests/<key>             "v1:<sha256>" of the entry's tree, written by this program only
//     leases/<key>.<pid>.<rand>   a service of this program runs on the entry
//     staging/<key>.<pid>.<rand>/ an install in progress, private to one start
//
// A start with a published entry gets it read only once its tree matches the manifest (verified
// at every reuse: a corrupted or partial entry is dropped and installed again, never used). A
// start without one gets a fresh staging directory, writable; when that service exits sealed,
// its tree is checked (no link out of it, no special file), digested and renamed into place
// under the lock, so a reader only ever sees a complete entry. Concurrent first installs on
// several devices each stage their own; the first to publish wins and the others are discarded.
// The scope (a deployment) keeps one deployment's service from planting what another runs.

/** The manifest format: a version and the sha256 of the tree listing. */
const MANIFEST_RE = /^v1:[0-9a-f]{64}$/;

/** How many unused entries a service keeps per scope (the newest by last use), besides the leased. */
export const INSTALL_CACHE_KEEP = 2;

/** How long a start waits for the lock another process holds before it fails. */
export const INSTALL_CACHE_LOCK_WAIT_MS = 60_000;

export interface InstallCacheOptions {
  /** The machine-wide root (`~/capybara-device/.install-cache`): made 0700 when missing. */
  root: string;
  /** The deployment the device belongs to (its origin): installs are shared only within it. */
  scope: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Whether a process with this id runs (default: signal 0; EPERM means it runs). */
  alive?: (pid: number) => boolean;
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

/**
 * The machine-wide cache root of an OS user: beside the default device directories
 * (`~/capybara-device/<device id>`), outside this program's state root (which a service's
 * sandbox may never read) and outside every device directory (which another connection's
 * sandbox denies).
 */
export function defaultInstallCacheRoot(home: string): string {
  return join(home, "capybara-device", ".install-cache");
}

/** The scope of a deployment's installs: its origin (the URL as given when it has none). */
export function installCacheScope(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Whether `key` is a valid install key ({@link DEVICE_SERVICE_INSTALL_KEY_RE}). */
export function validInstallKey(key: string | undefined): key is string {
  return key !== undefined && DEVICE_SERVICE_INSTALL_KEY_RE.test(key);
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class InstallCache {
  readonly root: string;
  private readonly scopeDir: string;
  private readonly alive: (pid: number) => boolean;

  constructor(private readonly o: InstallCacheOptions) {
    if (!isAbsolute(o.root)) throw new Error(`The install cache root ${o.root} is not absolute`);
    this.root = normalize(o.root);
    const scope = createHash("sha256").update(o.scope).digest("hex").slice(0, 16);
    this.scopeDir = `${scope}-${o.platform ?? process.platform}-${o.arch ?? process.arch}`;
    this.alive = o.alive ?? defaultAlive;
  }

  /**
   * The install directory of one start of `service` under `key`: the published entry, read only,
   * when it verifies; else a new staging directory, writable and empty.
   */
  async acquire(service: string, key: string, signal: AbortSignal): Promise<InstallLease> {
    if (!validInstallKey(key)) throw new Error(`Invalid install key ${JSON.stringify(key)}`);
    const dir = await this.serviceDir(service);
    const entry = join(dir, "entries", key);
    const manifest = join(dir, "manifests", key);
    // a lease taken under the lock: a sweep never removes an entry a start is about to verify
    const found = await this.locked(dir, signal, async () => {
      await this.sweep(dir, key);
      const recorded = await readSmallFile(manifest);
      if (recorded === undefined || !MANIFEST_RE.test(recorded)) return undefined;
      if (!(await isRealDirectory(entry))) return undefined;
      const lease = join(dir, "leases", `${key}.${process.pid}.${token()}`);
      await writeNew(lease, "");
      // the last use, which the sweep keeps the newest of
      const now = new Date();
      await utimes(manifest, now, now).catch(() => {});
      return { recorded, lease };
    });
    if (found !== undefined) {
      let actual: string | undefined;
      try {
        actual = (await isRegularFile(join(entry, DEVICE_SERVICE_INSTALL_SEAL)))
          ? await treeDigest(entry)
          : undefined;
      } catch {
        actual = undefined;
      }
      if (actual === found.recorded)
        return {
          dir: entry,
          sealed: true,
          release: once(async () => {
            await rm(found.lease, { force: true }).catch(() => {});
          }),
        };
      // corrupted or partial: dropped (unless another start republished it meanwhile), then
      // installed again like a missing one
      await rm(found.lease, { force: true }).catch(() => {});
      await this.locked(dir, signal, async () => {
        if ((await readSmallFile(manifest)) !== found.recorded) return;
        await rm(manifest, { force: true });
        await rm(entry, { recursive: true, force: true });
      });
    }
    signal.throwIfAborted();
    const staging = join(dir, "staging", `${key}.${process.pid}.${token()}`);
    await mkdir(staging, { mode: 0o700 });
    return {
      dir: staging,
      sealed: false,
      release: once(() => this.publish(dir, key, staging).catch(() => {})),
    };
  }

  /**
   * Publishes a staging directory its service sealed: digested outside the lock (it is private),
   * renamed into place under it unless an entry was published meanwhile; removed otherwise.
   */
  private async publish(dir: string, key: string, staging: string): Promise<void> {
    let digest: string | undefined;
    try {
      digest = (await isRegularFile(join(staging, DEVICE_SERVICE_INSTALL_SEAL)))
        ? await treeDigest(staging)
        : undefined;
    } catch {
      digest = undefined;
    }
    if (digest !== undefined) {
      await this.o.beforePublish?.();
      const entry = join(dir, "entries", key);
      const manifest = join(dir, "manifests", key);
      await this.locked(dir, AbortSignal.timeout(INSTALL_CACHE_LOCK_WAIT_MS), async () => {
        const recorded = await readSmallFile(manifest);
        if (recorded !== undefined && MANIFEST_RE.test(recorded) && (await isRealDirectory(entry)))
          return; // another start published first: this copy goes
        await rm(manifest, { force: true });
        await rm(entry, { recursive: true, force: true });
        await rename(staging, entry);
        await writeAtomic(manifest, `${digest}\n`);
        await this.sweep(dir, key);
      });
    }
    await rm(staging, { recursive: true, force: true });
  }

  /** `<root>/<scope>/<service>` with its parts, made link-free; the root checked private. */
  private async serviceDir(service: string): Promise<string> {
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
    const dir = await realDirectory(this.root, [this.scopeDir, service]);
    for (const part of ["entries", "manifests", "leases", "staging"])
      await realDirectory(dir, [part]);
    return dir;
  }

  /**
   * Removes, under the lock: leases and staging directories of processes that are gone, and every
   * entry (with its manifest) that no live lease holds and that is neither `keep` nor among the
   * {@link INSTALL_CACHE_KEEP} most recently used. Deleted devices cannot be enumerated, so a live
   * lease and recency stand in for "referenced by an install".
   */
  private async sweep(dir: string, keep: string): Promise<void> {
    const liveLeases = new Set<string>();
    for (const name of await readdir(join(dir, "leases"))) {
      const m = /^(.+)\.(\d+)\.[0-9a-f]+$/.exec(name);
      if (m && this.alive(Number(m[2]))) liveLeases.add(m[1] as string);
      else await rm(join(dir, "leases", name), { force: true });
    }
    for (const name of await readdir(join(dir, "staging"))) {
      const m = /^.+\.(\d+)\.[0-9a-f]+$/.exec(name);
      if (!m || !this.alive(Number(m[1])))
        await rm(join(dir, "staging", name), { recursive: true, force: true });
    }
    const keys = new Set([
      ...(await readdir(join(dir, "entries"))),
      ...(await readdir(join(dir, "manifests"))),
    ]);
    const used: { key: string; at: number }[] = [];
    for (const key of keys) {
      const at = await lstat(join(dir, "manifests", key)).then(
        (s) => (s.isFile() ? s.mtimeMs : -1),
        () => -1,
      );
      used.push({ key, at });
    }
    used.sort((a, b) => b.at - a.at);
    const recent = new Set(
      used
        .filter((u) => u.at >= 0)
        .slice(0, INSTALL_CACHE_KEEP)
        .map((u) => u.key),
    );
    for (const { key } of used) {
      if (key === keep || liveLeases.has(key) || recent.has(key)) continue;
      await rm(join(dir, "manifests", key), { force: true });
      await rm(join(dir, "entries", key), { recursive: true, force: true });
    }
  }

  /**
   * Runs `fn` holding `<dir>/.lock` (a file created exclusively, naming this process): a lock
   * whose process is gone is taken over; one held by a live process is waited for, with growing
   * pauses, until `signal` aborts or {@link INSTALL_CACHE_LOCK_WAIT_MS} passed.
   */
  private async locked<T>(dir: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const lock = join(dir, ".lock");
    const deadline = Date.now() + INSTALL_CACHE_LOCK_WAIT_MS;
    let pauseMs = 5;
    for (;;) {
      signal.throwIfAborted();
      try {
        await writeNew(lock, `${process.pid}\n`);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const holder = Number(await readSmallFile(lock));
      if (!Number.isInteger(holder) || holder <= 0 || !this.alive(holder)) {
        // its process is gone (or the file is not a lock): taken over; a racing taker fails the
        // exclusive create above and reads the new holder
        await unlink(lock).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error(
          `The install cache lock ${lock} stays held by process ${holder}; retry, or remove the file if that process is not capybara-device`,
        );
      await new Promise((r) => setTimeout(r, pauseMs));
      pauseMs = Math.min(pauseMs * 2, 200);
    }
    try {
      return await fn();
    } finally {
      await unlink(lock).catch(() => {});
    }
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

/**
 * The digest of a tree (`v1:<sha256>`), read without following a link: per entry in path order,
 * its kind, path and permission bits, and a file's size and sha256 or a link's target. A link
 * that is absolute or leaves the tree, or anything but a file, directory or link, throws: such a
 * tree is never published or used.
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
        const resolved = posix.normalize(posix.join(posix.dirname(path), target));
        if (
          isAbsolute(target) ||
          target.includes("\0") ||
          resolved === ".." ||
          resolved.startsWith("../")
        )
          throw new Error(`${abs} links out of the install`);
        lines.push(`l ${JSON.stringify(path)} ${JSON.stringify(target)}`);
      } else if (st.isDirectory()) {
        lines.push(`d ${JSON.stringify(path)} ${mode}`);
        await walk(path);
      } else if (st.isFile()) {
        lines.push(`f ${JSON.stringify(path)} ${mode} ${st.size} ${await fileDigest(abs)}`);
      } else {
        throw new Error(`${abs} is not a file, directory or link`);
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
    if (!(await fh.stat()).isFile()) throw new Error(`${path} is not a regular file`);
    const hash = createHash("sha256");
    for await (const chunk of fh.createReadStream({ autoClose: false, highWaterMark: 1 << 20 }))
      hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    await fh.close();
  }
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

/** Writes `path` through a new temporary file renamed over it. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${token()}.tmp`;
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
