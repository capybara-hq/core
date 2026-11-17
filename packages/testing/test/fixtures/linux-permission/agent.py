# Test-only trusted consumer inside the container: it pins granted roots once, launches the staged
# Linux runtime for restricted scopes and runs Full commands without restricted filters. It stands
# in for a provider's transport and never decides authority itself: each request carries its scope.
import base64
import json
import os
import signal
import subprocess
import sys
import threading

RUNTIME = os.path.dirname(os.path.abspath(__file__))
LAUNCHER = os.path.join(RUNTIME, "linux-sandbox.py")
NATIVE = os.path.join(RUNTIME, "native-files.py")
ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
lock = threading.Lock()
running = {}
OPTIONS = {}


def send(message):
    data = json.dumps(message) + "\n"
    with lock:
        sys.stdout.write(data)
        sys.stdout.flush()


class PinRefused(Exception):
    pass


def pin(paths):
    pinned = []
    try:
        for path in paths:
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            info = os.fstat(fd)
            pinned.append({"path": path, "fd": fd, "dev": info.st_dev, "ino": info.st_ino})
    except OSError:
        for entry in pinned:
            os.close(entry["fd"])
        # A root that no longer is a real directory (for example swapped for a symlink) is refused.
        raise PinRefused()
    return pinned


def network(scope, endpoints):
    kind = scope["kind"]
    if kind == "environment":
        return {"kind": "environment"}
    if kind == "none":
        return {"kind": "none"}
    granted = [endpoints[host] for host in scope["hosts"] if host in endpoints]
    return {"kind": "endpoints", "endpoints": granted}


def collect(process, limit):
    out = {}

    def drain(name, stream):
        data = bytearray()
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            if len(data) < limit:
                data += chunk[: limit - len(data)]
        out[name] = bytes(data)
    threads = [threading.Thread(target=drain, args=(name, getattr(process, name)))
               for name in ("stdout", "stderr")]
    for thread in threads:
        thread.start()
    return threads, out


def seed(entries):
    for entry in entries:
        os.makedirs(os.path.dirname(entry["path"]), exist_ok=True)
        if entry["kind"] == "directory":
            os.makedirs(entry["path"], exist_ok=True)
        elif entry["kind"] == "file":
            with open(entry["path"], "wb") as handle:
                handle.write(base64.b64decode(entry["dataB64"]))
        else:
            os.symlink(entry["target"], entry["path"])


def inspect(request):
    kind, path = request["what"], request.get("path")
    if kind == "read":
        try:
            with open(path, "rb") as handle:
                return base64.b64encode(handle.read()).decode()
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
            return None
    if kind == "mode":
        try:
            return os.stat(path).st_mode & 0o7777
        except FileNotFoundError:
            return None
    if kind == "alive":
        alive = []
        for pid in request["pids"]:
            try:
                with open("/proc/%d/stat" % pid) as handle:
                    state = handle.read().rsplit(")", 1)[1].split()[0]
                if state not in ("Z", "X"):
                    alive.append(pid)
            except OSError:
                pass
        return alive
    raise ValueError("Unknown inspection")


