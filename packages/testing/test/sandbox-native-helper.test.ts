import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import * as sdk from "@capybara-hq/plugin-sdk";
import { expect, it } from "vitest";
import {
  runSandboxNativeConformance,
  type SandboxNativeFixture,
} from "../src/sandbox-native-conformance.js";

async function nativeFixture() {
  expect(sdk).toHaveProperty("SANDBOX_RUNTIME_SOURCE");
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "capybara-native-")));
  const root = join(temporary, "owned");
  const helper = join(temporary, "native-files.py");
  await mkdir(root);
  await writeFile(helper, sdk.SANDBOX_RUNTIME_SOURCE.files[0]?.source ?? "", { mode: 0o600 });
  let calls = 0;
  let disposed = false;
  const fixture: SandboxNativeFixture = {
    root,
    async seed(entries) {
      for (const entry of entries) {
        const within = (path: string) => {
          const local = relative(root, path);
          if (local === ".." || local.startsWith("../") || local.startsWith("/")) {
            throw new Error("Fixture entries must remain inside the owned root");
          }
        };
        within(entry.path);
        await mkdir(dirname(entry.path), { recursive: true });
        if (entry.kind === "directory") await mkdir(entry.path, { recursive: true });
        else if (entry.kind === "file") await writeFile(entry.path, entry.data);
        else {
          within(entry.target);
          await symlink(entry.target, entry.path);
        }
      }
    },
    async operation() {
      const operationId = randomUUID();
      let consumed = false;
      async function request<T>(
        method: string,
        path: string,
        signal: AbortSignal,
        options: Record<string, unknown> = {},
      ): Promise<T> {
        signal.throwIfAborted();
        if (consumed) throw new Error(`Operation ${operationId} was reused`);
        consumed = true;
        calls++;
        const pinned = await open(
          root,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          return await new Promise<T>((resolve, reject) => {
            // Python 3 is an explicit prerequisite; no interpreter is installed by the fixture.
            const child = spawn("python3", ["-I", helper], {
              stdio: ["pipe", "pipe", "pipe", pinned.fd],
              signal,
            });
            let stdout = "";
            let stderr = "";
            child.stdout?.setEncoding("utf8").on("data", (data) => {
              stdout += data;
            });
            child.stderr?.setEncoding("utf8").on("data", (data) => {
              stderr += data;
            });
            child.on("error", reject);
            child.on("close", (code) => {
              if (code !== 0) return reject(new Error(`Native helper exited ${code}: ${stderr}`));
              try {
                const response = JSON.parse(stdout) as {
                  result: T;
                  error?: { code: string; message: string };
                };
                if (response.error)
                  reject(new Error(`${response.error.code}: ${response.error.message}`));
                else resolve(response.result);
              } catch (error) {
                reject(error);
              }
            });
            child.stdin?.on("error", reject);
            child.stdin?.end(
              JSON.stringify({
                method,
                path,
                ...options,
                roots: { read: [{ path: root, fd: 3 }], write: [{ path: root, fd: 3 }] },
              }),
            );
          });
        } finally {
          await pinned.close();
        }
      }
      return {
        async readFile(path, options) {
          const value = await request<{ dataB64: string; truncated: boolean } | null>(
            "readFile",
            path,
            options.signal,
            { maxBytes: options.maxBytes },
          );
          return value === null
            ? null
            : {
                data: new Uint8Array(Buffer.from(value.dataB64, "base64")),
                truncated: value.truncated,
              };
        },
        async writeFile(path, data, signal) {
          await request("writeFile", path, signal, {
            dataB64: Buffer.from(data).toString("base64"),
          });
        },
        stat: (path, signal) => request("stat", path, signal),
        list: (path, options) => request("list", path, options.signal, { limit: options.limit }),
        scan: (path, options) => request("scan", path, options.signal),
      };
    },
    async dispose() {
      await rm(temporary, { recursive: true, force: true });
      disposed = true;
    },
  };
  return { fixture, helper, calls: () => calls, disposed: () => disposed };
}

// The conformance run spawns one `python3` per request (more than 25) — the shipped helper is a
// one-shot program, so the wall time is process spawns, not the test's logic, and a machine running
// the whole suite at once starves it past the 5 s default. The bound stays generous but finite.
it("executes ordinary native semantics through the real Python helper and fresh operations", async () => {
  const { fixture, calls, disposed } = await nativeFixture();
  await runSandboxNativeConformance(fixture);
  expect(calls()).toBeGreaterThan(25);
  expect(disposed()).toBe(true);
}, 30_000);

/** Instrument only the helper's ordinary Python calls; fail before any potentially blocking open
 * or oversized allocation. The unchanged shipped source is loaded from its fixture-owned file. */
