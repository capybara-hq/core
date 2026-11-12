import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceExecArgs, SandboxLimits } from "@capybara-hq/plugin-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { launchScript, SESSION_MODE_SCRIPT } from "../../kernel/src/background/launch.js";
import { killSessionScript, termScript } from "../../kernel/src/background/session.js";
import {
  createOsExecutor,
  OsExecutor,
  osRoots,
  sandboxAvailability,
  utf8Prefix,
} from "../src/exec/os.js";
import { findMarked } from "../src/exec/procs.js";
import { DeviceOpError } from "../src/exec/types.js";
import { DEFAULT_POLICY } from "../src/state.js";

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("utf8Prefix", () => {
  it("drops an incomplete trailing sequence and keeps complete ones", () => {
    const b = Buffer.from("a€", "utf8"); // 61 e2 82 ac
    expect(utf8Prefix(b).toString()).toBe("a€");
    expect(utf8Prefix(b.subarray(0, 3)).toString()).toBe("a");
    expect(utf8Prefix(b.subarray(0, 2)).toString()).toBe("a");
    expect(utf8Prefix(Buffer.from("abc")).toString()).toBe("abc");
    const four = Buffer.from("x😀", "utf8");
    expect(utf8Prefix(four.subarray(0, 4)).toString()).toBe("x");
  });
});

