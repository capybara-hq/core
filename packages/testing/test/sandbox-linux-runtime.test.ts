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
  ENDPOINT_NAMES,
  execResult,
  IMAGE,
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
// CI evidence mode: everything that would otherwise skip (no Docker or image, restricted
// unavailable, skipped mechanisms) fails with its reason instead.
const required = process.env.CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED === "1";

describe.runIf(required && unavailable !== null)("Linux restricted runtime is required", () => {
  it("has Docker and the sandbox image", () => {
    throw new Error(`CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 but: ${unavailable}`);
  });
});

const SECRET = "linux-sibling-secret";
const decode = (value?: string) => Buffer.from(value ?? "", "base64").toString();

describe.skipIf(unavailable !== null)(
  `Linux restricted runtime on a real kernel${unavailable ? ` (skipped: ${unavailable})` : ""}`,
  () => {
    let device: DeviceContainer;
    let agent: Agent;
    let supported = false;
    let unsupportedReason = "";
    /** Skips a mechanism test where restricted mode is unavailable, or fails in evidence mode. */
    const requireSupport = (context: { skip: () => void }) => {
      if (supported) return;
      if (required) throw new Error(`restricted runtime unavailable: ${unsupportedReason}`);
      context.skip();
    };
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
      // The candidate flag lets a reviewed but not yet validated architecture table run here so the
      // evidence can be collected; the default probe keeps reporting it unavailable.
      agent = new Agent(device, { candidateArch: true });
      await agent.ready;
      const report = await support(agent);
      supported = report.restricted !== null;
      unsupportedReason = report.unavailableReason ?? "";
      const host = (command: string, args: string[]) =>
        spawnSync(command, args, { encoding: "utf8" }).stdout?.trim() ?? "";
      console.info(
        `[linux-runtime] ${JSON.stringify({
          candidateProbe: report,
          kernel: device.run("uname -srm").trim(),
          lsm:
            host("cat", ["/sys/kernel/security/lsm"]) ||
            device.run("cat /sys/kernel/security/lsm 2>/dev/null || echo unreadable").trim(),
          deviceSeccomp: device.run("grep -E 'Seccomp|NoNewPrivs' /proc/self/status").trim(),
          dockerSecurity: host("docker", ["info", "--format", "{{json .SecurityOptions}}"]),
          image: host("docker", [
            "image",
            "inspect",
            IMAGE,
            "--format",
            "{{.Id}} {{json .RepoDigests}} {{.Architecture}}",
          ]),
        })}`,
      );
      if (required && !supported) {
        throw new Error(`CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 but: ${unsupportedReason}`);
      }
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
      const plain = new Agent(device);
      await plain.ready;
      try {
        const report = (await plain.request({ op: "probe" })).result as {
          restricted: object | null;
          arch: string;
          validated?: boolean;
          landlockAbi?: number;
          reason?: string;
        };
        console.info(`[linux-runtime] default probe: ${JSON.stringify(report)}`);
        if ((report.arch === "aarch64" || report.arch === "x86_64") && supported) {
          expect(report.landlockAbi).toBeGreaterThanOrEqual(6);
          expect(report.validated).toBe(true);
        } else {
          expect(report.restricted).toBeNull();
          expect(report.reason).toBeTruthy();
        }
      } finally {
        plain.close();
      }
    });

    describe("mechanism", () => {
      it("uses the same pinned root descriptors for Landlock, the broker and the native helper", async (context) => {
        requireSupport(context);
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
        requireSupport(context);
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

      it("closes every inherited descriptor above stdio, however high", async (context) => {
        requireSupport(context);
        const result = await run(
          restricted(),
          "python3 -c 'import os; print(os.read(1500, 100), \"LEAKED\")'; ls /proc/self/fd",
          {
            attack: { kind: "leak-fd", target: `${sibling}/secret` },
          },
        );
        expect(decode(result.stdout)).not.toMatch(/LEAKED|linux-sibling-secret|1500/);
      });

      it("keeps the supervisor and other processes outside the restricted domain", async (context) => {
        requireSupport(context);
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
        requireSupport(context);
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
attempt("pair-seqpacket", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET))
attempt("pair-dgram", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM))
attempt("pair-raw", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_RAW))
attempt("pair-dgram-cloexec", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM | socket.SOCK_CLOEXEC))
attempt("unix-raw", lambda: socket.socket(socket.AF_UNIX, socket.SOCK_RAW))
attempt("unix-dgram-cloexec", lambda: socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM | socket.SOCK_CLOEXEC))
attempt("unix-seqpacket", lambda: socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET))
attempt("bind-any", lambda: socket.socket().bind(("0.0.0.0", 0)))
attempt("bind6-any", lambda: socket.socket(socket.AF_INET6).bind(("::", 0)))
attempt("abstract-bind", lambda: socket.socket(socket.AF_UNIX).bind("\0capybara-abstract-bind"))
keyctl = 219 if os.uname().machine == "aarch64" else 250
attempt("keyctl", lambda: raw(keyctl, 0, -3, 0))
attempt("unshare-user", lambda: os.unshare(0x10000000))
attempt("unshare-net", lambda: os.unshare(0x40000000))
attempt("clone3", lambda: raw(435, 0, 0))
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
          // brokered: the broker refuses a link whose source is outside the write roots
          "hardlink-readonly": "EACCES",
          "hardlink-sibling": "EACCES",
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
          "pair-seqpacket": "ALLOWED",
          "pair-dgram": "EACCES",
          "pair-raw": "EACCES",
          "pair-dgram-cloexec": "EACCES",
          "unix-raw": "EACCES",
          "unix-dgram-cloexec": "EACCES",
          "unix-seqpacket": "ALLOWED",
          "bind-any": "EACCES",
          "bind6-any": "EACCES",
          "abstract-bind": "EACCES",
          keyctl: "EPERM",
          "unshare-user": "EPERM",
          "unshare-net": "EPERM",
          clone3: "ENOSYS",
        });
        expect(device.run(`stat -c %a ${readOnly}/file ${sibling}/secret`)).toBe("644\n644\n");
        expect(device.run(`cat ${readOnly}/file ${sibling}/secret`)).toBe(`ro${SECRET}`);
      });

      it("kills every restricted survivor when the main command exits", async (context) => {
        requireSupport(context);
        const result = await run(restricted(), "(sleep 1000 & echo $! > survivor); true");
        expect(execResult(result, true).exitCode).toBe(0);
        const pid = Number(device.run(`cat ${root}/survivor`));
        const alive = (await agent.request({ op: "inspect", what: "alive", pids: [pid] })).result;
        expect(alive).toEqual([]);
      });

      it("a C thread rewriting the connect and chmod pointers never escapes", async (context) => {
        requireSupport(context);
        device.run(`gcc -O1 -pthread -o ${root}/flip ${RUNTIME_DIR}/flip.c`);
        const before = receipts("ungranted4");
        const control = await run(full, "./flip connect 3000");
        expect(decode(control.stdout)).toMatch(/connect ok=3000/);
        const reached = receipts("ungranted4") - before;
        // The unrestricted control proves the race really alternates between both endpoints.
        expect(reached).toBeGreaterThan(0);
        const allowlisted = restricted({ kind: "allowlist", hosts: [ENDPOINT_NAMES.granted] });
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

      it("a refused or dissolved connect never turns listen() into a bind to every address", async (context) => {
        requireSupport(context);
        const program = [
          "import ctypes, socket",
          "libc = ctypes.CDLL(None, use_errno=True)",
          "def listen_after(prepare):",
          "    s = socket.socket()",
          "    prepare(s)",
          "    try:",
          "        s.listen(1)",
          "        return s.getsockname()[0]",
          "    except OSError as error:",
          "        return 'denied'",
          "def refused(s):",
          "    try:",
          "        s.connect(('127.0.0.1', 18099))",
          "    except ConnectionRefusedError:",
          "        pass",
          "def unspec(s):",
          "    libc.connect(s.fileno(), ctypes.create_string_buffer(16), 16)",
          "print('refused=' + listen_after(refused), 'unspec=' + listen_after(unspec))",
        ].join("\n");
        const result = await run(
          restricted({ kind: "allowlist", hosts: ["refused.test"] }),
          `python3 - <<'EOF'\n${program}\nEOF`,
        );
        expect(decode(result.stdout).trim(), decode(result.stderr)).toBe(
          "refused=denied unspec=denied",
        );
      });

      it("records the session before any restricted code runs (supervisor killed at once)", async (context) => {
        requireSupport(context);
        device.run(`rm -f ${root}/early-*`);
        const started = agent.start({
          op: "exec",
          mode: "exec",
          grant: restricted(),
          command: "(sleep 2101 & echo $! > early-pid); printf ran > early-ran; sleep 2102",
          cwd: root,
          timeoutMs: 120_000,
          killSupervisorOnSession: true,
        });
        const done = await started.done;
        const kinds = done.events?.map((event) => event.event) ?? [];
        // The supervisor was killed as soon as the session existed; whatever ran was reaped.
        expect(kinds[0]).toBe("session");
        expect(execResult(done, true).exitCode).toBeNull();
        expect(device.run("pgrep -f 'sleep 210[12]' || true").trim()).toBe("");
      });

      it("losing the supervisor (SIGKILL) ends every owned restricted descendant", async (context) => {
        requireSupport(context);
        device.run(`rm -f ${root}/lost-*`);
        const started = agent.start({
          op: "exec",
          mode: "exec",
          grant: restricted(),
          command:
            "(sleep 2001 & echo $! > lost-a); (sleep 2002 & echo $! > lost-b); printf r > lost-ready; sleep 2003",
          cwd: root,
          timeoutMs: 120_000,
        });
        await agent.waitFor(`${root}/lost-ready`);
        const pids = ["lost-a", "lost-b"].map((name) => Number(device.run(`cat ${root}/${name}`)));
        expect((await agent.request({ op: "inspect", what: "alive", pids })).result).toEqual(pids);
        await agent.request({ op: "kill-supervisor", target: started.id });
        // The request completes (no orphan holds its pipes) and nothing owned survives.
        const done = await started.done;
        expect(execResult(done, true).exitCode).toBeNull();
        expect((await agent.request({ op: "inspect", what: "alive", pids })).result).toEqual([]);
        expect(device.run("pgrep -f 'sleep 200[123]' || true").trim()).toBe("");
      });

      it("passes the full permission conformance", async (context) => {
        requireSupport(context);
        const fixture = await dockerPermissionFixture(device, agent, async () => {});
        await runSandboxPermissionConformance(fixture);
      });

      it("passes the full permission conformance with allowlist traffic through a proxy", async (context) => {
        requireSupport(context);
        const proxied = new Agent(device, { candidateArch: true, access: "proxy" });
        await proxied.ready;
        try {
          const fixture = await dockerPermissionFixture(device, proxied, async () => {});
          await runSandboxPermissionConformance(fixture);
        } finally {
          proxied.close();
        }
      });
    });

    describe("fails closed", () => {
      for (const outer of ["landlock", "listener"] as const) {
        it(`reports restricted unavailable and refuses launch without the ${outer} primitive`, async (context) => {
          requireSupport(context);
          const limited = new Agent(device, { outer, candidateArch: true });
          await limited.ready;
          try {
            const report = await support(limited);
            expect(report.restricted).toBeNull();
            expect(report.unavailableReason).toMatch(
              outer === "landlock" ? /Landlock ABI 0 / : /required primitive failed/,
            );
            const refused = await run(restricted(), "printf ran > fail-closed", {}, limited);
            // Refused before any launch: no launch or exit event, only (possibly) the session.
            expect(refused.events?.at(-1)).toEqual(
              expect.objectContaining({ event: "refused", code: "UNAVAILABLE" }),
            );
            expect(refused.events?.map((event) => event.event)).not.toContain("launch");
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
      it("without Landlock the sibling read lands (writes stay brokered)", async (context) => {
        requireSupport(context);
        const runtime = stageMutant(
          device,
          "no-landlock",
          "    syscall(NR_LANDLOCK_RESTRICT, ruleset, 0)\n",
          "",
        );
        const mutant = new Agent(device, { runtime, candidateArch: true });
        await mutant.ready;
        try {
          const read = await run(restricted(), `cat ${sibling}/secret`, {}, mutant);
          expect(decode(read.stdout)).toBe(SECRET);
          // the broker still performs (and refuses) every write: Landlock is not the only wall
          await run(restricted(), `printf pwn > ${sibling}/mutant-landlock; true`, {}, mutant);
          expect(device.run(`cat ${sibling}/mutant-landlock 2>/dev/null; true`)).toBe("");
        } finally {
          mutant.close();
          device.run(`rm -f ${sibling}/mutant-landlock`);
        }
      });

      it("without the mandatory denies a git hook lands", async (context) => {
        requireSupport(context);
        const head = "def write_denied(path):\n";
        const runtime = stageMutant(device, "no-write-denies", head, `${head}    return False\n`);
        const mutant = new Agent(device, { runtime, candidateArch: true });
        await mutant.ready;
        try {
          await run(
            restricted(),
            `mkdir -p ${root}/hooked/.git/hooks && printf pwn > ${root}/hooked/.git/hooks/pre-commit`,
            {},
            mutant,
          );
          expect(device.run(`cat ${root}/hooked/.git/hooks/pre-commit`)).toBe("pwn");
        } finally {
          mutant.close();
          device.run(`rm -rf ${root}/hooked`);
        }
      });

      it("a launcher left dumpable is open to a same-uid outsider", async (context) => {
        requireSupport(context);
        const runtime = stageMutant(
          device,
          "dumpable",
          "SELF_PROTECTION = protect_self()\n",
          "SELF_PROTECTION = None\n",
        );
        const mutant = new Agent(device, { runtime, candidateArch: true });
        await mutant.ready;
        try {
          const fixture = await dockerPermissionFixture(device, mutant, async () => {});
          // The outsider case is what fails, and it fails because the probe reads everything.
          await expect(runSandboxPermissionConformance(fixture)).rejects.toThrow(
            /a same-uid outsider must not ptrace.*"target": \{"mem": "ALLOWED", "environ": "ALLOWED", "attach": "ALLOWED"\}/,
          );
        } finally {
          mutant.close();
        }
      });

      it("reopening the root pathname follows a swap into the sibling", async (context) => {
        requireSupport(context);
        const runtime = stageMutant(
          device,
          "reopen-root",
          `                info = os.fstat(fd)\n                where = os.readlink("/proc/self/fd/%d" % fd)\n`,
          `                fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)\n                info = os.fstat(fd)\n                where = path\n                entry = dict(entry, dev=info.st_dev, ino=info.st_ino)\n`,
        );
        const mutant = new Agent(device, { runtime, candidateArch: true });
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

      it("closing only descriptors below 1024 leaks a high inherited descriptor", async (context) => {
        requireSupport(context);
        const runtime = stageMutant(
          device,
          "low-close",
          "            close_except(keep)\n",
          "            for fd in range(3, 1024):\n                if fd not in keep:\n                    try:\n                        os.close(fd)\n                    except OSError:\n                        pass\n",
        );
        const mutant = new Agent(device, { runtime, candidateArch: true });
        await mutant.ready;
        try {
          const result = await run(
            restricted(),
            "python3 -c 'import os; print(os.read(1500, 100), \"LEAKED\")'",
            {
              attack: { kind: "leak-fd", target: `${sibling}/secret` },
            },
            mutant,
          );
          expect(decode(result.stdout)).toContain("LEAKED");
        } finally {
          mutant.close();
        }
      });

      it("a broker that re-reads the pointer lets the race escape", async (context) => {
        requireSupport(context);
        const runtime = stageMutant(
          device,
          "double-fetch",
          "object.\n        copied = ctypes.create_string_buffer(raw, size)\n",
          "object.\n        copied = ctypes.create_string_buffer(self.read(mem, args[1], size), size)\n",
        );
        const mutant = new Agent(device, { runtime, candidateArch: true });
        await mutant.ready;
        try {
          device.run(
            `test -x ${root}/flip || gcc -O1 -pthread -o ${root}/flip ${RUNTIME_DIR}/flip.c`,
          );
          const before = receipts("ungranted4");
          await run(
            restricted({ kind: "allowlist", hosts: [ENDPOINT_NAMES.granted] }),
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
