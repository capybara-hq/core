import socket, select
def run(fam, host, order):
    L = socket.socket(fam); L.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    L.bind((host, 0)); L.listen(64); P = L.getsockname()[1]
    L.shutdown(socket.SHUT_RD)
    X = socket.socket(fam); X.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if order == "X-then-L":
        X.bind((host, P)); X.listen(64); L.listen(64)
    else:
        X.bind((host, P)); L.listen(64); X.listen(64)
    hits = {"L": 0, "X": 0}
    for _ in range(50):
        c = socket.socket(fam); c.connect((host, P))
        r, _, _ = select.select([L, X], [], [], 1)
        for s in r:
            a, _ = s.accept(); a.close(); hits["L" if s is L else "X"] += 1
        c.close()
    print(host, order, "L acceptconn=%d" % L.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN), hits)
for o in ("X-then-L", "L-then-X"):
    try: run(socket.AF_INET, "127.0.0.1", o)
    except OSError as e: print(o, "v4", e)
    try: run(socket.AF_INET6, "::1", o)
    except OSError as e: print(o, "v6", e)
