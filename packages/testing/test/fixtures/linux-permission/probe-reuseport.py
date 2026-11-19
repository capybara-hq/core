import socket, select
def run(fam, host, clear):
    S = socket.socket(fam, socket.SOCK_STREAM)
    S.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    S.bind((host, 0)); S.listen(512); port = S.getsockname()[1]
    A = socket.socket(fam, socket.SOCK_STREAM)
    A.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    A.bind((host, port)); A.listen(512)
    if clear: A.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 0)
    ra = A.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT)
    hits = {"S": 0, "A": 0}
    for i in range(200):
        c = socket.socket(fam, socket.SOCK_STREAM); c.connect((host, port))
        r, _, _ = select.select([S, A], [], [], 1)
        for s in r:
            x, _ = s.accept(); x.close(); hits["S" if s is S else "A"] += 1
        c.close()
    print(host, "A_reuseport_at_connect=%d" % ra, hits)
for clear in (True, False):
    run(socket.AF_INET, "127.0.0.1", clear)
    run(socket.AF_INET6, "::1", clear)
