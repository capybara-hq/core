import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
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
  InstallTreeError,
  installCacheScope,
  type ProcessToken,
  processStartTime,
  treeDigest,
} from "../src/services/install-cache.js";

// The machine-wide install cache (capybara-hq/plugins#311): reuse across devices and plugin
// versions, verification on reuse, atomic publishing, concurrent installs, the lock, the sweep.

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const signal = () => AbortSignal.timeout(10_000);
const SERVICE = "browser.browser";
const PROD = "https://prod.example.com";
const KEY = "chromium-1255";
const root0 = process.getuid?.() === 0;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cap-icache-")));
  cleanups.push(async () => {
    spawnSync("chmod", ["-R", "u+rwx", root]);
    if (process.platform === "darwin") spawnSync("/usr/bin/chflags", ["-R", "nouchg", root]);
    await rm(root, { recursive: true, force: true });
  });
  const cacheRoot = join(root, "cache");
  const cache = (o: Partial<InstallCacheOptions> = {}) =>
    new InstallCache({ root: cacheRoot, scope: PROD, platform: "darwin", arch: "arm64", ...o });
  return { root, cacheRoot, cache };
}

/** Processes the tests name: the live set; everything else is gone. */
function liveSet(...live: ProcessToken[]) {
  const set = new Set(live.map((p) => `${p.pid}-${p.start}`));
  return {
    isLive: (p: ProcessToken) => set.has(`${p.pid}-${p.start}`),
    add: (p: ProcessToken) => set.add(`${p.pid}-${p.start}`),
    remove: (p: ProcessToken) => set.delete(`${p.pid}-${p.start}`),
  };
}

/** The `<root>/<scope>/<service>` directory a lease's path lies in. */
const serviceDirOf = (dir: string) => dir.replace(/\/entries\/[^/]+$/, "");
/** The one `<root>/<scope>/<service>` directory of the tests' cache. */
async function svcDir(cacheRoot: string): Promise<string> {
  const scopes = (await readdir(cacheRoot)).filter((n) => /^[0-9a-f]{64}$/.test(n));
  expect(scopes).toHaveLength(1);
  return join(cacheRoot, scopes[0] as string, SERVICE);
}
const chrome = (dir: string) => join(dir, "chromium-1255", "Chromium.app", "Contents", "chrome");

/** What a browser service does in its unsealed install directory, then the seal. */
async function install(dir: string, body = "chromium binary", seal = true): Promise<void> {
  await mkdir(join(dir, "chromium-1255", "Chromium.app", "Contents"), { recursive: true });
  await writeFile(chrome(dir), body);
  // a bundle's relative link inside the install is kept
  await symlink("Contents/chrome", join(dir, "chromium-1255", "Chromium.app", "current"));
  await writeFile(join(dir, "chromium-1255", "INSTALLATION_COMPLETE"), "");
  if (seal) await writeFile(join(dir, DEVICE_SERVICE_INSTALL_SEAL), "");
}

/** Installs and publishes `key` through one start; resolves the published entry's path. */
async function publish(c: InstallCache, key = KEY, body = "chromium binary"): Promise<string> {
  const l = await c.acquire(SERVICE, key, signal());
  expect(l.sealed).toBe(false);
  await install(l.dir, body);
  await l.release();
  const again = await c.acquire(SERVICE, key, signal());
  expect(again.sealed).toBe(true);
  await again.release();
  return again.dir;
}

const missing = (path: string) => expect(lstat(path)).rejects.toThrow(/ENOENT/);

