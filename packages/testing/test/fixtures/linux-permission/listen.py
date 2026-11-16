# Controlled endpoints: each accepted connection is counted in a file the device user cannot write.
import json
import os
import socket
import sys
import threading

directory, endpoints = sys.argv[1], json.loads(sys.argv[2])


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


ready = threading.Semaphore(0)
for name, (host, port) in endpoints.items():
    threading.Thread(target=serve, args=(name, host, port), daemon=True).start()
for _ in endpoints:
    ready.acquire()
print("ready", flush=True)
threading.Event().wait()
