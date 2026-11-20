import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isIP, isIPv4 } from "node:net";
import { posix } from "node:path";
import {
  classifyAddress,
  type ExecResult,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  isSandboxScopeValidationError,
  OPEN_PUBLIC_DENIED_CLASSES,
  type PermissionProfile,
  SANDBOX_RESERVED_NAME_PREFIX,
  type SandboxFileScope,
  type SandboxNetworkScope,
  type SandboxOperation,
  type SandboxPermissionSupport,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import type { NativeFixtureEntry } from "./sandbox-native-conformance.js";

/** A controlled endpoint whose receipts the fixture counts out of band (never via the device). */
export interface SandboxPermissionEndpoint {
  /**
   * The host name a scope allowlists for this endpoint (it must pass `validateAllowHost`, which
   * refuses IP literals). The provider or fixture maps it to the endpoint; an ungranted endpoint's
   * name is never allowlisted, so a proxy asked for it by name must refuse.
   */
  readonly name: string;
  /**
   * The endpoint's numeric address (an IP literal) for raw socket clients: the pointer race and
   * the ungranted, network-none and escalated controls connect here. The granted endpoint's address and
   * at least one ungranted address are IPv4 (the race program builds IPv4 socket addresses).
   */
  readonly address: string;
  readonly port: number;
  /** Accepted connections so far, observed by the endpoint itself. */
  receipts(): Promise<number>;
}

/**
 * A destination a sandboxed client asks for by URL (`http://<host>:<port>/`) through the proxy the
 * operation's environment names, when it has one.
 */
export interface SandboxPermissionTarget {
  /** A short label for messages (letters, digits, `-`). */
  readonly label: string;
  /** A host name or an IP literal (an IPv6 literal without brackets). */
  readonly host: string;
  readonly port: number;
  /**
   * The numeric address the target is served at, for a raw connect that bypasses the proxy (a
   * proxied provider must refuse it). Omit where it is not known (a public name on the internet).
   */
  readonly address?: string;
  /** Accepted connections so far, observed by the target itself; omit where none can be counted. */
  receipts?(): Promise<number>;
}

/**
 * The open public network (approval-only profiles design, "Open network"). Every target here is
 * asked for under the `open-public` network, once per profile.
 */
export interface SandboxPermissionOpenNetwork {
  /**
   * Set only where no public target can be reached here at all (offline): without it the harness
   * fails when every reachable list (`reachable`, `fakeIp.reachable`) is empty or unavailable.
   */
  readonly allowNoPositive?: true;
  /**
   * Public targets the open network reaches, by name and by literal. `{ unavailable }` where no
   * public target can be reached from here (no internet and no stand-in), with the reason; every
   * refusal still runs.
   */
  readonly reachable: readonly SandboxPermissionTarget[] | { readonly unavailable: string };
  /**
   * Destinations in the closed classes (private, CGNAT, ULA, link-local and metadata, loopback and
   * the host's own addresses, NAT64, benchmark), as IP literals in several spellings and as names
   * resolving there (a DNS rebinding name). Each must be refused; those with receipts see nothing.
   */
  readonly closed: readonly SandboxPermissionTarget[];
  /**
   * Names the device's resolver answers with a fake-IP address (198.18.0.0/15) while encrypted DNS
   * knows the real one: `reachable` resolve to public addresses, `closed` to closed classes or not
   * at all. `{ unavailable }` with the reason where no fake-IP resolver stands in front of the
   * device here.
   */
  readonly fakeIp?:
    | {
        readonly reachable: readonly SandboxPermissionTarget[];
        readonly closed: readonly SandboxPermissionTarget[];
      }
    | { readonly unavailable: string };
}

/** The scope one fresh operation receives; the fixture adds the IDs and revisions. */
export interface SandboxPermissionGrant {
  readonly profile: PermissionProfile;
  readonly filesystem: SandboxFileScope;
  readonly network: SandboxNetworkScope;
}

/**
 * The actual provider under test, on one shared device. All paths are absolute device paths on one
 * shared filesystem; `root` and `sibling` are empty directories owned by the device user. The
 * device must provide `/bin/sh`, `python3`, `node` and `curl`. Inspection is trusted, out of band
 * and read-only; it never runs through a restricted operation and never grants anything.
 */
export interface SandboxPermissionFixture {
  /**
   * The project root granted (writable) to restricted operations. On an instance-boundary provider
   * both `root` and `sibling` lie in the instance, whose whole filesystem is the scope.
   */
  readonly root: string;
  /** A directory outside every restricted grant, on the same filesystem. */
  readonly sibling: string;
  /** Existing files the device user may write ordinarily but no restricted grant covers. */
  readonly protectedPaths: readonly string[];
  /** `granted` is reachable by allowlisting its name; `ungranted` never is. */
  readonly endpoints: {
    readonly granted: SandboxPermissionEndpoint;
    readonly ungranted: readonly SandboxPermissionEndpoint[];
    /**
     * How a restricted allowlist operation reaches `granted`:
     * - `direct`: by connecting to its address (the provider admits the address it maps the
     *   allowlisted name to); Python, curl and Node connect straight to it.
     * - `proxy`: only through the HTTP proxy the provider names in the operation's environment
     *   (`http_proxy`, the variable curl and Python read for http URLs), which resolves `name`.
     *   Positives use curl and Python through that proxy; raw connects to the address are not
     *   expected to work, and the pointer race targets the proxy instead.
     * Either way the device needs no name resolution of its own for endpoint names.
     */
    readonly access: "direct" | "proxy";
    /**
     * `{ unavailable }` with the reason where the fixture cannot make the allowlisted name lead to
     * `granted` without changing the host (macOS: no hosts-file entry, and the runtime's proxy
     * refuses a name that resolves to loopback, by design). The by-name positives are then skipped
     * (and reported unavailable) and `granted` must see no connection at all; every negative still
     * runs. The positive allowlist reach is then the provider's own test's evidence (state it next
     * to the fixture). Default "available".
     */
    readonly namedReach?: "available" | { readonly unavailable: string };
    /**
     * Names on every allowlist the device applies (the scope's, the owner's and the org's) that
     * resolve into a closed address class: an allowlist grant never reaches a closed class, so
     * each must be refused and see no connection. Required for a provider with restricted support
     * and for an instance boundary (there at least one target whose `address` is a cloud metadata
     * address); `{ unavailable }` with the reason only where no name can resolve into a closed
     * class through the provider's own allowlist path (a stand-in proxy), reported unavailable.
     */
    readonly closedGranted?: readonly SandboxPermissionTarget[] | { readonly unavailable: string };
  };
  /**
   * The open public network's targets. Required when the provider reports
   * `network.openPublic`: the harness then proves the open network under every profile.
   */
  readonly openNetwork?: SandboxPermissionOpenNetwork;
  /**
   * Variables present in the environment of the device program (or the provider process) that runs
   * the operations: at least one secret-looking (`AWS_SECRET_ACCESS_KEY`) and at least one
   * innocent-looking name (no `SECRET`, `TOKEN`, `KEY`, `PASS`, `CREDENTIAL` or `CAPYBARA_` in it),
   * so a denylist cannot pass for a minimal environment. No sandboxed command under any profile may
   * see one of their values, and on an operation boundary its variable names must all be in the
   * minimal set (approval-only profiles design, "Fixed denies and the minimal environment"):
   * `PATH`, `LANG`, `HOME`, `TMPDIR` / `TMP` / `TEMP`, the proxy variables (any name containing
   * `PROXY`), what the shell itself sets (`PWD`, `OLDPWD`, `SHLVL`, `_`), and `allowed`: the tool
   * homes and runtime variables this provider adds (state each). With `escalatedControl` (and
   * outside-sandbox support), an escalated call must see every planted variable whose name does
   * not start with `CAPYBARA_` and none that does: the planted values are real, and the device's
   * own variables stay out even there. Required for a provider with restricted support.
   */
  readonly deviceEnvironment?: {
    readonly variables: Readonly<Record<string, string>>;
    readonly escalatedControl: boolean;
    readonly allowed?: readonly string[];
  };
  /**
   * Turns the owner's outside-sandbox setting off and returns a function that restores it. The
   * harness proves that the escalated pair runs only while the setting allows it. Required when
   * the provider reports `outsideSandbox`.
   */
  withoutOutsideSandbox?(): Promise<() => Promise<void>>;
  /**
   * The device user's home, where the protected home locations (shell startup files and the rest of
   * `SANDBOX_MANDATORY_WRITE_DENIES`) resolve for operations started from now on. When present,
   * the harness links `.zprofile` there through a chain of symbolic links into the granted root
   * (seeded with `seed`, which may write under this path) and proves that no hop of the chain and
   * not the target can be written, retargeted or moved away; `remove` deletes the entry it
   * seeded under the home afterwards. `{ unavailable }` with the reason where the provider has no
   * owner home to protect (reported unavailable); required for a provider with restricted support.
   */
  readonly home?:
    | { readonly path: string; remove(path: string): Promise<void> }
    | { readonly unavailable: string };
  /**
   * For an instance-boundary provider (`boundary: "instance"`: the container or microVM is the
   * sandbox): its outer network, which the harness proves instead of per-operation networks.
   * "open" needs {@link openNetwork}; "allowlist" allows exactly the granted endpoint's name.
   */
  readonly instanceNetwork?: "open" | "allowlist";
  /**
   * How restricted commands meet the mandatory write denies in other spellings of a protected
   * name. "nfkc" (default): every spelling whose NFKC case fold is protected is refused, as the
   * shared SDK policy compares names. "filesystem": the runtime enforces paths as the filesystem
   * resolves them (macOS Seatbelt on case-insensitive APFS: ASCII case and the Unicode case folds
   * APFS applies, such as the Kelvin sign for `k`, reach the protected file and are refused, while
   * compatibility forms such as fullwidth letters are distinct files there); the harness then
   * proves that a fullwidth spelling created a distinct file and never the protected one.
   */
  readonly foldedNames?: "nfkc" | "filesystem";
  /**
   * Whether restricted none/allowlist operations may listen on loopback. "allowed" (default, Linux):
   * loopback only, every wildcard address refused, a UNIX socket inside the root works,
   * `SO_REUSEPORT` is refused, no sandboxed client connects to a loopback listener (the command's
   * own included), and a client outside the sandbox (an escalated call) reaches the command's
   * listener. "refused" (macOS): the runtime refuses every listener, loopback and UNIX sockets
   * inside the root included (the macOS worker runs its runtime with local binding off).
   */
  readonly restrictedLoopbackListen?: "allowed" | "refused";
  /**
   * Whether cancellation must also end a descendant that left the command's process group
   * (fork + setpgid). "ended" (default): it must, as Linux PID namespaces and cgroups provide.
   * "not-promised": the runtime ends the owned process group and what stays in it, and does not
   * promise to rediscover a regrouped descendant (macOS, permission operation contract "Explicit
   * background supervision"); the harness then leaves that case out.
   */
  readonly regroupedDescendants?: "ended" | "not-promised";
  /** The provider's own runtime report; the harness never infers support from a fixture. */
  support(): Promise<SandboxPermissionSupport>;
  /** A fresh operation (new operation ID) for the grant, through the provider's factory. */
  operation(grant: SandboxPermissionGrant): Promise<SandboxOperation>;
  /** Trusted setup under root or sibling; preserves entries from earlier calls. */
  seed(entries: readonly NativeFixtureEntry[]): Promise<void>;
  inspect: {
    readFile(path: string): Promise<Uint8Array | null>;
    /** Permission bits (`st_mode & 0o7777`), or null when missing. */
    mode(path: string): Promise<number | null>;
    /** The subset of `pids` still running on the device. */
    alive(pids: readonly number[]): Promise<number[]>;
    /**
     * Runs a Python 3 program (`python3 - ...args`, program on stdin) as the device user in a
     * fresh process outside every operation and every restricted domain, standing in for another
     * session's Full-access work, and returns its stdout. When present, the harness proves that
     * such a process can neither ptrace nor read the memory or environment of the process that
     * supervises a restricted command (its parent). Omit it only where no process outside an
     * operation can run as the device user.
     */
    outside?(program: string, args: readonly string[]): Promise<string>;
  };
  /** Removes fixture-owned resources, including after an assertion failure. */
  dispose(): Promise<void>;
}

const text = (data: Uint8Array | null) => (data === null ? null : Buffer.from(data).toString());
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** A Python program in which one thread rewrites a syscall's pointer argument mid-call. */
const FLIP_PROGRAM = String.raw`
import ctypes, socket, struct, sys, threading
libc = ctypes.CDLL(None, use_errno=True)
mode, rounds = sys.argv[1], int(sys.argv[2])
stop = threading.Event()
def flipper(buffer, good, bad):
    while not stop.is_set():
        ctypes.memmove(buffer, bad, len(bad))
        ctypes.memmove(buffer, good, len(good))
ok = 0
if mode == "connect":
    def sockaddr(host, port):
        if sys.platform == "darwin":
            # BSD sockaddr_in: a length byte, then a one-byte family
            return struct.pack("BBH4s8x", 16, socket.AF_INET, socket.htons(port), socket.inet_aton(host))
        return struct.pack("HH4s8x", socket.AF_INET, socket.htons(port), socket.inet_aton(host))
    if sys.argv[3] == "proxy":
        # The allowed target is the operation's own HTTP proxy, taken from its environment.
        import os, urllib.parse
        proxy = urllib.parse.urlsplit(os.environ.get("http_proxy") or os.environ["HTTP_PROXY"])
        good = sockaddr(socket.gethostbyname(proxy.hostname), proxy.port)
    else:
        good = sockaddr(sys.argv[3], int(sys.argv[4]))
    bad = sockaddr(sys.argv[5], int(sys.argv[6]))
    buffer = ctypes.create_string_buffer(good, len(good))
    thread = threading.Thread(target=flipper, args=(buffer, good, bad))
    thread.start()
    for _ in range(rounds):
        fd = libc.socket(socket.AF_INET, socket.SOCK_STREAM, 0)
        if fd >= 0 and libc.connect(fd, buffer, len(good)) == 0:
            ok += 1
        if fd >= 0:
            libc.close(fd)
else:
    good, bad = sys.argv[3].encode() + b"\0", sys.argv[4].encode() + b"\0"
    size = max(len(good), len(bad))
    good, bad = good.ljust(size, b"\0"), bad.ljust(size, b"\0")
    buffer = ctypes.create_string_buffer(good, size)
    thread = threading.Thread(target=flipper, args=(buffer, good, bad))
    thread.start()
    for index in range(rounds):
        if libc.chmod(buffer, 0o640 if index % 2 else 0o600) == 0:
            ok += 1
stop.set()
thread.join()
print("ok=%d" % ok)
`;

/** Binds and listens on each address; restricted none/allowlist must allow loopback only. */
const BIND_PROGRAM = `
import socket
out = []
for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1"),
                     (socket.AF_INET, "0.0.0.0"), (socket.AF_INET6, "::")):
    s = socket.socket(family, socket.SOCK_STREAM)
    try:
        s.bind((host, 0))
        s.listen(1)
        out.append(host + "=ok")
    except OSError:
        out.append(host + "=denied")
    s.close()
# Dissolving an association (connect AF_UNSPEC) must not turn listen() into a bind to any address.
import ctypes
libc = ctypes.CDLL(None, use_errno=True)
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
libc.connect(s.fileno(), ctypes.create_string_buffer(16), 16)
try:
    s.listen(1)
    out.append("unspec=" + s.getsockname()[0])
except OSError:
    out.append("unspec=denied")
print(" ".join(out))
`;

/** A Full-access UNIX service (stream, seqpacket, datagram) counting every client it sees. */
const UNIX_SERVER = `
import errno, os, socket, sys, threading
UNSUPPORTED = (errno.EPROTONOSUPPORT, errno.ESOCKTNOSUPPORT, errno.EPROTOTYPE, errno.EOPNOTSUPP)
path, counter = sys.argv[1], sys.argv[2]
lock = threading.Lock()
count = [0]
def seen():
    with lock:
        count[0] += 1
        with open(counter + ".tmp", "w") as handle:
            handle.write(str(count[0]))
        os.replace(counter + ".tmp", counter)
def serve(kind, suffix):
    try:
        s = socket.socket(socket.AF_UNIX, kind)
    except OSError as error:
        if error.errno not in UNSUPPORTED:
            raise
        # this OS has no such UNIX socket type (macOS: SOCK_SEQPACKET): mark it and stop
        open(path + suffix, "w").close()
        return
    s.bind(path + suffix)
    if kind == socket.SOCK_DGRAM:
        while True:
            s.recv(100)
            seen()
    s.listen(16)
    while True:
        s.accept()[0].close()
        seen()
threads = [threading.Thread(target=serve, args=a, daemon=True)
           for a in ((socket.SOCK_STREAM, ""), (socket.SOCK_SEQPACKET, ".seq"), (socket.SOCK_DGRAM, ".dgram"))]
for thread in threads:
    thread.start()
with open(counter + ".tmp", "w") as handle:
    handle.write("0")
while not all(os.path.exists(path + suffix) for suffix in ("", ".seq", ".dgram")):
    pass
os.replace(counter + ".tmp", counter)
threading.Event().wait()
`;

/** Tries every way to reach the outside UNIX service; prints ok/denied per attempt. */
const UNIX_CLIENT = `
import errno, socket, sys
UNSUPPORTED = (errno.EPROTONOSUPPORT, errno.ESOCKTNOSUPPORT, errno.EPROTOTYPE, errno.EOPNOTSUPP)
path, link = sys.argv[1], sys.argv[2]
class Unsupported(Exception):
    pass
def make(create):
    # the OS has no such UNIX socket type at all (macOS: SOCK_SEQPACKET, SOCK_RAW)
    try:
        return create()
    except OSError as error:
        if error.errno in UNSUPPORTED:
            raise Unsupported()
        raise
def attempt(name, action):
    try:
        action()
        return name + "=ok"
    except Unsupported:
        return name + "=unsupported"
    except OSError:
        return name + "=denied"
def connect(kind, target):
    make(lambda: socket.socket(socket.AF_UNIX, kind)).connect(target)
def send(kind):
    make(lambda: socket.socket(socket.AF_UNIX, kind)).sendto(b"x", path + ".dgram")
def pair(kind):
    # An explicit address on a socketpair datagram socket is honoured by the kernel.
    first, _ = make(lambda: socket.socketpair(socket.AF_UNIX, kind))
    try:
        first.sendto(b"x", path + ".dgram")
    except OSError as error:
        # the OS ignores no explicit address on a connected socket (macOS): no such vector there
        if error.errno == errno.EISCONN:
            raise Unsupported()
        raise
print(" ".join([
    attempt("stream", lambda: connect(socket.SOCK_STREAM, path)),
    attempt("seqpacket", lambda: connect(socket.SOCK_SEQPACKET, path + ".seq")),
    attempt("dgram", lambda: send(socket.SOCK_DGRAM)),
    attempt("raw", lambda: send(socket.SOCK_RAW)),
    attempt("link", lambda: connect(socket.SOCK_STREAM, link)),
    attempt("pair-dgram", lambda: pair(socket.SOCK_DGRAM)),
    attempt("pair-raw", lambda: pair(socket.SOCK_RAW)),
]))
`;

/**
 * Connects to a UNIX service another process made inside the root (stream, and seqpacket where the
 * OS has it), by the relative path and by `argv[2]` (absolute); prints ok/denied/unsupported.
 */
const FOREIGN_UNIX_CLIENT = `
import errno, socket, sys
UNSUPPORTED = (errno.EPROTONOSUPPORT, errno.ESOCKTNOSUPPORT, errno.EPROTOTYPE, errno.EOPNOTSUPP)
out = []
for name, kind, suffix in (("stream", socket.SOCK_STREAM, ""), ("seqpacket", socket.SOCK_SEQPACKET, ".seq")):
    for spelling, path in (("", sys.argv[1]), ("-absolute", sys.argv[2])):
        try:
            s = socket.socket(socket.AF_UNIX, kind)
        except OSError as error:
            out.append(name + spelling + ("=unsupported" if error.errno in UNSUPPORTED else "=denied"))
            continue
        try:
            s.settimeout(10)
            s.connect(path + suffix)
            out.append(name + spelling + "=ok")
        except OSError:
            out.append(name + spelling + "=denied")
        s.close()
print("foreign-unix-client " + " ".join(out))
`;

/** A UNIX stream server and client inside the root talk to each other. */
const UNIX_ROUNDTRIP = `
import socket, sys
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(sys.argv[1])
server.listen(1)
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.connect(sys.argv[1])
peer = server.accept()[0]
client.sendall(b"ping")
print("roundtrip=ok" if peer.recv(4) == b"ping" else "roundtrip=bad")
`;

/** Atomically exchanges a directory with a symlink to an outside path until a stop file exists. */
const SWAP_PROGRAM = `
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
base, outside, stop = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(base + "/dir")
os.symlink(outside, base + "/link")
open(base + "/swapping", "w").close()
swaps = 0
def exchange(a, b):
    if sys.platform == "darwin":
        return libc.renamex_np(a, b, 2)  # RENAME_SWAP
    return libc.renameat2(-100, a, -100, b, 2)  # RENAME_EXCHANGE
while not os.path.exists(stop):
    if exchange((base + "/dir").encode(), (base + "/link").encode()) == 0:
        swaps += 1
print("swaps=%d" % swaps)
`;

/**
 * Run by a same-uid process outside every operation: tries `PTRACE_ATTACH` and opens `mem` and
 * `environ` of a control child of its own (proving the probe sees real access) and of the target.
 */
const OUTSIDE_PROBE = `
import ctypes, errno, json, os, signal, sys, time
libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.restype = ctypes.c_long
libc.ptrace.argtypes = (ctypes.c_long, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p)
PTRACE_ATTACH, PTRACE_DETACH, WALL = 16, 17, 0x40000000
def name(code):
    return errno.errorcode.get(code, str(code))
def opened(pid, entry):
    try:
        fd = os.open("/proc/%d/%s" % (pid, entry), os.O_RDONLY)
    except OSError as error:
        return name(error.errno)
    try:
        if entry == "environ":
            os.read(fd, 1)
    finally:
        os.close(fd)
    return "ALLOWED"
def attach(pid):
    if libc.ptrace(PTRACE_ATTACH, pid, None, None) < 0:
        return name(ctypes.get_errno())
    # Undo at once (the attach stopped the target) so even a failing check leaves it running.
    os.waitpid(pid, WALL)
    libc.ptrace(PTRACE_DETACH, pid, None, None)
    return "ALLOWED"
def probe(pid):
    return {"mem": opened(pid, "mem"), "environ": opened(pid, "environ"), "attach": attach(pid)}
child = os.fork()
if child == 0:
    time.sleep(600)
    os._exit(0)
control = probe(child)
os.kill(child, signal.SIGKILL)
os.waitpid(child, 0)
target = int(sys.argv[1])
def identity(pid):
    with open("/proc/%d/status" % pid) as handle:
        uid = [int(line.split()[1]) for line in handle if line.startswith("Uid:")][0]
    with open("/proc/%d/cmdline" % pid, "rb") as handle:
        return {"uid": uid, "cmdline": handle.read().replace(b"\\0", b" ").decode().strip()}
print(json.dumps({"uid": os.getuid(), "who": identity(target), "control": control,
                  "target": probe(target)}))
`;

/**
 * Listens on loopback and connects to its own listener (refused: no sandboxed client reaches a
 * loopback listener, its own included), then tries to join a reuseport group (refused).
 */
const OWN_LOOPBACK = `
import json, socket
out = {}
for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
    server = socket.socket(family, socket.SOCK_STREAM)
    server.bind((host, 0))
    server.listen(4)
    client = socket.socket(family, socket.SOCK_STREAM)
    client.settimeout(5)
    try:
        client.connect((host, server.getsockname()[1]))
        out["own " + host] = "ok"
    except OSError:
        out["own " + host] = "denied"
s = socket.socket()
try:
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    out["reuseport"] = "ok"
except OSError:
    out["reuseport"] = "denied"
print(json.dumps(out, sort_keys=True))
`;

/** Listens on loopback, publishes its port and prints what the first client sends. */
const LOOPBACK_SERVICE = `
import os, socket, sys
server = socket.socket()
server.bind(("127.0.0.1", 0))
server.listen(1)
server.settimeout(60)
with open(sys.argv[1] + ".tmp", "w") as handle:
    handle.write(str(server.getsockname()[1]))
os.rename(sys.argv[1] + ".tmp", sys.argv[1])
peer = server.accept()[0]
peer.settimeout(10)
print(peer.recv(16).decode())
`;

/**
 * A part of the operation-boundary conformance, for runs that split it (each part needs a fresh
 * fixture; the setup, positive controls and the scope contract run in every part):
 * - `filesystem`: mandatory denies, reserved names, protected link chains, git work, sibling and
 *   protected-path denials, every profile sandboxed with the minimal environment;
 * - `network`: allowlist, closed classes, loopback listeners, the open network, UNIX sockets;
 * - `processes`: escalated-pair controls, overlaps, swaps and pointer races, the supervisor,
 *   cancellation and narrowed scopes.
 */
export type SandboxPermissionConformancePart = "filesystem" | "network" | "processes";

/**
 * The approval-only checks of the operation-boundary conformance, for a focused rerun or a harness
 * self-test (`checks`: only these, after the setup, positive controls and the scope contract):
 * `outside-switch` (processes), `environment`, `reserved-names` and `link-chain` (filesystem),
 * `closed-granted`, `loopback`, `open-network` and `foreign-unix` (network).
 */
export type SandboxPermissionConformanceCheck =
  | "outside-switch"
  | "environment"
  | "reserved-names"
  | "link-chain"
  | "closed-granted"
  | "loopback"
  | "open-network"
  | "foreign-unix";

const CHECK_PART: Readonly<
  Record<SandboxPermissionConformanceCheck, SandboxPermissionConformancePart>
> = {
  "outside-switch": "processes",
  environment: "filesystem",
  "reserved-names": "filesystem",
  "link-chain": "filesystem",
  "closed-granted": "network",
  loopback: "network",
  "open-network": "network",
  "foreign-unix": "network",
};

export interface SandboxPermissionConformanceOptions {
  /** Only these parts (each needs a fresh fixture); never empty. Default: every part. */
  readonly parts?: readonly SandboxPermissionConformancePart[];
  /** Only these approval-only checks (see {@link SandboxPermissionConformanceCheck}); never empty. */
  readonly checks?: readonly SandboxPermissionConformanceCheck[];
}

/** What a run could not prove here, each with the fixture's reason (annotate or log them). */
export interface SandboxPermissionConformanceReport {
  readonly unavailable: readonly { readonly item: string; readonly reason: string }[];
}

/** The innocent-looking planted name a denylist would let through (see `deviceEnvironment`). */
const SECRET_LOOKING = /SECRET|TOKEN|KEY|PASS|CREDENTIAL|^CAPYBARA_/i;
/** The minimal environment's fixed names (see `deviceEnvironment`). */
const MINIMAL_ENVIRONMENT = new Set([
  "PATH",
  "LANG",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
]);

/**
 * Proves an actual provider's permission boundary on one shared device (approval-only profiles
 * design). The sandbox is the device's and the same under every profile: a profile only chooses
 * who approves a crossing, so every profile's ordinary call is sandboxed, and only the escalated
 * pair (the device filesystem with the environment network, legal only together) runs outside it,
 * and only with outside-sandbox support while the owner allows it.
 *
 * An operation-boundary provider (a local device) is proved with positive controls; sibling,
 * symlink, protected-path, mandatory-deny, reserved-name, protected-link-chain and network
 * denials; every profile sandboxed with the minimal environment; the open network (closed classes
 * refused by resolved address, rebinding and fake-IP names included) and the allowlist (closed
 * classes refused even for granted names); loopback listeners (Linux: loopback only, no sandboxed
 * connect to any, its own included, no `SO_REUSEPORT`; macOS: none at all); escalated-pair
 * controls outside the sandbox; both overlap orders; component/root swaps and mutable syscall
 * pointers during access; exact cancellation; a supervisor closed to same-uid outsiders (when the
 * fixture can run one) and fresh narrowed scopes. Pathname UNIX services outside the roots stay
 * unreachable under every sandbox network, and so does one another process made inside a write
 * root (only the operation's own sockets are reachable). A provider that reports restricted unsupported must
 * refuse restricted operations (fail closed); nothing here substitutes a fixture flag for support.
 *
 * An instance-boundary provider (a cloud device: the container or microVM is the sandbox) is
 * proved with every profile running alike in the instance (its whole filesystem the scope),
 * nothing outside it, the outer network (open or allowlist) for every operation, and exact
 * cancellation.
 *
 * Not covered, by design (known limitations, not passes): metadata reads outside the roots (stat,
 * readlink, xattrs, statfs), and the world-readable `/proc/<pid>` entries of other processes of the
 * same uid, such as `cmdline`, `stat` and `status`. A restricted operation can therefore read the
 * command line of a concurrent escalated command on the device: Landlock cannot scope `/proc` to the
 * operation's own process tree (see the Linux launcher's known limitations). Providers keep secrets
 * out of command lines; ptrace-guarded entries (`environ`, `mem`, `maps`, `fd`) stay closed.
 */
export async function runSandboxPermissionConformance(
  fixture: SandboxPermissionFixture,
  options: SandboxPermissionConformanceOptions = {},
): Promise<SandboxPermissionConformanceReport> {
  const { root, sibling } = fixture;
  const unavailable: { item: string; reason: string }[] = [];
  const report = (): SandboxPermissionConformanceReport => ({ unavailable: [...unavailable] });
  const part = (name: SandboxPermissionConformancePart) =>
    options.parts === undefined || options.parts.includes(name);
  /** The parts' other checks run only in a run that does not pick single checks. */
  const whole = (name: SandboxPermissionConformancePart) =>
    options.checks === undefined && part(name);
  const want = (check: SandboxPermissionConformanceCheck) =>
    options.checks === undefined ? part(CHECK_PART[check]) : options.checks.includes(check);
  const at = (base: string, name: string) => posix.join(base, name);
  const secret = `sibling-secret-${randomUUID()}`;
  const scoped = (writeRoots: string[]): SandboxFileScope => ({
    kind: "scoped",
    readRoots: [],
    writeRoots,
  });
  const restricted = (
    network: SandboxNetworkScope = { kind: "none" },
    writeRoots = [root],
  ): SandboxPermissionGrant => ({
    profile: "approve-for-me",
    filesystem: scoped(writeRoots),
    network,
  });
  /**
   * The escalated pair: one call run outside the sandbox (the device filesystem with the
   * environment network). Only an outside-sandbox grant makes it legal, under any profile; the
   * profile names who approved it, nothing more.
   */
  const escalated: SandboxPermissionGrant = {
    profile: "request-approval",
    filesystem: { kind: "device" },
    network: { kind: "environment" },
  };
  const PROFILES: readonly PermissionProfile[] = [
    "request-approval",
    "approve-for-me",
    "full-access",
  ];
  const { granted, ungranted, access } = fixture.endpoints;
  const proxied = access === "proxy";
  const allowlisted: SandboxNetworkScope = { kind: "allowlist", hosts: [granted.name] };
  const exec = async (
    grant: SandboxPermissionGrant,
    command: string,
    signal = new AbortController().signal,
    timeoutMs = 120_000,
  ): Promise<ExecResult> =>
    (await fixture.operation(grant)).exec({
      command,
      cwd: root,
      timeoutMs,
      maxOutputBytes: 1 << 20,
      signal,
    });
  const native = async (grant: SandboxPermissionGrant) => {
    const operation = await fixture.operation(grant);
    assert(operation.list && operation.scan, "Permission conformance requires list and scan");
    return operation as Required<SandboxOperation>;
  };
  const signal = new AbortController().signal;
  const denied = async (promise: Promise<unknown>, what: string) => {
    await assert.rejects(promise, (error) => isSandboxScopeDeniedError(error), what);
  };
  const waitFor = (path: string, pending: Promise<unknown>) =>
    waitForFile(fixture.inspect.readFile, path, pending);
  const receipts = async () =>
    Promise.all([granted, ...ungranted].map((endpoint) => endpoint.receipts()));
  const connect = (endpoint: SandboxPermissionEndpoint) =>
    `python3 -c ${quote(
      `import socket; socket.create_connection((${JSON.stringify(endpoint.address)}, ${endpoint.port}), 10).close()`,
    )}`;
  /** An HTTP request by name; curl and Python use the environment's proxy when there is one. */
  const byName = (endpoint: SandboxPermissionEndpoint) =>
    `curl -fsS -m 10 -o /dev/null http://${endpoint.name}:${endpoint.port}/`;
  const url = (target: SandboxPermissionTarget) =>
    `http://${isIP(target.host) === 6 ? `[${target.host}]` : target.host}:${target.port}/`;
  /**
   * Asks for each target by URL in one sandboxed command and returns the HTTP status per label
   * ("000": no answer at all). `viaProxy`: every request goes to the environment's proxy (curl
   * `--noproxy ''`, overriding a `NO_PROXY` list); otherwise curl follows the environment as an
   * ordinary client does (a `NO_PROXY` entry connects directly, which the sandbox must refuse).
   */
  const probeTargets = async (
    grant: SandboxPermissionGrant,
    targets: readonly SandboxPermissionTarget[],
    viaProxy: boolean,
  ): Promise<Record<string, string>> => {
    if (targets.length === 0) return {};
    const noProxy = viaProxy ? "--noproxy '' " : "";
    const result = await exec(
      grant,
      targets
        .map(
          (target) =>
            `printf '%s %s\\n' ${quote(target.label)} "$(curl -sS -m 10 ${noProxy}-o /dev/null -w '%{http_code}' ${quote(url(target))} 2>/dev/null)"`,
        )
        .join("; "),
    );
    assert.equal(result.exitCode, 0, `the target probe must run: ${result.stderr}`);
    return Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => line.split(" ") as [string, string]),
    );
  };
  const counts = async (targets: readonly SandboxPermissionTarget[]) =>
    Promise.all(targets.map(async (target) => (target.receipts ? target.receipts() : 0)));
  const reached = (status: string | undefined) => status !== undefined && /^[23]\d\d$/.test(status);
  /**
   * Every closed target is refused (a proxied provider answers its own 403 before any dial) and
   * none sees a connection; every reachable target answers and, where counted, sees one.
   */
  const proveTargets = async (
    grant: SandboxPermissionGrant,
    reachable: readonly SandboxPermissionTarget[],
    closed: readonly SandboxPermissionTarget[],
    what: string,
  ) => {
    const before = await counts([...reachable, ...closed]);
    // as an ordinary client: closed targets stay unreached whatever NO_PROXY says
    const plain = await probeTargets(grant, closed, false);
    for (const target of closed)
      assert(
        !reached(plain[target.label]),
        `${what}: ${target.label} (${url(target)}) must not be reached: ${JSON.stringify(plain)}`,
      );
    const statuses = await probeTargets(grant, [...reachable, ...closed], proxied);
    const after = await counts([...reachable, ...closed]);
    reachable.forEach((target, index) => {
      assert(
        reached(statuses[target.label]),
        `${what}: ${target.label} (${url(target)}) must be reached: ${JSON.stringify(statuses)}`,
      );
      if (target.receipts)
        assert(
          (after[index] ?? 0) > (before[index] ?? 0),
          `${what}: ${target.label} must see the connection`,
        );
    });
    closed.forEach((target, offset) => {
      const index = reachable.length + offset;
      const status = statuses[target.label];
      assert(
        proxied ? status === "403" : !reached(status),
        `${what}: ${target.label} (${url(target)}) must be refused${proxied ? " by the proxy (403)" : ""}: ${JSON.stringify(statuses)}`,
      );
      assert.equal(after[index], before[index], `${what}: ${target.label} must see no connection`);
    });
  };
  /** The names of the planted device variables a command under `grant` can see, and its names. */
  const environmentOf = async (grant: SandboxPermissionGrant) => {
    const planted = fixture.deviceEnvironment?.variables ?? {};
    const result = await exec(grant, "env");
    assert.equal(result.exitCode, 0, `env must run: ${result.stderr}`);
    const names = result.stdout
      .split("\n")
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
      .map((line) => line.slice(0, line.indexOf("=")));
    return {
      leaked: Object.entries(planted)
        .filter(([, value]) => result.stdout.includes(value))
        .map(([name]) => name),
      names,
    };
  };
  const leakedVariables = async (grant: SandboxPermissionGrant) =>
    (await environmentOf(grant)).leaked;
  /**
   * A sandboxed command under `grant` sees no planted value and, on an operation boundary, only
   * the minimal environment's names (a denylist would pass the first, never the second).
   */
  const proveMinimalEnvironment = async (grant: SandboxPermissionGrant, minimalNames: boolean) => {
    const environment = fixture.deviceEnvironment;
    if (!environment) return;
    const { leaked, names } = await environmentOf(grant);
    assert.deepEqual(
      leaked,
      [],
      `${grant.profile}: no device variable reaches a sandboxed command`,
    );
    if (!minimalNames) return;
    const allowed = new Set([...MINIMAL_ENVIRONMENT, ...(environment.allowed ?? [])]);
    const extra = names.filter((name) => !allowed.has(name) && !/proxy/i.test(name));
    assert.deepEqual(
      extra,
      [],
      `${grant.profile}: a sandboxed command gets the minimal environment only (PATH, LANG, HOME, ` +
        "TMPDIR/TMP/TEMP, the proxy variables, the stated tool homes), never a filtered copy of " +
        "the device's",
    );
  };
  /** The closed-class names behind allowlist grants, or none (reported unavailable). */
  const closedGrantedTargets = (): readonly SandboxPermissionTarget[] => {
    const closed = fixture.endpoints.closedGranted;
    if (closed === undefined) return [];
    if ("unavailable" in closed) return [];
    return closed;
  };
  const namedReachAvailable = () => {
    const reach = fixture.endpoints.namedReach;
    if (reach === undefined || reach === "available") return true;
    unavailable.push({ item: "allowlist positive by name", reason: reach.unavailable });
    return false;
  };
  /** The escalated pair is refused before anything runs (typed), and leaves no trace. */
  const escalationRefused = async (what: string) => {
    const marker = `escalated-${randomUUID()}`;
    await assert.rejects(
      exec(escalated, `printf ran > ${quote(at(root, marker))}`),
      (error) =>
        isSandboxScopeDeniedError(error) ||
        isSandboxPermissionUnsupportedError(error) ||
        isSandboxScopeValidationError(error),
      what,
    );
    assert.equal(await fixture.inspect.readFile(at(root, marker)), null, `${what}: nothing ran`);
  };
  /** A sandboxed filesystem with the environment network is refused as invalid (typed). */
  const environmentPairRefused = async (writeRoots: string[]) => {
    const marker = `env-ran-${randomUUID()}`;
    await assert.rejects(
      exec(
        {
          profile: "full-access",
          filesystem: scoped(writeRoots),
          network: { kind: "environment" },
        },
        `printf ran > ${quote(at(root, marker))}`,
      ),
      (error) => isSandboxScopeValidationError(error) || isSandboxScopeDeniedError(error),
      "the environment network without the device filesystem must be refused before it runs " +
        "(only the escalated pair carries it)",
    );
    assert.equal(await fixture.inspect.readFile(at(root, marker)), null, "nothing ran");
  };
  /** The open network under every profile (approval-only profiles design, "Open network"). */
  const proveOpenNetwork = async (writeRoots: string[]) => {
    const open = fixture.openNetwork;
    assert(open, "a provider reporting network.openPublic needs the openNetwork fixture");
    assert(open.closed.length > 0, "the open network needs closed targets");
    // the closed targets cover every closed class (by their literal host or served address)
    const covered = new Set(
      open.closed
        .map((target) => target.address ?? target.host)
        .filter((host) => isIP(host) !== 0)
        .map((host) => classifyAddress(host)),
    );
    const missing = OPEN_PUBLIC_DENIED_CLASSES.filter((cls) => !covered.has(cls));
    assert.deepEqual(missing, [], "the open network's closed targets cover every closed class");
    const reachable = "unavailable" in open.reachable ? [] : open.reachable;
    if ("unavailable" in open.reachable)
      unavailable.push({
        item: "open network: public targets",
        reason: open.reachable.unavailable,
      });
    const fake = open.fakeIp && !("unavailable" in open.fakeIp) ? open.fakeIp : undefined;
    if (open.fakeIp === undefined)
      unavailable.push({ item: "open network: fake-IP names", reason: "no fakeIp fixture" });
    else if ("unavailable" in open.fakeIp)
      unavailable.push({ item: "open network: fake-IP names", reason: open.fakeIp.unavailable });
    assert(
      reachable.length + (fake?.reachable.length ?? 0) > 0 || open.allowNoPositive === true,
      "the open network needs a reachable public target (set allowNoPositive only for an offline run)",
    );
    for (const profile of PROFILES) {
      const grant: SandboxPermissionGrant = {
        profile,
        filesystem: scoped(writeRoots),
        network: { kind: "open-public" },
      };
      await proveTargets(
        grant,
        [...reachable, ...(fake?.reachable ?? [])],
        [...open.closed, ...(fake?.closed ?? [])],
        `open network (${profile})`,
      );
      if (proxied)
        // only the proxy dials: a raw connect to a public address bypasses it and is refused
        for (const target of reachable.filter((t) => t.address !== undefined)) {
          const raw = await exec(
            grant,
            `python3 -c ${quote(`import socket; socket.create_connection((${JSON.stringify(target.address)}, ${target.port}), 10).close()`)}`,
          );
          assert.notEqual(raw.exitCode, 0, `open network (${profile}): raw ${target.label}`);
        }
    }
  };
  const urlopen = (endpoint: SandboxPermissionEndpoint) =>
    `python3 -c ${quote(
      `import urllib.request; urllib.request.urlopen("http://${endpoint.name}:${endpoint.port}/", timeout=10).read()`,
    )}`;

  /** Exact cancellation and timeouts of operations under `grant` (whose roots cover `root`). */
  const proveCancellation = async (grant: SandboxPermissionGrant) => {
    // Exact cancellation: detached descendants end; a sibling operation keeps running.
    const keepAlive = exec(
      grant,
      `printf r > ready-keep; until [ -e release-keep ]; do sleep 0.01; done; printf done > kept`,
    );
    await waitFor(at(root, "ready-keep"), keepAlive);
    const abort = new AbortController();
    const regrouped = fixture.regroupedDescendants !== "not-promised";
    const cancelled = exec(
      grant,
      `(sleep 1000 & echo $! > p1); nohup sh -c 'sleep 1001' > /dev/null 2>&1 & echo $! > p2; ` +
        `setsid sleep 1002 > /dev/null 2>&1 & ` +
        (regrouped
          ? `python3 -c ${quote("import os, time\nif os.fork() == 0:\n    os.setpgid(0, 0)\n    open('p3.tmp', 'w').write(str(os.getpid()))\n    os.rename('p3.tmp', 'p3')\n    time.sleep(1003)")} & ` +
            `until [ -e p3 ]; do sleep 0.01; done; `
          : "") +
        `printf r > ready-cancel; sleep 1004`,
      abort.signal,
    );
    await waitFor(at(root, "ready-cancel"), cancelled);
    const pids = await Promise.all(
      (regrouped ? ["p1", "p2", "p3"] : ["p1", "p2"]).map(async (name) =>
        Number(text(await fixture.inspect.readFile(at(root, name)))),
      ),
    );
    assert.deepEqual(await fixture.inspect.alive(pids), pids, "descendants run before cancel");
    abort.abort();
    const stopped = await cancelled;
    assert.equal(stopped.exitCode, null, "a cancelled operation has no exit code");
    assert.deepEqual(await fixture.inspect.alive(pids), [], "cancellation ends every descendant");
    await exec(grant, "touch release-keep");
    assert.equal((await keepAlive).exitCode, 0, "the sibling operation survives the cancel");
    assert.equal(text(await fixture.inspect.readFile(at(root, "kept"))), "done");

    // Timeout ends the whole owned tree as well.
    const timed = await exec(grant, `(sleep 1005 & echo $! > p4); sleep 1006`, signal, 1000);
    assert.equal(timed.timedOut, true, "a restricted timeout is reported");
    const p4 = Number(text(await fixture.inspect.readFile(at(root, "p4"))));
    assert.deepEqual(await fixture.inspect.alive([p4]), [], "timeout ends background children");
  };

  /**
   * An instance-boundary provider (a cloud device): the container or microVM is the sandbox, its
   * whole filesystem the scope, its outer network the sandbox network. Every profile runs there
   * alike, nothing runs outside it, and the outer network holds for every operation.
   */
  const proveInstanceBoundary = async (support: SandboxPermissionSupport) => {
    assert.equal(support.restricted, null, "an instance boundary has no per-operation restriction");
    assert.equal(support.outsideSandbox, false, "an instance boundary has nothing outside");
    assert.equal(
      support.network.perOperationHosts,
      false,
      "an instance's outer network covers every operation: no per-operation hosts",
    );
    const network = fixture.instanceNetwork;
    assert(network, "an instance-boundary fixture names its outer network (instanceNetwork)");
    const closedGranted = fixture.endpoints.closedGranted;
    assert(
      Array.isArray(closedGranted) &&
        closedGranted.some(
          (target) =>
            target.address !== undefined && classifyAddress(target.address) === "metadata",
        ),
      "an instance boundary needs closedGranted with a name served at a cloud metadata address",
    );
    const whole = ["/"];
    const instanceGrant = (
      profile: PermissionProfile,
      kind: "none" | "allowlist" | "open-public" = network === "open" ? "open-public" : "allowlist",
    ): SandboxPermissionGrant => ({
      profile,
      filesystem: scoped(whole),
      network:
        kind === "allowlist"
          ? {
              kind: "allowlist",
              hosts: [granted.name, ...closedGrantedTargets().map((t) => t.host)],
            }
          : { kind },
    });
    await fixture.seed([
      { path: at(sibling, "secret"), kind: "file", data: new TextEncoder().encode(secret) },
    ]);
    // nothing runs outside the instance, and the environment network comes only with it
    await escalationRefused("an instance boundary must refuse the escalated pair");
    await environmentPairRefused(whole);
    // every profile runs alike inside: the whole instance is the scope, root and sibling included
    const bytes = new Uint8Array([7, 8, 9]);
    for (const profile of PROFILES) {
      const shell = await exec(
        instanceGrant(profile),
        `printf ${profile} > ${quote(at(root, `${profile}.txt`))} && cat ${quote(at(sibling, "secret"))}`,
      );
      assert.equal(shell.exitCode, 0, `${profile} runs in the instance: ${shell.stderr}`);
      assert.equal(shell.stdout, secret, `${profile} reads anywhere in the instance`);
      assert.equal(text(await fixture.inspect.readFile(at(root, `${profile}.txt`))), profile);
      await (await native(instanceGrant(profile))).writeFile(
        at(sibling, `${profile}.bin`),
        bytes,
        signal,
      );
      assert.deepEqual(
        await (await native(instanceGrant(profile))).readFile(at(sibling, `${profile}.bin`), {
          maxBytes: 10,
          signal,
        }),
        { data: bytes, truncated: false },
      );
      if (fixture.deviceEnvironment)
        assert.deepEqual(
          await leakedVariables(instanceGrant(profile)),
          [],
          `${profile}: no provider variable reaches a command`,
        );
    }
    // the outer network holds for every operation and profile
    if (network === "open") {
      assert(support.network.openPublic, "an open outer network must be reported as openPublic");
      await proveOpenNetwork(whole);
    } else {
      assert(support.network.allowlist, "an allowlist outer network must be reported as allowlist");
      assert(ungranted.length > 0, "an allowlist outer network needs an ungranted endpoint");
      const named = namedReachAvailable();
      for (const profile of PROFILES) {
        const before = await receipts();
        const grant = instanceGrant(profile);
        let positives = 0;
        if (named) {
          const result = await exec(grant, byName(granted));
          assert.equal(result.exitCode, 0, `${profile}: the allowlisted name: ${result.stderr}`);
          positives++;
        }
        for (const endpoint of ungranted)
          for (const command of [connect(endpoint), byName(endpoint)]) {
            const result = await exec(grant, command);
            assert.notEqual(
              result.exitCode,
              0,
              `${profile}: ungranted ${endpoint.name}: ${command}`,
            );
          }
        // a scope that names an ungranted host widens nothing: the instance's list holds for
        // every operation (no per-operation hosts)
        const asked: SandboxPermissionGrant = {
          ...grant,
          network: {
            kind: "allowlist",
            hosts: [granted.name, ...ungranted.map((endpoint) => endpoint.name)],
          },
        };
        for (const endpoint of ungranted) {
          const result = await exec(asked, byName(endpoint));
          assert.notEqual(
            result.exitCode,
            0,
            `${profile}: an ungranted name in the scope's hosts must still be refused: ${endpoint.name}`,
          );
        }
        await proveTargets(grant, [], closedGrantedTargets(), `${profile} allowlist`);
        const after = await receipts();
        assert.equal(after[0], (before[0] ?? 0) + positives, `${profile}: granted receipts`);
        assert.deepEqual(after.slice(1), before.slice(1), `${profile}: ungranted see nothing`);
      }
    }
    await proveCancellation(instanceGrant("full-access"));
  };

  try {
    assert(options.parts === undefined || options.parts.length > 0, "parts must not be empty");
    assert(options.checks === undefined || options.checks.length > 0, "checks must not be empty");
    for (const [label, endpoint] of [
      ["granted", granted],
      ...ungranted.map((endpoint) => ["ungranted", endpoint] as const),
    ] as const) {
      const problems = validateAllowHost(endpoint.name);
      assert(
        problems.length === 0,
        `${label} endpoint name ${endpoint.name} is not a valid allowlist host: ${problems.join("; ")}`,
      );
      assert(
        isIP(endpoint.address) !== 0,
        `${label} endpoint address ${endpoint.address} is not a numeric address`,
      );
    }
    assert(isIPv4(granted.address), "the granted endpoint address must be IPv4 (race program)");
    assert(
      ungranted.every((endpoint) => endpoint.name !== granted.name),
      "ungranted endpoints need names other than the granted one",
    );

    const support = await fixture.support();
    assert.equal(support.version, 2, "permission support must be version 2");
    if (support.boundary === "instance") {
      await proveInstanceBoundary(support);
      return report();
    }
    if (support.restricted === null) {
      // Fail closed: no restricted operation may run, and nothing falls back to the escalated pair.
      await assert.rejects(
        (async () =>
          (await fixture.operation(restricted())).exec({
            command: "true",
            cwd: root,
            timeoutMs: 10_000,
            maxOutputBytes: 1024,
            signal,
          }))(),
        (error) => isSandboxPermissionUnsupportedError(error),
        "an unsupported runtime must refuse restricted operations",
      );
      return report();
    }
    assert.deepEqual(
      support.restricted,
      { filesystem: true, network: true, native: true, concurrentScopes: true },
      "restricted support requires all four claims together",
    );
    // the approval-only inputs a provider with restricted support must give the harness
    const planted = fixture.deviceEnvironment?.variables ?? {};
    assert(
      Object.keys(planted).some((name) => SECRET_LOOKING.test(name)) &&
        Object.keys(planted).some((name) => !SECRET_LOOKING.test(name)),
      "deviceEnvironment must plant a secret-looking and an innocent-looking variable",
    );
    assert(
      fixture.endpoints.closedGranted !== undefined,
      "closedGranted is required (or { unavailable } with the reason)",
    );
    if (Array.isArray(fixture.endpoints.closedGranted))
      assert(fixture.endpoints.closedGranted.length > 0, "closedGranted must not be empty");
    else
      unavailable.push({
        item: "allowlisted names in closed classes",
        reason: (fixture.endpoints.closedGranted as { unavailable: string }).unavailable,
      });
    if (support.outsideSandbox)
      assert(
        fixture.withoutOutsideSandbox,
        "withoutOutsideSandbox is required with outside-sandbox support",
      );
    assert(fixture.home, "home is required (or { unavailable } with the reason)");
    if ("unavailable" in fixture.home)
      unavailable.push({ item: "protected link chains", reason: fixture.home.unavailable });

    await fixture.seed([
      { path: at(sibling, "secret"), kind: "file", data: new TextEncoder().encode(secret) },
      { path: at(root, "inroot.txt"), kind: "file", data: new TextEncoder().encode("inroot") },
      { path: at(root, "escape"), kind: "symlink", target: at(sibling, "secret") },
      { path: at(root, "linked"), kind: "symlink", target: sibling },
    ]);
    const siblingMode = await fixture.inspect.mode(at(sibling, "secret"));
    const siblingIntact = async (label: string) => {
      assert.equal(text(await fixture.inspect.readFile(at(sibling, "secret"))), secret, label);
      assert.equal(await fixture.inspect.mode(at(sibling, "secret")), siblingMode, label);
    };

    // Positive controls: ordinary shell, Python, Node and native work inside the root.
    const shell = await exec(
      restricted(),
      "cat inroot.txt && printf shell > shell.txt && mkdir -p d/e && printf x > d/e/f && " +
        "chmod 755 d/e/f && touch -t 200101010000 d/e/f && ln -s shell.txt alias && cat alias",
    );
    assert.equal(shell.exitCode, 0, `restricted shell work must succeed: ${shell.stderr}`);
    assert.equal(shell.stdout, "inrootshell");
    assert.equal(await fixture.inspect.mode(at(root, "d/e/f")), 0o755, "chmod inside the root");
    const python = await exec(
      restricted(),
      `python3 -c ${quote("import pathlib; p = pathlib.Path('py.txt'); p.write_text('py'); print(p.read_text())")}`,
    );
    assert.equal(python.exitCode, 0, `restricted Python work must succeed: ${python.stderr}`);
    assert.equal(python.stdout.trim(), "py");
    const node = await exec(
      restricted(),
      `node -e ${quote("const fs = require('fs'); fs.writeFileSync('node.txt', 'node'); console.log(fs.readFileSync('node.txt', 'utf8'))")}`,
    );
    assert.equal(node.exitCode, 0, `restricted Node work must succeed: ${node.stderr}`);
    assert.equal(node.stdout.trim(), "node");
    const bytes = new Uint8Array([0, 1, 2, 255]);
    await (await native(restricted())).writeFile(at(root, "native/n.bin"), bytes, signal);
    assert.deepEqual(
      await (await native(restricted())).readFile(at(root, "native/n.bin"), {
        maxBytes: 10,
        signal,
      }),
      { data: bytes, truncated: false },
    );
    assert.deepEqual(await (await native(restricted())).stat(at(root, "native/n.bin"), signal), {
      size: 4,
      isDir: false,
    });
    assert.deepEqual(
      await (await native(restricted())).list(at(root, "native"), {
        limit: 10,
        signal,
      }),
      { entries: [{ name: "n.bin", isDir: false }], truncated: false },
    );

    // The scope contract: the environment network comes only with the device filesystem (the
    // escalated pair), which runs only with outside-sandbox support and while the owner allows it.
    await environmentPairRefused([root]);
    if (!support.outsideSandbox)
      await escalationRefused("without outside-sandbox support the escalated pair is refused");
    else if (want("outside-switch") && fixture.withoutOutsideSandbox) {
      const restore = await fixture.withoutOutsideSandbox();
      try {
        await escalationRefused(
          "the escalated pair while the owner's outside-sandbox setting is off",
        );
      } finally {
        await restore();
      }
      const control = await exec(escalated, `printf ran > ${quote(at(root, "escalated-ran"))}`);
      assert.equal(control.exitCode, 0, `the escalated pair runs again: ${control.stderr}`);
      assert.equal(text(await fixture.inspect.readFile(at(root, "escalated-ran"))), "ran");
    }
    if (whole("filesystem")) {
      // Mandatory write denies inside a granted root (the macOS set, shared through the SDK): git
      // configuration and hooks (a later unsandboxed `git` there would run them), shell startup
      // files and editor/agent configuration. Direct writes, creation, renames, hard and symbolic
      // links, and the same paths in a repository the command creates itself all stay refused.
      await fixture.seed([
        { path: at(root, "repo/.git/config"), kind: "file", data: new TextEncoder().encode("cfg") },
        {
          path: at(root, "repo/.git/hooks/pre-commit.sample"),
          kind: "file",
          data: new TextEncoder().encode("s"),
        },
        {
          path: at(root, "repo/.git/HEAD"),
          kind: "file",
          data: new TextEncoder().encode("ref: x"),
        },
      ]);
      const evil = '[core]\n\tfsmonitor = "touch escaped; false"\n';
      const denies = await exec(
        restricted(),
        [
          `cd repo`,
          `printf ${quote(evil)} > .git/config`,
          `printf x >> .git/config`,
          `mkdir -p .git/hooks; printf '#!/bin/sh' > .git/hooks/pre-commit`,
          `chmod 755 .git/hooks/pre-commit.sample`,
          `printf x > staged-config; mv staged-config .git/config`,
          `printf x > staged-hook; ln staged-hook .git/hooks/post-checkout`,
          `ln -s ../staged-hook .git/hooks/pre-push`,
          `ln -s .git/config cfg-link; printf x > cfg-link`,
          `mkdir moved; printf x > moved/config; mkdir -p sub; mv moved sub/.git`,
          `mkdir -p ../ptr && printf 'gitdir: /tmp' > ../ptr/.git`,
          `cd ..; git init -q nested 2>/dev/null; mkdir -p nested/.git/hooks; printf x > nested/.git/hooks/pre-commit; printf x > nested/.git/config`,
          `printf x > .bashrc; printf x > .zshrc; printf x > .profile; printf x > .gitconfig; printf x > .gitmodules; printf x > .mcp.json`,
          `mkdir -p .vscode && printf x > .vscode/settings.json; mkdir -p .idea && printf x > .idea/x`,
          `mkdir -p .claude/commands .claude/agents; printf x > .claude/commands/c.md; printf x > .claude/agents/a.md`,
          `mkdir -p deep/er; printf x > deep/er/.bash_profile`,
          `printf ok > allowed.txt`,
          `true`,
        ].join("; "),
      );
      assert.equal(denies.exitCode, 0, `the mandatory-deny probe must run: ${denies.stderr}`);
      assert.equal(
        text(await fixture.inspect.readFile(at(root, "allowed.txt"))),
        "ok",
        "ordinary writes",
      );
      assert.equal(
        text(await fixture.inspect.readFile(at(root, "repo/.git/config"))),
        "cfg",
        ".git/config",
      );
      assert.equal(
        (await fixture.inspect.mode(at(root, "repo/.git/hooks/pre-commit.sample"))) !== 0o755,
        true,
        "hook mode",
      );
      for (const path of [
        "repo/.git/hooks/pre-commit",
        "repo/.git/hooks/post-checkout",
        "repo/.git/hooks/pre-push",
        "repo/sub/.git/config",
        "ptr/.git",
        "nested/.git/hooks/pre-commit",
        "nested/.git/config",
        ".bashrc",
        ".zshrc",
        ".profile",
        ".gitconfig",
        ".gitmodules",
        ".mcp.json",
        ".vscode/settings.json",
        ".idea/x",
        ".claude/commands/c.md",
        ".claude/agents/a.md",
        "deep/er/.bash_profile",
      ])
        assert.equal(
          await fixture.inspect.readFile(at(root, path)),
          null,
          `mandatory deny: ${path}`,
        );
      assert.equal(
        await fixture.inspect.mode(at(root, "repo/.git/hooks/pre-push")),
        null,
        "a symbolic link into the hooks is refused too",
      );
      await denied(
        (await native(restricted())).writeFile(at(root, "repo/.git/config"), bytes, signal),
        "native write of .git/config",
      );
      await denied(
        (await native(restricted())).writeFile(
          at(root, "repo/.git/hooks/post-merge"),
          bytes,
          signal,
        ),
        "native write of a git hook",
      );
      await denied(
        (await native(restricted())).writeFile(at(root, ".vscode/tasks.json"), bytes, signal),
        "native write of editor configuration",
      );
      assert.equal(text(await fixture.inspect.readFile(at(root, "repo/.git/config"))), "cfg");

      // Inside a .git directory only git's ordinary internals are writable: the gitdirs of
      // submodules and worktrees keep their configuration, hooks and pointers too. A bare-repository
      // lookalike (a HEAD file outside .git) and moving .git away are refused as well, and the
      // matching folds case and Unicode compatibility forms.
      await fixture.seed([
        {
          path: at(root, "repo/.git/modules/sub/config"),
          kind: "file",
          data: new TextEncoder().encode("cfg"),
        },
        { path: at(root, "repo/.git/modules/sub/hooks"), kind: "directory" },
        { path: at(root, "repo/.git/modules/sub/objects"), kind: "directory" },
        {
          path: at(root, "repo/.git/worktrees/wt/commondir"),
          kind: "file",
          data: new TextEncoder().encode("../.."),
        },
      ]);
      const internals = await exec(
        restricted(),
        [
          "cd repo",
          "printf x >> .git/modules/sub/config",
          "printf x > .git/modules/sub/hooks/pre-commit",
          "printf x > .git/worktrees/wt/commondir",
          "printf x > .git/worktrees/wt/config.worktree",
          "printf x > .git/worktrees/wt/gitdir",
          "printf x > .git/info-attributes-probe; mkdir -p .git/info; printf x > .git/info/attributes",
          "printf x > .git/modules/sub/objects/ok-object",
          "mkdir -p ../bare/objects ../bare/refs; printf 'ref: refs/heads/main' > ../bare/HEAD; printf x > ../bare/config",
          "mv .git ../moved-git; printf x >> ../moved-git/config",
          "cd ..",
          "printf x > .envrc; printf x > .npmrc; mkdir -p deep; printf x > deep/.npmrc",
          "printf x > .ＢＡＳＨＲＣ; printf x > .ｅｎｖｒｃ",
          "true",
        ].join("; "),
      );
      assert.equal(internals.exitCode, 0, `the git-internals probe must run: ${internals.stderr}`);
      assert.equal(
        text(await fixture.inspect.readFile(at(root, "repo/.git/modules/sub/config"))),
        "cfg",
        "submodule config",
      );
      assert.equal(
        text(await fixture.inspect.readFile(at(root, "repo/.git/worktrees/wt/commondir"))),
        "../..",
        "worktree commondir",
      );
      assert.equal(
        text(await fixture.inspect.readFile(at(root, "repo/.git/modules/sub/objects/ok-object"))),
        "x",
        "submodule objects stay writable",
      );
      assert.equal(
        text(await fixture.inspect.readFile(at(root, "repo/.git/config"))),
        "cfg",
        "moving .git away",
      );
      for (const path of [
        "repo/.git/modules/sub/hooks/pre-commit",
        "repo/.git/worktrees/wt/config.worktree",
        "repo/.git/worktrees/wt/gitdir",
        "repo/.git/info-attributes-probe",
        "repo/.git/info/attributes",
        "bare/HEAD",
        "moved-git/config",
        ".envrc",
        ".npmrc",
        "deep/.npmrc",
        ...(fixture.foldedNames === "filesystem" ? [".bashrc"] : [".ＢＡＳＨＲＣ", ".ｅｎｖｒｃ"]),
      ])
        assert.equal(
          await fixture.inspect.readFile(at(root, path)),
          null,
          `mandatory deny: ${path}`,
        );
      if (fixture.foldedNames === "filesystem") {
        // fullwidth spellings are their own files on such a filesystem, never the protected ones
        for (const path of [".ＢＡＳＨＲＣ", ".ｅｎｖｒｃ"])
          assert.equal(
            text(await fixture.inspect.readFile(at(root, path))),
            "x",
            `distinct ${path}`,
          );
      }
      await denied(
        (await native(restricted())).writeFile(
          at(root, "repo/.git/modules/sub/config"),
          bytes,
          signal,
        ),
        "native write of a submodule's config",
      );
      await denied(
        (await native(restricted())).writeFile(at(root, "bare2/HEAD"), bytes, signal),
        "native write of a bare-repository HEAD",
      );
      // No repository can be forged inside git's own allowlisted subtrees, and hook managers
      // files stay out of reach.
      const forged = await exec(
        restricted(),
        [
          "cd repo/.git",
          "mkdir -p objects/zz/.git/objects objects/zz/.git/refs",
          "printf 'ref: refs/heads/main' > objects/zz/.git/HEAD",
          "printf x > objects/zz/.git/config",
          "mkdir -p objects/yy/objects objects/yy/refs; printf 'ref: refs/heads/main' > objects/yy/HEAD",
          "mkdir -p logs/objects; printf ../.. > logs/commondir",
          "mkdir -p refs/remotes/o/objects",
          "cd ../..",
          "mkdir -p .husky .lefthook .githooks .config",
          "printf x > .husky/pre-commit; printf x > .pre-commit-config.yaml; printf x > lefthook.yml",
          "printf x > .lefthook/x; printf x > .githooks/pre-commit; printf x > .config/lefthook.yml",
          "true",
        ].join("; "),
      );
      assert.equal(forged.exitCode, 0, `the forged-repository probe must run: ${forged.stderr}`);
      for (const path of [
        "repo/.git/objects/zz/.git/HEAD",
        "repo/.git/objects/zz/.git/config",
        "repo/.git/objects/yy/HEAD",
        "repo/.git/logs/objects",
        "repo/.git/logs/commondir",
        "repo/.git/refs/remotes/o/objects",
        ".husky/pre-commit",
        ".pre-commit-config.yaml",
        "lefthook.yml",
        ".lefthook/x",
        ".githooks/pre-commit",
        ".config/lefthook.yml",
      ])
        assert.equal(await fixture.inspect.mode(at(root, path)), null, `mandatory deny: ${path}`);
    }

    if (want("reserved-names")) {
      // The reserved staging prefix (the Linux broker's staging and quarantine names) is denied to
      // every sandboxed write, at any depth and in any case; a name merely containing it is not.
      const reserved = SANDBOX_RESERVED_NAME_PREFIX;
      const upper = reserved.toUpperCase();
      const staging = await exec(
        restricted(),
        [
          `mkdir ${reserved}a`,
          `printf x > ${reserved}b`,
          `mkdir -p deep/${upper}c`,
          `printf x > deep/${upper}d`,
          "mkdir -p plain-dir",
          `mv plain-dir ${reserved}e`,
          `printf ok > not${reserved}f`,
          "true",
        ].join("; "),
      );
      assert.equal(staging.exitCode, 0, `the reserved-name probe must run: ${staging.stderr}`);
      for (const path of [
        `${reserved}a`,
        `${reserved}b`,
        `deep/${upper}c`,
        `deep/${upper}d`,
        `${reserved}e`,
      ])
        assert.equal(await fixture.inspect.mode(at(root, path)), null, `reserved name: ${path}`);
      assert.notEqual(
        await fixture.inspect.mode(at(root, "plain-dir")),
        null,
        "the move was refused",
      );
      assert.equal(text(await fixture.inspect.readFile(at(root, `not${reserved}f`))), "ok");
      await denied(
        (await native(restricted())).writeFile(at(root, `${reserved}n`), bytes, signal),
        "native write of a reserved name",
      );
    }

    // A protected home location linked into the granted root (a dotfile manager's chain): every
    // link on the chain and the target are denied, and no hop can be retargeted or moved away.
    if (want("link-chain") && fixture.home && "path" in fixture.home) {
      const home = fixture.home;
      const chain = at(root, "dotfiles");
      await fixture.seed([
        { path: at(chain, "v1/zprofile"), kind: "file", data: new TextEncoder().encode("rc1") },
        { path: at(chain, "v2/zprofile"), kind: "file", data: new TextEncoder().encode("rc2") },
        { path: at(chain, "current"), kind: "symlink", target: "v1" },
        {
          path: at(home.path, ".zprofile"),
          kind: "symlink",
          target: at(chain, "current/zprofile"),
        },
      ]);
      try {
        const hops = await exec(
          restricted(),
          [
            "cd dotfiles",
            "(printf x >> v1/zprofile) 2>/dev/null && echo wrote-target",
            "(printf x > current/zprofile) 2>/dev/null && echo wrote-through",
            "ln -sfn v2 current 2>/dev/null && echo retargeted",
            "mv current c2 2>/dev/null && echo moved-link",
            "rm current 2>/dev/null && echo removed-link",
            "mv v1 gone 2>/dev/null && echo moved-target",
            "cd .. && mv dotfiles gone 2>/dev/null && echo moved-ancestor",
            "true",
          ].join("; "),
        );
        assert.equal(hops.exitCode, 0, `the link-chain probe must run: ${hops.stderr}`);
        assert.equal(
          hops.stdout.trim(),
          "",
          `no hop of a protected chain is writable: ${hops.stdout}`,
        );
        assert.equal(text(await fixture.inspect.readFile(at(chain, "current/zprofile"))), "rc1");
        assert.equal(text(await fixture.inspect.readFile(at(chain, "v2/zprofile"))), "rc2");
        await denied(
          (await native(restricted())).writeFile(at(chain, "v1/zprofile"), bytes, signal),
          "native write of a protected chain's target",
        );
      } finally {
        await home.remove(at(home.path, ".zprofile"));
      }
    }

    if (whole("filesystem") && support.outsideSandbox) {
      // ordinary git work in a restricted repository keeps working under these rules
      await exec(
        escalated,
        `cd ${quote(root)} && git init -q work && git -C work -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`,
      );
      const git = await exec(
        restricted(),
        "cd work && printf a > f && git add f && git -c user.name=t -c user.email=t@t commit -qm m && " +
          "git checkout -qb topic && git status --short && git log --oneline | wc -l",
      );
      assert.equal(git.exitCode, 0, `ordinary restricted git work: ${git.stderr}`);
      assert.equal(git.stdout.trim(), "2", "the restricted commit landed");
      // stash, pack-refs and gc write git internals of their own (index.stash.<n>,
      // packed-refs.new, MERGE_AUTOSTASH) that the allowlist keeps writable
      const housekeeping = await exec(
        restricted(),
        'cd work && g() { git -c user.name=t -c user.email=t@t -c gc.auto=0 "$@"; } && ' +
          "printf b >> f && g stash -q && g stash pop -q && g commit -qam s && " +
          "g pack-refs --all && g gc -q && git stash list | wc -l",
      );
      assert.equal(
        housekeeping.exitCode,
        0,
        `restricted stash, pack-refs and gc: ${housekeeping.stderr}`,
      );
    }

    if (whole("filesystem")) {
      // Negative controls: sibling, symlink escapes and protected paths stay out of reach.
      const reads = await exec(
        restricted(),
        `cat ${quote(at(sibling, "secret"))}; cat escape; cat linked/secret; true`,
      );
      assert(!reads.stdout.includes(secret), "restricted reads must not reach the sibling");
      await exec(
        restricted(),
        `printf pwn > ${quote(at(sibling, "w1"))}; printf pwn > linked/w2; printf pwn > escape; ` +
          `chmod 777 ${quote(at(sibling, "secret"))}; chmod 777 escape; ` +
          `touch -t 200101010000 ${quote(at(sibling, "secret"))}; true`,
      );
      assert.equal(await fixture.inspect.readFile(at(sibling, "w1")), null, "sibling write");
      assert.equal(await fixture.inspect.readFile(at(sibling, "w2")), null, "symlinked dir write");
      await siblingIntact("restricted writes and chmod must not change the sibling");
      for (const path of fixture.protectedPaths) {
        const before = text(await fixture.inspect.readFile(path));
        await exec(restricted(), `printf pwn >> ${quote(path)}; true`);
        assert.equal(text(await fixture.inspect.readFile(path)), before, `protected ${path}`);
      }
      await denied(
        (await native(restricted())).readFile(at(sibling, "secret"), { maxBytes: 100, signal }),
        "native sibling read",
      );
      await denied(
        (await native(restricted())).readFile(at(root, "escape"), { maxBytes: 100, signal }),
        "native symlink escape read",
      );
      await denied(
        (await native(restricted())).writeFile(at(sibling, "n1"), bytes, signal),
        "native sibling write",
      );
      await denied(
        (await native(restricted())).writeFile(at(root, "linked/n2"), bytes, signal),
        "native write through a directory symlink",
      );
      await denied((await native(restricted())).stat(at(sibling, "secret"), signal), "stat");
      await denied((await native(restricted())).list(sibling, { limit: 5, signal }), "list");
      await siblingIntact("native denials must leave the sibling unchanged");

      // Every profile is sandboxed: Full access only skips the approvals, never the sandbox. Under
      // each profile a call keeps the scope, the fixed denies, the network and the minimal
      // environment (no device variable reaches it).
      {
        const before = await receipts();
        for (const profile of PROFILES) {
          const grant: SandboxPermissionGrant = {
            profile,
            filesystem: scoped([root]),
            network: { kind: "none" },
          };
          const probe = await exec(
            grant,
            [
              `cat ${quote(at(sibling, "secret"))}`,
              `printf pwn > ${quote(at(sibling, `profile-${profile}`))}`,
              ...fixture.protectedPaths.map((path) => `printf pwn >> ${quote(path)}`),
              connect(ungranted[0] ?? granted),
              `printf ok > ${quote(`in-root-${profile}`)}`,
              "true",
            ].join("; "),
          );
          assert.equal(probe.exitCode, 0, `${profile}: the probe must run: ${probe.stderr}`);
          assert(!probe.stdout.includes(secret), `${profile}: the sibling stays out of reach`);
          assert.equal(await fixture.inspect.readFile(at(sibling, `profile-${profile}`)), null);
          assert.equal(text(await fixture.inspect.readFile(at(root, `in-root-${profile}`))), "ok");
          await denied(
            (await native(grant)).readFile(at(sibling, "secret"), { maxBytes: 100, signal }),
            `${profile}: native sibling read`,
          );
        }
        for (const path of fixture.protectedPaths)
          assert(
            !text(await fixture.inspect.readFile(path))?.includes("pwn"),
            `protected ${path} under every profile`,
          );
        assert.deepEqual(
          await receipts(),
          before,
          "no profile reaches an endpoint on network none",
        );
        await siblingIntact("every profile leaves the sibling unchanged");
      }
    }

    // The minimal environment under every profile: no planted value and no name beyond the
    // minimal set; the planted values are real (an escalated call sees them).
    if (want("environment")) {
      for (const profile of PROFILES)
        await proveMinimalEnvironment(
          { profile, filesystem: scoped([root]), network: { kind: "none" } },
          true,
        );
      if (fixture.deviceEnvironment?.escalatedControl && support.outsideSandbox) {
        // the planted values are real: an escalated call (outside the sandbox) sees them, except
        // the device's own CAPYBARA_ variables
        const seen = await leakedVariables(escalated);
        const planted = Object.keys(fixture.deviceEnvironment.variables);
        assert.deepEqual(
          seen.sort(),
          planted.filter((name) => !/^CAPYBARA_/.test(name)).sort(),
          "an escalated call gets the device environment minus every CAPYBARA_ variable",
        );
      }
    }

    {
      if (whole("network")) {
        // Network: only the granted endpoint, and only while allowlisted.
        const base = await receipts();
        const namedReach = namedReachAvailable();
        const positives = !namedReach
          ? []
          : proxied
            ? [byName(granted), urlopen(granted)]
            : [
                connect(granted),
                `curl -fsS -m 10 -o /dev/null http://${granted.address}:${granted.port}/`,
                `node -e ${quote(`require("net").connect(${granted.port}, ${JSON.stringify(granted.address)}).on("connect", function () { this.end() })`)}`,
              ];
        for (const command of positives) {
          const result = await exec(restricted(allowlisted), command);
          assert.equal(
            result.exitCode,
            0,
            `granted endpoint must work: ${command}: ${result.stderr}`,
          );
        }
        for (const endpoint of ungranted) {
          // Raw connects to an ungranted address fail; through a proxy, so does a request by name.
          for (const command of proxied
            ? [connect(endpoint), byName(endpoint)]
            : [connect(endpoint)]) {
            const result = await exec(restricted(allowlisted), command);
            assert.notEqual(result.exitCode, 0, `ungranted ${endpoint.name}: ${command}`);
          }
        }
        if (proxied) {
          // allowlisted traffic goes through the proxy: a raw connect to the granted address bypasses
          // it and must be refused as well
          const raw = await exec(restricted(allowlisted), connect(granted));
          assert.notEqual(
            raw.exitCode,
            0,
            `a proxied provider must refuse a raw connect: ${granted.name}`,
          );
        }
        for (const command of [connect(granted), byName(granted)]) {
          const none = await exec(restricted(), command);
          assert.notEqual(
            none.exitCode,
            0,
            `network none must refuse even the granted endpoint: ${command}`,
          );
        }
        const after = await receipts();
        assert.equal(after[0], (base[0] ?? 0) + positives.length, "granted endpoint receipts");
        assert.deepEqual(
          after.slice(1),
          base.slice(1),
          "ungranted endpoints must see no connection",
        );
      }

      // An allowlist grant never reaches a closed address class, not even for a granted name.
      const closedGranted = closedGrantedTargets();
      if (want("closed-granted") && closedGranted.length > 0) {
        const before = await receipts();
        await proveTargets(
          restricted({
            kind: "allowlist",
            hosts: [granted.name, ...closedGranted.map((t) => t.host)],
          }),
          [],
          closedGranted,
          "allowlisted names resolving into a closed class",
        );
        assert.deepEqual(await receipts(), before, "no endpoint sees a closed-class grant");
      }

      if (want("loopback")) {
        // Restricted network none/allowlist may listen on loopback only.
        for (const network of [{ kind: "none" } as const, allowlisted]) {
          const binds = await exec(restricted(network), `python3 -c ${quote(BIND_PROGRAM)}`);
          assert.equal(
            binds.stdout.trim(),
            fixture.restrictedLoopbackListen === "refused"
              ? "127.0.0.1=denied ::1=denied 0.0.0.0=denied ::=denied unspec=denied"
              : "127.0.0.1=ok ::1=ok 0.0.0.0=denied ::=denied unspec=denied",
            `restricted ${network.kind} binds loopback only: ${binds.stderr}`,
          );
        }
        if (fixture.restrictedLoopbackListen !== "refused") {
          // No sandboxed client connects to a loopback listener, its own included (a listener cannot
          // be told from another process's at the address dialled), and no reuseport group is joined.
          for (const network of [{ kind: "none" } as const, allowlisted]) {
            const own = await exec(restricted(network), `python3 -c ${quote(OWN_LOOPBACK)}`);
            assert.equal(own.exitCode, 0, `the own-loopback probe must run: ${own.stderr}`);
            assert.deepEqual(
              JSON.parse(own.stdout),
              { "own 127.0.0.1": "denied", "own ::1": "denied", reuseport: "denied" },
              `restricted ${network.kind}: no loopback connect, no SO_REUSEPORT`,
            );
          }
          if (support.outsideSandbox) {
            // a client outside the sandbox (an escalated call) reaches the command's listener
            const portFile = at(root, "loopback-port");
            const service = exec(
              restricted(),
              `python3 -c ${quote(LOOPBACK_SERVICE)} ${quote(portFile)}`,
            );
            await waitFor(portFile, service);
            const port = Number(text(await fixture.inspect.readFile(portFile)));
            const client = await exec(
              escalated,
              `python3 -c ${quote(`import socket\ns = socket.create_connection(("127.0.0.1", ${port}), 10)\ns.sendall(b"from-outside")\ns.close()`)}`,
            );
            assert.equal(client.exitCode, 0, `the outside client must connect: ${client.stderr}`);
            const served = await service;
            assert.equal(
              served.stdout.trim(),
              "from-outside",
              `the listener serves it: ${served.stderr}`,
            );
          }
        }
      }

      if (want("open-network") && support.network.openPublic) await proveOpenNetwork([root]);

      // A UNIX socket another process made inside a write root (a user D-Bus, a rootless
      // docker.sock, ssh-agent or tmux in a granted directory) is code execution outside the
      // sandbox: no sandboxed command connects to it, under any sandbox network. An escalated call
      // stands in for that process; the same client there proves the probe is real.
      if (want("foreign-unix") && support.outsideSandbox) {
        const server = new AbortController();
        const outside = exec(
          escalated,
          `python3 -c ${quote(UNIX_SERVER)} foreign.sock foreign.count`,
          server.signal,
        );
        try {
          await waitFor(at(root, "foreign.count"), outside);
          const client = `python3 -c ${quote(FOREIGN_UNIX_CLIENT)} foreign.sock ${quote(at(root, "foreign.sock"))}`;
          for (const network of [{ kind: "none" } as const, allowlisted]) {
            const probe = await exec(restricted(network), client);
            const reached = probe.stdout
              .trim()
              .split(" ")
              .slice(1)
              .filter((entry) => entry.endsWith("=ok"));
            assert.equal(
              probe.stdout.trim().startsWith("foreign-unix-client stream=") && reached.length === 0,
              true,
              `restricted ${network.kind} must not connect to a socket another process made in the root: ${probe.stdout} ${probe.stderr}`,
            );
          }
          assert.equal(
            text(await fixture.inspect.readFile(at(root, "foreign.count"))),
            "0",
            "the foreign UNIX service in the root must see no sandboxed client",
          );
          const control = await exec(escalated, client);
          assert.match(
            control.stdout,
            /^foreign-unix-client stream=ok /,
            `the escalated control reaches the foreign UNIX service: ${control.stderr}`,
          );
        } finally {
          server.abort();
          await outside.catch(() => undefined);
        }
      }

      // Pathname UNIX sockets: a service outside the roots (run by an escalated call) is unreachable
      // under every sandbox network; one inside the root works.
      if (whole("network") && support.outsideSandbox) {
        const server = new AbortController();
        const outside = exec(
          escalated,
          `python3 -c ${quote(UNIX_SERVER)} ${quote(at(sibling, "srv.sock"))} ${quote(at(sibling, "srv.count"))}`,
          server.signal,
        );
        await waitFor(at(sibling, "srv.count"), outside);
        await fixture.seed([
          { path: at(root, "srv-link.sock"), kind: "symlink", target: at(sibling, "srv.sock") },
        ]);
        // The OS's own UNIX socket types, probed outside every restriction (unsupported types are
        // reported as such by an escalated call and expected the same in restricted operations)
        const types = await exec(
          escalated,
          `python3 -c ${quote(UNIX_CLIENT)} ${quote(at(sibling, "missing.sock"))} missing-link.sock`,
        );
        const kinds = types.stdout
          .trim()
          .split(" ")
          .map((entry) => entry.split("=") as [string, string]);
        for (const name of ["stream", "dgram", "link"])
          assert.notEqual(
            kinds.find(([kind]) => kind === name)?.[1],
            "unsupported",
            `UNIX ${name} sockets are required: ${types.stdout} ${types.stderr}`,
          );
        const expectWhen = (reachable: boolean) =>
          kinds
            .map(([kind, state]) =>
              state === "unsupported"
                ? `${kind}=unsupported`
                : `${kind}=${reachable ? "ok" : "denied"}`,
            )
            .join(" ");
        for (const network of [{ kind: "none" } as const, allowlisted]) {
          const probe = await exec(
            restricted(network),
            `python3 -c ${quote(UNIX_CLIENT)} ${quote(at(sibling, "srv.sock"))} srv-link.sock`,
          );
          assert.equal(
            // a type the OS lacks may also be refused before the OS says so: both reach nothing
            probe.stdout
              .trim()
              .split(" ")
              .map((entry) =>
                entry.endsWith("=denied") &&
                kinds.some(([kind, state]) => `${kind}=denied` === entry && state === "unsupported")
                  ? entry.replace("=denied", "=unsupported")
                  : entry,
              )
              .join(" "),
            expectWhen(false),
            `restricted ${network.kind} must not reach a UNIX service outside the roots: ${probe.stderr}`,
          );
          const inside = await exec(
            restricted(network),
            `python3 -c ${quote(UNIX_ROUNDTRIP)} ${quote(at(root, `own-${network.kind}.sock`))}`,
          );
          if (fixture.restrictedLoopbackListen === "refused")
            // no listener at all: binding a UNIX socket fails before any roundtrip
            assert.notEqual(inside.stdout.trim(), "roundtrip=ok", "no restricted UNIX listener");
          else
            assert.equal(
              inside.stdout.trim(),
              "roundtrip=ok",
              `in-root UNIX socket: ${inside.stderr}`,
            );
        }
        assert.equal(
          text(await fixture.inspect.readFile(at(sibling, "srv.count"))),
          "0",
          "the outside UNIX service must see no client",
        );
        // The same client in an escalated call reaches the service seven times: the probe is real.
        const control = await exec(
          escalated,
          `python3 -c ${quote(UNIX_CLIENT)} ${quote(at(sibling, "srv.sock"))} srv-link.sock`,
        );
        assert.equal(
          control.stdout.trim(),
          expectWhen(true),
          `escalated UNIX control: ${control.stderr}`,
        );
        const reached = String(kinds.filter(([, state]) => state !== "unsupported").length);
        await waitForFile(
          async (path) => {
            const data = await fixture.inspect.readFile(path);
            return text(data) === reached ? data : null;
          },
          at(sibling, "srv.count"),
          outside,
        );
        server.abort();
        await outside;
      }
    }

    if (!whole("processes")) return report();
    // Escalated-pair controls on the same device: outside the sandbox no restricted filter applies.
    if (support.outsideSandbox) {
      const before = await receipts();
      const control = await exec(
        escalated,
        `cat ${quote(at(sibling, "secret"))} && printf full > ${quote(at(sibling, "full"))} && ${connect(ungranted[0] ?? granted)}`,
      );
      assert.equal(control.exitCode, 0, `the escalated control must succeed: ${control.stderr}`);
      assert(control.stdout.includes(secret), "the escalated call reads the sibling");
      assert.equal(text(await fixture.inspect.readFile(at(sibling, "full"))), "full");
      assert.equal(
        (await receipts())[1],
        (before[1] ?? 0) + 1,
        "the escalated call reaches an ungranted endpoint",
      );
    }

    // Both overlap orders: a live escalated call never widens a restricted one, and vice versa.
    if (support.outsideSandbox) {
      const first = exec(
        restricted(),
        `printf r > ready-a; until [ -e barrier-a ]; do sleep 0.01; done; ` +
          `printf pwn > ${quote(at(sibling, "overlap-a"))}; cat ${quote(at(sibling, "secret"))}; true`,
      );
      await waitFor(at(root, "ready-a"), first);
      await exec(escalated, `printf full > ${quote(at(sibling, "full-a"))} && touch barrier-a`);
      assert(!(await first).stdout.includes(secret), "restricted after a live escalated call");
      assert.equal(await fixture.inspect.readFile(at(sibling, "overlap-a")), null);
      const fullFirst = exec(
        escalated,
        `printf r > ready-b; until [ -e barrier-b ]; do sleep 0.01; done; ` +
          `printf full > ${quote(at(sibling, "full-b"))}`,
      );
      await waitFor(at(root, "ready-b"), fullFirst);
      const second = await exec(
        restricted(),
        `printf pwn > ${quote(at(sibling, "overlap-b"))}; cat ${quote(at(sibling, "secret"))}; touch barrier-b`,
      );
      assert(!second.stdout.includes(secret), "restricted while an escalated call is live");
      assert.equal((await fullFirst).exitCode, 0);
      assert.equal(await fixture.inspect.readFile(at(sibling, "overlap-b")), null);
      assert.equal(text(await fixture.inspect.readFile(at(sibling, "full-b"))), "full");
    }

    // Component swaps during native and shell access never escape.
    if (support.outsideSandbox) {
      const race = at(root, "race");
      const swapper = exec(
        escalated,
        `python3 -c ${quote(SWAP_PROGRAM)} ${quote(race)} ${quote(sibling)} ${quote(at(root, "race-stop"))}`,
      );
      await waitFor(at(race, "swapping"), swapper);
      for (let index = 0; index < 30; index++) {
        const op = await native(restricted());
        try {
          await op.writeFile(at(race, `dir/n-${index}`), bytes, signal);
        } catch {}
        const read = await (await native(restricted()))
          .readFile(at(race, "dir/secret"), { maxBytes: 200, signal })
          .catch(() => null);
        assert.notEqual(read && text(read.data), secret, "native read escaped during a swap");
      }
      const shellRace = await exec(
        restricted(),
        `i=0; while [ $i -lt 400 ]; do printf pwn > race/dir/x-$i; cat race/dir/secret; ` +
          `chmod 777 race/dir/secret; i=$((i+1)); done 2>/dev/null; true`,
      );
      assert(!shellRace.stdout.includes(secret), "shell read escaped during a swap");
      await exec(escalated, "touch race-stop");
      assert.equal((await swapper).exitCode, 0);
      for (let index = 0; index < 400; index++) {
        assert.equal(await fixture.inspect.readFile(at(sibling, `x-${index}`)), null);
        if (index < 30)
          assert.equal(await fixture.inspect.readFile(at(sibling, `n-${index}`)), null);
      }
      await siblingIntact("component swaps must not reach the sibling");

      // A swap of the root path itself during a live operation, then a fresh operation.
      const moved = `${root}.moved-${randomUUID()}`;
      const live = exec(
        restricted(),
        `printf r > ready-root; until [ -e ${quote(at(moved, "barrier-root"))} ]; do sleep 0.01; done; ` +
          `printf pwn > ${quote(at(root, "after-swap"))}; cat ${quote(at(root, "secret"))}; printf ok > in-place; true`,
      );
      await waitFor(at(root, "ready-root"), live);
      await exec(
        escalated,
        `mv ${quote(root)} ${quote(moved)} && ln -s ${quote(sibling)} ${quote(root)} && touch ${quote(at(moved, "barrier-root"))}`,
      );
      const swapped = await live;
      assert(!swapped.stdout.includes(secret), "a live operation must not follow a root swap");
      // an inode-pinned runtime (Landlock) keeps writing in the moved root; a path-based one
      // (Seatbelt) refuses the moved path: either way nothing follows the swap
      assert(
        [null, "ok"].includes(text(await fixture.inspect.readFile(at(moved, "in-place")))),
        "a live operation writes in place or nowhere",
      );
      await denied(
        (async () => (await native(restricted())).writeFile(at(root, "fresh"), bytes, signal))(),
        "a fresh native operation must reject a swapped root",
      );
      const fresh = await (await fixture.operation(restricted()))
        .exec({
          command: "printf pwn > fresh-exec",
          cwd: root,
          timeoutMs: 30_000,
          maxOutputBytes: 1024,
          signal,
        })
        .catch((error: unknown) => error);
      assert(
        isSandboxScopeDeniedError(fresh) || (fresh as ExecResult).exitCode !== 0,
        "a fresh exec must not run in a swapped root",
      );
      await exec(escalated, `rm ${quote(root)} && mv ${quote(moved)} ${quote(root)}`);
      for (const name of ["after-swap", "fresh", "fresh-exec"]) {
        assert.equal(await fixture.inspect.readFile(at(sibling, name)), null, `root swap ${name}`);
      }
      await siblingIntact("root swaps must not reach the sibling");
    }

    // A mutable syscall pointer: another thread rewrites the address/path during the check.
    // Direct access flips between the granted and an ungranted address; proxied access between the
    // operation's proxy (from its environment) and an ungranted address.
    const target = ungranted.find((endpoint) => isIPv4(endpoint.address));
    if (target) {
      const before = await receipts();
      const good = proxied ? "proxy -" : `${granted.address} ${granted.port}`;
      const flip = await exec(
        restricted(allowlisted),
        `python3 -c ${quote(FLIP_PROGRAM)} connect 1500 ${good} ${target.address} ${target.port}`,
      );
      assert.equal(flip.exitCode, 0, `pointer race program must run: ${flip.stderr}`);
      const flipped = await receipts();
      assert.deepEqual(flipped.slice(1), before.slice(1), "a flipped sockaddr must not escape");
      assert.notEqual(flip.stdout.trim(), "ok=0", "the race must also reach the allowed target");
      if (!proxied) {
        assert((flipped[0] ?? 0) > (before[0] ?? 0), "the race must reach the granted endpoint");
      }
      const chmods = await exec(
        restricted(),
        `python3 -c ${quote(FLIP_PROGRAM)} chmod 3000 ${quote(at(root, "inroot.txt"))} ${quote(at(sibling, "secret"))}`,
      );
      assert.equal(chmods.exitCode, 0, `chmod race program must run: ${chmods.stderr}`);
      assert.notEqual(chmods.stdout.trim(), "ok=0", "in-root chmods must succeed");
      await siblingIntact("a flipped path must not chmod the sibling");
    }

    // The supervisor of a restricted command (its parent) is closed to a same-uid process outside
    // the operation: no ptrace attach, no mem or environ, while the command itself runs normally.
    if (fixture.inspect.outside) {
      const held = exec(
        restricted(),
        `echo $PPID > supervisor-pid; printf r > ready-held; ` +
          `until [ -e release-held ]; do sleep 0.01; done; printf ran > held.txt`,
      );
      await waitFor(at(root, "ready-held"), held);
      const supervisor = Number(text(await fixture.inspect.readFile(at(root, "supervisor-pid"))));
      let probed: string;
      try {
        probed = await fixture.inspect.outside(OUTSIDE_PROBE, [String(supervisor)]);
      } finally {
        await exec(restricted(), "touch release-held");
      }
      assert.equal((await held).exitCode, 0, "the supervised command runs normally");
      assert.equal(text(await fixture.inspect.readFile(at(root, "held.txt"))), "ran");
      const { uid, who, control, target } = JSON.parse(probed) as {
        uid: number;
        who: { uid: number; cmdline: string };
        control: Record<string, string>;
        target: Record<string, string>;
      };
      // Not vacuous: the target is a live process of the outsider's own uid.
      assert.equal(who?.uid, uid, `the supervisor must run as the outsider's uid: ${probed}`);
      assert.notEqual(who?.cmdline ?? "", "", `the supervisor must still be running: ${probed}`);
      assert.equal(control?.mem, "ALLOWED", `the probe must read a same-uid control: ${probed}`);
      assert.equal(
        control?.environ,
        "ALLOWED",
        `the probe must read a same-uid control: ${probed}`,
      );
      assert.deepEqual(
        target,
        { mem: "EACCES", environ: "EACCES", attach: "EPERM" },
        `a same-uid outsider must not ptrace or read the supervisor ${supervisor}: ${probed}`,
      );
    }

    await proveCancellation(restricted());

    // A fresh narrowed scope (after revocation) is enforced on the very next operation, while an
    // operation that started with the broader grant keeps it.
    await fixture.seed([{ path: at(root, "narrow/keep"), kind: "directory" }]);
    const narrowed = restricted({ kind: "none" }, [at(root, "narrow/keep")]);
    const broad = exec(
      restricted(),
      `printf r > ready-broad; until [ -e narrow/keep/release-broad ]; do sleep 0.01; done; ` +
        `printf broad > broad.txt`,
    );
    await waitFor(at(root, "ready-broad"), broad);
    const overlapping = await (await fixture.operation(narrowed)).exec({
      command: `printf pwn > ${quote(at(root, "overlapping.txt"))}; touch release-broad; true`,
      cwd: at(root, "narrow/keep"),
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      signal,
    });
    assert.equal(overlapping.exitCode, 0);
    assert.equal((await broad).exitCode, 0, "the broader live grant is retained");
    assert.equal(text(await fixture.inspect.readFile(at(root, "broad.txt"))), "broad");
    assert.equal(
      await fixture.inspect.readFile(at(root, "overlapping.txt")),
      null,
      "a concurrent narrower scope stays narrow",
    );
    const narrow = await (await fixture.operation(narrowed)).exec({
      command: `printf ok > keep.txt; printf pwn > ${quote(at(root, "revoked.txt"))}; true`,
      cwd: at(root, "narrow/keep"),
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      signal,
    });
    assert.equal(narrow.exitCode, 0);
    assert.equal(text(await fixture.inspect.readFile(at(root, "narrow/keep/keep.txt"))), "ok");
    assert.equal(await fixture.inspect.readFile(at(root, "revoked.txt")), null, "revoked root");
    await denied(
      (await native(narrowed)).writeFile(at(root, "revoked-native"), bytes, signal),
      "native write after narrowing",
    );
    return report();
  } finally {
    await fixture.dispose();
  }
}

/**
 * Polls a trusted read until `path` exists, racing the operation that should create it: if that
 * operation settles first (refused, failed or exited without the file), this throws at once with
 * the operation's error or exit, after one last read. The operation's rejection is always handled.
 */
export async function waitForFile(
  read: (path: string) => Promise<Uint8Array | null>,
  path: string,
  pending: Promise<unknown>,
): Promise<void> {
  let ended: { error: unknown } | { value: unknown } | undefined;
  pending.then(
    (value) => {
      ended = { value };
    },
    (error: unknown) => {
      ended = { error };
    },
  );
  for (;;) {
    if ((await read(path)) !== null) return;
    if (ended) {
      // The operation may have written the file just before it ended.
      if ((await read(path)) !== null) return;
      if ("error" in ended) {
        const reason = ended.error instanceof Error ? ended.error.message : String(ended.error);
        throw new Error(`operation ended before ${path} existed: ${reason}`, {
          cause: ended.error,
        });
      }
      const result = ended.value as Partial<ExecResult> | undefined;
      const detail =
        result && "exitCode" in result
          ? `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}: ${result.stderr ?? ""}`
          : "it returned";
      throw new Error(`operation ended before ${path} existed: ${detail}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}
