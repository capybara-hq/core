import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

describe("sandbox runtime source bundle", () => {
  it("ships the native helper and the Linux launcher as immutable bytes with exact digests", () => {
    expect(sdk).toHaveProperty("SANDBOX_RUNTIME_SOURCE");
    const bundle = sdk.SANDBOX_RUNTIME_SOURCE;
    expect(bundle.version).toBe(2);
    expect(Object.isFrozen(bundle)).toBe(true);
    for (const set of [bundle.files, bundle.current]) {
      expect(set.map((file) => file.name)).toEqual(["native-files.py", "linux-sandbox.py"]);
      expect(Object.isFrozen(set)).toBe(true);
      for (const file of set) {
        expect(Object.isFrozen(file)).toBe(true);
        expect(file.source.length).toBeGreaterThan(0);
        expect(file.sha256).toBe(createHash("sha256").update(file.source).digest("hex"));
        expect(() => Object.assign(file, { source: "replaced" })).toThrow();
      }
    }
    expect(Object.keys(bundle).sort()).toEqual(["accepted", "current", "files", "version"]);
  });

  it("keeps the staged set at the bytes released image providers stage", () => {
    // device-docker checks its image against the host SDK's `files`: these digests move only with
    // marketplace.commit and the device-docker pin (tools/checks/README.md, SDK runtime sources)
    const digests = Object.fromEntries(
      sdk.SANDBOX_RUNTIME_SOURCE.files.map((file) => [file.name, file.sha256]),
    );
    expect(digests).toEqual({
      "native-files.py": "c1712198af4ffedc0b48f789c28ed4233dc9008521b897300731c4f903168950",
      "linux-sandbox.py": "ceb5bb0971437978a7695091792bfafcf3dbf2e7c74e8425d8aceb76e442f848",
    });
    // between steps (core#907): only native-files.py is ahead of the staged set
    const current = Object.fromEntries(
      sdk.SANDBOX_RUNTIME_SOURCE.current.map((file) => [file.name, file.sha256]),
    );
    expect(current).toEqual({
      "native-files.py": "41cf54ea285d29c49b42b33efd99d11254ba07cee4832a9d6f9414dc99c31461",
      "linux-sandbox.py": "ceb5bb0971437978a7695091792bfafcf3dbf2e7c74e8425d8aceb76e442f848",
    });
  });

  it("accepts the staged and current digests of each file, plus one previous revision", () => {
    const bundle = sdk.SANDBOX_RUNTIME_SOURCE;
    expect(Object.isFrozen(bundle.accepted)).toBe(true);
    const expected: Record<string, string[]> = {};
    // the launcher before exact file read roots, for instances of earlier device-docker images
    const previous = [
      {
        name: "linux-sandbox.py",
        sha256: "4e046df902dc644532ada9f2a3bef30a983daf7d1f238bd46dcd16524d96c66c",
      },
    ];
    for (const file of [...bundle.files, ...bundle.current, ...previous]) {
      const list = expected[file.name] ?? [];
      if (!list.includes(file.sha256)) list.push(file.sha256);
      expected[file.name] = list;
    }
    expect(bundle.accepted).toEqual(expected);
    for (const list of Object.values(bundle.accepted)) expect(Object.isFrozen(list)).toBe(true);
  });

  it("declares file read roots on the launcher that enforces them", () => {
    const current = sdk.SANDBOX_RUNTIME_SOURCE.current.find((f) => f.name === "linux-sandbox.py");
    expect(current?.features).toEqual(["fileReadRoots"]);
    expect(current?.source).toContain('"readFiles"');
  });

  it("keeps SDK source packaging free of Node runtime imports and I/O", async () => {
    for (const name of [
      "sandbox-runtime-source.ts",
      "sandbox-native-runtime-source.ts",
      "sandbox-native-staged-runtime-source.ts",
      "sandbox-linux-runtime-source.ts",
    ]) {
      const source = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/(?:from\s*|import\s*\()["'](?:node:|fs|child_process|crypto)/);
      expect(source).not.toMatch(/\b(?:readFileSync|writeFileSync|execFileSync|process\.env)\b/);
    }
  });
});

const python = spawnSync("python3", ["--version"]).status === 0;
const linux = () =>
  sdk.SANDBOX_RUNTIME_SOURCE.current.find((file) => file.name === "linux-sandbox.py")?.source ?? "";

/**
 * Loads the launcher source as a module with only the platform facts stubbed (no syscalls) and
 * runs `body`, which prints JSON. Behaviour, not source text: the probe decisions and the seccomp
 * program itself, evaluated by a small classic-BPF interpreter for both architecture tables.
 */
function launcher(body: string): unknown {
  const script = `
import json, sys, types
source = sys.stdin.read()
module = types.ModuleType("linux_sandbox")
exec(compile(source, "linux-sandbox.py", "exec"), module.__dict__)
def platform(system, machine):
    module.platform = types.SimpleNamespace(system=lambda: system, machine=lambda: machine)
def run(program, arch, nr, args=(0, 0, 0, 0, 0, 0)):
    import struct
    data = struct.pack("<iIQ6Q", nr, arch, 0, *args)
    code = [struct.unpack_from("HBBI", program, i) for i in range(0, len(program), 8)]
    pc, acc = 0, 0
    while True:
        op, jt, jf, k = code[pc]
        if op == 0x20: acc = struct.unpack_from("<I", data, k)[0]
        elif op == 0x54: acc &= k
        elif op == 0x06: return k
        elif op in (0x15, 0x25, 0x35, 0x45):
            hit = {0x15: acc == k, 0x25: acc > k, 0x35: acc >= k, 0x45: bool(acc & k)}[op]
            pc += jt if hit else jf
        else: raise ValueError(op)
        pc += 1
def action(value):
    if value == module.RET_ALLOW: return "allow"
    if value == module.RET_NOTIFY: return "notify"
    if value == module.RET_KILL: return "kill"
    import errno
    return errno.errorcode[value & 0xFFFF]
${body}
`;
  const result = spawnSync("python3", ["-I", "-c", script], { input: linux(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

describe.skipIf(!python)("Linux launcher fail-closed decisions (behavioural)", () => {
  it("reports restricted unavailable for every unsupported platform and ABI", () => {
    const decisions = launcher(`
cases = {}
def static(name, system, machine, abi, children=True, candidate=False):
    platform(system, machine)
    module.landlock_abi = lambda: abi
    module.os.path.exists = lambda path: children
    cases[name] = module.probe_static(module.ARCHES.get(machine), candidate)
static("darwin", "Darwin", "arm64", 8)
static("riscv", "Linux", "riscv64", 8)
static("x86-default", "Linux", "x86_64", 8)
static("x86-candidate", "Linux", "x86_64", 8, candidate=True)
static("riscv-candidate", "Linux", "riscv64", 8, candidate=True)
static("abi5", "Linux", "aarch64", 5)
static("no-children", "Linux", "aarch64", 8, children=False)
static("aarch64", "Linux", "aarch64", 6)
cases["undumpable-on-host"] = module.SELF_PROTECTION
# On Linux the loaded launcher really is non-dumpable (PR_GET_DUMPABLE); elsewhere nothing runs.
import ctypes
cases["dumpable"] = (ctypes.CDLL(None).prctl(3, 0, 0, 0, 0)
                     if sys.platform.startswith("linux") else 0)
module.SELF_PROTECTION = "The launcher was traced before it became non-dumpable"
static("traced", "Linux", "x86_64", 8, candidate=True)
module.SELF_PROTECTION = None
platform("Linux", "aarch64")
def broken(candidate):
    raise RuntimeError("primitive exploded")
module.probe_primitives = broken
cases["crash"] = module.probe()
supported = {"restricted": {"filesystem": True}, "arch": "stub"}
module.probe_primitives = lambda candidate: dict(supported)
platform("Linux", "x86_64")
cases["x86-candidate-probe"] = module.probe(True)
platform("Linux", "aarch64")
cases["aarch64-candidate-probe"] = module.probe(True)
print(json.dumps(cases))
`);
    expect(decisions).toEqual({
      darwin: "Restricted Linux execution requires Linux",
      riscv: "No syscall inventory exists for riscv64",
      "x86-default": null,
      "x86-candidate": null,
      "riscv-candidate": "No syscall inventory exists for riscv64",
      abi5: "Landlock ABI 5 is below the required 6",
      "no-children": "The kernel does not expose child lists for exact supervision",
      aarch64: null,
      // Loading the launcher made this (untraced) process non-dumpable without failing.
      "undumpable-on-host": null,
      dumpable: 0,
      // A launcher that cannot protect itself never reports restricted support.
      traced: "The launcher was traced before it became non-dumpable",
      crash: {
        restricted: null,
        arch: "aarch64",
        reason: "The probe failed: RuntimeError",
      },
      // x86_64 is validated, so a candidate probe there returns the plain result.
      "x86-candidate-probe": { restricted: { filesystem: true }, arch: "stub" },
      "aarch64-candidate-probe": { restricted: { filesystem: true }, arch: "stub" },
    });
  });

  it("keys granted endpoints by address, port and IPv6 scope ID", () => {
    expect(
      launcher(`
grants = module.endpoints_of({"kind": "endpoints", "endpoints": [
    {"address": "fe80::1", "port": 80, "scopeId": 2},
    {"address": "::ffff:127.0.0.1", "port": 81, "scopeId": 9},
    {"address": "127.0.0.1", "port": 82}]})
print(json.dumps(sorted(list(grant) for grant in grants)))
`),
    ).toEqual([
      ["127.0.0.1", 81, 0],
      ["127.0.0.1", 82, 0],
      ["fe80::1", 80, 2],
    ]);
  });

  it("filters both architecture tables the same way, failing closed on unknown calls", () => {
    const verdicts = launcher(`
m = module
out = {}
for machine in ("aarch64", "x86_64"):
    table = module.ARCHES[machine]
    nr = dict(table["nr"], **module.COMMON)
    for mediated in (True, False):
        program = module.build_filter(table, mediated, True)
        audit = table["audit"]
        call = lambda name, *args: action(run(program, audit, nr[name], args + (0,) * (6 - len(args))))
        key = "%s/%s" % (machine, "mediated" if mediated else "environment")
        out[key] = {
            "foreign-arch": action(run(program, 0x40000003, nr["socket"])),
            "future": action(run(program, audit, 470)),
            "x32": action(run(program, audit, 0x40000000 | 41)) if machine == "x86_64" else "ENOSYS",
            "unix-stream": call("socket", m.AF_UNIX, m.SOCK_STREAM),
            "unix-seqpacket": call("socket", m.AF_UNIX, m.SOCK_SEQPACKET | m.SOCK_CLOEXEC),
            "unix-dgram": call("socket", m.AF_UNIX, m.SOCK_DGRAM | m.SOCK_CLOEXEC),
            "unix-raw": call("socket", m.AF_UNIX, 3),
            "pair-stream": call("socketpair", m.AF_UNIX, m.SOCK_STREAM | m.SOCK_CLOEXEC),
            "pair-seqpacket": call("socketpair", m.AF_UNIX, m.SOCK_SEQPACKET),
            "pair-dgram": call("socketpair", m.AF_UNIX, m.SOCK_DGRAM | m.SOCK_NONBLOCK),
            "pair-raw": call("socketpair", m.AF_UNIX, 3),
            "pair-inet": call("socketpair", m.AF_INET, m.SOCK_STREAM),
            "inet": call("socket", m.AF_INET, m.SOCK_STREAM),
            "packet": call("socket", 17, 3),
            "connect": call("connect"),
            "bind": call("bind"),
            "listen": call("listen"),
            "fastopen": call("sendto", 3, 0, 0, 0x20000000),
            "keyctl": call("keyctl"),
            "add_key": call("add_key"),
            "request_key": call("request_key"),
            "setns": call("setns"),
            "unshare-user": call("unshare", 0x10000000),
            "unshare-files": call("unshare", 0x400),
            "clone-newnet": call("clone", 0x40000000 | 17),
            "clone-thread": call("clone", 0x3D0F00),
            "clone3": call("clone3"),
            "setsid": call("setsid"),
            "fchmodat": call("fchmodat"),
            "tiocsti": call("ioctl", 0, 0x5412),
            "io_uring": call("io_uring_setup"),
            "open-read": call("openat", 0, 0, 0),
            "open-write": call("openat", 0, 0, 1),
            "open-create": call("openat", 0, 0, 0o100),
            "open-tmpfile": call("openat", 0, 0, 0o20200000),
            "openat2": call("openat2"),
            "mkdirat": call("mkdirat"),
            "unlinkat": call("unlinkat"),
            "renameat2": call("renameat2"),
            "linkat": call("linkat"),
            "symlinkat": call("symlinkat"),
            "truncate": call("truncate"),
            "native-open-write": action(run(module.build_filter(table, mediated, False), audit,
                                            nr["openat"], (0, 0, 1, 0, 0, 0))),
        }
print(json.dumps(out))
`) as Record<string, Record<string, string>>;
    const expected = (mediated: boolean) => ({
      "foreign-arch": "kill",
      future: "ENOSYS",
      x32: "ENOSYS",
      "unix-stream": "notify",
      "unix-seqpacket": "notify",
      "unix-dgram": "EACCES",
      "unix-raw": "EACCES",
      "pair-stream": "allow",
      "pair-seqpacket": "allow",
      "pair-dgram": "EACCES",
      "pair-raw": "EACCES",
      "pair-inet": "EACCES",
      inet: "notify",
      packet: "EAFNOSUPPORT",
      connect: "notify",
      // brokered: a pathname UNIX bind creates a file, so the broker makes it
      bind: "notify",
      listen: "notify",
      fastopen: mediated ? "EACCES" : "allow",
      keyctl: "EPERM",
      add_key: "EPERM",
      request_key: "EPERM",
      setns: "EPERM",
      "unshare-user": "EPERM",
      "unshare-files": "allow",
      "clone-newnet": "EPERM",
      "clone-thread": "allow",
      clone3: "ENOSYS",
      setsid: "EPERM",
      fchmodat: "notify",
      tiocsti: "EPERM",
      io_uring: "ENOSYS",
      // every filesystem write goes through the broker; read-only opens stay direct
      "open-read": "allow",
      "open-write": "notify",
      "open-create": "notify",
      "open-tmpfile": "notify",
      openat2: "ENOSYS",
      mkdirat: "notify",
      unlinkat: "notify",
      renameat2: "notify",
      linkat: "notify",
      symlinkat: "notify",
      truncate: "notify",
      // native mode (not brokered): the trusted helper writes itself under Landlock
      "native-open-write": "allow",
    });
    for (const machine of ["aarch64", "x86_64"]) {
      expect(verdicts[`${machine}/mediated`]).toEqual(expected(true));
      expect(verdicts[`${machine}/environment`]).toEqual(expected(false));
    }
  });
});

/** Runs `native-files.py`'s main() on a readFile of a FIFO and returns its JSON answer. */
function nativeAnswerForFifo(source: string): unknown {
  const script = `
import io, json, os, sys, tempfile, types
source = sys.stdin.read()
module = types.ModuleType("native_files")
exec(compile(source, "native-files.py", "exec"), module.__dict__)
root = os.path.realpath(tempfile.mkdtemp())
os.mkfifo(os.path.join(root, "pipe"))
fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
request = {"roots": {"read": [{"path": root, "fd": fd}], "write": []},
           "method": "readFile", "path": os.path.join(root, "pipe"), "maxBytes": 3}
sys.stdin = io.StringIO(json.dumps(request))
module.main()
`;
  const result = spawnSync("python3", ["-I", "-c", script], { input: source, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

describe.skipIf(!python)("native-files.py answers a non-regular file (core#907)", () => {
  const of = (set: readonly { name: string; source: string }[]) =>
    set.find((file) => file.name === "native-files.py")?.source ?? "";
  it("the current helper answers NOT_REGULAR_FILE, which the SDK maps to its own text", () => {
    const answer = nativeAnswerForFifo(of(sdk.SANDBOX_RUNTIME_SOURCE.current)) as {
      error: { code: string; message: string };
    };
    expect(answer.error.code).toBe(sdk.NATIVE_NOT_REGULAR_FILE);
    expect(sdk.nativeFailureText(answer.error.code)).toMatch(/not a regular file/);
  });
  it("the staged helper still answers the generic code (its consumers fall back to the generic text)", () => {
    const answer = nativeAnswerForFifo(of(sdk.SANDBOX_RUNTIME_SOURCE.files)) as {
      error: { code: string };
    };
    expect(answer.error.code).toBe("INVALID_NATIVE_REQUEST");
    expect(sdk.nativeFailureText(answer.error.code)).toBe(sdk.NATIVE_FAILURE_GENERIC);
  });
});
