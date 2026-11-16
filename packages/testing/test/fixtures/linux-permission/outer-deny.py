# Evidence only: stands in for a kernel or container policy WITHOUT a primitive by adding a
# stricter outer seccomp filter (never a relaxation), then runs the given program under it.
import ctypes
import os
import platform
import struct
import sys

libc = ctypes.CDLL(None, use_errno=True)
what, argv = sys.argv[1], sys.argv[2:]
seccomp = {"aarch64": 277, "x86_64": 317}[platform.machine()]
ENOSYS, EINVAL = 0x50000 | 38, 0x50000 | 22
code = [(0x20, 0, 0, 0)]  # load the syscall number
if what == "landlock":
    code += [(0x15, 0, 1, 444), (0x06, 0, 0, ENOSYS), (0x15, 0, 1, 445), (0x06, 0, 0, ENOSYS),
             (0x15, 0, 1, 446), (0x06, 0, 0, ENOSYS)]
elif what == "listener":
    # seccomp(SECCOMP_SET_MODE_FILTER, flags & SECCOMP_FILTER_FLAG_NEW_LISTENER) fails.
    code += [(0x15, 0, 3, seccomp), (0x20, 0, 0, 24), (0x45, 0, 1, 8), (0x06, 0, 0, EINVAL)]
else:
    raise SystemExit("unknown primitive")
code.append((0x06, 0, 0, 0x7FFF0000))
program = b"".join(struct.pack("HBBI", *instruction) for instruction in code)
buffer = ctypes.create_string_buffer(program, len(program))
fprog = ctypes.create_string_buffer(
    struct.pack("HxxxxxxQ", len(code), ctypes.addressof(buffer)), 16)
if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.syscall(seccomp, 1, 0, fprog) != 0:
    raise SystemExit("outer filter failed")
os.execv(argv[0], argv)