async function checkPython(body: string) {
  const { fixture, helper } = await nativeFixture();
  try {
    const script = `import os, sys, stat, runpy
module = runpy.run_path(sys.argv[1])
root = sys.argv[2]
pinned = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
native = module["NativeFiles"]({"read": [{"path": root, "fd": pinned}], "write": [{"path": root, "fd": pinned}]})
def request(method, name, **options):
    return native.run(dict(method=method, path=os.path.join(root, name), **options))
try:
${body
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
finally:
    os.close(pinned)
`;
    const { stdout, stderr } = await promisify(execFile)("python3", [
      "-I",
      "-c",
      script,
      helper,
      fixture.root,
    ]);
    expect(stderr).toBe("");
    expect(stdout).toBe("");
  } finally {
    await fixture.dispose();
  }
}

it("refuses owned FIFOs using nonblocking opens and checks regular files before truncation", async () => {
  await checkPython(`
fifo = os.path.join(root, "pipe")
os.mkfifo(fifo)
real_open = os.open
real_ftruncate = os.ftruncate
# Keep a normal FIFO endpoint open so both read and write opens can return immediately.
peer = real_open(fifo, os.O_RDWR | os.O_NONBLOCK)
def guarded_open(path, flags, *args, **kwargs):
    if path == "pipe" or path == "regular":
        assert flags & os.O_NONBLOCK, "native open must be nonblocking"
        assert not flags & os.O_TRUNC, "native open must not truncate before checking the descriptor"
    fd = real_open(path, flags, *args, **kwargs)
    return fd
def checked_truncate(fd, size):
    assert stat.S_ISREG(os.fstat(fd).st_mode), "only regular files may be truncated"
    return real_ftruncate(fd, size)
os.open = guarded_open
os.ftruncate = checked_truncate
try:
    for method in ("readFile", "writeFile"):
        try:
            request(method, "pipe", maxBytes=8, dataB64="eA==")
        except (OSError, ValueError):
            pass
        else:
            raise AssertionError("nonregular file must be refused")
    request("writeFile", "regular", dataB64="YWJj")
    assert request("readFile", "regular", maxBytes=3) == {"dataB64": "YWJj", "truncated": False}
finally:
    os.open = real_open
    os.ftruncate = real_ftruncate
    os.close(peer)
`);
});

it("rejects dangling-link writes without creating targets and retains valid link writes", async () => {
  await checkPython(`
os.symlink(os.path.join(root, "missing"), os.path.join(root, "dangling"))
try:
    request("writeFile", "dangling", dataB64="eA==")
except (OSError, ValueError):
    pass
else:
    raise AssertionError("dangling-link write must be refused")
assert not os.path.exists(os.path.join(root, "missing"))
request("writeFile", "new/regular", dataB64="eA==")
os.symlink(os.path.join(root, "new/regular"), os.path.join(root, "valid"))
request("writeFile", "valid", dataB64="eXo=")
assert request("readFile", "new/regular", maxBytes=2) == {"dataB64": "eXo=", "truncated": False}
`);
});

it("bounds requested read buffers by file size even for the largest safe byte limit", async () => {
  await checkPython(`
with open(os.path.join(root, "tiny"), "wb") as stream:
    stream.write(b"abc")
real_fdopen = os.fdopen
real_read = os.read
sizes = []
short_read = False
class BoundedReader:
    def __init__(self, stream):
        self.stream = stream
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.stream.close()
    def fileno(self):
        return self.stream.fileno()
    def read(self, size=-1):
        assert 0 <= size <= 3, "read allocation exceeds the actual file size"
        sizes.append(size)
        return b"" if short_read else self.stream.read(size)
def bounded_fdopen(fd, mode, *args, **kwargs):
    stream = real_fdopen(fd, mode, *args, **kwargs)
    return BoundedReader(stream) if mode == "rb" else stream
def bounded_read(fd, size):
    assert 0 <= size <= 3, "read allocation exceeds the actual file size"
    sizes.append(size)
    return b"" if short_read else real_read(fd, size)
os.fdopen = bounded_fdopen
os.read = bounded_read
try:
    assert request("readFile", "tiny", maxBytes=9007199254740991) == {"dataB64": "YWJj", "truncated": False}
    assert request("readFile", "tiny", maxBytes=2) == {"dataB64": "YWI=", "truncated": True}
    assert sizes and max(sizes) <= 3
    # A short read does not change the truncation decision from the opened file's metadata.
    short_read = True
    assert request("readFile", "tiny", maxBytes=2) == {"dataB64": "", "truncated": True}
finally:
    os.fdopen = real_fdopen
    os.read = real_read
`);
});

