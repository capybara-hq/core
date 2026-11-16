import assert from "node:assert/strict";
import { posix } from "node:path";
import type { SandboxOperation } from "@capybara-hq/plugin-sdk";

/** Fixture setup only. All paths and symlink targets are absolute and inside the owned root. */
export type NativeFixtureEntry =
  | { path: string; kind: "directory" }
  | { path: string; kind: "file"; data: Uint8Array }
  | { path: string; kind: "symlink"; target: string };
/** Supplies isolated ordinary files and fresh native operations; never a permission grant. */
export interface SandboxNativeFixture {
  /** An empty owned temporary directory, expressed as an absolute POSIX device path. */
  root: string;
  /** A new operation ID for each factory call, consumed by one native method invocation. */
  operation(): Promise<Pick<SandboxOperation, "readFile" | "writeFile" | "stat" | "list" | "scan">>;
  /** Creates entries and their parents inside root; preserves entries from earlier seed calls. */
  seed(entries: readonly NativeFixtureEntry[]): Promise<void>;
  /** Removes fixture-owned resources, including after an assertion failure. */
  dispose(): Promise<void>;
}
/**
 * Checks ordinary native API compatibility in a fixture-owned temporary root. Each invocation
 * gets a fresh operation. Passing does not establish OS enforcement or permission capabilities.
 * The fixture owns setup and cleanup; no official plugin, database or network service is used.
 */