it("a sealed install is published once and reused by other devices and plugin versions", async () => {
  const { cacheRoot, cache } = await fixture();
  const first = await cache().acquire(SERVICE, KEY, signal());
  expect(first.sealed).toBe(false);
  // staged privately, never at the entry's path while the service writes
  expect(first.dir.startsWith(`${cacheRoot}/`)).toBe(true);
  // a short, digits-only name: the macOS sandbox spells a write root out in its rules
  expect(first.dir).toMatch(/\/staging\/\d+-\d+-\d{15}$/);
  await install(first.dir);
  await first.release();
  await missing(first.dir);
  // another device of the same deployment (another cache object), whatever its plugin version:
  // the same key finds the published entry, read only, with nothing downloaded
  const second = await cache().acquire(SERVICE, KEY, signal());
  expect(second.sealed).toBe(true);
  expect(second.dir).toMatch(/\/entries\/chromium-1255@[0-9a-f]{12}$/);
  expect(await readFile(chrome(second.dir), "utf8")).toBe("chromium binary");
  const third = await cache().acquire(SERVICE, KEY, signal());
  expect(third.dir).toBe(second.dir);
  await second.release();
  await third.release();
  // the cache root is this user's alone, and a scope is the full digest
  expect((await lstat(cacheRoot)).mode & 0o777).toBe(0o700);
  expect((await readdir(cacheRoot)).sort()).toEqual([
    expect.stringMatching(/^[0-9a-f]{64}$/),
    "staging",
  ]);
});

it("another deployment, platform, launch variant or service never shares an install", async () => {
  const { cache } = await fixture();
  await publish(cache());
  for (const other of [
    cache({ scope: "https://dev.example.com" }),
    cache({ scope: installCacheScope("https://prod.example.com/other") }),
    cache({ arch: "x64" }),
    cache({ platform: "linux" }),
  ]) {
    const lease = await other.acquire(SERVICE, KEY, signal());
    expect(lease.sealed).toBe(false);
    await lease.release();
  }
  const variant = await cache().acquire(SERVICE, KEY, signal(), "CAPYBARA_SERVICE_MACH=none");
  expect(variant.sealed).toBe(false);
  await variant.release();
  const service = await cache().acquire("other.service", KEY, signal());
  expect(service.sealed).toBe(false);
  await service.release();
  // the scope is the origin and the path, without a trailing slash
  expect(installCacheScope("https://prod.example.com/")).toBe(PROD);
  expect(installCacheScope("https://prod.example.com/a/")).toBe(`${PROD}/a`);
  expect(installCacheScope("https://prod.example.com/a")).not.toBe(
    installCacheScope("https://prod.example.com/b"),
  );
});

it("a corrupted entry is dropped and installed again under a new name, never used", async () => {
  const { cache } = await fixture();
  const entry = await publish(cache());
  await writeFile(chrome(entry), "chromium binarZ");
  const again = await cache().acquire(SERVICE, KEY, signal());
  expect(again.sealed).toBe(false);
  await install(again.dir);
  await again.release();
  const fixed = await cache().acquire(SERVICE, KEY, signal());
  expect(fixed.sealed).toBe(true);
  expect(fixed.dir).not.toBe(entry);
  expect(await readFile(chrome(fixed.dir), "utf8")).toBe("chromium binary");
  await fixed.release();
  // the corrupted entry went with the sweep (nothing held it)
  await missing(entry);
});

it("a corrupted entry another device still runs on is kept until it lets go", async () => {
  const { cache } = await fixture();
  const entry = await publish(cache());
  const running = await cache().acquire(SERVICE, KEY, signal());
  await writeFile(chrome(entry), "tampered");
  const again = await cache().acquire(SERVICE, KEY, signal());
  expect(again.sealed).toBe(false);
  await install(again.dir);
  await again.release();
  // the running browser's files stay in place under its lease
  expect(await readFile(chrome(entry), "utf8")).toBe("tampered");
  await running.release();
  const next = await cache().acquire(SERVICE, KEY, signal());
  expect(next.sealed).toBe(true);
  await next.release();
  await missing(entry);
});

it.skipIf(root0)(
  "an entry that cannot be read now is not dropped (a transient error)",
  async () => {
    const { cache } = await fixture();
    const entry = await publish(cache());
    await chmod(chrome(entry), 0o000);
    const blocked = await cache().acquire(SERVICE, KEY, signal());
    expect(blocked.sealed).toBe(false);
    await blocked.release(); // nothing sealed: nothing published
    await chmod(chrome(entry), 0o644);
    const back = await cache().acquire(SERVICE, KEY, signal());
    expect(back.sealed).toBe(true);
    expect(back.dir).toBe(entry);
    await back.release();
  },
);