def launch(request, endpoints):
    grant = request["grant"]
    limit = request.get("maxOutputBytes", 65536)
    env = dict(ENV, **request.get("env", {}))
    if grant["filesystem"]["kind"] == "device":
        if grant["profile"] != "full-access" or grant["network"]["kind"] != "environment":
            raise ValueError("This fixture runs device scope only as Full access")
        # Full access: the OS user's ordinary authority, no restricted filters at all.
        env.setdefault("HOME", "/home/sandbox")
        process = subprocess.Popen(["/bin/sh", "-c", request["command"]], cwd=request.get("cwd"),
                                   env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
        return process, None, None
    files = grant["filesystem"]
    write = pin(files["writeRoots"])
    read = pin([path for path in files["readRoots"] if path not in files["writeRoots"]])
    attack = request.get("attack")
    if attack and attack["kind"] == "swap-after-pin":
        # Evidence only: the root path changes between pinning and launch.
        os.rename(attack["root"], attack["moved"])
        os.symlink(attack["target"], attack["root"])
    elif attack and attack["kind"] == "wrong-identity":
        write[0] = dict(write[0], ino=write[0]["ino"] + 1)
    leaked = []
    if attack and attack["kind"] == "leak-fd":
        # Evidence only: a careless consumer leaves a high inheritable descriptor open.
        opened = os.open(attack["target"], os.O_RDONLY)
        os.dup2(opened, 1500, inheritable=True)
        os.close(opened)
        leaked.append(1500)
    report_r, report_w = os.pipe()
    env.setdefault("HOME", files["writeRoots"][0])
    body = {"mode": request["mode"], "roots": {"read": read, "write": write},
            "candidateArch": OPTIONS.get("candidateArch", False),
            "network": network(grant["network"], endpoints), "reportFd": report_w,
            "env": env, "cwd": request.get("cwd")}
    if request["mode"] == "exec":
        body["argv"] = ["/bin/sh", "-c", request["command"]]
        body["timeoutMs"] = request.get("timeoutMs")
    else:
        body["native"] = request["native"]
    try:
        process = subprocess.Popen([sys.executable, "-I", LAUNCHER], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   pass_fds=[report_w] + leaked + [e["fd"] for e in read + write],
                                   env=ENV)
    finally:
        os.close(report_w)
        for fd in leaked:
            os.close(fd)
        for entry in read + write:
            os.close(entry["fd"])
    process.stdin.write(json.dumps(body).encode())
    process.stdin.close()
    return process, report_r, {"pinned": [{k: e[k] for k in ("path", "fd", "dev", "ino")}
                                          for e in read + write]}


def handle(request, endpoints):
    ident = request["id"]
    try:
        if request["op"] == "seed":
            seed(request["entries"])
            send({"id": ident, "result": True})
            return
        if request["op"] == "inspect":
            send({"id": ident, "result": inspect(request)})
            return
        if request["op"] == "probe":
            args = ["probe", "--candidate-arch"] if OPTIONS.get("candidateArch") else ["probe"]
            done = subprocess.run([sys.executable, "-I", LAUNCHER, *args], capture_output=True)
            send({"id": ident, "result": json.loads(done.stdout)})
            return
        if request["op"] == "kill-supervisor":
            # Evidence only: the supervisor is lost (as by the OOM killer), not asked to stop.
            target = running.get(request["target"])
            if target is not None and target[1]:
                target[0].kill()
            send({"id": ident, "result": True})
            return
        if request["op"] == "cancel":
            target = running.get(request["target"])
            if target is not None:
                if target[1]:
                    target[0].send_signal(signal.SIGTERM)
                else:
                    os.killpg(target[0].pid, signal.SIGKILL)
            send({"id": ident, "result": True})
            return
        if request["op"] == "native" and request["grant"]["filesystem"]["kind"] == "device":
            fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
            body = dict(request["native"], roots={"read": [], "write": [{"path": "/", "fd": fd}]})
            done = subprocess.run([sys.executable, "-I", NATIVE], input=json.dumps(body).encode(),
                                  capture_output=True, pass_fds=[fd])
            os.close(fd)
            send({"id": ident, "native": json.loads(done.stdout)})
            return
        process, report_r, extra = launch(request, endpoints)
        restricted = report_r is not None
        running[ident] = (process, restricted)
        threads, out = collect(process, request.get("maxOutputBytes", 65536))
        events = []
        reader = None
        if report_r is not None:
            def read_events():
                with os.fdopen(report_r, "rb") as stream:
                    for line in stream:
                        event = json.loads(line)
                        events.append(event)
                        if event.get("event") == "session" and request.get("killSupervisorOnSession"):
                            # Evidence only: lose the supervisor the moment its session exists.
                            process.kill()
            reader = threading.Thread(target=read_events)
            reader.start()
        code = process.wait()
        running.pop(ident, None)
        if reader is not None:
            reader.join()
            session = next((e for e in events if e.get("event") == "session"), None)
            if session is not None:
                # Consumer-side cleanup: whatever happened to the supervisor, end its closed
                # session (exact SID plus leader start time) so nothing owned outlives it and no
                # orphan keeps the output pipes open.
                subprocess.run([sys.executable, "-I", LAUNCHER, "reap"],
                               input=json.dumps(session).encode(), capture_output=True)
        for thread in threads:
            thread.join()
        message = {"id": ident, "code": code, "events": events, "extra": extra,
                   "stdout": base64.b64encode(out["stdout"]).decode(),
                   "stderr": base64.b64encode(out["stderr"]).decode()}
        if request["op"] == "native":
            text = out["stdout"].decode().strip()
            message["native"] = json.loads(text) if text else None
        send(message)
    except PinRefused:
        send({"id": ident, "code": 125, "events": [{"event": "refused", "code": "SCOPE_DENIED"}]})
    except Exception as error:
        send({"id": ident, "error": "%s: %s" % (type(error).__name__, error)})


def main():
    endpoints = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    OPTIONS.update(json.loads(sys.argv[2]) if len(sys.argv) > 2 else {})
    send({"ready": True})
    for line in sys.stdin:
        request = json.loads(line)
        threading.Thread(target=handle, args=(request, endpoints), daemon=True).start()


if __name__ == "__main__":
    main()
