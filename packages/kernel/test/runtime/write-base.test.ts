import { createHash } from "node:crypto";
import { ToolError, type ToolInputView } from "@capybara-hq/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import type { ExecutionClaim } from "../../src/runtime/run-execution.js";
import {
  chooseGuess,
  closedStringProperty,
  GUESS_PREFIX_LINES,
  guessLines,
  TopLevelStringProperty,
  TopLevelStrings,
  WRITE_BASE_CANDIDATES,
  WRITE_BASE_SETTLE_MS,
  type WriteBase,
  type WriteBaseReader,
  writeBaseViewOf,
  writeBaseWatcher,
} from "../../src/runtime/write-base.js";
import {
  expectedNoBase,
  readWriteBase,
  type WriteBaseReadDeps,
} from "../../src/runtime/write-base.service.js";
import {
  KernelReadInstanceNotRunning,
  KernelReadNotAdmitted,
  KernelReadUnsupported,
} from "../../src/sandbox/kernel-read.js";
import { sandboxBusy } from "../../src/sandbox/leases.js";
import { recreateRequired, retirementPending } from "../../src/sandbox/sandbox.service.js";
import { TOOL_VIEW_DIFF_MAX_TEXT_BYTES } from "../../src/tools/view.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

describe("closedStringProperty", () => {
  it("is null until the property's closing quote arrives", () => {
    expect(closedStringProperty('{"file_path":"/w/a', "file_path")).toBeNull();
    expect(closedStringProperty('{"file_path":"/w/a.py","con', "file_path")).toBe("/w/a.py");
  });

  it("decodes escapes", () => {
    expect(closedStringProperty('{"file_path":"/w/\\"q\\".py"}', "file_path")).toBe('/w/"q".py');
    expect(closedStringProperty('{"file_path":"/w/\\u00e9.txt"}', "file_path")).toBe("/w/é.txt");
  });

  it("ignores a nested object's property, another value's text and other keys", () => {
    expect(closedStringProperty('{"x":{"file_path":"/w/n"},"file_path":"/w/t"}', "file_path")).toBe(
      "/w/t",
    );
    expect(closedStringProperty('{"x":{"file_path":"/w/n"}}', "file_path")).toBeNull();
    expect(
      closedStringProperty(
        '{"content":"\\"file_path\\":\\"/w/x\\"","file_path":"/w/y"}',
        "file_path",
      ),
    ).toBe("/w/y");
    expect(closedStringProperty('{"a":["file_path","/w/z"],"file_path":"/w/y"}', "file_path")).toBe(
      "/w/y",
    );
    expect(closedStringProperty('{"file_path_x":"/w/n"}', "file_path")).toBeNull();
  });

  it("gives nothing for a non-string value or a top level that is not an object", () => {
    expect(closedStringProperty('{"file_path":12,"a":"b"}', "file_path")).toBeNull();
    expect(closedStringProperty('["file_path","/w/a"]', "file_path")).toBeNull();
    expect(closedStringProperty('{"file_path" : "/w/a"}', "file_path")).toBe("/w/a");
    expect(closedStringProperty('{\t"file_path"\r\n:\n"/w/a"}', "file_path")).toBe("/w/a");
    // not JSON whitespace: the value is not a string, so nothing
    expect(closedStringProperty('{"file_path":\u00a0"/w/a"}', "file_path")).toBeNull();
  });

  it("finds the same value fed one character at a time", () => {
    const json = '{ "content": "a\\"b{[", "file_path": "/w/\\\\x.py", "more": 1 }';
    const s = new TopLevelStringProperty("file_path");
    let got: string | null = null;
    const seen: (string | null)[] = [];
    for (const c of json) {
      got = s.feed(c);
      seen.push(got);
    }
    expect(got).toBe("/w/\\x.py");
    // null exactly until the closing quote of the value
    const closed = json.indexOf('.py"') + 3;
    expect(seen.slice(0, closed).every((v) => v === null)).toBe(true);
    expect(seen[closed]).toBe("/w/\\x.py");
  });
});

