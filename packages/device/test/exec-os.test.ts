import { randomBytes } from "node:crypto";
import {
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
import {
  createOsExecutor,
  OsExecutor,
  osRoots,
  sandboxAvailability,
  utf8Prefix,
} from "../src/exec/os.js";
import { DeviceOpError } from "../src/exec/types.js";
import { DEFAULT_POLICY } from "../src/state.js";

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

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

describe("OsExecutor: roots and file operations", () => {
  let base: string;
  let dir: string;
  let ex: OsExecutor;
  beforeEach(() => {
    base = tmp("device-os-");
    dir = join(base, "env");
    mkdirSync(dir);
    ex = new OsExecutor({ dir, policy: DEFAULT_POLICY });
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
    expect(await new OsExecutor({ dir, policy: DEFAULT_POLICY }).ensureRoot()).toBe("gone");
  });

  it("the marker vanishing while the directory stays is gone in this process", async () => {
    expect(await ex.ensureRoot()).toBe("ok");
    rmSync(join(dir, ".capybara-device"));
    expect(await ex.ensureRoot()).toBe("gone");
  });

  it("readFile, writeFile and stat work under the roots; writeFile may write skills", async () => {
    await ex.ensureRoot();
    const f = join(ex.roots.workspace, "a/b.txt");
    await ex.writeFile(f, Buffer.from("hello"));
    expect(await ex.stat(f)).toEqual({ size: 5, isDir: false });
    expect(await ex.stat(join(ex.roots.workspace, "a"))).toEqual(
      expect.objectContaining({ isDir: true }),
    );
    const r = await ex.readFile(f, 3);
    expect(Buffer.from(r?.data ?? []).toString()).toBe("hel");
    expect(r?.truncated).toBe(true);
    expect(await ex.readFile(join(ex.roots.workspace, "missing"), 10)).toBeNull();
    expect(await ex.readFile(join(ex.roots.workspace, "a"), 10)).toBeNull();
    expect(await ex.stat(join(ex.roots.workspace, "missing"))).toBeNull();
    await ex.writeFile(join(ex.roots.skills, "s/SKILL.md"), Buffer.from("# s"));
    expect(readFileSync(join(ex.roots.skills, "s/SKILL.md"), "utf8")).toBe("# s");
  });

  it("a symlink in the workspace pointing outside is refused by readFile", async () => {
    await ex.ensureRoot();
    const secret = join(base, "secret.txt");
    writeFileSync(secret, "top secret");
    symlinkSync(secret, join(ex.roots.workspace, "link"));
    await expect(ex.readFile(join(ex.roots.workspace, "link"), 100)).rejects.toMatchObject({
      kind: "policy",
    });
    await expect(ex.stat(join(ex.roots.workspace, "link"))).rejects.toBeInstanceOf(DeviceOpError);
    await expect(
      ex.writeFile(join(ex.roots.workspace, "link"), Buffer.from("x")),
    ).rejects.toMatchObject({ kind: "policy" });
    expect(readFileSync(secret, "utf8")).toBe("top secret");
  });

  it("a symlinked directory pointing outside is refused by writeFile", async () => {
    await ex.ensureRoot();
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(ex.roots.workspace, "out"));
    await expect(
      ex.writeFile(join(ex.roots.workspace, "out/new/x.txt"), Buffer.from("x")),
    ).rejects.toMatchObject({ kind: "policy" });
    expect(existsSync(join(outside, "new"))).toBe(false);
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

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const availability = sandboxAvailability();
if (!availability.ok) {
  console.warn(`exec-os: sandbox tests skipped: ${availability.reason}`);
}

describe.skipIf(!availability.ok)("OsExecutor: commands in the OS sandbox", () => {
  let base: string;
  let fakeHome: string;
  let ex: OsExecutor;
  const never = new AbortController().signal;

  beforeAll(async () => {
    base = tmp("device-sbx-");
    fakeHome = join(base, "home");
    mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
    writeFileSync(join(fakeHome, ".ssh/id_rsa"), "PRIVATE KEY");
    const dir = join(base, "env");
    mkdirSync(dir);
    ex = await createOsExecutor({
      dir,
      policy: DEFAULT_POLICY,
      home: fakeHome,
      denyRead: [join(base, "state")],
    });
    expect(await ex.ensureRoot()).toBe("ok");
  }, 60_000);

  afterAll(async () => {
    await ex?.dispose();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("runs a command in the workspace with HOME and TMPDIR set", async () => {
    const r = await ex.exec(
      execArgs('pwd; echo "$HOME"; echo "$TMPDIR"; echo "$FOO"', { env: { FOO: "bar" } }),
      never,
    );
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, truncated: false });
    expect(r.stdout.trim().split("\n")).toEqual([
      ex.roots.workspace,
      ex.roots.workspace,
      ex.roots.tmp,
      "bar",
    ]);
    const w = await ex.exec(execArgs("echo hi > f.txt && cat f.txt; exit 3"), never);
    expect(w).toMatchObject({ exitCode: 3, stdout: "hi\n" });
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
    await waitFor(() => list.every((p) => !alive(p)));
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
    await new Promise((r) => setTimeout(r, 300));
    await ex.killTagged(["ab"]);
    expect((await a).exitCode).toBeNull();
    let bDone = false;
    void b.then(() => {
      bDone = true;
    });
    await new Promise((r) => setTimeout(r, 200));
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

  it("a background child holding the output pipes does not hold the result", async () => {
    const t0 = Date.now();
    const r = await ex.exec(execArgs("sleep 1000 & echo $!"), never);
    expect(r.exitCode).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    // A plain background child outlives its command, as in a container exec.
    process.kill(Number(r.stdout.trim()), "SIGKILL");
  });

  it("a cwd outside the roots is refused", async () => {
    await expect(ex.exec(execArgs("pwd", { cwd: base }), never)).rejects.toMatchObject({
      kind: "policy",
    });
  });
});
