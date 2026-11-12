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
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceExecArgs, SandboxLimits } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostExecutor } from "../src/exec/host.js";
import { findMarked } from "../src/exec/procs.js";
import { osRoots } from "../src/exec/shared.js";
import { execIsolation, SwitchingExecutor } from "../src/exec/switch.js";
import { DEFAULT_POLICY, type Policy } from "../src/state.js";
import { FakeExecutor } from "./fake-kernel.js";

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = new AbortController().signal;

const LIMITS: SandboxLimits = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  egress: "allowlist",
  allowHosts: [],
  tier: "open",
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

describe("HostExecutor: commands without a sandbox", () => {
  let base: string;
  let ex: HostExecutor;

  beforeAll(async () => {
    base = tmp("device-host-");
    const dir = join(base, "env");
    mkdirSync(dir);
    ex = new HostExecutor({
      dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: base, HOST_ONLY: "from-program" },
    });
    expect(await ex.ensureRoot()).toBe("ok");
  });

  afterAll(async () => {
    await ex?.dispose();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("reports the OS mode's roots", () => {
    expect(ex.mode).toBe("os");
    expect(ex.roots).toEqual(osRoots(join(base, "env")));
  });

  it("runs in the workspace with the program's environment, the request's and the marker", async () => {
    const r = await ex.exec(
      execArgs('pwd; echo "$HOME"; echo "$HOST_ONLY"; echo "$REQ"; echo "$CAPYBARA_EXEC"', {
        env: { REQ: "from-request", HOST_ONLY: "overridden" },
        tag: "envtag",
      }),
      never,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      ex.roots.workspace,
      base,
      "overridden",
      "from-request",
      ex.markerOf("envtag"),
    ]);
  });

  it("reaches the rest of the machine (no sandbox)", async () => {
    const outside = join(base, "outside.txt");
    const r = await ex.exec(execArgs(`echo hi > '${outside}' && cat '${outside}'`), never);
    expect(r.stdout.trim()).toBe("hi");
    expect(readFileSync(outside, "utf8")).toBe("hi\n");
  });

  it("an invalid request environment name is a policy error", async () => {
    await expect(ex.exec(execArgs("true", { env: { "A-B": "x" } }), never)).rejects.toMatchObject({
      kind: "policy",
    });
  });

  it("a cwd outside the roots, or leaving them by a link, is refused", async () => {
    await expect(ex.exec(execArgs("pwd", { cwd: base }), never)).rejects.toMatchObject({
      kind: "policy",
    });
    symlinkSync(base, join(ex.roots.workspace, "out"));
    await expect(
      ex.exec(execArgs("pwd", { cwd: join(ex.roots.workspace, "out") }), never),
    ).rejects.toMatchObject({ kind: "policy" });
  });

  it("an already-aborted signal starts nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      ex.exec(execArgs(`touch '${join(ex.roots.workspace, "ran")}'`), ac.signal),
    ).rejects.toThrow();
    expect(existsSync(join(ex.roots.workspace, "ran"))).toBe(false);
  });

  it("reports the exit code, and 128 + n for a signal it killed itself with", async () => {
    expect((await ex.exec(execArgs("exit 7"), never)).exitCode).toBe(7);
    expect((await ex.exec(execArgs("kill -TERM $$"), never)).exitCode).toBe(128 + 15);
  });

  it("timeout kills the command and its children", async () => {
    const pids = join(ex.roots.workspace, "pids");
    const r = await ex.exec(
      execArgs(
        `sleep 1000 & echo $! > '${pids}'; nohup sleep 1001 > /dev/null 2>&1 & echo $! >> '${pids}'; sleep 1002`,
        { timeoutMs: 1000 },
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
    expect(await p).toMatchObject({ exitCode: null, timedOut: false });
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

  it("killTagged reaches background children after the command returned", async () => {
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
  }, 20_000);

  it("killTagged reaches a child that left the process group (by the device marker)", async () => {
    const script = `const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1e6)'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)`;
    const r = await ex.exec(
      execArgs(`'${process.execPath}' -e "${script}"`, { tag: "esc" }),
      never,
    );
    expect(r.exitCode).toBe(0);
    const pid = Number(r.stdout.trim());
    expect(alive(pid)).toBe(true);
    expect(await findMarked((v) => v === ex.markerOf("esc"))).toContain(pid);
    await ex.killTagged(["esc"]);
    await waitFor(() => !alive(pid));
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

  it("file operations stay inside the roots", async () => {
    const f = join(ex.roots.workspace, "dir/a.txt");
    await ex.writeFile(f, Buffer.from("hello"));
    expect(await ex.stat(f)).toEqual({ size: 5, isDir: false });
    expect(Buffer.from((await ex.readFile(f, 3))?.data ?? []).toString()).toBe("hel");
    expect(await ex.readFile(join(ex.roots.tmp, "missing"), 10)).toBeNull();
    writeFileSync(join(base, "secret"), "S");
    await expect(ex.readFile(join(base, "secret"), 10)).rejects.toMatchObject({ kind: "policy" });
    await expect(
      ex.writeFile(join(ex.roots.workspace, "out/x"), Buffer.from("x")),
    ).rejects.toMatchObject({
      kind: "policy",
    });
    expect(existsSync(join(base, "x"))).toBe(false);
  });
});

describe("execIsolation: when a command runs without a sandbox", () => {
  const p = (over: Partial<Policy>): Policy => ({ ...DEFAULT_POLICY, ...over });

  it("only with isolation none, OS mode and tier open after the ceiling", () => {
    expect(execIsolation(p({ tier: "open", isolation: "none" }), { tier: "open" }, "os")).toEqual({
      tier: "open",
      isolation: "none",
    });
    // The org's default counts when the owner chose no tier.
    expect(
      execIsolation(p({ isolation: "none" }), { tier: "open", defaultTier: "open" }, "os"),
    ).toEqual({ tier: "open", isolation: "none" });
    expect(execIsolation(p({ tier: "open" }), { tier: "open" }, "os")).toEqual({
      tier: "open",
      isolation: "sandbox",
    });
  });

  it("Docker mode ignores isolation", () => {
    expect(
      execIsolation(p({ tier: "open", isolation: "none" }), { tier: "open" }, "docker"),
    ).toEqual({ tier: "open", isolation: "sandbox" });
    expect(
      execIsolation(p({ tier: "open", isolation: "none" }), { tier: "dev" }, "docker"),
    ).toEqual({ tier: "dev", isolation: "sandbox" });
  });

  it("refuses, naming why, when the tier is below open", () => {
    expect(execIsolation(p({ tier: "open", isolation: "none" }), { tier: "dev" }, "os")).toEqual({
      tier: "dev",
      isolation: "none",
      refusal:
        "This device is set to run commands without a sandbox, but the organization allows at " +
        "most the dev tier, and running without a sandbox needs tier open. The device's owner " +
        "can turn the sandbox back on with capybara-device policy set isolation sandbox.",
    });
    expect(
      execIsolation(p({ isolation: "none" }), { tier: "open", defaultTier: "dev" }, "os"),
    ).toEqual({
      tier: "dev",
      isolation: "none",
      refusal:
        "This device is set to run commands without a sandbox, but its tier is dev; running " +
        "without a sandbox needs tier open. On this machine, run capybara-device policy set " +
        "tier open, or turn the sandbox back on with capybara-device policy set isolation sandbox.",
    });
  });
});

describe("SwitchingExecutor", () => {
  const never = new AbortController().signal;
  let policy: Policy;
  let sandboxed: FakeExecutor;
  let host: FakeExecutor;
  let switches: string[];
  let ex: SwitchingExecutor;
  const tierArgs = (tier: SandboxLimits["tier"], tag = "t1") =>
    execArgs("now", { tag, limits: { ...LIMITS, tier } });

  const setup = () => {
    policy = { ...DEFAULT_POLICY };
    sandboxed = new FakeExecutor();
    host = new FakeExecutor();
    sandboxed.files.set("/f", Buffer.from("sandboxed"));
    host.files.set("/f", Buffer.from("host"));
    switches = [];
    ex = new SwitchingExecutor(
      sandboxed,
      host,
      () => policy,
      (i) => switches.push(i),
    );
  };

  it("runs in the sandbox by default and switches at the next command after a policy change", async () => {
    setup();
    expect(ex.mode).toBe("os");
    expect(ex.roots).toBe(sandboxed.roots);
    await ex.exec(tierArgs("open"), never);
    expect(sandboxed.started).toEqual(["now"]);
    expect(Buffer.from((await ex.readFile("/f", 100))?.data ?? []).toString()).toBe("sandboxed");
    policy = { ...policy, tier: "open", isolation: "none" };
    // File operations follow the last command: still sandboxed until one ran without.
    expect(Buffer.from((await ex.readFile("/f", 100))?.data ?? []).toString()).toBe("sandboxed");
    await ex.exec(tierArgs("open"), never);
    expect(host.started).toEqual(["now"]);
    expect(switches).toEqual(["none"]);
    expect(Buffer.from((await ex.readFile("/f", 100))?.data ?? []).toString()).toBe("host");
    // Turning the sandbox back on applies to file operations at once and to the next command.
    policy = { ...policy, isolation: "sandbox" };
    expect(Buffer.from((await ex.readFile("/f", 100))?.data ?? []).toString()).toBe("sandboxed");
    await ex.exec(tierArgs("open"), never);
    expect(sandboxed.started).toEqual(["now", "now"]);
    expect(switches).toEqual(["none", "sandbox"]);
  });

  it("refuses a command the policy wants unsandboxed below tier open, never runs it sandboxed", async () => {
    setup();
    policy = { ...policy, tier: "open", isolation: "none" };
    await expect(ex.exec(tierArgs("dev"), never)).rejects.toMatchObject({
      kind: "policy",
      message: expect.stringContaining("allows at most the dev tier"),
    });
    expect(sandboxed.started).toEqual([]);
    expect(host.started).toEqual([]);
  });

  it("kills reach both executors' commands", async () => {
    setup();
    await ex.killTagged(["a"]);
    expect(sandboxed.killed).toEqual([["a"]]);
    expect(host.killed).toEqual([["a"]]);
  });
});
