/**
 * The trusted Linux operation agent of capybara-device, run as `python3 -I -c <source>` (never from
 * a file another process could change). One agent process runs one operation; it never decides
 * authority: every request carries a grant the device already intersected with its owner ceiling.
 * The request also carries the SDK's `linux-sandbox.py` and `native-files.py` with their digests;
 * the agent seals each into a memfd, checks the digest of the sealed bytes, and runs them only from
 * those descriptors, so the checked bytes are the bytes that run.
 *
 * Transport: one JSON request line on stdin, then control lines (`{"op":"cancel","graceMs":n}`);
 * end of stdin means the device was lost and cancels at once. JSON event lines on stdout:
 * `launched` (the agent's pid and, for exec, the closed session it owns), `output` (stream 1 or 2,
 * base64, at most 64 KiB), `native`, `probe`, `reaped`, `refused`, `exit`.
 *
 * - restricted exec: pins every granted root once (no-follow, canonical), runs the SDK launcher on
 *   those descriptors (Landlock rules, the seccomp broker), and for an allowlist or the open
 *   network gives it exactly one endpoint, a loopback proxy owned by this operation: it tunnels
 *   only the allowlisted names, or (open) any name and address literal on any port, and dials only
 *   resolved addresses the SDK's address-class table calls public (a copy kept equal by a test),
 *   never this host's own. The command's own loopback listeners are the launcher's broker's
 *   business. Whatever ends the launcher, the agent then reaps its closed session (exact SID plus
 *   start time). Write denies the device resolved for this operation (protected home locations
 *   reached through links) go to the launcher and to native work.
 * - Full exec: no restricted filters; the command runs as the OS user in a session of its own, and
 *   the agent ends that session (exact SID plus start time) when it exits, is cancelled or times out.
 * - native: the SDK native helper on pinned descriptors (descriptor-relative, no-follow), in this
 *   process; a missing write root is established component by component without following links.
 * - probe / reap: the launcher's own probe, and reaping a recorded session after a lost supervisor.
 *
 * Signals go to a session member through a pidfd; where pidfds are unavailable (an old kernel or a
 * seccomp profile) the member's session and start time are checked again right before kill().
 */
