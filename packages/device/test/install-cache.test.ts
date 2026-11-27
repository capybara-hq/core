import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_SERVICE_INSTALL_SEAL } from "@capybara-hq/plugin-sdk";
import { afterEach, expect, it } from "vitest";
import {
  INSTALL_CACHE_KEEP,
  InstallCache,
  type InstallCacheOptions,
  installCacheScope,
  treeDigest,
} from "../src/services/install-cache.js";

// The machine-wide install cache (capybara-hq/plugins#311): reuse across devices and plugin
// versions, verification on reuse, atomic publishing, concurrent installs, and the sweep.

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const signal = () => AbortSignal.timeout(10_000);
const SERVICE = "browser.browser";
const PROD = "https://prod.example.com";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cap-icache-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cacheRoot = join(root, "cache");
  const cache = (o: Partial<InstallCacheOptions> = {}) =>
    new InstallCache({ root: cacheRoot, scope: PROD, platform: "darwin", arch: "arm64", ...o });
  return { root, cacheRoot, cache };
}

/** What a browser service does in its unsealed install directory, then the seal. */
async function install(dir: string, body = "chromium binary", seal = true): Promise<void> {
  await mkdir(join(dir, "chromium-1255", "Chromium.app", "Contents"), { recursive: true });
  await writeFile(join(dir, "chromium-1255", "Chromium.app", "Contents", "chrome"), body);
  // a bundle's relative link inside the install is kept
  await symlink("Contents/chrome", join(dir, "chromium-1255", "Chromium.app", "current"));
  await writeFile(join(dir, "chromium-1255", "INSTALLATION_COMPLETE"), "");
  if (seal) await writeFile(join(dir, DEVICE_SERVICE_INSTALL_SEAL), "");
}

const missing = (path: string) => expect(lstat(path)).rejects.toThrow(/ENOENT/);

it("a sealed install is published once and reused by other devices and plugin versions", async () => {
  const { cacheRoot, cache } = await fixture();
  const first = await cache().acquire(SERVICE, "chromium-1255", signal());
  expect(first.sealed).toBe(false);
  // staged privately, never at the entry's path while the service writes
  expect(first.dir).toContain(`${join(cacheRoot)}/`);
  expect(first.dir).toContain("/staging/");
  await install(first.dir);
  await first.release();
  await missing(first.dir);
  // another device of the same deployment (another process: another cache object), whatever its
  // plugin version: the same key finds the published entry, read only, with nothing downloaded
  const second = await cache().acquire(SERVICE, "chromium-1255", signal());
  expect(second.sealed).toBe(true);
  expect(second.dir).toMatch(/\/entries\/chromium-1255$/);
  expect(
    await readFile(join(second.dir, "chromium-1255", "Chromium.app", "Contents", "chrome"), "utf8"),
  ).toBe("chromium binary");
  const third = await cache().acquire(SERVICE, "chromium-1255", signal());
  expect(third.dir).toBe(second.dir);
  await second.release();
  await third.release();
  // the cache root is this user's alone
  expect((await lstat(cacheRoot)).mode & 0o777).toBe(0o700);
});

it("another deployment, platform or service never shares an install", async () => {
  const { cache } = await fixture();
  const first = await cache().acquire(SERVICE, "chromium-1255", signal());
  await install(first.dir);
  await first.release();
  for (const other of [
    cache({ scope: "https://dev.example.com" }),
    cache({ arch: "x64" }),
    cache({ platform: "linux" }),
  ]) {
    const lease = await other.acquire(SERVICE, "chromium-1255", signal());
    expect(lease.sealed).toBe(false);
    await lease.release();
  }
  const lease = await cache().acquire("other.service", "chromium-1255", signal());
  expect(lease.sealed).toBe(false);
  await lease.release();
  expect(installCacheScope("https://prod.example.com/some/path")).toBe(PROD);
});