export async function runSandboxNativeConformance(fixture: SandboxNativeFixture): Promise<void> {
  const path = (name: string) => posix.join(fixture.root, name);
  const signal = new AbortController().signal;
  const fresh = async () => {
    const operation = await fixture.operation();
    assert(operation.list && operation.scan, "Native conformance requires list and scan");
    return operation as Required<typeof operation>;
  };
  const read = async (name: string, maxBytes: number) =>
    (await fresh()).readFile(path(name), { maxBytes, signal });
  const stat = async (name: string) => (await fresh()).stat(path(name), signal);
  const write = async (name: string, data: Uint8Array) =>
    (await fresh()).writeFile(path(name), data, signal);
  const list = async (name: string, limit: number) =>
    (await fresh()).list(path(name), { limit, signal });
  const scan = async (name: string) => (await fresh()).scan(path(name), { signal });
  const directory = (name: string): NativeFixtureEntry => ({ path: path(name), kind: "directory" });
  const file = (name: string): NativeFixtureEntry => ({
    path: path(name),
    kind: "file",
    data: new Uint8Array(),
  });
  const link = (name: string, target: string): NativeFixtureEntry => ({
    path: path(name),
    kind: "symlink",
    target: path(target),
  });
  const candidates = (names: string[]) =>
    names.map((name) => ({
      path: path(name),
      suggestedName: posix.basename(name),
    }));
  try {
    assert.equal(await stat("missing"), null, "missing stat must return null");
    assert.equal(await read("missing", 10), null, "missing read must return null");
    assert.equal(await list("missing", 10), null, "missing list must return null");
    assert.deepEqual(await scan("missing"), [], "missing scan must be empty");
    await fixture.seed([directory("empty")]);
    assert.equal((await stat("empty"))?.isDir, true);
    assert.equal(await read("empty", 10), null, "directory read must return null");
    assert.deepEqual(await list("empty", 0), { entries: [], truncated: false });
    const bytes = new Uint8Array([0, 255, 128, 10, 65, 0]);
    await write("parents/nested/binary", bytes);
    assert.deepEqual(await stat("parents/nested/binary"), { size: 6, isDir: false });
    assert.deepEqual(await read("parents/nested/binary", 6), { data: bytes, truncated: false });
    assert.deepEqual(await read("parents/nested/binary", 100), { data: bytes, truncated: false });
    assert.deepEqual(await read("parents/nested/binary", 3), {
      data: new Uint8Array([0, 255, 128]),
      truncated: true,
    });
    assert.deepEqual(await read("parents/nested/binary", 0), {
      data: new Uint8Array(),
      truncated: true,
    });
    await write("parents/nested/binary", new Uint8Array());
    assert.deepEqual(await read("parents/nested/binary", 0), {
      data: new Uint8Array(),
      truncated: false,
    });
    assert.deepEqual(await stat("parents/nested/binary"), { size: 0, isDir: false });
    assert.equal(await stat("parents/nested/binary/missing"), null);
    assert.equal(await read("parents/nested/binary/missing", 10), null);
    assert.equal(await list("parents/nested/binary/missing", 10), null);
    assert.deepEqual(await scan("parents/nested/binary/missing"), []);
    await assert.rejects(() => list("parents/nested/binary", 5));
    await assert.rejects(() => scan("parents/nested/binary"));
    await fixture.seed([
      directory("listing/B"),
      file("listing/a"),
      file("listing/\u{1f600}"),
      file("listing/\ue000"),
      link("listing/alias", "listing/B"),
      link("listing/dangling", "listing/missing"),
      link("file-link", "listing/a"),
    ]);
    assert.deepEqual(await list("listing", 0), { entries: [], truncated: true });
    assert.deepEqual(await list("listing", 2), {
      entries: [
        { name: "B", isDir: true },
        { name: "a", isDir: false },
      ],
      truncated: true,
    });
    assert.deepEqual(await list("listing", 6), {
      entries: [
        { name: "B", isDir: true },
        { name: "a", isDir: false },
        { name: "alias", isDir: true },
        { name: "dangling", isDir: false },
        { name: "\u{1f600}", isDir: false },
        { name: "\ue000", isDir: false },
      ],
      truncated: false,
    });
    await write("file-link", bytes);
    assert.deepEqual(await read("listing/a", 6), { data: bytes, truncated: false });
    assert.deepEqual(await stat("file-link"), { size: 6, isDir: false });
    assert.deepEqual(await list("listing/alias", 1), { entries: [], truncated: false });
    assert.equal(await read("listing/dangling", 10), null);
    await assert.rejects(() => write("listing/dangling", bytes));
    assert.equal(await stat("listing/missing"), null, "dangling writes must not create a target");
    await fixture.seed([file("percent/a%2f%ZZ/AGENTS.md"), file("percent/a%5c%/AGENTS.md")]);
    assert.deepEqual(await scan("percent"), candidates(["percent/a%2f%ZZ", "percent/a%5c%"]));
    const longName = "x".repeat(65);
    await fixture.seed([
      file("scan/AGENTS.md"),
      file("scan/a/.git"),
      file("scan/a/deep/AGENTS.md"),
      file("scan/a/deep/too-deep/.git"),
      directory("scan/false-hit/AGENTS.md"),
      file("scan/.hidden/.git"),
      file("scan/node_modules/.git"),
      file("scan/Library/.git"),
      file("scan/a/node_modules/.git"),
      file("scan/a/Library/.git"),
      file(`scan/${longName}/.git`),
      file(`scan/${longName}/valid/.git`),
      file("scan/ leading/.git"),
      file("scan/ trailing /.git"),
      file("scan/ leading/valid/.git"),
      link("scan/link", "scan/a"),
    ]);
    assert.deepEqual(
      await scan("scan"),
      candidates([
        "scan",
        "scan/ leading/valid",
        "scan/a",
        "scan/a/Library",
        "scan/a/deep",
        `scan/${longName}/valid`,
      ]),
      "scan must descend past hits and invalid names, and apply depth/skips exactly",
    );
    await fixture.seed([
      ...Array.from({ length: 51 }, (_, i) => file(`results/b${String(i).padStart(3, "0")}/.git`)),
      file("results/a/deep/.git"),
    ]);
    assert.deepEqual(
      await scan("results"),
      candidates([
        "results/a/deep",
        ...Array.from({ length: 49 }, (_, i) => `results/b${String(i).padStart(3, "0")}`),
      ]),
      "scan truncates to 50 only after sorting all visited candidates",
    );
    await fixture.seed([
      ...Array.from({ length: 500 }, (_, i) => directory(`visits/d${String(i).padStart(3, "0")}`)),
      file("visits/d498/.git"),
      file("visits/d499/.git"),
      file("visits/d000/deep/.git"),
    ]);
    assert.deepEqual(
      await scan("visits"),
      candidates(["visits/d498"]),
      "base counts as visit one; breadth-first visit 500 includes d498, excludes d499 and depth two",
    );
  } finally {
    await fixture.dispose();
  }
}