it("matches SDK percent decoding including malformed escapes and invalid UTF-8", async () => {
  const cases = ["a%2f%ZZ", "a%5c%", "a%2f%C0%AF", "a%2f%E0%A4", "a%2f", "a%5c", "%2e%2e"];
  const accepted = cases.map((name) => sdk.validateSandboxPathShape(`/owned/${name}`).length === 0);
  await checkPython(`
cases = ${JSON.stringify(cases)}
accepted = ${JSON.stringify(accepted).replaceAll("true", "True").replaceAll("false", "False")}
for name, expected in zip(cases, accepted):
    assert module["valid_path"](os.path.join(root, name)) == expected, name
    if expected:
        os.mkdir(os.path.join(root, name))
        with open(os.path.join(root, name, "AGENTS.md"), "wb") as stream:
            stream.write(b"x")
        assert request("readFile", name + "/AGENTS.md", maxBytes=1) == {"dataB64": "eA==", "truncated": False}
found = request("scan", ".")
assert {entry["suggestedName"] for entry in found} == {name for name, expected in zip(cases, accepted) if expected}
`);
});

it("preserves directory entries and hits when children cannot be statted", async () => {
  await checkPython(`
folder = os.path.join(root, "readable")
os.mkdir(folder)
os.mkdir(os.path.join(folder, "child"))
with open(os.path.join(folder, "AGENTS.md"), "wb") as stream:
    stream.write(b"x")
os.symlink(os.path.join(folder, "child"), os.path.join(folder, "link"))
# A readable directory's Dirent types do not require search permission on its children.
os.chmod(folder, 0o400)
real_stat = os.stat
def denied_child_stat(path, *args, **kwargs):
    if path in ("child", "AGENTS.md", "link"):
        raise PermissionError("ordinary child metadata unavailable")
    return real_stat(path, *args, **kwargs)
os.stat = denied_child_stat
try:
    assert request("list", "readable", limit=2) == {"entries": [{"name": "AGENTS.md", "isDir": False}, {"name": "child", "isDir": True}], "truncated": True}
    assert request("list", "readable", limit=3)["entries"][-1] == {"name": "link", "isDir": False}
    assert request("scan", "readable") == [{"path": folder, "suggestedName": "readable"}]
finally:
    os.stat = real_stat
    os.chmod(folder, 0o700)
`);
});

it("propagates directory enumeration errors and counts failed child reads in the scan budget", async () => {
  await checkPython(`
real_scandir = os.scandir
def unreadable(fd):
    raise PermissionError("ordinary directory enumeration failure")
os.scandir = unreadable
try:
    for method in ("list", "scan"):
        try:
            request(method, ".", limit=10)
        except PermissionError:
            pass
        else:
            raise AssertionError("unreadable base must not become an empty success")
finally:
    os.scandir = real_scandir
for i in range(500):
    os.mkdir(os.path.join(root, "d%03d" % i))
for i in (498, 499):
    with open(os.path.join(root, "d%03d" % i, "AGENTS.md"), "wb") as stream:
        stream.write(b"x")
real_open = os.open
def denied_directory(path, flags, *args, **kwargs):
    if path == "d000":
        raise PermissionError("ordinary child read failure")
    return real_open(path, flags, *args, **kwargs)
os.open = denied_directory
try:
    assert request("scan", ".") == [{"path": os.path.join(root, "d498"), "suggestedName": "d498"}]
finally:
    os.open = real_open
`);
});

it("resolves each link target once for valid file and directory chains", async () => {
  await checkPython(`
with open(os.path.join(root, "target"), "wb") as stream:
    stream.write(b"original")
os.mkdir(os.path.join(root, "directory"))
for prefix, destination in (("file", "target"), ("dir", "directory")):
    target = destination
    for i in range(6):
        name = prefix + str(i)
        os.symlink(os.path.join(root, target), os.path.join(root, name))
        target = name
real_readlink = os.readlink
visits = []
def counted_readlink(path, *args, **kwargs):
    visits.append(path)
    # Fail before repeating the chain, independently of wall-clock timing.
    assert len(visits) <= 6, "symlink target resolved more than once"
    return real_readlink(path, *args, **kwargs)
os.readlink = counted_readlink
try:
    request("writeFile", "file5", dataB64="eA==")
    assert visits == ["file5", "file4", "file3", "file2", "file1", "file0"]
    assert request("readFile", "target", maxBytes=1) == {"dataB64": "eA==", "truncated": False}
    for method in ("readFile", "stat", "list", "scan"):
        visits.clear()
        expected = [] if method == "scan" else None
        assert request(method, "file5/missing", maxBytes=1, limit=1) == expected
        assert len(visits) == 6
    visits.clear()
    request("writeFile", "dir5/new/parents/file", dataB64="eXo=")
    assert visits == ["dir5", "dir4", "dir3", "dir2", "dir1", "dir0"]
    assert request("readFile", "directory/new/parents/file", maxBytes=2) == {"dataB64": "eXo=", "truncated": False}
finally:
    os.readlink = real_readlink
`);
});