it("a corrupted entry is dropped and installed again, never used", async () => {
  const { cache } = await fixture();
  const first = await cache().acquire(SERVICE, "chromium-1255", signal());
  await install(first.dir);
  await first.release();
  const reused = await cache().acquire(SERVICE, "chromium-1255", signal());
  await reused.release();
  const chrome = join(reused.dir, "chromium-1255", "Chromium.app", "Contents", "chrome");
  await writeFile(chrome, "chromium binarZ");
  const again = await cache().acquire(SERVICE, "chromium-1255", signal());
  expect(again.sealed).toBe(false);
  await missing(reused.dir);
  await install(again.dir);
  await again.release();
  const fixed = await cache().acquire(SERVICE, "chromium-1255", signal());
  expect(fixed.sealed).toBe(true);
  expect(await readFile(chrome, "utf8")).toBe("chromium binary");
  await fixed.release();
});

it("a partial entry (a file gone, the seal gone) is never used", async () => {
  const { cache } = await fixture();
  for (const damage of ["chromium-1255/INSTALLATION_COMPLETE", DEVICE_SERVICE_INSTALL_SEAL]) {
    const first = await cache().acquire(SERVICE, "chromium-1255", signal());
    await install(first.dir);
    await first.release();
    const reused = await cache().acquire(SERVICE, "chromium-1255", signal());
    expect(reused.sealed).toBe(true);
    await reused.release();
    await rm(join(reused.dir, damage));
    const again = await cache().acquire(SERVICE, "chromium-1255", signal());
    expect(again.sealed).toBe(false);
    await again.release();
  }
});

it("an unsealed, linked-out or special install is discarded, not published", async () => {
  const { root, cache } = await fixture();
  // killed during the download: no seal
  const partial = await cache().acquire(SERVICE, "chromium-1255", signal());
  await install(partial.dir, "half", false);
  await partial.release();
  await missing(partial.dir);
  // a link out of the install (to something the service could change later)
  await writeFile(join(root, "outside"), "planted");
  const linked = await cache().acquire(SERVICE, "chromium-1255", signal());
  expect(linked.sealed).toBe(false);
  await install(linked.dir);
  await symlink(join(root, "outside"), join(linked.dir, "chromium-1255", "abs"));
  await linked.release();
  const relative = await cache().acquire(SERVICE, "chromium-1255", signal());
  expect(relative.sealed).toBe(false);
  await install(relative.dir);
  await symlink("../../outside", join(relative.dir, "chromium-1255", "up"));
  await relative.release();
  const still = await cache().acquire(SERVICE, "chromium-1255", signal());
  expect(still.sealed).toBe(false);
  await still.release();
  await expect(treeDigest(root)).resolves.toMatch(/^v1:/);
});

it("concurrent installs of one key publish one entry; the later copy is discarded", async () => {
  const { cache } = await fixture();
  const a = await cache().acquire(SERVICE, "chromium-1255", signal());
  const b = await cache().acquire(SERVICE, "chromium-1255", signal());
  expect(a.sealed || b.sealed).toBe(false);
  expect(a.dir).not.toBe(b.dir);
  await install(a.dir, "from a");
  await install(b.dir, "from b");
  await Promise.all([a.release(), b.release()]);
  await missing(a.dir);
  await missing(b.dir);
  const reused = await cache().acquire(SERVICE, "chromium-1255", signal());
  expect(reused.sealed).toBe(true);
  const body = await readFile(
    join(reused.dir, "chromium-1255", "Chromium.app", "Contents", "chrome"),
    "utf8",
  );
  expect(["from a", "from b"]).toContain(body);
  await reused.release();
});