it("a partial entry (a file gone, the seal gone) is never used", async () => {
  const { cache } = await fixture();
  for (const damage of ["chromium-1255/INSTALLATION_COMPLETE", DEVICE_SERVICE_INSTALL_SEAL]) {
    const entry = await publish(cache());
    await rm(join(entry, damage));
    const again = await cache().acquire(SERVICE, KEY, signal());
    expect(again.sealed).toBe(false);
    await again.release();
  }
});

it("an unsealed, linked-out, hard-linked or special install is discarded, not published", async () => {
  const { root, cache } = await fixture();
  await writeFile(join(root, "outside"), "planted");
  const plant: [string, (dir: string) => Promise<void>][] = [
    ["unsealed", async (dir) => rm(join(dir, DEVICE_SERVICE_INSTALL_SEAL))],
    ["absolute link", async (dir) => symlink(join(root, "outside"), join(dir, "abs"))],
    ["lexical climb", async (dir) => symlink("../../outside", join(dir, "chromium-1255", "up"))],
    [
      // each link is lexically inside; together they climb out
      "chained links",
      async (dir) => {
        await mkdir(join(dir, "d"));
        await symlink("..", join(dir, "d", "b"));
        await symlink("d/b/d/b/d/b/../../../outside", join(dir, "e"));
      },
    ],
    ["link loop", async (dir) => symlink("loop", join(dir, "loop"))],
    [
      // another name for the binary outside the install could change it after the digest
      "hard link",
      async (dir) => link(join(root, "outside"), join(dir, "chromium-1255", "helper")),
    ],
    [
      "fifo",
      async (dir) => {
        expect(spawnSync("mkfifo", [join(dir, "pipe")]).status).toBe(0);
      },
    ],
  ];
  for (const [what, damage] of plant) {
    const l = await cache().acquire(SERVICE, KEY, signal());
    expect(l.sealed, what).toBe(false);
    await install(l.dir);
    await damage(l.dir);
    await l.release();
    await missing(l.dir);
  }
  const still = await cache().acquire(SERVICE, KEY, signal());
  expect(still.sealed).toBe(false);
  await still.release();
});

it("resolves link chains against the real tree", async () => {
  const { root } = await fixture();
  const tree = join(root, "tree");
  await mkdir(join(tree, "d"), { recursive: true });
  await writeFile(join(tree, "bin"), "x");
  await symlink("..", join(tree, "d", "b"));
  // through d/b (the tree's root) back to bin: inside
  await symlink("d/b/d/b/bin", join(tree, "inside"));
  await expect(treeDigest(tree)).resolves.toMatch(/^v1:[0-9a-f]{64}$/);
  // one more climb from the root: outside
  await symlink("d/b/../bin", join(tree, "escape"));
  await expect(treeDigest(tree)).rejects.toBeInstanceOf(InstallTreeError);
});

it("concurrent installs of one key publish one entry; the later copy is discarded", async () => {
  const { cache } = await fixture();
  const a = await cache().acquire(SERVICE, KEY, signal());
  const b = await cache().acquire(SERVICE, KEY, signal());
  expect(a.sealed || b.sealed).toBe(false);
  expect(a.dir).not.toBe(b.dir);
  await install(a.dir, "from a");
  await install(b.dir, "from b");
  await Promise.all([a.release(), b.release()]);
  await missing(a.dir);
  await missing(b.dir);
  const reused = await cache().acquire(SERVICE, KEY, signal());
  expect(reused.sealed).toBe(true);
  expect(["from a", "from b"]).toContain(await readFile(chrome(reused.dir), "utf8"));
  expect(await readdir(join(serviceDirOf(reused.dir), "entries"))).toHaveLength(1);
  await reused.release();
});