describe("writeBaseViewOf (ruling R7)", () => {
  const view: ToolInputView = { kind: "file_write", path: "file_path", content: "content" };
  it("gives the view of the builtin Write only", () => {
    const tools = [
      {
        key: "Write",
        spec: { inputView: view },
        source: { kind: "builtin" as const, name: "Write" },
      },
      {
        key: "ext__put",
        spec: { inputView: view },
        source: { kind: "plugin" as const, plugin: "ext", name: "put" },
      },
      {
        key: "mcp__fs__write",
        spec: { inputView: view },
        source: { kind: "connector" as const, connectorId: "c", name: "write" },
      },
      { key: "Bare", spec: { inputView: view } },
      {
        key: "Edit",
        spec: { inputView: { kind: "file_edit" as const, path: "p", old: "o", new: "n" } },
        source: { kind: "builtin" as const, name: "Edit" },
      },
    ];
    expect(writeBaseViewOf(tools, "Write")).toEqual(view);
    for (const name of ["ext__put", "mcp__fs__write", "Bare", "Edit", "Missing"])
      expect(writeBaseViewOf(tools, name)).toBeUndefined();
  });
});

const WRITE: ToolInputView = { kind: "file_write", path: "file_path", content: "content" };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function watcherWith(
  read: WriteBaseReader["read"],
  signal = new AbortController().signal,
  recentPaths: WriteBaseReader["recentPaths"] = async () => [],
) {
  const emit = vi.fn<(callId: string, base: WriteBase & { guess?: { path: string } }) => void>();
  const verdict = vi.fn<(callId: string, confirmed: boolean) => void>();
  const warn = vi.fn();
  const info = vi.fn();
  const reader = {
    read: vi.fn(read),
    recentPaths: vi.fn(recentPaths),
    // the test's normalization: absolute paths only, `//` collapsed
    normalize: (p: string) => (p.startsWith("/") ? p.replace(/\/+/g, "/") : null),
  };
  const w = writeBaseWatcher({
    reader,
    inputViewOf: (name) => (name === "Write" ? WRITE : name === "Bash" ? undefined : undefined),
    emit,
    verdict,
    conversationId: "c1",
    model: { provider: "p", model: "m" },
    signal,
    log: { warn, info },
  });
  return { w, emit, verdict, warn, info, reader };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe("writeBaseWatcher", () => {
  it("reads once for a file_write call after its path closes and emits the base", async () => {
    const base = { text: "old\n", sha256: "h" };
    const { w, emit, reader } = watcherWith(async () => base);
    w.onStart("t1", "Write");
    w.onInput("t1", '{"file_path":"/w/a');
    expect(reader.read).not.toHaveBeenCalled();
    w.onInput("t1", '.py","content":"x');
    w.onInput("t1", 'y"}');
    await flush();
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.read.mock.calls[0]?.[0]).toMatchObject({ conversationId: "c1", path: "/w/a.py" });
    expect(emit).toHaveBeenCalledExactlyOnceWith("t1", base);
  });

  it("never reads for a tool without a file_write view, nor a repeated start", async () => {
    const { w, reader } = watcherWith(async () => ({ text: "", sha256: "h" }));
    w.onStart("b1", "Bash");
    w.onInput("b1", '{"file_path":"/w/a.py"}');
    w.onInput("x1", '{"file_path":"/w/a.py"}');
    w.onStart("t1", "Write");
    w.onInput("t1", '{"file_path":"/w/a.py"}');
    w.onStart("t1", "Write");
    w.onInput("t1", '{"file_path":"/w/b.py"}');
    await flush();
    expect(reader.read).toHaveBeenCalledTimes(1);
  });

  it("emits nothing when the reader finds no base", async () => {
    const { w, emit, reader } = watcherWith(async () => null);
    w.onStart("t1", "Write");
    w.onInput("t1", '{"file_path":"/w/a.py"}');
    await flush();
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits nothing for a read that resolves after the signal aborted", async () => {
    const ac = new AbortController();
    const d = deferred<WriteBase | null>();
    const { w, emit, warn } = watcherWith(() => d.promise, ac.signal);
    w.onStart("t1", "Write");
    w.onInput("t1", '{"file_path":"/w/a.py"}');
    ac.abort();
    d.resolve({ text: "old", sha256: "h" });
    await flush();
    expect(emit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("starts no read once the signal aborted", async () => {
    const ac = new AbortController();
    const { w, reader } = watcherWith(async () => null, ac.signal);
    w.onStart("t1", "Write");
    ac.abort();
    w.onInput("t1", '{"file_path":"/w/a.py"}');
    w.onStart("t2", "Write");
    w.onInput("t2", '{"file_path":"/w/a.py"}');
    await flush();
    expect(reader.read).not.toHaveBeenCalled();
  });

  it("settles only once every read started has finished, also after an abort", async () => {
    const ac = new AbortController();
    const d = deferred<WriteBase | null>();
    const { w, emit } = watcherWith(() => d.promise, ac.signal);
    await w.settle();
    w.onStart("t1", "Write");
    w.onInput("t1", '{"file_path":"/w/a.py"}');
    let settled = false;
    const s = w.settle().then(() => {
      settled = true;
    });
    ac.abort();
    await flush();
    expect(settled).toBe(false);
    d.resolve({ text: "late", sha256: "h" });
    await s;
    expect(settled).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it("stops waiting for a read that never settles once the bound elapsed, warning once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const ac = new AbortController();
      // a provider that ignores its abort: the read never ends
      const { w, warn } = watcherWith(() => new Promise<never>(() => {}), ac.signal);
      w.onStart("t1", "Write");
      w.onInput("t1", '{"file_path":"/w/a.py"}');
      ac.abort();
      let settled = false;
      const s = w.settle().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(WRITE_BASE_SETTLE_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await s;
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toMatchObject({ conversationId: "c1", pending: 1 });
      // a second wait on the same stray read is bounded too, and not logged again
      const again = w.settle();
      await vi.advanceTimersByTimeAsync(WRITE_BASE_SETTLE_MS);
      await again;
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer when the reads end before the bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const d = deferred<WriteBase | null>();
      const { w, warn } = watcherWith(() => d.promise);
      w.onStart("t1", "Write");
      w.onInput("t1", '{"file_path":"/w/a.py"}');
      const s = w.settle();
      expect(vi.getTimerCount()).toBe(1);
      d.resolve(null);
      await s;
      expect(vi.getTimerCount()).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles after a reader that throws", async () => {
    const d = deferred<WriteBase | null>();
    const { w } = watcherWith(() => d.promise);
    w.onStart("t1", "Write");
    w.onInput("t1", '{"file_path":"/w/a.py"}');
    const s = w.settle();
    d.reject(new Error("boom"));
    await expect(s).resolves.toBeUndefined();
  });

  it("swallows and logs a reader that throws", async () => {
    const { w, emit, warn } = watcherWith(async () => {
      throw new Error("boom");
    });
    w.onStart("t1", "Write");
    expect(() => w.onInput("t1", '{"file_path":"/w/a.py"}')).not.toThrow();
    await flush();
    expect(emit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("TopLevelStrings", () => {
  const input = JSON.stringify({ content: 'a\\b "q"\nline2\né', file_path: "/w/a.py" });

  it("orders two properties' openings and closings, also within one fragment", () => {
    const s = new TopLevelStrings([{ name: "file_path" }, { name: "content" }]);
    s.feed(input);
    const c = s.timing("content");
    const p = s.timing("file_path");
    expect(c.openedAt).toBeGreaterThan(0);
    expect(c.openedAt).toBeLessThan(c.closedAt);
    expect(c.closedAt).toBeLessThan(p.openedAt);
    expect(s.value("file_path")).toBe("/w/a.py");
    expect(s.value("content")).toBe('a\\b "q"\nline2\né');
  });

  it("reads the open value's decoded head at every cut, never a broken escape", () => {
    const content = 'a\\b "q"\nline2\né😀 end';
    const json = JSON.stringify({ content, file_path: "/w/a.py" });
    for (let cut = 0; cut <= json.length; cut++) {
      const s = new TopLevelStrings([{ name: "content" }]);
      s.feed(json.slice(0, cut));
      s.feed("");
      const head = s.prefix("content");
      if (head === null) continue;
      // every head is a prefix of the value, up to a lone high surrogate at its end
      const trimmed = /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head;
      expect(content.startsWith(trimmed), `cut ${cut}: ${JSON.stringify(head)}`).toBe(true);
    }
  });

  it("keeps only the head of a capped keep-head value, and still sees it close", () => {
    const s = new TopLevelStrings([{ name: "content", maxChars: 4, overflow: "keep-head" }]);
    s.feed('{"content":"abcdefgh","x":1}');
    expect(s.prefix("content")).toBe("abcd");
    expect(s.value("content")).toBeNull();
    expect(s.timing("content").closedAt).toBeGreaterThan(0);
  });

  it("gives nothing for a non-string value", () => {
    const s = new TopLevelStrings([{ name: "content" }]);
    s.feed('{"content":12,"y":"z"}');
    expect(s.prefix("content")).toBeNull();
    expect(s.timing("content").openedAt).toBe(0);
  });
});

describe("guessLines and chooseGuess", () => {
  it("keeps non-blank trimmed lines, the last one only when complete", () => {
    expect(guessLines("  a\n\nb \nc", false)).toEqual(["a", "b"]);
    expect(guessLines("  a\n\nb \nc", true)).toEqual(["a", "b", "c"]);
  });

  it("picks the clear best candidate at or above the score and margin", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const hit = { id: 1, text: "a\nb\nc\nzz\n" }; // 3 / 5 = 0.6
    const weak = { id: 2, text: "a\n" }; // 0.2
    expect(chooseGuess(lines, [weak, hit])).toBe(hit);
    expect(chooseGuess(lines, [{ id: 3, text: "a\nb\n" }])).toBeNull(); // 0.4
    // two near candidates: no clear winner
    expect(chooseGuess(lines, [hit, { id: 4, text: "a\nb\nd\n" }])).toBeNull();
    expect(chooseGuess([], [hit])).toBeNull();
  });
});

describe("writeBaseWatcher guess (spec 2026-11-27 §4)", () => {
  const FILE = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  const OTHER = "something else\nentirely\n";
  const bases: Record<string, WriteBase> = {
    "/w/a.py": { text: `${FILE}\nold tail\n`, sha256: "ha" },
    "/w/b.py": { text: OTHER, sha256: "hb" },
  };
  const readBase: WriteBaseReader["read"] = async ({ path }) => bases[path] ?? null;
  const recent = async () => ["/w/b.py", "/w/a.py"];
  /** The input with content first, cut in two: the content, then the path. */
  const contentFirst = (path: string, content = FILE) => {
    const json = JSON.stringify({ content, file_path: path });
    const at = json.indexOf(',"file_path"');
    return [json.slice(0, at), json.slice(at)] as const;
  };

  it("guesses the matching candidate once the content streamed, then confirms it", async () => {
    const { w, emit, verdict, reader, info } = watcherWith(readBase, undefined, recent);
    const [head, tail] = contentFirst("/w/a.py");
    w.onStart("t1", "Write");
    w.onInput("t1", head.slice(0, 20));
    w.onInput("t1", head.slice(20));
    await flush();
    expect(reader.recentPaths).toHaveBeenCalledExactlyOnceWith({
      conversationId: "c1",
      limit: WRITE_BASE_CANDIDATES,
    });
    expect(emit).toHaveBeenCalledExactlyOnceWith("t1", {
      text: bases["/w/a.py"]?.text,
      sha256: "ha",
      guess: { path: "/w/a.py" },
    });
    w.onInput("t1", tail);
    expect(verdict).toHaveBeenCalledExactlyOnceWith("t1", true);
    await flush();
    // a confirmed guess starts no second read: two candidates read, nothing else
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledTimes(1);
    await w.settle();
    expect(info).toHaveBeenCalledExactlyOnceWith("write input order", {
      conversationId: "c1",
      provider: "p",
      model: "m",
      order: "content_first",
      guess: "confirmed",
    });
  });

  it("chooses after GUESS_PREFIX_LINES lines, before the content closes", async () => {
    const { w, emit } = watcherWith(readBase, undefined, recent);
    const [head] = contentFirst("/w/a.py");
    const cut = head.indexOf(`line ${GUESS_PREFIX_LINES}`);
    w.onStart("t1", "Write");
    w.onInput("t1", head.slice(0, cut - 4));
    await flush();
    expect(emit).not.toHaveBeenCalled();
    w.onInput("t1", head.slice(cut - 4, cut + 2));
    await flush();
    expect(emit).toHaveBeenCalledTimes(1);
    // later fragments never guess again
    w.onInput("t1", head.slice(cut + 2));
    await flush();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("withdraws a guess the path contradicts, then reads the real path", async () => {
    const { w, emit, verdict, reader, info } = watcherWith(readBase, undefined, recent);
    const [head, tail] = contentFirst("/w/c.py");
    w.onStart("t1", "Write");
    w.onInput("t1", head);
    await flush();
    expect(emit).toHaveBeenCalledTimes(1);
    w.onInput("t1", tail);
    expect(verdict).toHaveBeenCalledExactlyOnceWith("t1", false);
    await flush();
    expect(reader.read).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/w/c.py" }));
    await w.settle();
    expect(info.mock.calls[0]?.[1]).toMatchObject({ guess: "rejected" });
  });

  it("guesses nothing when no candidate matches clearly, and reads the path when it closes", async () => {
    const { w, emit, verdict, reader, info } = watcherWith(readBase, undefined, recent);
    const [head, tail] = contentFirst("/w/a.py", "brand\nnew\nfile\n");
    w.onStart("t1", "Write");
    w.onInput("t1", head);
    await flush();
    expect(emit).not.toHaveBeenCalled();
    w.onInput("t1", tail);
    expect(verdict).not.toHaveBeenCalled();
    await flush();
    // the exact read of the closed path still runs (here it finds the file)
    expect(reader.read).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/w/a.py" }));
    expect(emit).toHaveBeenCalledExactlyOnceWith("t1", bases["/w/a.py"]);
    await w.settle();
    expect(info.mock.calls[0]?.[1]).toMatchObject({ order: "content_first", guess: "no_match" });
  });

  it("never guesses after the path closed while the candidates were being read", async () => {
    const list = deferred<string[]>();
    const { w, emit, verdict, info } = watcherWith(readBase, undefined, () => list.promise);
    const [head, tail] = contentFirst("/w/x.py");
    w.onStart("t1", "Write");
    w.onInput("t1", head);
    w.onInput("t1", tail);
    list.resolve(["/w/a.py"]);
    await flush();
    await flush();
    expect(emit).not.toHaveBeenCalled();
    expect(verdict).not.toHaveBeenCalled();
    await w.settle();
    expect(info.mock.calls[0]?.[1]).toMatchObject({ guess: "path_first_won" });
  });

  it("lists no candidates for a path-first call", async () => {
    const { w, reader, info } = watcherWith(readBase, undefined, recent);
    w.onStart("t1", "Write");
    w.onInput("t1", JSON.stringify({ file_path: "/w/a.py", content: FILE }));
    await flush();
    expect(reader.recentPaths).not.toHaveBeenCalled();
    await w.settle();
    expect(info.mock.calls[0]?.[1]).toMatchObject({ order: "path_first", guess: "none" });
  });

  it("emits no guess once the signal aborted", async () => {
    const ac = new AbortController();
    const list = deferred<string[]>();
    const { w, emit } = watcherWith(readBase, ac.signal, () => list.promise);
    const [head] = contentFirst("/w/a.py");
    w.onStart("t1", "Write");
    w.onInput("t1", head);
    ac.abort();
    list.resolve(["/w/a.py"]);
    await flush();
    await flush();
    expect(emit).not.toHaveBeenCalled();
  });
});

const claim: ExecutionClaim = {
  runId: "r1",
  conversationId: "c1",
  orgId: "o1",
  rootId: "c1",
  executionId: "e1",
};
const ROOTS = { workspace: "/workspace", skills: "/skills", tmp: "/tmp" };

interface Fake {
  file: Uint8Array | null;
  /** The size `stat` reports (defaults to the file's). */
  statSize?: number;
  truncated?: boolean;
  recorded: { size: number; sha256: string } | null;
  kernelRead?: () => Promise<never>;
  readFileError?: Error;
}

function readerDeps(f: Fake) {
  const stat = vi.fn(async () =>
    f.file === null ? null : { size: f.statSize ?? f.file.byteLength, isDir: false },
  );
  const withKernelRead = vi.fn(
    async (_ctx: unknown, _read: unknown, fn: (...a: never[]) => unknown, signal: AbortSignal) => {
      if (f.kernelRead) return f.kernelRead();
      const p = {
        stat,
        readFile: async () => {
          if (f.readFileError) throw f.readFileError;
          return f.file === null ? null : { data: f.file, truncated: f.truncated === true };
        },
      };
      return fn(...([{}, p, { roots: ROOTS, fresh: false, restarted: false }, signal] as never[]));
    },
  );
  const latestFileState = vi.fn(async () => f.recorded);
  const warn = vi.fn();
  const debug = vi.fn();
  const deps: WriteBaseReadDeps = {
    claim: () => claim,
    runFacts: async () => ({ deviceId: "d1", accountId: "a1" }),
    eventLog: { latestFileState, recentFilePaths: async () => [] },
    sandbox: { withKernelRead } as never,
    log: { warn, debug },
  };
  return { deps, withKernelRead, latestFileState, warn, debug, stat };
}

const input = (path = "/workspace/a.py", signal = new AbortController().signal) => ({
  conversationId: "c1",
  path,
  signal,
});

describe("readWriteBase", () => {
  const text = "line 1\nline 2\n";
  const file = bytes(text);
  const recorded = { size: file.byteLength, sha256: sha(file) };

  it("returns the text and sha256 when the bytes read match the recorded state", async () => {
    const { deps, withKernelRead, latestFileState } = readerDeps({ file, recorded });
    const ac = new AbortController();
    expect(await readWriteBase(deps, input("/workspace/./a.py", ac.signal))).toEqual({
      text,
      sha256: recorded.sha256,
    });
    expect(latestFileState).toHaveBeenCalledWith("c1", "/workspace/a.py");
    const [ctx, read, , signal] = withKernelRead.mock.calls[0] ?? [];
    expect(ctx).toEqual({
      orgId: "o1",
      deviceId: "d1",
      holderConversationId: "c1",
      silent: true,
      actor: { accountId: "a1", conversationId: "c1", runId: "r1" },
    });
    expect(read).toEqual({ claim, purpose: "write_base", path: "/workspace/a.py" });
    expect(signal).toBe(ac.signal);
  });

  it("gives none without a recorded state, and does not read", async () => {
    const { deps, withKernelRead } = readerDeps({ file, recorded: null });
    expect(await readWriteBase(deps, input())).toBeNull();
    expect(withKernelRead).not.toHaveBeenCalled();
  });

  it("gives none on a sha256 or size mismatch", async () => {
    const other = bytes("line 1\nline X\n");
    expect(await readWriteBase(readerDeps({ file: other, recorded }).deps, input())).toBeNull();
    const longer = bytes(`${text}more`);
    expect(await readWriteBase(readerDeps({ file: longer, recorded }).deps, input())).toBeNull();
    // stat reports another size: no readFile result is used
    expect(
      await readWriteBase(readerDeps({ file, statSize: 1, recorded }).deps, input()),
    ).toBeNull();
  });

  it("gives none for a binary file, bytes that are not UTF-8, a cut read or a missing file", async () => {
    const nul = new Uint8Array([97, 0, 98]);
    expect(
      await readWriteBase(
        readerDeps({ file: nul, recorded: { size: 3, sha256: sha(nul) } }).deps,
        input(),
      ),
    ).toBeNull();
    const latin = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    expect(
      await readWriteBase(
        readerDeps({ file: latin, recorded: { size: 4, sha256: sha(latin) } }).deps,
        input(),
      ),
    ).toBeNull();
    expect(
      await readWriteBase(readerDeps({ file, truncated: true, recorded }).deps, input()),
    ).toBeNull();
    expect(await readWriteBase(readerDeps({ file: null, recorded }).deps, input())).toBeNull();
  });

  it("gives none above TOOL_VIEW_DIFF_MAX_TEXT_BYTES without reading", async () => {
    const { deps, withKernelRead } = readerDeps({
      file,
      recorded: { size: TOOL_VIEW_DIFF_MAX_TEXT_BYTES + 1, sha256: "x" },
    });
    expect(await readWriteBase(deps, input())).toBeNull();
    expect(withKernelRead).not.toHaveBeenCalled();
  });

  it("gives none for a relative, malformed, root or skills path", async () => {
    for (const path of ["a.py", "/workspace/../etc/passwd", "/"]) {
      const { deps, withKernelRead, warn, debug } = readerDeps({ file, recorded });
      expect(await readWriteBase(deps, input(path))).toBeNull();
      expect(withKernelRead).not.toHaveBeenCalled();
      // a malformed model path is an expected no-base outcome
      expect(warn).not.toHaveBeenCalled();
      if (path.includes("..")) expect(debug).toHaveBeenCalledTimes(1);
    }
    // the skills directory is read-only to Write: refused inside the read, before any stat
    const { deps, stat } = readerDeps({ file, recorded });
    expect(await readWriteBase(deps, input("/skills/s/SKILL.md"))).toBeNull();
    expect(stat).not.toHaveBeenCalled();
  });

  it("gives none without the step's claim for this conversation, or without run facts", async () => {
    const a = readerDeps({ file, recorded });
    a.deps.claim = () => undefined;
    expect(await readWriteBase(a.deps, input())).toBeNull();
    const b = readerDeps({ file, recorded });
    b.deps.claim = () => ({ ...claim, conversationId: "other" });
    expect(await readWriteBase(b.deps, input())).toBeNull();
    const c = readerDeps({ file, recorded });
    c.deps.runFacts = async () => null;
    expect(await readWriteBase(c.deps, input())).toBeNull();
    for (const x of [a, b, c]) expect(x.withKernelRead).not.toHaveBeenCalled();
  });

  it("classifies the outcomes that only mean no base now as expected", () => {
    for (const err of [
      new KernelReadInstanceNotRunning(),
      new KernelReadNotAdmitted(new Error("refused")),
      new KernelReadUnsupported(),
      sandboxBusy(),
      retirementPending(),
      recreateRequired(),
      new ApiError("device.unavailable", "off"),
      new ApiError("device.not_found", "gone"),
      new ToolError("bad path"),
    ]) {
      expect(expectedNoBase(err)).toBe(true);
    }
    for (const err of [
      new Error("io"),
      new ApiError("sandbox.create_failed", "no"),
      new DOMException("x", "AbortError"),
      null,
    ]) {
      expect(expectedNoBase(err)).toBe(false);
    }
  });

  it("gives none, logged at debug, when the read is not possible now", async () => {
    for (const err of [
      new KernelReadInstanceNotRunning(),
      new KernelReadNotAdmitted(new Error("refused")),
      new KernelReadUnsupported(),
      sandboxBusy(),
      retirementPending(),
      new ApiError("device.unavailable", "off"),
      new ApiError("device.not_found", "gone"),
    ]) {
      const { deps, warn, debug } = readerDeps({
        file,
        recorded,
        kernelRead: () => Promise.reject(err),
      });
      expect(await readWriteBase(deps, input())).toBeNull();
      expect(debug).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it("gives none, logged as a warning, when the read fails", async () => {
    const { deps, warn } = readerDeps({ file, recorded, readFileError: new Error("io") });
    expect(await readWriteBase(deps, input())).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("gives none, unlogged, once its signal aborted", async () => {
    const ac = new AbortController();
    const { deps, warn, withKernelRead } = readerDeps({ file, recorded });
    withKernelRead.mockImplementationOnce(async () => {
      ac.abort();
      return file;
    });
    expect(await readWriteBase(deps, input("/workspace/a.py", ac.signal))).toBeNull();
    ac.abort();
    expect(await readWriteBase(deps, input("/workspace/a.py", ac.signal))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    // the second call aborted before the read: no admission started
    expect(withKernelRead).toHaveBeenCalledTimes(1);
  });
});