it("waits for the lock a live process holds and takes over one whose process is gone", async () => {
  const { cache } = await fixture();
  const alive = new Set<number>([process.pid]);
  const c = cache({ alive: (pid) => alive.has(pid) });
  const warm = await c.acquire(SERVICE, "chromium-1255", signal());
  await warm.release();
  const serviceDir = warm.dir.replace(/\/staging\/.*$/, "");
  const lock = join(serviceDir, ".lock");
  // a crashed holder: taken over
  await writeFile(lock, "999999\n");
  const taken = await c.acquire(SERVICE, "chromium-1255", signal());
  await taken.release();
  await missing(lock);
  // a live holder: the start waits until it lets go
  alive.add(424242);
  await writeFile(lock, "424242\n");
  let done = false;
  const waiting = c.acquire(SERVICE, "chromium-1255", signal()).then((l) => {
    done = true;
    return l;
  });
  // the waiter polls the lock: it is still waiting after its first pauses
  await new Promise((r) => setImmediate(r));
  expect(done).toBe(false);
  await rm(lock);
  const lease = await waiting;
  await lease.release();
});

it("a revision change installs the new key; old keys go once no running service holds them", async () => {
  const { cache } = await fixture();
  const alive = new Set<number>([process.pid]);
  const c = cache({ alive: (pid) => alive.has(pid) });
  const publish = async (key: string) => {
    const l = await c.acquire(SERVICE, key, signal());
    expect(l.sealed).toBe(false);
    await install(l.dir);
    await l.release();
    return l.dir.replace(/\/staging\/.*$/, `/entries/${key}`);
  };
  const e1 = await publish("chromium-1");
  // a service still runs on chromium-1 (an older plugin version on another device)
  const held = await c.acquire(SERVICE, "chromium-1", signal());
  expect(held.sealed).toBe(true);
  const e2 = await publish("chromium-2");
  const e3 = await publish("chromium-3");
  const e4 = await publish("chromium-4");
  // kept: the leased one and the two most recently used
  expect(INSTALL_CACHE_KEEP).toBe(2);
  expect((await lstat(e1)).isDirectory()).toBe(true);
  await missing(e2);
  expect((await lstat(e3)).isDirectory()).toBe(true);
  expect((await lstat(e4)).isDirectory()).toBe(true);
  // its service exits: the next sweep removes it
  await held.release();
  await publish("chromium-5");
  await missing(e1);
  await missing(e3);
});

it("sweeps the staging directories and leases of processes that are gone", async () => {
  const { cache } = await fixture();
  const alive = new Set<number>([process.pid]);
  const c = cache({ alive: (pid) => alive.has(pid) });
  const l = await c.acquire(SERVICE, "chromium-1255", signal());
  const serviceDir = l.dir.replace(/\/staging\/.*$/, "");
  const orphan = join(serviceDir, "staging", "chromium-1255.999999.abcdef");
  await mkdir(orphan);
  await writeFile(join(orphan, "half.zip"), "x");
  const lease = join(serviceDir, "leases", "chromium-1255.999999.abcdef");
  await writeFile(lease, "");
  await install(l.dir);
  await l.release();
  await missing(orphan);
  await missing(lease);
});

it("refuses a cache root that is not private to this user, and invalid keys", async () => {
  const { cacheRoot, cache } = await fixture();
  await mkdir(cacheRoot, { mode: 0o755 });
  await chmod(cacheRoot, 0o755);
  await expect(cache().acquire(SERVICE, "chromium-1255", signal())).rejects.toThrow(
    /not a private directory/,
  );
  await chmod(cacheRoot, 0o700);
  for (const key of ["", "../x", ".hidden", "a/b", "x".repeat(200)])
    await expect(cache().acquire(SERVICE, key, signal())).rejects.toThrow(/Invalid install key/);
});

it("refuses a cache root that is a link", async () => {
  const { root, cacheRoot, cache } = await fixture();
  await mkdir(join(root, "real"), { mode: 0o700 });
  await symlink(join(root, "real"), cacheRoot);
  await expect(cache().acquire(SERVICE, "chromium-1255", signal())).rejects.toThrow(
    /not a private directory/,
  );
});