it("a start that publishes while another is digesting wins; the later copy goes", async () => {
  const { cache } = await fixture();
  let first: Promise<void> | undefined;
  const other = cache();
  const b = await other.acquire(SERVICE, KEY, signal());
  await install(b.dir, "from b");
  // between A's digest and its publish, B publishes
  const a = await cache({ beforePublish: () => (first ??= b.release()) }).acquire(
    SERVICE,
    KEY,
    signal(),
  );
  await install(a.dir, "from a");
  await a.release();
  await missing(a.dir);
  await missing(b.dir);
  const reused = await cache().acquire(SERVICE, KEY, signal());
  expect(await readFile(chrome(reused.dir), "utf8")).toBe("from b");
  await reused.release();
});

/** The lock of a cache, run directly (the private method every write goes through). */
const lockOf = (c: InstallCache) =>
  (
    c as unknown as {
      locked<T>(dir: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T>;
    }
  ).locked.bind(c);

it("of several takers of a stale lock exactly one holds it at a time", async () => {
  const { cacheRoot, cache } = await fixture();
  const dead: ProcessToken = { pid: 999_999, start: 1 };
  const takers = Array.from({ length: 6 }, (_, i) => ({ pid: 1000 + i, start: 42 }));
  const live = liveSet(...takers);
  const caches = takers.map((self) => cache({ self, isLive: live.isLive }));
  const warm = await caches[0]?.acquire(SERVICE, KEY, signal());
  await warm?.release();
  const dir = await svcDir(cacheRoot);
  // a crash left the highest generation held by a process that is gone
  await writeFile(join(dir, "locks", "7"), `holder ${dead.pid}-${dead.start}\n`);
  let inside = 0;
  let most = 0;
  await Promise.all(
    caches.map((c) =>
      lockOf(c)(dir, signal(), async () => {
        inside++;
        most = Math.max(most, inside);
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        inside--;
      }),
    ),
  );
  expect(most).toBe(1);
  // the generations moved on past the stale one, and only the last (released) is left
  const left = await readdir(join(dir, "locks"));
  expect(left).toHaveLength(1);
  expect(Number(left[0])).toBe(7 + takers.length);
  expect(await readFile(join(dir, "locks", left[0] as string), "utf8")).toBe("released\n");
});

it("waits for a live holder, and a reused pid never keeps a dead holder's lock", async () => {
  const { cacheRoot, cache } = await fixture();
  const holder: ProcessToken = { pid: 4242, start: 7 };
  const self: ProcessToken = { pid: 5151, start: 7 };
  const live = liveSet(holder, self);
  const c = cache({ self, isLive: live.isLive });
  const warm = await c.acquire(SERVICE, KEY, signal());
  await warm.release();
  const dir = await svcDir(cacheRoot);
  const top = Math.max(...(await readdir(join(dir, "locks"))).map(Number));
  await writeFile(join(dir, "locks", String(top + 1)), `holder ${holder.pid}-${holder.start}\n`);
  let done = false;
  const waiting = c.acquire(SERVICE, KEY, signal()).then((l) => {
    done = true;
    return l;
  });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  expect(done).toBe(false);
  // the holder's process ends: its lock is free at the next look
  live.remove(holder);
  await (await waiting).release();
  // the real liveness check: this test's own pid with another start time is a reused pid
  const real = cache();
  await writeFile(
    join(dir, "locks", String(top + 99)),
    `holder ${process.pid}-${(processStartTime(process.pid) ?? 0) - 1000}\n`,
  );
  const quick = await real.acquire(SERVICE, KEY, signal());
  await quick.release();
});

it("a revision change installs the new key; old keys go once no running service holds them", async () => {
  const { cache } = await fixture();
  const c = cache();
  const e1 = await publish(c, "chromium-1");
  // a service still runs on chromium-1 (an older plugin version on another device)
  const held = await c.acquire(SERVICE, "chromium-1", signal());
  expect(held.sealed).toBe(true);
  const e2 = await publish(c, "chromium-2");
  const e3 = await publish(c, "chromium-3");
  const e4 = await publish(c, "chromium-4");
  // kept: the leased one and the two most recently used
  expect(INSTALL_CACHE_KEEP).toBe(2);
  expect((await lstat(e1)).isDirectory()).toBe(true);
  await missing(e2);
  expect((await lstat(e3)).isDirectory()).toBe(true);
  expect((await lstat(e4)).isDirectory()).toBe(true);
  // its service exits: the next sweep removes it
  await held.release();
  await publish(c, "chromium-5");
  await missing(e1);
  await missing(e3);
});

it("sweeps the staging directories and leases of processes that are gone (a reused pid too)", async () => {
  const { cacheRoot, cache } = await fixture();
  const c = cache();
  const l = await c.acquire(SERVICE, KEY, signal());
  const dir = await svcDir(cacheRoot);
  // a dead process, and this very pid with another start time (a reused pid)
  const reused = `${process.pid}-${(processStartTime(process.pid) ?? 0) - 1000}`;
  const owners = ["999999-1", reused];
  for (const owner of owners) {
    const orphan = join(cacheRoot, "staging", `${owner}-000000000000001`);
    await mkdir(orphan);
    await writeFile(join(orphan, "half.zip"), "x");
    await writeFile(join(dir, "leases", `${KEY}@000000000000~${owner}~ab`), "");
  }
  await install(l.dir);
  await l.release();
  for (const owner of owners) await missing(join(cacheRoot, "staging", `${owner}-000000000000001`));
  expect(await readdir(join(cacheRoot, "staging"))).toEqual([]);
  expect(await readdir(join(dir, "leases"))).toEqual([]);
  expect(await readdir(join(dir, "trash"))).toEqual([]);
});

it.skipIf(root0)(
  "what cannot be deleted never blocks a start; it is removed once possible",
  async () => {
    const { cacheRoot, cache } = await fixture();
    const c = cache();
    const l = await c.acquire(SERVICE, KEY, signal());
    const dir = await svcDir(cacheRoot);
    // an unsealed run of a gone process left a directory without access, and a locked file
    const orphan = join(cacheRoot, "staging", "999999-1-000000000000001");
    await mkdir(join(orphan, "inner"), { recursive: true });
    await writeFile(join(orphan, "inner", "f"), "x");
    await chmod(join(orphan, "inner"), 0o000);
    if (process.platform === "darwin") {
      await writeFile(join(orphan, "locked"), "x");
      expect(spawnSync("/usr/bin/chflags", ["uchg", join(orphan, "locked")]).status).toBe(0);
    }
    await install(l.dir);
    await l.release();
    // made accessible and removed
    await missing(orphan);
    expect(await readdir(join(dir, "trash"))).toEqual([]);
    // an entry due for removal that cannot be moved (the trash refuses it): starts still work
    const stale = join(dir, "entries", "chromium-9@000000000000");
    await mkdir(stale);
    await chmod(join(dir, "trash"), 0o500);
    const next = await c.acquire(SERVICE, KEY, signal());
    expect(next.sealed).toBe(true);
    await next.release();
    expect((await lstat(stale)).isDirectory()).toBe(true);
    // once it can, the next sweep removes it
    await chmod(join(dir, "trash"), 0o700);
    const after = await c.acquire(SERVICE, KEY, signal());
    await after.release();
    await missing(stale);
  },
);

it("refuses a cache root that is not private to this user, and invalid keys", async () => {
  const { cacheRoot, cache } = await fixture();
  await mkdir(cacheRoot, { mode: 0o755 });
  await chmod(cacheRoot, 0o755);
  await expect(cache().acquire(SERVICE, KEY, signal())).rejects.toThrow(/not a private directory/);
  await chmod(cacheRoot, 0o700);
  for (const key of ["", "../x", ".hidden", "a/b", "x".repeat(200), "Chromium-1255", "a~b", "a@b"])
    await expect(cache().acquire(SERVICE, key, signal())).rejects.toThrow(/Invalid install key/);
});

it("refuses a cache root that is a link", async () => {
  const { root, cacheRoot, cache } = await fixture();
  await mkdir(join(root, "real"), { mode: 0o700 });
  await symlink(join(root, "real"), cacheRoot);
  await expect(cache().acquire(SERVICE, KEY, signal())).rejects.toThrow(/not a private directory/);
});
