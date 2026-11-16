import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ManagedOutputSpool,
  type OutputLocator,
  type OutputSpoolOptions,
} from "../src/exec/output-spool.js";

const signal = new AbortController().signal;
const roots: string[] = [];
const opened: ManagedOutputSpool[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(opened.splice(0).map((s) => s.close()));
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const ref = { executionId: "e", operationId: "o", instanceId: "d", instanceGeneration: "g" };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  releases.push(release);
  return { promise, release };
}
async function fixture(hook?: OutputSpoolOptions["barrier"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cap-output-")));
  roots.push(root);
  await mkdir(join(root, "private"), { mode: 0o700 });
  await mkdir(join(root, "project"));
  let locator: OutputLocator | undefined;
  const opts: OutputSpoolOptions = {
    privateRoot: join(root, "private"),
    artifactRoot: join(root, "project"),
    outputPath: join(root, "project", "nested", "task.out"),
    ref,
    pythonPath: "/usr/bin/python3",
    barrier: hook,
    publish: async (record) => {
      locator = structuredClone(record);
    },
  };
  const create = async () => {
    const spool = await ManagedOutputSpool.create(opts);
    opened.push(spool);
    return spool;
  };
  return { root, opts, create, locator: () => locator as OutputLocator };
}
it("creates separate exclusive no-follow files and preserves exact bounded byte ranges", async () => {
  const f = await fixture();
  const s = await f.create();
  const bytes = Buffer.from([0, 255, 240, 159, 152, 128]);
  await s.append(bytes, signal);
  expect(await readFile(f.opts.outputPath)).toEqual(bytes);
  expect((await stat(f.opts.outputPath)).ino).not.toBe(f.locator().identity.ino);
  expect(await s.read({ offset: 2, maxBytes: 3, signal })).toEqual({
    data: bytes.subarray(2, 5),
    offset: 2,
    nextOffset: 5,
    totalBytes: 6,
  });
  expect(await s.read({ offset: 99, maxBytes: 0, signal })).toEqual({
    data: Buffer.alloc(0),
    offset: 99,
    nextOffset: 99,
    totalBytes: 6,
  });
  await expect(f.create()).rejects.toThrow();
});
it.each(["ancestor", "final", "existing"])(
  "refuses %s artifact substitution before publication",
  async (kind) => {
    const f = await fixture();
    if (kind === "ancestor") await symlink(f.opts.privateRoot, join(f.opts.artifactRoot, "nested"));
    else {
      await mkdir(join(f.opts.artifactRoot, "nested"));
      if (kind === "final") await symlink(join(f.root, "unrelated"), f.opts.outputPath);
      else await writeFile(f.opts.outputPath, "owned-by-user");
    }
    await expect(f.create()).rejects.toThrow();
    expect(f.locator()).toBeUndefined();
  },
);
it("pinned artifact and ancestor replacements never redirect appends or retained reads", async () => {
  const f = await fixture();
  const s = await f.create();
  await rename(join(f.opts.artifactRoot, "nested"), join(f.opts.artifactRoot, "old"));
  await mkdir(join(f.opts.artifactRoot, "nested"));
  await writeFile(f.opts.outputPath, "replacement");
  await s.append(Buffer.from("exact"), signal);
  expect(await readFile(f.opts.outputPath, "utf8")).toBe("replacement");
  expect(await readFile(join(f.opts.artifactRoot, "old", "task.out"), "utf8")).toBe("exact");
  expect((await s.read({ offset: 0, maxBytes: 65536, signal })).data).toEqual(Buffer.from("exact"));
});
it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0.5])(
  "rejects invalid offset %s before I/O",
  async (offset) => {
    const f = await fixture();
    const s = await f.create();
    await expect(s.read({ offset, maxBytes: 0, signal })).rejects.toThrow(/bound/);
  },
);
it.each([-1, NaN, Infinity, 65537, 0.5])("rejects invalid budget %s", async (maxBytes) => {
  const f = await fixture();
  const s = await f.create();
  await expect(s.read({ offset: 0, maxBytes, signal })).rejects.toThrow(/bound/);
});
it("creation-sync-before-locator-and-launch", async () => {
  const events: string[] = [];
  const f = await fixture(async (name) => {
    events.push(name);
  });
  const publish = f.opts.publish;
  f.opts.publish = async (record) => {
    events.push("publish");
    await publish(record);
  };
  await f.create();
  expect(events.indexOf("spool-file-sync")).toBeLessThan(events.indexOf("publish"));
  expect(events.indexOf("artifact-file-sync")).toBeLessThan(events.indexOf("publish"));
  expect(events.filter((x) => x.startsWith("directory-sync:")).length).toBeGreaterThanOrEqual(3);
  expect(events.at(-1)).toBe("publish");
});
it("checkpoint-failure-keeps-published-prefix", async () => {
  let fail = false;
  const f = await fixture(async (name) => {
    if (fail && name === "checkpoint") throw Error("ENOSPC");
  });
  const s = await f.create();
  await s.append(Buffer.from("prefix"), signal);
  fail = true;
  await expect(s.append(Buffer.from("uncommitted"), signal)).rejects.toThrow("ENOSPC");
  expect((await s.read({ offset: 0, maxBytes: 65536, signal })).data).toEqual(
    Buffer.from("prefix"),
  );
  await s.close();
  const recovered = await ManagedOutputSpool.openExisting({ ...f.opts, locator: f.locator() });
  opened.push(recovered);
  expect((await recovered.read({ offset: 0, maxBytes: 65536, signal })).data).toEqual(
    Buffer.from("prefix"),
  );
  await expect(recovered.append(Buffer.from("replay"), signal)).rejects.toThrow();
});
it("pins a snapshot across append and read/expiry barriers", async () => {
  const entered = gate(),
    release = gate();
  let block = false;
  const f = await fixture(async (name) => {
    if (block && name === "read") {
      entered.release();
      await release.promise;
    }
  });
  const s = await f.create();
  await s.append(Buffer.from("old"), signal);
  block = true;
  const reading = s.read({ offset: 0, maxBytes: 65536, signal });
  await entered.promise;
  await s.append(Buffer.from("new"), signal);
  const expiry = s.expire(
    async () => {},
    async () => {},
  );
  release.release();
  expect(await reading).toEqual({
    data: Buffer.from("old"),
    offset: 0,
    nextOffset: 3,
    totalBytes: 3,
  });
  await expiry;
  await expect(s.read({ offset: 0, maxBytes: 1, signal })).rejects.toThrow(/expired/);
  expect(await readFile(f.opts.outputPath, "utf8")).toBe("oldnew");
});