export const LINUX_DEVICE_AGENT: string = String.raw`import ctypes
import sys

SELF_PROTECTION = None
if sys.platform.startswith("linux"):
    # Non-dumpable first: a same-uid process cannot ptrace this agent or read its descriptors.
    if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:
        SELF_PROTECTION = "The operation agent could not make itself non-dumpable"
    else:
        try:
            with open("/proc/self/status") as handle:
                for line in handle:
                    if line.startswith("TracerPid:") and int(line.split()[1]) != 0:
                        SELF_PROTECTION = "The operation agent was traced"
        except (OSError, ValueError):
            SELF_PROTECTION = "The operation agent could not confirm that it is not traced"

import base64
import errno
import fcntl
import hashlib
import hmac
import importlib.machinery
import importlib.util
import ipaddress
import json
import os
import select
import signal
import socket
import stat
import subprocess
import threading
import time

CHUNK = 65536
RUNTIME_FILES = ("linux-sandbox.py", "native-files.py")
NR_PIDFD_OPEN = 434
NR_PIDFD_SEND_SIGNAL = 424
PROXY_KEYS = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy",
              "NO_PROXY", "no_proxy")
LAUNCHER_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
# The SDK launcher's own default read-only system roots (linux-sandbox.py DEFAULT_SYSTEM_ROOTS,
# kept equal by a test); a request's single read files are appended to them.
LAUNCHER_SYSTEM_ROOTS = ("/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc")
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
out_lock = threading.Lock()


class Refused(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def send(event):
    data = (json.dumps(event) + "\n").encode()
    with out_lock:
        view = memoryview(data)
        while view:
            view = view[os.write(1, view):]


def sealed_runtime(request):
    """The SDK runtime files sealed into memfds (no write, grow, shrink or further seals), each
    checked against the digest the device verified. Returns {name: descriptor}."""
    fds = {}
    try:
        for name in RUNTIME_FILES:
            source = request["runtime"][name].encode()
            fd = os.memfd_create(name, os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
            fds[name] = fd
            view = memoryview(source)
            while view:
                view = view[os.write(fd, view):]
            fcntl.fcntl(fd, fcntl.F_ADD_SEALS, fcntl.F_SEAL_SEAL | fcntl.F_SEAL_SHRINK
                        | fcntl.F_SEAL_GROW | fcntl.F_SEAL_WRITE)
            if hashlib.sha256(os.pread(fd, len(source) + 1, 0)).hexdigest() != \
                    request["expect"].get(name):
                raise Refused("UNAVAILABLE", "The runtime does not match its digest")
    except Refused:
        close_fds(fds.values())
        raise
    except (OSError, AttributeError, KeyError, TypeError):
        close_fds(fds.values())
        raise Refused("UNAVAILABLE", "The runtime could not be sealed for launch")
    return fds


def close_fds(fds):
    for fd in list(fds):
        try:
            os.close(fd)
        except OSError:
            pass


def load_sealed(fd, name):
    path = "/proc/self/fd/%d" % fd
    spec = importlib.util.spec_from_loader(name, importlib.machinery.SourceFileLoader(name, path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---- sessions -----------------------------------------------------------------------------

def stat_fields(pid):
    with open("/proc/%d/stat" % pid) as handle:
        data = handle.read()
    return data[data.rindex(")") + 2:].split()


def start_time(pid):
    return int(stat_fields(pid)[19])


def signal_member(pid, sid, started, signum, leader_reused):
    """Signals one session member, pinned by a pidfd where the kernel offers one; otherwise its
    session and start time are checked again immediately before kill()."""
    handle = libc.syscall(ctypes.c_long(NR_PIDFD_OPEN), ctypes.c_long(pid), ctypes.c_long(0))
    try:
        fields = stat_fields(pid)
        if int(fields[3]) != sid or int(fields[19]) < started or fields[0] in ("Z", "X") \
                or leader_reused():
            return False
        if handle >= 0:
            return libc.syscall(ctypes.c_long(NR_PIDFD_SEND_SIGNAL), ctypes.c_long(handle),
                                ctypes.c_long(signum), None, ctypes.c_long(0)) == 0
        os.kill(pid, signum)
        return True
    except OSError:
        return False
    finally:
        if handle >= 0:
            os.close(handle)


def signal_session(session, signum):
    """Signals every live member of a recorded closed session.

    A member is signalled only while it is still in the session, started no earlier than the
    leader, and the leader's PID is not held by another process; a PID reuse can only skip one."""
    sid, started = int(session["sid"]), int(session["start"])

    def leader_reused():
        try:
            return start_time(sid) != started
        except OSError:
            return False
    if leader_reused():
        return 0
    count = 0
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        try:
            fields = stat_fields(pid)
        except OSError:
            continue
        if int(fields[3]) != sid or fields[0] in ("Z", "X"):
            continue
        if signal_member(pid, sid, started, signum, leader_reused):
            count += 1
    return count


def kill_session(session):
    """SIGKILLs a closed session until no live member is left."""
    for _ in range(10000):
        if signal_session(session, signal.SIGKILL) == 0:
            return
        time.sleep(0.005)
    raise Refused("UNAVAILABLE", "The owned session could not be ended")


# ---- pinned roots -------------------------------------------------------------------------

def close_pinned(pinned):
    for entry in pinned:
        try:
            os.close(entry["fd"])
        except OSError:
            pass


def canonical_fd(fd, path):
    try:
        return os.readlink("/proc/self/fd/%d" % fd) == path
    except OSError:
        return False


def pin(path):
    """Opens an existing granted root once (no-follow, canonical); None when it does not exist."""
    if not isinstance(path, str) or not path.startswith("/") or os.path.normpath(path) != path:
        raise Refused("SCOPE_DENIED", "Supply canonical absolute roots")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    except OSError:
        raise Refused("SCOPE_DENIED", "A granted root is not a directory at its path")
    info = os.fstat(fd)
    if not canonical_fd(fd, path):
        os.close(fd)
        raise Refused("SCOPE_DENIED", "A granted root is not canonical (it contains a link)")
    return {"path": path, "fd": fd, "dev": info.st_dev, "ino": info.st_ino}


def establish(path):
    """Creates a missing write root below its nearest existing canonical ancestor, never
    following a link, and pins it."""
    missing = []
    anchor = path
    while True:
        try:
            os.lstat(anchor)
            break
        except FileNotFoundError:
            if anchor == "/":
                raise Refused("SCOPE_DENIED", "No existing ancestor of the write root")
            missing.insert(0, os.path.basename(anchor))
            anchor = os.path.dirname(anchor)
    entry = pin(anchor)
    if entry is None:
        raise Refused("SCOPE_DENIED", "The write root's ancestor changed")
    fd = entry["fd"]
    try:
        for name in missing:
            try:
                os.mkdir(name, 0o755, dir_fd=fd)
            except FileExistsError:
                pass
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=fd)
            os.close(fd)
            fd = child
    except OSError:
        os.close(fd)
        raise Refused("SCOPE_DENIED", "A write root component is not a directory")
    info = os.fstat(fd)
    if not canonical_fd(fd, path):
        os.close(fd)
        raise Refused("SCOPE_DENIED", "A write root changed while it was established")
    return {"path": path, "fd": fd, "dev": info.st_dev, "ino": info.st_ino}


def read_files(request):
    """The request's single read-only files (a global version pin): each canonical, absolute and,
    opened without following a link, a regular file at exactly its path. A missing one grants
    nothing; anything else is refused."""
    files = request.get("readFiles", [])
    if not isinstance(files, list):
        raise Refused("INVALID_REQUEST", "Supply read files as a list")
    out = []
    for path in files:
        if not isinstance(path, str) or not path.startswith("/") or os.path.normpath(path) != path:
            raise Refused("SCOPE_DENIED", "Supply canonical absolute read files")
        try:
            fd = os.open(path, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
        except FileNotFoundError:
            continue
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode) or not canonical_fd(fd, path):
                raise Refused("SCOPE_DENIED", "A read file is not a regular file at its path")
        finally:
            os.close(fd)
        out.append(path)
    return out


def within(root, path):
    return root == "/" or path == root or path.startswith(root + "/")


def pin_roots(request, create_for=None):
    """Pins the request's roots. Returns (read, write, missing): roots that do not exist grant
    nothing; a write root covering create_for (a native write target) is established first."""
    write, read, missing = [], [], []
    try:
        for path in request["writeRoots"]:
            entry = pin(path)
            if entry is None and create_for is not None and within(path, create_for):
                entry = establish(path)
            if entry is None:
                missing.append(path)
            else:
                write.append(entry)
        for path in request["readRoots"]:
            if path in request["writeRoots"]:
                continue
            entry = pin(path)
            if entry is None:
                missing.append(path)
            else:
                read.append(entry)
    except BaseException:
        close_pinned(read + write)
        raise
    return read, write, missing


# ---- address classes (a copy of the SDK's network-classes.ts) ------------------------------
# ADDRESS_CLASS_RANGES is the SDK's table, copied exactly, and classify_address its lookup: an
# address has the class of the first (most specific) range containing it; an embedded range
# classifies the IPv4 address at its bit offset. A device test (linux-agent-network.test.ts)
# compares this copy with the SDK's table and this lookup with classifyAddress, so the classes
# cannot drift between the SDK, the macOS worker, the cloud proxies and this forwarder.
ADDRESS_CLASS_RANGES = json.loads(r'''
[
    {"family":"ipv4","cidr":"100.100.100.200/32","class":"metadata"},
    {"family":"ipv4","cidr":"168.63.129.16/32","class":"metadata"},
    {"family":"ipv4","cidr":"169.254.169.254/32","class":"metadata"},
    {"family":"ipv4","cidr":"255.255.255.255/32","class":"broadcast"},
    {"family":"ipv4","cidr":"192.0.0.0/24","class":"reserved"},
    {"family":"ipv4","cidr":"192.0.2.0/24","class":"reserved"},
    {"family":"ipv4","cidr":"192.88.99.0/24","class":"reserved"},
    {"family":"ipv4","cidr":"198.51.100.0/24","class":"reserved"},
    {"family":"ipv4","cidr":"203.0.113.0/24","class":"reserved"},
    {"family":"ipv4","cidr":"169.254.0.0/16","class":"link-local"},
    {"family":"ipv4","cidr":"192.168.0.0/16","class":"private"},
    {"family":"ipv4","cidr":"198.18.0.0/15","class":"reserved"},
    {"family":"ipv4","cidr":"172.16.0.0/12","class":"private"},
    {"family":"ipv4","cidr":"100.64.0.0/10","class":"cgnat"},
    {"family":"ipv4","cidr":"0.0.0.0/8","class":"unspecified"},
    {"family":"ipv4","cidr":"10.0.0.0/8","class":"private"},
    {"family":"ipv4","cidr":"127.0.0.0/8","class":"loopback"},
    {"family":"ipv4","cidr":"224.0.0.0/4","class":"multicast"},
    {"family":"ipv4","cidr":"240.0.0.0/4","class":"reserved"},
    {"family":"ipv4","cidr":"0.0.0.0/0","class":"public"},
    {"family":"ipv6","cidr":"::/128","class":"unspecified"},
    {"family":"ipv6","cidr":"::1/128","class":"loopback"},
    {"family":"ipv6","cidr":"fd00:ec2::254/128","class":"metadata"},
    {"family":"ipv6","cidr":"::ffff:0:0/96","embeddedIpv4At":96},
    {"family":"ipv6","cidr":"::ffff:0:0:0/96","embeddedIpv4At":96},
    {"family":"ipv6","cidr":"64:ff9b::/96","class":"nat64"},
    {"family":"ipv6","cidr":"::/96","embeddedIpv4At":96},
    {"family":"ipv6","cidr":"100::/64","class":"reserved"},
    {"family":"ipv6","cidr":"64:ff9b:1::/48","class":"nat64"},
    {"family":"ipv6","cidr":"2001:db8::/32","class":"reserved"},
    {"family":"ipv6","cidr":"2001::/23","class":"reserved"},
    {"family":"ipv6","cidr":"3fff::/20","class":"reserved"},
    {"family":"ipv6","cidr":"2002::/16","embeddedIpv4At":16},
    {"family":"ipv6","cidr":"fe80::/10","class":"link-local"},
    {"family":"ipv6","cidr":"fec0::/10","class":"reserved"},
    {"family":"ipv6","cidr":"ff00::/8","class":"multicast"},
    {"family":"ipv6","cidr":"fc00::/7","class":"ula"},
    {"family":"ipv6","cidr":"2000::/3","class":"public"},
    {"family":"ipv6","cidr":"::/0","class":"reserved"}
]
''')
_CLASS_RANGES = [(ipaddress.ip_network(r["cidr"]), r.get("class"), r.get("embeddedIpv4At"))
                 for r in ADDRESS_CLASS_RANGES]


def classify_address(address):
    """The class of an IPv4 or IPv6 address (a string, optionally with a zone, or an address)."""
    if isinstance(address, str):
        address = ipaddress.ip_address(address.split("%")[0])
    for network, cls, at in _CLASS_RANGES:
        if network.version != address.version or address not in network:
            continue
        if cls is not None:
            return cls
        return classify_address(ipaddress.IPv4Address((int(address) >> (96 - at)) & 0xFFFFFFFF))
    raise ValueError("The address-class table is not total")
# ---- end of address classes ----------------------------------------------------------------


def local_address(address):
    """Whether address is one of this host's own (a socket can bind to it). Any answer but "not
    available" counts as own, so a host that allows binding any address (ip_nonlocal_bind) closes
    every address instead of opening its own."""
    probe = socket.socket(socket.AF_INET6 if ":" in address else socket.AF_INET,
                          socket.SOCK_STREAM)
    try:
        probe.bind((address, 0))
        return True
    except OSError as error:
        return error.errno != errno.EADDRNOTAVAIL
    finally:
        probe.close()


def public_address(address):
    """Whether the forwarder may dial a resolved address: the class table calls it public,
    Python's own registry calls it global too (a stricter second opinion: Python versions differ
    at the edges, which can only refuse more), and it is not this host's own."""
    ip = ipaddress.ip_address(address.split("%")[0])
    if classify_address(ip) != "public":
        return False
    plain = ip.ipv4_mapped if ip.version == 6 and ip.ipv4_mapped else ip
    return plain.is_global and not local_address(str(ip))


# ---- per-operation proxy (allowlist or open) ----------------------------------------------

def host_allowed(host, hosts):
    host = host.lower().rstrip(".")
    for entry in hosts:
        if entry.startswith("*."):
            if host.endswith(entry[1:]) and host != entry[2:]:
                return True
        elif host == entry:
            return True
    return False


def split_target(target, default_port, literals=False):
    """(host, port) of a request target; an IPv6 literal in brackets only when literals is set
    (allowlist hosts are names, never address literals)."""
    if target.startswith("["):
        end = target.find("]")
        if not literals or end < 0 or (len(target) > end + 1 and target[end + 1] != ":"):
            return None, None
        host, port = target[1:end], target[end + 2:]
        try:
            if ipaddress.ip_address(host).version != 6:
                return None, None
        except ValueError:
            return None, None
    else:
        host, _, port = target.partition(":")
    try:
        number = int(port) if port else default_port
    except ValueError:
        return None, None
    if not host or not 0 < number < 65536:
        return None, None
    return host, number


class Forwarder:
    """A loopback HTTP proxy owned by one operation. Allowlist: CONNECT and absolute http://
    requests for the operation's allowlisted names are tunnelled, CONNECT to ports 80 and 443 and
    plain requests to port 80 only (allowlist entries name no port); every other name is refused
    without connecting. Open (the open public network): any name or address literal, on any
    port. Either way a connection is made only to a resolved address public_address allows,
    checked on the address dialled, which is never resolved again (so never rebound); when every
    address is refused the answer is 403, before any connect. The launcher's broker grants the
    restricted command this endpoint (and its own loopback listeners) and nothing else. Clients
    authenticate with the operation's token. A test fixture's seam (allow_private) lifts the
    address and port rules."""

    def __init__(self, hosts, allow_private=False, open_network=False):
        self.hosts = hosts
        self.allow_private = allow_private
        self.open = open_network
        # Only this operation knows the token: another local process cannot use the proxy.
        self.token = os.urandom(16).hex()
        self.authorization = "Basic " + base64.b64encode(
            ("capybara:" + self.token).encode()).decode()
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(64)
        self.port = self.server.getsockname()[1]
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self.handle, args=(client,), daemon=True).start()

    @staticmethod
    def splice(a, b):
        def pump(src, dst):
            try:
                while True:
                    data = src.recv(CHUNK)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            for sock in (src, dst):
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        threading.Thread(target=pump, args=(b, a), daemon=True).start()
        pump(a, b)

    def handle(self, client):
        try:
            client.settimeout(30)
            head = b""
            while b"\r\n\r\n" not in head:
                data = client.recv(4096)
                if not data or len(head) > 16384:
                    client.close()
                    return
                head += data
            head, _, body = head.partition(b"\r\n\r\n")
            lines = head.split(b"\r\n")
            method, target, version = (lines[0].decode("latin-1").split(" ") + ["", "", ""])[:3]
            supplied = ""
            for line in lines[1:]:
                key, _, value = line.decode("latin-1").partition(":")
                if key.strip().lower() == "proxy-authorization":
                    supplied = value.strip()
            if not hmac.compare_digest(supplied, self.authorization):
                client.sendall(b"HTTP/1.1 407 Proxy Authentication Required\r\n"
                               b"Proxy-Authenticate: Basic realm=\"capybara\"\r\n"
                               b"Content-Length: 0\r\nConnection: close\r\n\r\n")
                client.close()
                return
            rewritten = None
            any_port = self.open or self.allow_private
            if method == "CONNECT":
                host, port = split_target(target, 443, self.open)
                # allowlist entries name no port: web ports only (any port when open, or for a
                # test fixture)
                if port not in (80, 443) and not any_port:
                    host = None
            elif target.startswith("http://"):
                authority, _, path = target[7:].partition("/")
                host, port = split_target(authority, 80, self.open)
                if port != 80 and not any_port:
                    host = None
                headers = [line for line in lines[1:]
                           if not line.lower().startswith((b"proxy-", b"connection:"))]
                rewritten = ("%s /%s %s\r\n" % (method, path, version)).encode() + b"\r\n".join(
                    headers + [b"Connection: close"]) + b"\r\n\r\n"
            else:
                host, port = None, None
            if host is None or not (self.open or host_allowed(host, self.hosts)):
                client.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n"
                               b"Connection: close\r\n\r\n")
                client.close()
                return
            try:
                up = self.connect(host, port)
            except PermissionError:
                # every address of the name is closed: refused before any connect
                client.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n"
                               b"Connection: close\r\n\r\n")
                client.close()
                return
            except OSError:
                client.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n"
                               b"Connection: close\r\n\r\n")
                client.close()
                return
            up.settimeout(None)
            client.settimeout(None)
            if rewritten is None:
                client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                if body:
                    up.sendall(body)
            else:
                up.sendall(rewritten + body)
            self.splice(client, up)
        except OSError:
            try:
                client.close()
            except OSError:
                pass

    def connect(self, host, port):
        """Connects to a vetted address of host (never resolved again, so never rebound). Raises
        PermissionError when public_address refuses every address (none is dialled)."""
        candidates = [c for c in socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
                      if self.allow_private or public_address(c[4][0])]
        if not candidates:
            raise PermissionError(errno.EACCES, "No permitted address")
        for family, kind, proto, _, address in candidates:
            sock = socket.socket(family, kind, proto)
            try:
                sock.settimeout(30)
                sock.connect(address)
                return sock
            except OSError:
                sock.close()
        raise OSError(errno.EHOSTUNREACH, "No permitted address")

    def close(self):
        try:
            self.server.close()
        except OSError:
            pass


# ---- execution ----------------------------------------------------------------------------

class Control:
    """Reads control lines; end of input (the device was lost) cancels at once."""

    def __init__(self):
        self.cancel = None
        self.event = threading.Event()
        self.handlers = []
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in sys.stdin:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message.get("op") == "cancel":
                grace = message.get("graceMs", 0)
                self.fire(grace if type(grace) is int and 0 <= grace <= 3600000 else 0)
        self.fire(0)

    def fire(self, grace):
        if self.cancel is not None and (grace != 0 or self.cancel == 0):
            return
        self.cancel = grace
        self.event.set()
        for handler in list(self.handlers):
            handler(grace)


def copy(stream, number):
    try:
        while True:
            data = os.read(stream, CHUNK)
            if not data:
                return
            send({"event": "output", "stream": number,
                  "data": base64.b64encode(data).decode("ascii")})
    except OSError:
        return


def start_copies(*streams):
    threads = []
    for number, fd in streams:
        thread = threading.Thread(target=copy, args=(fd, number), daemon=True)
        thread.start()
        threads.append(thread)
    return threads


def join_copies(threads, fds, grace_s):
    deadline = time.monotonic() + grace_s
    for thread in threads:
        thread.join(max(0, deadline - time.monotonic()))
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            pass


def validated_env(env):
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str)
                                            for k, v in env.items()):
        raise Refused("INVALID_REQUEST", "Supply string environment variables")
    return env


def run_full(request, control):
    """Full access: the OS user's ordinary authority, no restricted filters, in a session of its
    own that the agent ends when the command exits, is cancelled or times out."""
    env = validated_env(request["env"])
    if control.cancel is not None:
        raise Refused("CANCELLED", "Cancelled before launch")
    try:
        # the child is a session leader before Popen returns (setsid runs before exec)
        process = subprocess.Popen(["/bin/bash", "-c", request["command"]], cwd=request["cwd"],
                                   env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
    except OSError as error:
        send({"event": "output", "stream": 2, "data": base64.b64encode(
            ("capybara-device: Full launch failed: %s\n" % error.strerror).encode()).decode()})
        send({"event": "exit", "exitCode": 127, "timedOut": False, "cancelled": False})
        return
    pid = process.pid
    session = {"sid": pid, "start": start_time(pid)}
    send({"event": "launched", "pid": os.getpid(), "session": session})
    threads = start_copies((1, process.stdout.fileno()), (2, process.stderr.fileno()))
    state = {"timedOut": False, "cancelled": False}

    def cancel(grace):
        state["cancelled"] = True
        if grace > 0:
            signal_session(session, signal.SIGTERM)
            timer = threading.Timer(grace / 1000, lambda: kill_session(session))
            timer.daemon = True
            timer.start()
        else:
            kill_session(session)
    control.handlers.append(cancel)
    if control.cancel is not None:
        cancel(control.cancel)
    try:
        code = process.wait(request["timeoutMs"] / 1000)
    except subprocess.TimeoutExpired:
        state["timedOut"] = True
        kill_session(session)
        code = process.wait()
    # The leader exited: whatever it left in its session ends with it.
    kill_session(session)
    join_copies(threads, [], 0.2)
    killed = state["timedOut"] or state["cancelled"]
    send({"event": "exit", "exitCode": None if killed or code < 0 else code,
          "timedOut": state["timedOut"], "cancelled": state["cancelled"]})


PRCTL = libc.prctl  # resolved before any fork


def pdeathsig():
    # The launcher cancels (ending its whole tree) when this agent is lost. Runs between fork and
    # exec: one prepared foreign call, no allocation, no lock.
    PRCTL(1, 15, 0, 0, 0)  # PR_SET_PDEATHSIG, SIGTERM


def run_restricted(request, control):
    runtime = sealed_runtime(request)
    try:
        return run_sealed(request, control, runtime)
    finally:
        close_fds(runtime.values())


def write_denies(request):
    """The write denies the device resolved for this operation: absolute, normalized paths."""
    paths = request.get("writeDenies", [])
    if not isinstance(paths, list) or not all(
            isinstance(p, str) and p.startswith("/") and os.path.normpath(p) == p for p in paths):
        raise Refused("INVALID_REQUEST", "Supply absolute normalized write denies")
    return list(paths)


def run_sealed(request, control, runtime):
    env = dict(validated_env(request["env"]))
    for key in PROXY_KEYS:
        env.pop(key, None)
    denies = write_denies(request)
    read, write, _ = pin_roots(request)
    forwarder = None
    try:
        if not write:
            raise Refused("SCOPE_DENIED", "Restricted execution needs an existing writable root")
        network = request["network"]
        kind = network.get("kind")
        if kind != "open" and (kind != "allowlist" or not network.get("hosts")):
            launcher_network = {"kind": "none"}
        else:
            forwarder = Forwarder(list(network["hosts"]) if kind == "allowlist" else [],
                                  request.get("allowPrivate") is True, kind == "open")
            proxy = "http://capybara:%s@127.0.0.1:%d" % (forwarder.token, forwarder.port)
            for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY",
                        "all_proxy"):
                env[key] = proxy
            env["NO_PROXY"] = env["no_proxy"] = "localhost,127.0.0.1,::1"
            launcher_network = {"kind": "endpoints",
                                "endpoints": [{"address": "127.0.0.1", "port": forwarder.port}]}
        report_r, report_w = os.pipe()
        files = read_files(request)
        body = {"mode": "exec", "roots": {"read": read, "write": write},
                "network": launcher_network, "reportFd": report_w, "env": env,
                "cwd": request["cwd"], "argv": ["/bin/bash", "-c", request["command"]],
                "timeoutMs": request["timeoutMs"], "nativeFd": runtime["native-files.py"],
                "writeDenies": denies}
        if files:
            body["systemRoots"] = list(LAUNCHER_SYSTEM_ROOTS) + files
        if control.cancel is not None:
            os.close(report_r)
            os.close(report_w)
            raise Refused("CANCELLED", "Cancelled before launch")
        try:
            launcher = subprocess.Popen(
                [sys.executable, "-I", "/proc/self/fd/%d" % runtime["linux-sandbox.py"]],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                pass_fds=[report_w, runtime["linux-sandbox.py"], runtime["native-files.py"]]
                + [e["fd"] for e in read + write],
                env=LAUNCHER_ENV, preexec_fn=pdeathsig)
        finally:
            os.close(report_w)
            close_pinned(read + write)
            read, write = [], []
        return supervise(launcher, report_r, body, request, control)
    finally:
        close_pinned(read + write)
        if forwarder is not None:
            forwarder.close()


def supervise(launcher, report_r, body, request, control):
    state = {"session": None, "cancelled": False, "exit": None, "refused": None}
    lock = threading.Lock()

    def stop_launcher():
        try:
            launcher.send_signal(signal.SIGTERM)
        except OSError:
            pass

    def cancel(grace):
        with lock:
            state["cancelled"] = True
            session = state["session"]
        if grace > 0 and session is not None:
            # Graceful: the command's session sees SIGTERM first; the launcher then ends the tree.
            signal_session(session, signal.SIGTERM)
            timer = threading.Timer(grace / 1000, stop_launcher)
            timer.daemon = True
            timer.start()
        else:
            stop_launcher()
    control.handlers.append(cancel)
    try:
        launcher.stdin.write(json.dumps(body).encode())
        launcher.stdin.close()
    except OSError:
        pass
    threads = start_copies((1, launcher.stdout.fileno()), (2, launcher.stderr.fileno()))

    def read_events():
        with os.fdopen(report_r, "rb") as stream:
            for line in stream:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                kind = event.get("event")
                if kind == "session":
                    with lock:
                        state["session"] = {"sid": event["sid"], "start": event["start"]}
                    send({"event": "launched", "pid": os.getpid(), "session": state["session"]})
                elif kind == "exit":
                    state["exit"] = event
                elif kind == "refused":
                    state["refused"] = event
    reader = threading.Thread(target=read_events, daemon=True)
    reader.start()
    if control.cancel is not None:
        cancel(control.cancel)
    # The launcher enforces timeoutMs itself; this is the hard stop if it does not.
    try:
        launcher.wait(timeout=request["timeoutMs"] / 1000 + 10)
    except subprocess.TimeoutExpired:
        stop_launcher()
        try:
            launcher.wait(timeout=10)
        except subprocess.TimeoutExpired:
            launcher.kill()
            launcher.wait()
    reader.join()
    session = state["session"]
    if session is not None:
        # Whatever happened to the launcher, nothing it owned outlives it.
        kill_session(session)
    join_copies(threads, [], 2)
    if state["refused"] is not None and state["session"] is None:
        raise Refused(state["refused"].get("code", "INVALID_REQUEST"),
                      state["refused"].get("message", "Restricted launch refused"))
    exit_event = state["exit"]
    if exit_event is None:
        send({"event": "exit", "exitCode": None, "timedOut": False,
              "cancelled": state["cancelled"], "supervisorLost": not state["cancelled"]})
        return
    stopped = exit_event.get("exitCode") is None or exit_event.get("cancelled")
    send({"event": "exit", "exitCode": None if stopped or state["cancelled"] else exit_event["exitCode"],
          "timedOut": bool(exit_event.get("timedOut")), "cancelled": state["cancelled"]})


# ---- native -------------------------------------------------------------------------------

def run_native(request):
    runtime = sealed_runtime(request)
    try:
        native = load_sealed(runtime["native-files.py"], "capybara_native_files")
    finally:
        close_fds(runtime.values())
    body = request["native"]
    pinned = []
    try:
        if request["full"]:
            fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            pinned.append({"fd": fd})
            roots = {"read": [], "write": [{"path": "/", "fd": fd}]}
        else:
            target = os.path.normpath(body["path"]) if isinstance(body.get("path"), str) else None
            create = target if body.get("method") == "writeFile" else None
            read, write, missing = pin_roots(request, create)
            pinned = read + write
            covered = [e for e in pinned if target is not None and within(e["path"], target)]
            if not covered and target is not None and any(within(m, target) for m in missing):
                # The permitted root does not exist yet, so neither does anything below it.
                send({"event": "native", "response": {"result": [] if body["method"] == "scan" else None}})
                return
            # restricted native writes honour the mandatory write denies (as the broker does) and
            # the operation's resolved ones (this agent serves one operation)
            folded = [native._fold_parts(p) for p in write_denies(request)]
            native.SYSTEM_WRITE_DENIES.extend(folded)
            native.PREFIX_GUARDED.extend((names, True) for names in folded)
            roots = {"read": [{"path": e["path"], "fd": e["fd"]} for e in read],
                     "write": [{"path": e["path"], "fd": e["fd"]} for e in write],
                     "denyWrites": True}
        denied = [d for d in request.get("denied", []) if isinstance(d, str)]

        class Bounded(native.NativeFiles):
            """Refuses every path, and every link target, inside a root the owner denies."""

            def resolve(self, path, write, create, links, must_exist):
                if any(within(d, os.path.normpath(path)) for d in denied):
                    raise native.ScopeDenied("Native path is denied by the owner")
                result = super().resolve(path, write, create, links, must_exist)
                if any(within(d, result[2]) for d in denied):
                    os.close(result[0])
                    raise native.ScopeDenied("Native path is denied by the owner")
                return result
        send({"event": "launched", "pid": os.getpid()})
        try:
            response = {"result": (native.NativeFiles if request["full"] else Bounded)(roots).run(body)}
        except Exception as error:
            code = ("SCOPE_DENIED" if isinstance(error, native.ScopeDenied)
                    else errno.errorcode.get(getattr(error, "errno", None), "INVALID_NATIVE_REQUEST"))
            response = {"error": {"code": code, "message": "Native operation failed; check the path, scope and filesystem access"}}
        send({"event": "native", "response": response})
    finally:
        close_pinned(pinned)


def native_watch():
    """Native work has no command tree: a cancel or a lost device ends the agent itself."""
    for line in sys.stdin:
        try:
            if json.loads(line).get("op") == "cancel":
                break
        except ValueError:
            continue
    os._exit(130)


def main():
    try:
        # first: the agent's exact identity, so a lost client's agent can be ended precisely
        send({"event": "agent", "pid": os.getpid(), "start": start_time(os.getpid())})
        line = sys.stdin.readline()
        request = json.loads(line)
        op = request.get("op")
        if sys.version_info < (3, 9):
            raise Refused("UNAVAILABLE", "The operation agent needs Python 3.9 or later")
        if SELF_PROTECTION:
            raise Refused("UNAVAILABLE", SELF_PROTECTION)
        if op == "probe":
            runtime = sealed_runtime(request)
            try:
                fd = runtime["linux-sandbox.py"]
                done = subprocess.run([sys.executable, "-I", "/proc/self/fd/%d" % fd, "probe"],
                                      capture_output=True, env=LAUNCHER_ENV, pass_fds=[fd])
            finally:
                close_fds(runtime.values())
            try:
                result = json.loads(done.stdout)
            except ValueError:
                result = {"restricted": None, "reason": "The launcher probe gave no report"}
            send({"event": "probe", "result": result})
            return 0
        if op == "reap":
            session = request["session"]
            if request.get("requireLeader"):
                # Another device process recorded this session: act only while its leader is
                # alive with the recorded start time, the one identity no PID reuse can fake.
                try:
                    alive = start_time(int(session["sid"])) == int(session["start"])
                except (OSError, ValueError, KeyError):
                    alive = False
                if not alive:
                    send({"event": "reaped", "killed": 0})
                    return 0
            killed = signal_session(session, signal.SIGKILL)
            kill_session(session)
            send({"event": "reaped", "killed": killed})
            return 0
        if op == "native":
            threading.Thread(target=native_watch, daemon=True).start()
            run_native(request)
            return 0
        if op == "exec":
            control = Control()
            if request["full"]:
                run_full(request, control)
            else:
                run_restricted(request, control)
            return 0
        raise Refused("INVALID_REQUEST", "Unknown agent operation")
    except Refused as error:
        send({"event": "refused", "code": error.code, "message": str(error)})
        return 125
    except Exception as error:
        send({"event": "refused", "code": "INVALID_REQUEST",
              "message": "The operation agent failed: %s" % type(error).__name__})
        return 125


if __name__ == "__main__":
    sys.exit(main())
`;
