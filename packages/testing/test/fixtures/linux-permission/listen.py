# Controlled endpoints: each accepted connection is counted in a file the device user cannot write.
# An optional HTTP forward proxy (argv[3]) forwards requests for its routed names only.
import json
import os
import socket
import sys
import threading
import urllib.parse

directory, endpoints = sys.argv[1], json.loads(sys.argv[2])
proxy = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None


def serve(name, host, port):
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    server = socket.socket(family, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    server.listen(128)
    count = 0
    ready.release()
    while True:
        connection, _ = server.accept()
        count += 1
        path = os.path.join(directory, name)
        with open(path + ".tmp", "w") as handle:
            handle.write(str(count))
        os.chmod(path + ".tmp", 0o644)
        os.rename(path + ".tmp", path)
        try:
            connection.sendall(b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok")
        except OSError:
            pass
        connection.close()


def forward(connection, routes):
    try:
        request = b""
        while b"\r\n\r\n" not in request:
            chunk = connection.recv(4096)
            if not chunk:
                return
            request += chunk
        target = urllib.parse.urlsplit(request.split(b" ", 2)[1].decode())
        route = routes.get("%s:%s" % (target.hostname, target.port or 80))
        if route is None:
            connection.sendall(b"HTTP/1.0 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        upstream = socket.create_connection(tuple(route), 10)
        upstream.sendall(request)
        while True:
            chunk = upstream.recv(65536)
            if not chunk:
                break
            connection.sendall(chunk)
        upstream.close()
    except (OSError, ValueError, IndexError):
        pass
    finally:
        connection.close()


def serve_proxy(host, port, routes):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    server.listen(128)
    ready.release()
    while True:
        connection, _ = server.accept()
        threading.Thread(target=forward, args=(connection, routes), daemon=True).start()


ready = threading.Semaphore(0)
for name, (host, port) in endpoints.items():
    threading.Thread(target=serve, args=(name, host, port), daemon=True).start()
if proxy:
    threading.Thread(target=serve_proxy, args=(proxy["address"], proxy["port"], proxy["routes"]),
                     daemon=True).start()
for _ in range(len(endpoints) + (1 if proxy else 0)):
    ready.acquire()
print("ready", flush=True)
threading.Event().wait()