describe("OsExecutor: roots, ensureRoot and the skills root", () => {
  let base: string;
  let dir: string;
  let ex: OsExecutor;
  beforeEach(() => {
    base = tmp("device-os-");
    dir = join(base, "env");
    mkdirSync(dir);
    ex = new OsExecutor({ dir, policy: () => DEFAULT_POLICY });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("reports <dir>/workspace, <dir>/skills and <dir>/tmp as its roots", () => {
    expect(ex.mode).toBe("os");
    expect(ex.roots).toEqual(osRoots(dir));
    expect(ex.roots).toEqual({
      workspace: join(dir, "workspace"),
      skills: join(dir, "skills"),
      tmp: join(dir, "tmp"),
    });
  });

  it("ensureRoot creates the marker and roots; a vanished directory is gone, never recreated", async () => {
    expect(await ex.ensureRoot()).toBe("ok");
    expect(existsSync(join(dir, ".capybara-device"))).toBe(true);
    expect(existsSync(join(dir, "workspace"))).toBe(true);
    rmSync(dir, { recursive: true });
    expect(await ex.ensureRoot()).toBe("gone");
    expect(existsSync(dir)).toBe(false);
    // A fresh process (new executor) finds the directory missing too.
    expect(await new OsExecutor({ dir, policy: () => DEFAULT_POLICY }).ensureRoot()).toBe("gone");
  });

  it("a root removed under a marked directory is gone, never recreated empty", async () => {
    for (const root of ["workspace", "skills", "tmp"]) {
      expect(await ex.ensureRoot()).toBe("ok");
      rmSync(join(dir, root), { recursive: true });
      expect(await ex.ensureRoot()).toBe("gone");
      expect(existsSync(join(dir, root))).toBe(false);
      // A fresh process sees the marker and the missing root: still gone.
      expect(await new OsExecutor({ dir, policy: () => DEFAULT_POLICY }).ensureRoot()).toBe("gone");
      mkdirSync(join(dir, root));
    }
  });

  it("the marker vanishing while the directory stays is gone in this process", async () => {
    expect(await ex.ensureRoot()).toBe("ok");
    rmSync(join(dir, ".capybara-device"));
    expect(await ex.ensureRoot()).toBe("gone");
  });

  it("skills files are written, read and stat-ed in process; links out are refused", async () => {
    await ex.ensureRoot();
    const f = join(ex.roots.skills, "s/SKILL.md");
    await ex.writeFile(f, Buffer.from("# skill"));
    expect(readFileSync(f, "utf8")).toBe("# skill");
    expect(await ex.stat(f)).toEqual({ size: 7, isDir: false });
    const r = await ex.readFile(f, 3);
    expect(Buffer.from(r?.data ?? []).toString()).toBe("# s");
    expect(r?.truncated).toBe(true);
    expect(await ex.readFile(join(ex.roots.skills, "missing"), 10)).toBeNull();
    const secret = join(base, "secret.txt");
    writeFileSync(secret, "top secret");
    symlinkSync(secret, join(ex.roots.skills, "link"));
    await expect(ex.readFile(join(ex.roots.skills, "link"), 100)).rejects.toMatchObject({
      kind: "policy",
    });
    await expect(ex.stat(join(ex.roots.skills, "link"))).rejects.toBeInstanceOf(DeviceOpError);
    await expect(
      ex.writeFile(join(ex.roots.skills, "link"), Buffer.from("x")),
    ).rejects.toMatchObject({ kind: "policy" });
    expect(readFileSync(secret, "utf8")).toBe("top secret");
  });

  it("paths outside the roots, relative paths and .. escapes are refused", async () => {
    await ex.ensureRoot();
    await expect(ex.readFile(join(base, "x"), 10)).rejects.toMatchObject({ kind: "policy" });
    await expect(ex.readFile(join(dir, ".capybara-device"), 10)).rejects.toMatchObject({
      kind: "policy",
    });
    await expect(ex.readFile("workspace/x", 10)).rejects.toMatchObject({ kind: "policy" });
    await expect(
      ex.writeFile(`${ex.roots.workspace}/../../x`, Buffer.from("x")),
    ).rejects.toMatchObject({ kind: "policy" });
    await expect(ex.stat("/etc/passwd")).rejects.toMatchObject({ kind: "policy" });
  });

  it("exec refuses an already-aborted signal without starting anything", async () => {
    await ex.ensureRoot();
    const ac = new AbortController();
    ac.abort();
    await expect(
      ex.exec(execArgs(`touch ${join(ex.roots.workspace, "ran")}`), ac.signal),
    ).rejects.toThrow();
    expect(existsSync(join(ex.roots.workspace, "ran"))).toBe(false);
  });
});

const LIMITS: SandboxLimits = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  egress: "none",
  allowHosts: [],
  tier: "strict",
  devHosts: [],
};

function execArgs(command: string, over: Partial<DeviceExecArgs> = {}): DeviceExecArgs {
  return {
    command,
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    tag: "t1",
    actor: { accountId: "acc", conversationId: "conv" },
    limits: LIMITS,
    ...over,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await sleep(25);
  }
}

function hasCurl(): boolean {
  try {
    execFileSync("curl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const availability = sandboxAvailability();
if (!availability.ok) {
  console.warn(`exec-os: sandbox tests skipped: ${availability.reason}`);
}

describe.skipIf(!availability.ok)(
  "OsExecutor: commands and file operations in the OS sandbox",
  () => {
    let base: string;
    let fakeHome: string;
    let state: string;
    let ex: OsExecutor;
    /** Domains the local policy gains while the executor runs (a live policy change). */
    let extraDomains: string[] = [];
    const never = new AbortController().signal;

    beforeAll(async () => {
      base = tmp("device-sbx-");
      fakeHome = join(base, "home");
      mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
      writeFileSync(join(fakeHome, ".ssh/id_rsa"), "PRIVATE KEY");
      state = join(base, "state");
      mkdirSync(state);
      writeFileSync(join(state, "credential.json"), '{"credential":"cap_dev_secret"}');
      writeFileSync(join(state, "f"), "OUTSIDE SECRET");
      const dir = join(base, "env");
      mkdirSync(dir);
      ex = await createOsExecutor({
        dir,
        policy: () => ({
          ...DEFAULT_POLICY,
          allowedDomains: ["one.example.com", "two.example.com", ...extraDomains],
        }),
        home: fakeHome,
        denyRead: [state],
      });
      expect(await ex.ensureRoot()).toBe("ok");
    }, 60_000);

    afterAll(async () => {
      await ex?.dispose();
      if (base) rmSync(base, { recursive: true, force: true });
    });

    describe("file operations (in the sandboxed helper)", () => {
      it("readFile, writeFile and stat work in the workspace and tmp roots", async () => {
        const f = join(ex.roots.workspace, "a/b.txt");
        await ex.writeFile(f, Buffer.from("hello"));
        expect(readFileSync(f, "utf8")).toBe("hello");
        expect(await ex.stat(f)).toEqual({ size: 5, isDir: false });
        expect(await ex.stat(join(ex.roots.workspace, "a"))).toEqual(
          expect.objectContaining({ isDir: true }),
        );
        const r = await ex.readFile(f, 3);
        expect(Buffer.from(r?.data ?? []).toString()).toBe("hel");
        expect(r?.truncated).toBe(true);
        const whole = await ex.readFile(f, 100);
        expect(whole?.truncated).toBe(false);
        expect(await ex.readFile(join(ex.roots.workspace, "missing"), 10)).toBeNull();
        expect(await ex.readFile(join(ex.roots.workspace, "a"), 10)).toBeNull();
        expect(await ex.stat(join(ex.roots.workspace, "missing"))).toBeNull();
        const bin = randomBytes(70_000);
        await ex.writeFile(join(ex.roots.tmp, "bin"), bin);
        expect(
          Buffer.from((await ex.readFile(join(ex.roots.tmp, "bin"), 1e6))?.data ?? []),
        ).toEqual(bin);
      });

      it("a symlink in the workspace pointing outside is refused by readFile", async () => {
        const secret = join(base, "secret.txt");
        writeFileSync(secret, "top secret");
        symlinkSync(secret, join(ex.roots.workspace, "link"));
        await expect(ex.readFile(join(ex.roots.workspace, "link"), 100)).rejects.toMatchObject({
          kind: "policy",
        });
        await expect(ex.stat(join(ex.roots.workspace, "link"))).rejects.toBeInstanceOf(
          DeviceOpError,
        );
        await expect(
          ex.writeFile(join(ex.roots.workspace, "link"), Buffer.from("x")),
        ).rejects.toMatchObject({ kind: "policy" });
        expect(readFileSync(secret, "utf8")).toBe("top secret");
      });

      it("a symlinked directory pointing outside is refused by writeFile", async () => {
        const outside = join(base, "outside");
        mkdirSync(outside);
        symlinkSync(outside, join(ex.roots.workspace, "out"));
        await expect(
          ex.writeFile(join(ex.roots.workspace, "out/new/x.txt"), Buffer.from("x")),
        ).rejects.toMatchObject({ kind: "policy" });
        expect(existsSync(join(outside, "new"))).toBe(false);
      });

      it("a FIFO is refused without hanging", async () => {
        const fifo = join(ex.roots.workspace, "fifo");
        execFileSync("mkfifo", [fifo]);
        const t0 = Date.now();
        await expect(ex.readFile(fifo, 100)).rejects.toMatchObject({ kind: "policy" });
        await expect(ex.writeFile(fifo, Buffer.from("x"))).rejects.toBeInstanceOf(DeviceOpError);
        expect(Date.now() - t0).toBeLessThan(10_000);
      });

      it("a parent directory swapped for a symlink mid-operation never leaks or writes outside", async () => {
        const ws = ex.roots.workspace;
        // `state` is read-denied and not writable to the sandbox, like ~/.ssh or credential.json.
        const swapper = spawn(
          "/bin/bash",
          [
            "-c",
            `cd '${ws}'; while true; do rm -rf d; mkdir d; echo inside > d/f; rm -rf d; ln -s '${state}' d; done`,
          ],
          { stdio: "ignore", detached: true },
        );
        try {
          const until = Date.now() + 3000;
          let ops = 0;
          while (Date.now() < until) {
            const r = await ex.readFile(join(ws, "d/f"), 100).catch(() => null);
            expect(Buffer.from(r?.data ?? []).toString()).not.toContain("OUTSIDE");
            await ex.writeFile(join(ws, "d/w"), Buffer.from("w")).catch(() => {});
            ops++;
          }
          expect(ops).toBeGreaterThan(3);
        } finally {
          if (swapper.pid !== undefined) process.kill(-swapper.pid, "SIGKILL");
        }
        expect(existsSync(join(state, "w"))).toBe(false);
        expect(readFileSync(join(state, "f"), "utf8")).toBe("OUTSIDE SECRET");
      }, 30_000);
    });

    it("runs a command in the workspace with HOME and TMPDIR set", async () => {
      const r = await ex.exec(
        execArgs('pwd; echo "$HOME"; echo "$TMPDIR"; echo "$FOO"', { env: { FOO: "it's" } }),
        never,
      );
      expect(r).toMatchObject({ exitCode: 0, timedOut: false, truncated: false });
      expect(r.stdout.trim().split("\n")).toEqual([
        ex.roots.workspace,
        ex.roots.workspace,
        ex.roots.tmp,
        "it's",
      ]);
      const w = await ex.exec(execArgs("echo hi > f.txt && cat f.txt; exit 3"), never);
      expect(w).toMatchObject({ exitCode: 3, stdout: "hi\n" });
    });

    it("an asdf-style shim finds its install under the real home, read only", async () => {
      const saved = process.env.ASDF_DATA_DIR;
      delete process.env.ASDF_DATA_DIR;
      try {
        const asdf = join(fakeHome, ".asdf");
        const install = join(asdf, "installs/fakepy/1.0/bin");
        mkdirSync(install, { recursive: true });
        mkdirSync(join(asdf, "shims"), { recursive: true });
        writeFileSync(join(install, "fakepy"), "#!/bin/sh\necho fakepy 1.0\n");
        // as asdf's shims do: the data directory defaults to $HOME/.asdf
        writeFileSync(
          join(asdf, "shims/fakepy"),
          '#!/bin/sh\nd="$ASDF_DATA_DIR"\n[ -n "$d" ] || d="$HOME/.asdf"\n[ -x "$d/installs/fakepy/1.0/bin/fakepy" ] || { echo "unknown command: fakepy. Perhaps you have to reshim?" >&2; exit 126; }\nexec "$d/installs/fakepy/1.0/bin/fakepy"\n',
        );
        chmodSync(join(install, "fakepy"), 0o755);
        chmodSync(join(asdf, "shims/fakepy"), 0o755);
        const r = await ex.exec(
          execArgs(`echo "$ASDF_DATA_DIR"; '${join(asdf, "shims/fakepy")}'`),
          never,
        );
        expect(r).toMatchObject({ exitCode: 0, stderr: "" });
        expect(r.stdout).toBe(`${asdf}\nfakepy 1.0\n`);
        // the data directory is readable, never writable
        const w = await ex.exec(execArgs('touch "$ASDF_DATA_DIR/written"'), never);
        expect(w.exitCode).not.toBe(0);
        expect(existsSync(join(asdf, "written"))).toBe(false);
        // the request's own value wins
        const own = await ex.exec(
          execArgs('echo "$ASDF_DATA_DIR"', { env: { ASDF_DATA_DIR: "/own" } }),
          never,
        );
        expect(own.stdout).toBe("/own\n");
      } finally {
        if (saved !== undefined) process.env.ASDF_DATA_DIR = saved;
      }
    });

    it("the request env applies only inside the sandbox", async () => {
      const ws = ex.roots.workspace;
      const marker = (n: string) => join(base, `escaped-${n}`);
      writeFileSync(join(ws, "env"), `#!/bin/sh\ntouch '${marker("env")}'\n`);
      writeFileSync(join(ws, "sandbox-exec"), `#!/bin/sh\ntouch '${marker("sbx")}'\n`);
      writeFileSync(join(ws, "bwrap"), `#!/bin/sh\ntouch '${marker("bwrap")}'\n`);
      writeFileSync(join(ws, "rc"), `touch '${marker("rc")}'\n`);
      for (const f of ["env", "sandbox-exec", "bwrap"]) chmodSync(join(ws, f), 0o755);
      const r = await ex.exec(
        execArgs("echo ran", {
          env: { PATH: ws, BASH_ENV: join(ws, "rc"), SHLVL: "1", LD_PRELOAD: join(ws, "x.so") },
        }),
        never,
      );
      expect(r.stdout).toContain("ran");
      for (const n of ["env", "sbx", "bwrap", "rc"]) expect(existsSync(marker(n))).toBe(false);
      await expect(
        ex.exec(execArgs("true", { env: { "A;touch /tmp/x": "1" } }), never),
      ).rejects.toMatchObject({ kind: "policy" });
    });

    it("write outside the root is refused", async () => {
      // HOME inside the sandbox is the workspace, so name the real home explicitly.
      const target = join(homedir(), `.capybara-device-test-${randomBytes(6).toString("hex")}`);
      try {
        const r = await ex.exec(execArgs(`touch '${target}'`), never);
        expect(r.exitCode).not.toBe(0);
        expect(existsSync(target)).toBe(false);
        const t = await ex.exec(execArgs("touch /tmp/claude/capybara-device-test"), never);
        expect(t.exitCode).not.toBe(0);
        const s = await ex.exec(execArgs(`echo x > '${join(ex.roots.skills, "s.md")}'`), never);
        expect(s.exitCode).not.toBe(0);
        expect(existsSync(join(ex.roots.skills, "s.md"))).toBe(false);
      } finally {
        rmSync(target, { force: true });
      }
    });

    it("reading ~/.ssh is denied", async () => {
      const r = await ex.exec(execArgs(`cat '${join(fakeHome, ".ssh/id_rsa")}'`), never);
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).not.toContain("PRIVATE KEY");
    });

    it("reading the program's credential.json is denied", async () => {
      const r = await ex.exec(execArgs(`cat '${join(state, "credential.json")}'`), never);
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).not.toContain("cap_dev_");
    });

    it("timeout kills the command and its children", async () => {
      const pids = join(ex.roots.workspace, "pids");
      const r = await ex.exec(
        execArgs(
          `sleep 1000 & echo $! > ${pids}; nohup sleep 1001 > /dev/null 2>&1 & echo $! >> ${pids}; sleep 1002`,
          { timeoutMs: 1500 },
        ),
        never,
      );
      expect(r).toMatchObject({ exitCode: null, timedOut: true });
      const list = readFileSync(pids, "utf8").trim().split("\n").map(Number);
      expect(list).toHaveLength(2);
      if (process.platform === "darwin") await waitFor(() => list.every((p) => !alive(p)));
    }, 20_000);

    it("abort kills the running command", async () => {
      const ac = new AbortController();
      const p = ex.exec(execArgs("sleep 1000"), ac.signal);
      setTimeout(() => ac.abort(), 300);
      const r = await p;
      expect(r).toMatchObject({ exitCode: null, timedOut: false });
    }, 20_000);

    it("killTagged kills only the commands with that exact tag; killAll kills the rest", async () => {
      const a = ex.exec(execArgs("sleep 1000", { tag: "ab" }), never);
      const b = ex.exec(execArgs("sleep 1000", { tag: "ab-cd" }), never);
      await sleep(300);
      await ex.killTagged(["ab"]);
      expect((await a).exitCode).toBeNull();
      let bDone = false;
      void b.then(() => {
        bDone = true;
      });
      await sleep(200);
      expect(bDone).toBe(false);
      await ex.killAll();
      expect((await b).exitCode).toBeNull();
    }, 20_000);

    it("output is capped at maxOutputBytes, combined, on a UTF-8 boundary", async () => {
      const r = await ex.exec(
        execArgs("for i in $(seq 1 2000); do printf '€'; done; echo err >&2", {
          maxOutputBytes: 1000,
        }),
        never,
      );
      expect(r.truncated).toBe(true);
      expect(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(1000);
      expect(r.stdout).toMatch(/^(€)+$/);
    });

    it.runIf(process.platform === "darwin")(
      "killTagged reaches background children after the command returned",
      async () => {
        const t0 = Date.now();
        const r = await ex.exec(
          execArgs("sleep 1000 & echo $!; nohup sleep 1001 > /dev/null 2>&1 & echo $!; echo done", {
            tag: "bg",
          }),
          never,
        );
        // A background child holding the pipes does not hold the result, and its clean exit stands.
        expect(r.exitCode).toBe(0);
        expect(Date.now() - t0).toBeLessThan(5000);
        const pids = r.stdout.trim().split("\n").slice(0, 2).map(Number);
        expect(pids.every(alive)).toBe(true);
        await ex.killTagged(["other"]);
        expect(pids.every(alive)).toBe(true);
        await ex.killTagged(["bg"]);
        await waitFor(() => pids.every((p) => !alive(p)));
      },
      20_000,
    );

    it.runIf(process.platform === "darwin")(
      "killTagged reaches a child that left the process group (by the device marker)",
      async () => {
        const node = process.execPath;
        const script = `const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1e6)'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)`;
        const r = await ex.exec(execArgs(`'${node}' -e "${script}"`, { tag: "esc" }), never);
        expect(r.exitCode).toBe(0);
        const pid = Number(r.stdout.trim());
        expect(alive(pid)).toBe(true);
        expect(await findMarked((v) => v === ex.markerOf("esc"))).toContain(pid);
        await ex.killTagged(["esc"]);
        await waitFor(() => !alive(pid));
      },
      20_000,
    );

    it("a cwd outside the roots is refused", async () => {
      await expect(ex.exec(execArgs("pwd", { cwd: base }), never)).rejects.toMatchObject({
        kind: "policy",
      });
    });

    describe.skipIf(!hasCurl())("network (the proxy refuses before any connection)", () => {
      const curl = (host: string) =>
        `curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://${host}/`;

      it("egress none denies every host", async () => {
        const r = await ex.exec(execArgs(curl("one.example.com")), never);
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toMatch(/403/);
      });

      it("open egress still denies a host outside the local policy", async () => {
        const r = await ex.exec(
          execArgs(curl("github.com"), { limits: { ...LIMITS, egress: "open" } }),
          never,
        );
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toMatch(/403/);
      });

      it("a host the device does not allow gets the device trailer", async () => {
        const r = await ex.exec(
          execArgs(curl("github.com"), { limits: { ...LIMITS, egress: "open" } }),
          never,
        );
        expect(r.stderr).toContain(
          "[capybara-device] Network access was blocked:\n" +
            "- github.com:443: not in this device's allowed domains. Only the device owner can " +
            "allow it (capybara-device policy add allowedDomains github.com, or the device page).",
        );
      });

      it("a host the org does not allow gets the org trailer", async () => {
        const r = await ex.exec(execArgs(curl("one.example.com")), never);
        expect(r.stderr).toContain(
          "- one.example.com:443: not in the organization's network allowlist. " +
            "Only an organization admin can add it.",
        );
        expect(r.stderr).not.toContain("not in this device's allowed domains");
      });

      it("a policy change applies at the next command, without a restart", async () => {
        const open = { limits: { ...LIMITS, egress: "open" as const } };
        // `.invalid` never resolves: once allowed, the proxy fails the lookup, connecting nowhere.
        const before = await ex.exec(execArgs(curl("allowed.invalid"), open), never);
        expect(before.stderr).toContain("- allowed.invalid:443: not in this device's allowed");
        extraDomains = ["allowed.invalid"];
        try {
          const after = await ex.exec(execArgs(curl("allowed.invalid"), open), never);
          expect(after.exitCode).not.toBe(0);
          expect(after.stderr).not.toContain("[capybara-device]");
        } finally {
          extraDomains = [];
        }
      }, 30_000);

      it("two concurrent commands each get only their own allow list", async () => {
        const allow = (h: string): SandboxLimits => ({
          ...LIMITS,
          egress: "allowlist",
          allowHosts: [h],
        });
        const [a, b] = await Promise.all([
          ex.exec(
            execArgs(`sleep 0.5; ${curl("two.example.com")}`, { limits: allow("one.example.com") }),
            never,
          ),
          ex.exec(
            execArgs(`sleep 0.5; ${curl("one.example.com")}`, { limits: allow("two.example.com") }),
            never,
          ),
        ]);
        expect(a.stderr).toMatch(/403/);
        expect(b.stderr).toMatch(/403/);
      }, 30_000);
    });
  },
);

describe.skipIf(!availability.ok || process.platform !== "linux")(
  "OsExecutor on Linux: the pid namespace",
  () => {
    let base: string;
    let ex: OsExecutor;
    beforeAll(async () => {
      base = tmp("device-ns-");
      mkdirSync(join(base, "env"));
      ex = await createOsExecutor({ dir: join(base, "env"), policy: () => DEFAULT_POLICY });
      await ex.ensureRoot();
    }, 60_000);
    afterAll(async () => {
      await ex?.dispose();
      if (base) rmSync(base, { recursive: true, force: true });
    });

    it("a setsid child dies with its command", async () => {
      const r = await ex.exec(
        execArgs("setsid sleep 1001 > /dev/null 2>&1 < /dev/null & echo started", { tag: "ns" }),
        new AbortController().signal,
      );
      expect(r.stdout).toContain("started");
      await waitFor(async () => (await findMarked((v) => v === ex.markerOf("ns"))).length === 0);
    }, 20_000);
  },
);

describe.skipIf(!availability.ok || process.platform !== "darwin")(
  "OsExecutor on macOS: tier dev",
  () => {
    let base: string;
    let ex: OsExecutor;
    const never = new AbortController().signal;
    const DEV: SandboxLimits = { ...LIMITS, tier: "dev", defaultTier: "dev" };
    const node = `'${process.execPath}'`;
    // Listens on `addr` (a port 0 on loopback, or a socket path), connects back, prints the reply.
    const echo = (addr: string) =>
      `${node} -e "const n=require('net');const s=n.createServer(c=>c.end('hi')).on('error',e=>{console.log('ERR '+e.code);process.exit(0)});s.listen(${addr},()=>{const a=s.address();n.connect(typeof a==='string'?a:a.port,'127.0.0.1').on('data',d=>{console.log(String(d));process.exit(0)}).on('error',e=>{console.log('ERR '+e.code);process.exit(0)})})"`;

    beforeAll(async () => {
      base = tmp("device-dev-");
      mkdirSync(join(base, "env"));
      mkdirSync(join(base, "s"));
      ex = await createOsExecutor({
        dir: join(base, "env"),
        policy: () => DEFAULT_POLICY,
        // Not the real /private/tmp: a test leaves nothing behind there.
        socketBase: join(base, "s"),
        detectProxy: async () => ({ detected: false, reasons: [] }),
      });
      await ex.ensureRoot();
    }, 60_000);
    afterAll(async () => {
      await ex?.dispose();
      if (base) rmSync(base, { recursive: true, force: true });
    });

    it("TMPDIR is the short socket directory, where a unix socket works", async () => {
      const r = await ex.exec(execArgs('printf "%s" "$TMPDIR"', { limits: DEV }), never);
      expect(r.stdout).toMatch(new RegExp(`^${join(base, "s")}/cap-[0-9a-f]{8}$`));
      const s = await ex.exec(
        execArgs(echo(`process.env.TMPDIR+'/s.sock'`), { limits: DEV }),
        never,
      );
      expect(s.stdout.trim()).toBe("hi");
    }, 30_000);

    it("a local server listens and answers on loopback; strict refuses it", async () => {
      const r = await ex.exec(execArgs(echo("0,'127.0.0.1'"), { limits: DEV }), never);
      expect(r.stdout.trim()).toBe("hi");
      const strict = await ex.exec(execArgs(echo("0,'127.0.0.1'")), never);
      expect(strict.stdout.trim()).toMatch(/^ERR/);
    }, 30_000);

    it("package caches are writable under the device's cache folder", async () => {
      const r = await ex.exec(
        execArgs('mkdir -p "$npm_config_cache/x" && echo ok > "$npm_config_cache/x/f" && echo ok', {
          limits: DEV,
        }),
        never,
      );
      expect(r.stdout.trim()).toBe("ok");
      expect(readFileSync(join(base, "env", "cache", "npm", "x", "f"), "utf8")).toBe("ok\n");
    }, 30_000);
  },
);

// The kernel's background task scripts (spec 2026-11-05-background-bash-design §4.2), run by the
// real OS executor: a macOS device has no setsid, no GNU timeout and no `pgrep -s`, and its sandbox
// lets no command list or signal another command's processes.

describe.skipIf(!availability.ok || process.platform !== "darwin")(
  "background tasks on a macOS OS-sandboxed device",
  () => {
    let base: string;
    let ex: OsExecutor;
    const never = new AbortController().signal;
    const DEV: SandboxLimits = { ...LIMITS, tier: "dev", defaultTier: "dev" };

    beforeAll(async () => {
      base = tmp("device-bg-");
      mkdirSync(join(base, "env"));
      mkdirSync(join(base, "s"));
      ex = await createOsExecutor({
        dir: join(base, "env"),
        policy: () => DEFAULT_POLICY,
        socketBase: join(base, "s"),
        detectProxy: async () => ({ detected: false, reasons: [] }),
      });
      await ex.ensureRoot();
    }, 60_000);
    afterAll(async () => {
      await ex?.dispose();
      if (base) rmSync(base, { recursive: true, force: true });
    });

    const run = (command: string, over: Partial<DeviceExecArgs> = {}) =>
      ex.exec(
        {
          command,
          cwd: ex.roots.workspace,
          timeoutMs: 20_000,
          maxOutputBytes: 64 * 1024,
          tag: "bg",
          actor: { accountId: "acc", conversationId: "conv" },
          limits: LIMITS,
          ...over,
        },
        never,
      );
    const task = (id: string, ext: string) =>
      join(ex.roots.workspace, ".capybara", "tasks", `${id}.${ext}`);
    const fileOf = (id: string, ext: string): string | null => {
      try {
        return readFileSync(task(id, ext), "utf8");
      } catch {
        return null;
      }
    };
    /** Whether the task still has a process, asked inside the sandbox as the poll asks. */
    const alive = async (sid: string): Promise<boolean> =>
      (await run(`${SESSION_MODE_SCRIPT}\ntk_alive ${sid}`)).exitCode === 0;
    const launch = async (
      id: string,
      command: string,
      seconds: number,
      limits: SandboxLimits = LIMITS,
    ) => {
      const r = await run(launchScript(id, command, seconds), { limits });
      expect(r).toMatchObject({ exitCode: 0, stderr: "" });
      expect(r.stdout).toMatch(/^[1-9][0-9]*\n$/);
      return r.stdout.trim();
    };

    it("selects the process group (-g) on macOS", async () => {
      expect((await run(`${SESSION_MODE_SCRIPT}\necho "$pg"`)).stdout).toBe("-g\n");
    }, 30_000);

    it("starts, outlives the launch exec, and leaves its output and exit status", async () => {
      const t0 = Date.now();
      const sid = await launch("bt_mac222", "echo out; echo err >&2; sleep 2; exit 3", 60);
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(fileOf("bt_mac222", "sid")).toBe(`${sid}\n`);
      // the launch exec is over and the task still runs
      expect(await alive(sid)).toBe(true);
      expect(fileOf("bt_mac222", "exit")).toBeNull();
      await waitFor(() => fileOf("bt_mac222", "exit") !== null);
      expect(fileOf("bt_mac222", "exit")).toBe("3\n");
      expect(fileOf("bt_mac222", "out")).toBe("out\nerr\n");
      await waitFor(async () => !(await alive(sid)));
    }, 30_000);

    it("the task ends with its command: what it left running is killed", async () => {
      const sid = await launch("bt_macabc", "sleep 300 > /dev/null 2>&1 & echo left", 60);
      await waitFor(() => fileOf("bt_macabc", "exit") !== null);
      expect(fileOf("bt_macabc", "exit")).toBe("0\n");
      await waitFor(async () => !(await alive(sid)));
    }, 30_000);

    it("runs the command with bash and keeps it byte for byte", async () => {
      const command = `[[ 1 == 1 ]] && echo ok; echo {1..3}; echo 'q "d" $HOME \`x\`'`;
      await launch("bt_mac333", command, 60);
      await waitFor(() => fileOf("bt_mac333", "exit") !== null);
      expect(fileOf("bt_mac333", "sh")).toBe(command);
      expect(fileOf("bt_mac333", "out")).toBe('ok\n1 2 3\nq "d" $HOME `x`\n');
      expect(fileOf("bt_mac333", "exit")).toBe("0\n");
    }, 30_000);

    it("works at tier dev too", async () => {
      const sid = await launch("bt_mac444", "echo dev", 60, DEV);
      await waitFor(() => fileOf("bt_mac444", "exit") !== null);
      expect(fileOf("bt_mac444", "out")).toBe("dev\n");
      await waitFor(async () => !(await alive(sid)));
    }, 30_000);

    it("the time limit SIGKILLs the whole tree, a child that ignores SIGTERM too: exit 137", async () => {
      const sid = await launch(
        "bt_mac555",
        `trap "" TERM; (trap "" TERM; sleep 300) & echo started; sleep 300`,
        2,
      );
      await waitFor(() => fileOf("bt_mac555", "out") === "started\n");
      await waitFor(() => fileOf("bt_mac555", "exit") !== null, 15_000);
      expect(fileOf("bt_mac555", "exit")).toBe("137\n");
      await waitFor(async () => !(await alive(sid)));
    }, 30_000);

    it("a stop (SIGTERM, then SIGKILL of the group) kills the whole tree", async () => {
      const sid = await launch("bt_mac666", "sleep 300 & sleep 300 & wait", 60);
      const term = await run(termScript("bt_mac666", sid));
      expect(term.stdout.trim()).toBe("term");
      expect(await alive(sid)).toBe(false);

      // a tree that ignores SIGTERM survives the term and dies with the SIGKILL of the group
      const stubborn = await launch(
        "bt_mac777",
        `trap "" TERM; (trap "" TERM; sleep 300) & sleep 300`,
        60,
      );
      expect((await run(termScript("bt_mac777", stubborn))).stdout.trim()).toBe("term");
      expect(await alive(stubborn)).toBe(true);
      const kill = await run(`${killSessionScript(stubborn)}; exit "$ks"`);
      expect(kill.exitCode).toBe(0);
      expect(await alive(stubborn)).toBe(false);
    }, 40_000);
  },
);
