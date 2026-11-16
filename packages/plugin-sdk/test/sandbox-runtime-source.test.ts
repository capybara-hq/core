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
    expect(bundle.files.map((file) => file.name)).toEqual(["native-files.py", "linux-sandbox.py"]);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.files)).toBe(true);
    for (const file of bundle.files) {
      expect(Object.isFrozen(file)).toBe(true);
      expect(file.source.length).toBeGreaterThan(0);
      expect(file.sha256).toBe(createHash("sha256").update(file.source).digest("hex"));
      expect(() => Object.assign(file, { source: "replaced" })).toThrow();
    }
    expect(Object.keys(bundle).sort()).toEqual(["files", "version"]);
  });

  it("keeps SDK source packaging free of Node runtime imports and I/O", async () => {
    for (const name of [
      "sandbox-runtime-source.ts",
      "sandbox-native-runtime-source.ts",
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
  sdk.SANDBOX_RUNTIME_SOURCE.files.find((file) => file.name === "linux-sandbox.py")?.source ?? "";

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
      bind: mediated ? "notify" : "allow",
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
    });
    for (const machine of ["aarch64", "x86_64"]) {
      expect(verdicts[`${machine}/mediated`]).toEqual(expected(true));
      expect(verdicts[`${machine}/environment`]).toEqual(expected(false));
    }
  });
});