it.each([
  "spool-file-sync",
  "artifact-file-sync",
  "directory-sync:2",
  "directory-sync:1",
  "directory-sync:0",
])("creation-sync-before-locator-and-launch refuses failed %s", async (boundary) => {
  const f = await fixture(async (name) => {
    if (name === boundary) throw Error("sync failed");
  });
  await expect(f.create()).rejects.toThrow("sync failed");
  expect(f.locator()).toBeUndefined();
});
it("creation rejects a pinned ancestor swapped before locator publication", async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async (name) => {
    if (name === "creation-verify") {
      await rename(f.opts.artifactRoot, `${f.opts.artifactRoot}-moved`);
      await mkdir(f.opts.artifactRoot);
    }
  });
  await expect(f.create()).rejects.toThrow(/ancestor changed/);
  expect(f.locator()).toBeUndefined();
});
it("retries actual short writes and reads without duplicating bytes", async () => {
  const f = await fixture();
  f.opts.io = { maxWriteBytes: 3, maxReadBytes: 2 };
  const s = await f.create();
  const bytes = Buffer.from("identical identical 😀");
  await s.append(bytes, signal);
  await s.append(bytes, signal);
  expect((await s.read({ offset: 0, maxBytes: 65536, signal })).data).toEqual(
    Buffer.concat([bytes, bytes]),
  );
  expect(await readFile(f.opts.outputPath)).toEqual(Buffer.concat([bytes, bytes]));
});
it("partial-write ENOSPC never publishes an uncommitted suffix", async () => {
  const f = await fixture();
  f.opts.io = { maxWriteBytes: 3, failWriteAfterBytes: 15 };
  const s = await f.create();
  await s.append(Buffer.from("prefix"), signal);
  await expect(s.append(Buffer.from("suffix"), signal)).rejects.toThrow();
  expect((await s.read({ offset: 0, maxBytes: 65536, signal })).data).toEqual(
    Buffer.from("prefix"),
  );
  await s.close();
  const reopened = await ManagedOutputSpool.openExisting({ ...f.opts, locator: f.locator() });
  opened.push(reopened);
  expect((await reopened.read({ offset: 0, maxBytes: 65536, signal })).data).toEqual(
    Buffer.from("prefix"),
  );
});
it.each(["artifact-write", "append-spool-sync", "checkpoint"])(
  "checkpoint-failure-keeps-published-prefix at %s",
  async (boundary) => {
    let fail = false;
    const f = await fixture(async (name) => {
      if (fail && name === boundary) throw Error("EIO");
    });
    const s = await f.create();
    await s.append(Buffer.from("prefix"), signal);
    fail = true;
    await expect(s.append(Buffer.from("suffix"), signal)).rejects.toThrow("EIO");
    expect((await s.read({ offset: 0, maxBytes: 65536, signal })).data).toEqual(
      Buffer.from("prefix"),
    );
  },
);
it("unexpected short reads fail instead of inventing EOF", async () => {
  const f = await fixture();
  f.opts.io = { maxReadBytes: 2, shortReadAfterBytes: 2 };
  const s = await f.create();
  await s.append(Buffer.from("longer"), signal);
  await expect(s.read({ offset: 0, maxBytes: 65536, signal })).rejects.toThrow(/short/);
});
it("an interrupted pinned read propagates its abort", async () => {
  const entered = gate(),
    release = gate();
  const f = await fixture(async (name) => {
    if (name === "read") {
      entered.release();
      await release.promise;
    }
  });
  const s = await f.create();
  await s.append(Buffer.from("bytes"), signal);
  const abort = new AbortController();
  const read = s.read({ offset: 0, maxBytes: 5, signal: abort.signal });
  const rejected = expect(read).rejects.toThrow("interrupted");
  await entered.promise;
  abort.abort(Error("interrupted"));
  await rejected;
  release.release();
});
it("one outstanding append bounds producer bytes while a sink is blocked", async () => {
  const entered = gate(),
    release = gate();
  const f = await fixture(async (name) => {
    if (name === "spool-write") {
      entered.release();
      await release.promise;
    }
  });
  const s = await f.create();
  const append = s.append(Buffer.alloc(65536, 1), signal);
  await entered.promise;
  await expect(s.append(Buffer.alloc(1), signal)).rejects.toThrow(/outstanding/);
  expect(await s.read({ offset: 0, maxBytes: 0, signal })).toMatchObject({ totalBytes: 0 });
  release.release();
  await append;
  expect((await s.read({ offset: 0, maxBytes: 65536, signal })).data.length).toBe(65536);
  await expect(s.append(Buffer.alloc(65537), signal)).rejects.toThrow(/bounded/);
});
it.each(["instanceGeneration", "executionId", "operationId"])(
  "reopen rejects changed %s without discovering paths",
  async (key) => {
    const f = await fixture();
    const s = await f.create();
    await s.close();
    await expect(
      ManagedOutputSpool.openExisting({
        ...f.opts,
        ref: { ...ref, [key]: "other" },
        locator: f.locator(),
      }),
    ).rejects.toThrow(/reference/);
  },
);
it("reopen rejects a private replacement and expiry never unlinks it", async () => {
  const f = await fixture();
  const s = await f.create();
  const path = join(f.opts.privateRoot, f.locator().name);
  await rename(path, `${path}.old`);
  await writeFile(path, "replacement");
  await expect(
    ManagedOutputSpool.openExisting({ ...f.opts, locator: f.locator() }),
  ).rejects.toThrow();
  await expect(
    s.expire(
      async () => {},
      async () => {},
    ),
  ).rejects.toThrow(/replacement/);
  expect(await readFile(path, "utf8")).toBe("replacement");
});
it.each(["expiry-tombstone", "expiry-unlink", "expiry-directory-sync", "expiry-complete"])(
  "expiry-tombstone-unlink-directory-sync retries interruption at %s",
  async (boundary) => {
    let failed = false;
    const events: string[] = [];
    const f = await fixture(async (name) => {
      events.push(name);
      if (!failed && name === boundary) {
        failed = true;
        throw Error("interrupted");
      }
    });
    const s = await f.create();
    await s.append(Buffer.from("artifact survives"), signal);
    let tombstoned = false,
      cleaned = false;
    const tombstone = async () => {
      tombstoned = true;
      events.push("tombstoned");
    };
    const complete = async () => {
      expect(tombstoned).toBe(true);
      cleaned = true;
      events.push("cleaned");
    };
    await expect(s.expire(tombstone, complete)).rejects.toThrow("interrupted");
    await s.close();
    const reopened = await ManagedOutputSpool.openExisting({
      ...f.opts,
      locator: f.locator(),
      cleanup: tombstoned,
    });
    opened.push(reopened);
    await reopened.expire(tombstone, complete);
    expect(cleaned).toBe(true);
    expect(events.lastIndexOf("expiry-directory-sync")).toBeLessThan(events.lastIndexOf("cleaned"));
    expect(await readFile(f.opts.outputPath, "utf8")).toBe("artifact survives");
  },
);

it("creation refuses final-file replacement before locator publication", async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async (name) => {
    if (name === "creation-verify") {
      await rename(f.opts.outputPath, `${f.opts.outputPath}.old`);
      await writeFile(f.opts.outputPath, "replacement");
    }
  });
  await expect(f.create()).rejects.toThrow(/file changed/);
  expect(f.locator()).toBeUndefined();
  expect(await readFile(f.opts.outputPath, "utf8")).toBe("replacement");
});
