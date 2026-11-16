import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runSandboxPermissionConformance,
  type SandboxPermissionGrant,
} from "../src/sandbox-permission-conformance.js";
import {
  Agent,
  type DeviceContainer,
  dockerPermissionFixture,
  dockerUnavailable,
  execResult,
  RUNTIME_DIR,
  stageMutant,
  startDevice,
  startEndpoints,
  support,
} from "./fixtures/linux-permission/docker.js";

// Real-kernel evidence for the SDK's restricted Linux runtime inside one hardened container
// (Docker's default seccomp, cap-drop ALL, no-new-privileges, read-only rootfs, UID 1000, no
// network). Nothing here relaxes the container; the outer filters used for the fail-closed
// cases are stricter than the default. Skipped where Docker or the image is missing.
const unavailable = dockerUnavailable();

const SECRET = "linux-sibling-secret";
const decode = (value?: string) => Buffer.from(value ?? "", "base64").toString();

describe.skipIf(unavailable !== null)(
  `Linux restricted runtime on a real kernel${unavailable ? ` (skipped: ${unavailable})` : ""}`,
  () => {
    let device: DeviceContainer;
    let agent: Agent;
    let supported = false;
    const root = "/workspace/project";
    const readOnly = "/workspace/readonly";
    const sibling = "/workspace/sibling";
    const restricted = (
      network: SandboxPermissionGrant["network"] = { kind: "none" },
      readRoots: string[] = [],
    ): SandboxPermissionGrant => ({
      profile: "approve-for-me",
      filesystem: { kind: "scoped", readRoots, writeRoots: [root] },
      network,
    });
    const full: SandboxPermissionGrant = {
      profile: "full-access",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    };
    const run = (grant: SandboxPermissionGrant, command: string, extra = {}, via = agent) =>
      via.request({
        op: "exec",
        mode: "exec",
        grant,
        command,
        cwd: root,
        timeoutMs: 60_000,
        ...extra,
      });
    const receipts = (name: string) =>
      Number(device.run(`cat /opt/capybara-receipts/${name} 2>/dev/null || echo 0`).trim());

    beforeAll(async () => {
      device = startDevice();
      startEndpoints(device);
      device.run(
        `mkdir -p ${root} ${readOnly} ${sibling} && printf ${SECRET} > ${sibling}/secret && ` +
          `printf ro > ${readOnly}/file && printf in > ${root}/inroot.txt`,
      );
      agent = new Agent(device);
      await agent.ready;
      supported = (await support(agent)).restricted !== null;
    });
    afterAll(() => {
      agent?.close();
      device?.remove();
    });

    it("runs under the unchanged hardened container", () => {
      const inspect = JSON.parse(
        spawnSync("docker", ["inspect", device.name], { encoding: "utf8" }).stdout,
      )[0].HostConfig;
      expect(inspect.CapDrop).toEqual(["ALL"]);
      expect(inspect.CapAdd ?? []).toEqual([]);
      expect(inspect.SecurityOpt).toEqual(["no-new-privileges"]);
      expect(inspect.ReadonlyRootfs).toBe(true);
      expect(inspect.Privileged).toBe(false);
      expect(inspect.NetworkMode).toBe("none");
      // Docker's default seccomp profile is active (filter mode 2) for the device user.
      expect(device.run("id -u; grep Seccomp: /proc/self/status")).toMatch(/^1000\nSeccomp:\s+2/);
    });

    it("reports restricted support only on a validated architecture with Landlock ABI 6+", async () => {
      const report = (await agent.request({ op: "probe" })).result as {
        restricted: object | null;
        arch: string;
        landlockAbi?: number;
        reason?: string;
      };
      if (report.arch === "aarch64" && supported) {
        expect(report.landlockAbi).toBeGreaterThanOrEqual(6);
      } else {
        expect(report.restricted).toBeNull();
        expect(report.reason).toBeTruthy();
      }
    });

    describe("mechanism", () => {
      it("uses the same pinned root descriptors for Landlock, the broker and the native helper", async (context) => {
        if (!supported) context.skip();
        const exec = await run(
          restricted({ kind: "none" }, [readOnly]),
          "pwd -P; printf x > pinned.txt",
        );
        const pinned = exec.extra?.pinned ?? [];
        const launch = exec.events?.find((event) => event.event === "launch") as unknown as {
          roots: { path: string; fd: number; dev: number; ino: number }[];
          ruleFds: number[];
          brokerFds: number[];
          cwd: number[];
        };
        const identity = (entries: { path: string; fd: number; dev: number; ino: number }[]) =>
          entries
            .map(({ path, fd, dev, ino }) => ({ path, fd, dev, ino }))
            .sort((a, b) => a.fd - b.fd);
        expect(identity(launch.roots)).toEqual(identity(pinned));
        expect([...launch.ruleFds].sort()).toEqual(pinned.map((entry) => entry.fd).sort());
        expect([...launch.brokerFds].sort()).toEqual(launch.ruleFds.sort());
        const writeRoot = pinned.find((entry) => entry.path === root);
        expect(launch.cwd).toEqual([writeRoot?.dev, writeRoot?.ino]);
        expect(decode(exec.stdout).trim()).toBe(root);
        const native = await agent.request({
          op: "native",
          mode: "native",
          grant: restricted(),
          native: { method: "readFile", path: `${root}/pinned.txt`, maxBytes: 10 },
        });
        const nativeLaunch = native.events?.find(
          (event) => event.event === "launch",
        ) as unknown as {
          roots: { fd: number; dev: number; ino: number }[];
          ruleFds: number[];
          nativeFds: number[];
        };
        expect(nativeLaunch.nativeFds).toEqual(nativeLaunch.ruleFds);
        expect(nativeLaunch.roots.map(({ dev, ino }) => [dev, ino])).toEqual([
          [writeRoot?.dev, writeRoot?.ino],
        ]);
        expect(native.native).toEqual({ result: { dataB64: "eA==", truncated: false } });
      });

      it("refuses a root swapped between pinning and launch, and a wrong recorded identity", async (context) => {
        if (!supported) context.skip();
        const moved = `${root}.moved`;
        const swapped = await run(restricted(), `printf pwn > ${root}/escaped; printf ran > ran`, {
          attack: { kind: "swap-after-pin", root, moved, target: sibling },
        });
        device.run(`rm ${root} && mv ${moved} ${root}`);
        expect(swapped.events).toEqual([
          expect.objectContaining({ event: "refused", code: "ROOT_CHANGED" }),
        ]);
        expect(device.run(`ls ${sibling} ${root}`)).not.toMatch(/escaped|\bran\b/);
        const wrong = await run(restricted(), "printf ran > ran", {
          attack: { kind: "wrong-identity" },
        });
        expect(wrong.events).toEqual([
          expect.objectContaining({ event: "refused", code: "ROOT_CHANGED" }),
        ]);
        expect(device.run(`ls ${root}`)).not.toMatch(/\bran\b/);
      });

      it("keeps the supervisor and other processes outside the restricted domain", async (context) => {
        if (!supported) context.skip();
        const result = await run(
          restricted(),
          "kill -0 $PPID && echo SIGNAL-OK; cat /proc/$PPID/environ > /dev/null && echo ENVIRON-OK; " +
            'python3 -c \'import os, sys; os.open("/proc/%s/mem" % sys.argv[1], os.O_RDONLY); print("MEM-OK")\' $PPID; ' +
            "cat /proc/1/root/etc/hostname && echo ROOT-OK; true",
        );
        const out = decode(result.stdout);
        expect(out).not.toMatch(/SIGNAL-OK|ENVIRON-OK|MEM-OK|ROOT-OK/);
      });

      it("mediates the metadata, socket and syscall inventory", async (context) => {
        if (!supported) context.skip();
        const probe = String.raw`
import ctypes, errno, os, socket, sys
libc = ctypes.CDLL(None, use_errno=True)
def attempt(name, action):
    try:
        action()
        print(name, "ALLOWED")
    except OSError as error:
        print(name, errno.errorcode.get(error.errno, error.errno))
def raw(nr, *args):
    if libc.syscall(nr, *args) < 0:
        raise OSError(ctypes.get_errno(), "")
ro = os.open(sys.argv[1], os.O_RDONLY)
attempt("fchmod-readonly", lambda: os.fchmod(ro, 0o777))
attempt("fchown-readonly", lambda: os.fchown(ro, -1, os.getgid()))
attempt("utime-readonly", lambda: os.utime(ro, (1, 1)))
attempt("setxattr-readonly", lambda: os.setxattr(ro, "user.x", b"1"))
attempt("chmod-readonly-path", lambda: os.chmod(sys.argv[1], 0o777))
attempt("write-readonly", lambda: open(sys.argv[1], "a"))
attempt("truncate-readonly", lambda: os.truncate(sys.argv[1], 0))
attempt("hardlink-readonly", lambda: os.link(sys.argv[1], "hardlink-ro"))
attempt("hardlink-sibling", lambda: os.link(sys.argv[2], "hardlink-sibling"))
attempt("rename-out", lambda: os.rename("inroot.txt", sys.argv[3] + "/moved"))
attempt("rename-root", lambda: os.rename(os.getcwd(), os.getcwd() + ".renamed"))
opath = os.open(sys.argv[2], os.O_PATH)
attempt("fchmodat2-opath-sibling", lambda: raw(452, opath, b"", 0o777, 0x1000))
attempt("fchownat-opath-sibling", lambda: raw(54 if os.uname().machine == "aarch64" else 260, opath, b"", -1, os.getgid(), 0x1000))
attempt("reopen-opath-sibling", lambda: os.open("/proc/self/fd/%d" % opath, os.O_RDONLY))
own = os.open("inventory.txt", os.O_RDWR | os.O_CREAT, 0o600)
attempt("fchmod-own", lambda: os.fchmod(own, 0o640))
attempt("utime-own", lambda: os.utime("inventory.txt", (1, 1)))
attempt("chown-own", lambda: os.chown("inventory.txt", -1, os.getgid()))
attempt("udp", lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
attempt("raw-packet", lambda: socket.socket(17, socket.SOCK_RAW, 0))
attempt("vsock", lambda: socket.socket(40, socket.SOCK_STREAM, 0))
attempt("sctp", lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM, 132))
attempt("unix-dgram", lambda: socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM))
attempt("unix-connect", lambda: socket.socket(socket.AF_UNIX).connect("\0capybara-abstract"))
attempt("fastopen", lambda: socket.socket().sendto(b"x", 0x20000000, ("127.0.0.1", 18081)))
attempt("io_uring", lambda: raw(425, 1, ctypes.create_string_buffer(120)))
attempt("future-syscall", lambda: raw(470))
attempt("setsid", os.setsid)
attempt("unix-listen", lambda: (lambda s: (s.bind("u.sock"), s.listen(1)))(socket.socket(socket.AF_UNIX)))
attempt("tcp-listen", lambda: (lambda s: (s.bind(("127.0.0.1", 0)), s.listen(1)))(socket.socket()))
attempt("socketpair", socket.socketpair)
`;
        const result = await run(
          restricted({ kind: "none" }, [readOnly]),
          `python3 - ${readOnly}/file ${sibling}/secret ${sibling} <<'EOF'\n${probe}\nEOF`,
        );
        const lines = Object.fromEntries(
          decode(result.stdout)
            .trim()
            .split("\n")
            .map((line) => line.split(" ")),
        );
        expect(lines).toEqual({
          "fchmod-readonly": "EACCES",
          "fchown-readonly": "EACCES",
          "utime-readonly": "EACCES",
          "setxattr-readonly": "EACCES",
          "chmod-readonly-path": "EACCES",
          "write-readonly": "EACCES",
          "truncate-readonly": "EACCES",
          "hardlink-readonly": "EXDEV",
          "hardlink-sibling": "EXDEV",
          "rename-out": "EACCES",
          "rename-root": "EACCES",
          "fchmodat2-opath-sibling": "EACCES",
          "fchownat-opath-sibling": "EACCES",
          "reopen-opath-sibling": "EACCES",
          "fchmod-own": "ALLOWED",
          "utime-own": "ALLOWED",
          "chown-own": "ALLOWED",
          udp: "EACCES",
          "raw-packet": "EAFNOSUPPORT",
          vsock: "EAFNOSUPPORT",
          sctp: "EACCES",
          "unix-dgram": "EACCES",
          "unix-connect": "EACCES",
          fastopen: "EACCES",
          io_uring: "ENOSYS",
          "future-syscall": "ENOSYS",
          setsid: "EPERM",
          "unix-listen": "ALLOWED",
          "tcp-listen": "ALLOWED",
          socketpair: "ALLOWED",
        });
        expect(device.run(`stat -c %a ${readOnly}/file ${sibling}/secret`)).toBe("644\n644\n");
        expect(device.run(`cat ${readOnly}/file ${sibling}/secret`)).toBe(`ro${SECRET}`);
      });

      it("kills every restricted survivor when the main command exits", async (context) => {
        if (!supported) context.skip();
        const result = await run(restricted(), "(sleep 1000 & echo $! > survivor); true");
        expect(execResult(result, true).exitCode).toBe(0);
        const pid = Number(device.run(`cat ${root}/survivor`));
        const alive = (await agent.request({ op: "inspect", what: "alive", pids: [pid] })).result;
        expect(alive).toEqual([]);
      });

      it("a C thread rewriting the connect and chmod pointers never escapes", async (context) => {
        if (!supported) context.skip();
        device.run(`gcc -O1 -pthread -o ${root}/flip ${RUNTIME_DIR}/flip.c`);
        const before = receipts("ungranted4");
        const control = await run(full, "./flip connect 3000");
        expect(decode(control.stdout)).toMatch(/connect ok=3000/);
        const reached = receipts("ungranted4") - before;
        // The unrestricted control proves the race really alternates between both endpoints.
        expect(reached).toBeGreaterThan(0);
        const allowlisted = restricted({ kind: "allowlist", hosts: ["127.0.0.1"] });
        const raced = await run(allowlisted, "./flip connect 3000");
        expect(decode(raced.stdout)).toMatch(/connect ok=\d+ fail=\d+/);
        expect(receipts("ungranted4")).toBe(before + reached);
        const chmod = await run(
          allowlisted,
          `./flip chmod 3000 ${root}/inroot.txt ${sibling}/secret`,
        );
        expect(decode(chmod.stdout)).toMatch(/chmod ok=[1-9]/);
        expect(device.run(`stat -c %a ${sibling}/secret`).trim()).toBe("644");
      });

      it("passes the full permission conformance", async (context) => {
        if (!supported) context.skip();
        const fixture = await dockerPermissionFixture(device, agent, async () => {});
        await runSandboxPermissionConformance(fixture);
      });
    });

    describe("fails closed", () => {
      for (const outer of ["landlock", "listener"] as const) {
        it(`reports restricted unavailable and refuses launch without the ${outer} primitive`, async () => {
          const limited = new Agent(device, { outer });
          await limited.ready;
          try {
            const report = await support(limited);
            expect(report.restricted).toBeNull();
            expect(report.unavailableReason).toBeTruthy();
            const refused = await run(restricted(), "printf ran > fail-closed", {}, limited);
            expect(refused.events).toEqual([
              expect.objectContaining({ event: "refused", code: "UNAVAILABLE" }),
            ]);
            expect(device.run(`ls ${root}`)).not.toMatch(/fail-closed/);
            const fixture = await dockerPermissionFixture(device, limited, async () => {});
            await runSandboxPermissionConformance(fixture);
          } finally {
            limited.close();
          }
        });
      }
    });

    describe("detects deliberately broken launchers", () => {
      it("without Landlock the sibling write lands", async (context) => {
        if (!supported) context.skip();
        const runtime = stageMutant(
          device,
          "no-landlock",
          "    syscall(NR_LANDLOCK_RESTRICT, ruleset, 0)\n",
          "",
        );
        const mutant = new Agent(device, { runtime });
        await mutant.ready;
        try {
          await run(restricted(), `printf pwn > ${sibling}/mutant-landlock`, {}, mutant);
          expect(device.run(`cat ${sibling}/mutant-landlock`)).toBe("pwn");
        } finally {
          mutant.close();
          device.run(`rm -f ${sibling}/mutant-landlock`);
        }
      });

      it("reopening the root pathname follows a swap into the sibling", async (context) => {
        if (!supported) context.skip();
        const runtime = stageMutant(
          device,
          "reopen-root",
          `                info = os.fstat(fd)\n                where = os.readlink("/proc/self/fd/%d" % fd)\n`,
          `                fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)\n                info = os.fstat(fd)\n                where = path\n                entry = dict(entry, dev=info.st_dev, ino=info.st_ino)\n`,
        );
        const mutant = new Agent(device, { runtime });
        await mutant.ready;
        const moved = `${root}.moved`;
        try {
          await run(
            restricted(),
            `printf pwn > ${root}/mutant-reopen`,
            {
              attack: { kind: "swap-after-pin", root, moved, target: sibling },
            },
            mutant,
          );
          expect(device.run(`cat ${sibling}/mutant-reopen`)).toBe("pwn");
        } finally {
          mutant.close();
          device.run(`rm -f ${root} ${sibling}/mutant-reopen && mv ${moved} ${root}`);
        }
      });

      it("a broker that re-reads the pointer lets the race escape", async (context) => {
        if (!supported) context.skip();
        const runtime = stageMutant(
          device,
          "double-fetch",
          "        copied = ctypes.create_string_buffer(raw, size)\n",
          "        copied = ctypes.create_string_buffer(self.read(mem, args[1], size), size)\n",
        );
        const mutant = new Agent(device, { runtime });
        await mutant.ready;
        try {
          device.run(
            `test -x ${root}/flip || gcc -O1 -pthread -o ${root}/flip ${RUNTIME_DIR}/flip.c`,
          );
          const before = receipts("ungranted4");
          await run(
            restricted({ kind: "allowlist", hosts: ["127.0.0.1"] }),
            "./flip connect 5000",
            {},
            mutant,
          );
          expect(receipts("ungranted4")).toBeGreaterThan(before);
        } finally {
          mutant.close();
        }
      });
    });
  },
);
