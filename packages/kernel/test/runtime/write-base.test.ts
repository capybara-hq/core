import { createHash } from "node:crypto";
import type { ToolInputView } from "@capybara-hq/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionClaim } from "../../src/runtime/run-execution.js";
import {
  closedStringProperty,
  TopLevelStringProperty,
  type WriteBase,
  type WriteBaseReader,
  writeBaseWatcher,
} from "../../src/runtime/write-base.js";
import { readWriteBase, type WriteBaseReadDeps } from "../../src/runtime/write-base.service.js";
import {
  KernelReadInstanceNotRunning,
  KernelReadNotAdmitted,
} from "../../src/sandbox/kernel-read.js";
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

function watcherWith(read: WriteBaseReader["read"], signal = new AbortController().signal) {
  const emit = vi.fn<(callId: string, base: WriteBase) => void>();
  const warn = vi.fn();
  const reader = { read: vi.fn(read) };
  const w = writeBaseWatcher({
    reader,
    inputViewOf: (name) => (name === "Write" ? WRITE : name === "Bash" ? undefined : undefined),
    emit,
    conversationId: "c1",
    signal,
    log: { warn },
  });
  return { w, emit, warn, reader };
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
  const withKernelRead = vi.fn(
    async (_ctx: unknown, _read: unknown, fn: (...a: never[]) => unknown, signal: AbortSignal) => {
      if (f.kernelRead) return f.kernelRead();
      const p = {
        stat: async () =>
          f.file === null ? null : { size: f.statSize ?? f.file.byteLength, isDir: false },
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
  const deps: WriteBaseReadDeps = {
    claim: () => claim,
    runFacts: async () => ({ deviceId: "d1", accountId: "a1" }),
    eventLog: { latestFileState },
    sandbox: { withKernelRead } as never,
    log: { warn },
  };
  return { deps, withKernelRead, latestFileState, warn };
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
    for (const path of ["a.py", "/workspace/../etc/passwd", "/", "/skills/s/SKILL.md"]) {
      const { deps } = readerDeps({ file, recorded });
      expect(await readWriteBase(deps, input(path))).toBeNull();
    }
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

  it("gives none, logged, when the read is refused, the instance is not running or it fails", async () => {
    for (const err of [
      new KernelReadInstanceNotRunning(),
      new KernelReadNotAdmitted(new Error("refused")),
    ]) {
      const { deps, warn } = readerDeps({
        file,
        recorded,
        kernelRead: () => Promise.reject(err),
      });
      expect(await readWriteBase(deps, input())).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    }
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
  });
});
