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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HostExecutor } from "../src/exec/host.js";
import { findMarked } from "../src/exec/procs.js";
import { osRoots } from "../src/exec/shared.js";
import {
  FILE_OPS_DECISION_TTL_MS,
  SANDBOX_BACK_ON,
  SwitchingExecutor,
} from "../src/exec/switch.js";
import { DEFAULT_POLICY, type Policy, type SandboxMode } from "../src/state.js";
import { FakeExecutor } from "./fake-kernel.js";

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = new AbortController().signal;

const limitsWith = (mode: SandboxMode, hosts: string[] = []): SandboxLimits => ({
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  mode,
  network: { kind: "allowlist", hosts },
});

const LIMITS: SandboxLimits = limitsWith("auto");

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

  it("a cwd anywhere on the machine is allowed in auto mode", async () => {
    expect((await ex.exec(execArgs("pwd", { cwd: base }), never)).stdout.trim()).toBe(base);
    symlinkSync(base, join(ex.roots.workspace, "out"));
    expect(
      (
        await ex.exec(execArgs("pwd", { cwd: join(ex.roots.workspace, "out") }), never)
      ).stdout.trim(),
    ).toBe(base);
  });

  it("an already-aborted signal starts nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      ex.exec(execArgs(`touch '${join(ex.roots.workspace, "ran")}'`), ac.signal),
    ).rejects.toThrow();
    expect(existsSync(join(ex.roots.workspace, "ran"))).toBe(false);
  });

  it("a beforeSpawn hook that throws refuses the command before it is spawned", async () => {
    const marker = join(base, "spawned");
    const refusal = new Error("refused");
    await expect(
      ex.exec(execArgs(`touch ${marker}`), never, {
        beforeSpawn: () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    await sleep(100);
    expect(existsSync(marker)).toBe(false);
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

  it("file operations reach the machine (auto mode): shape checks only", async () => {
    const f = join(ex.roots.workspace, "dir/a.txt");
    await ex.writeFile(f, Buffer.from("hello"));
    expect(await ex.stat(f)).toEqual({ size: 5, isDir: false });
    expect(Buffer.from((await ex.readFile(f, 3))?.data ?? []).toString()).toBe("hel");
    expect(await ex.readFile(join(ex.roots.tmp, "missing"), 10)).toBeNull();
    // Outside the device directory, as the owner's own tools do.
    writeFileSync(join(base, "secret"), "S");
    expect(Buffer.from((await ex.readFile(join(base, "secret"), 10))?.data ?? []).toString()).toBe(
      "S",
    );
    await ex.writeFile(join(base, "out/x"), Buffer.from("x"));
    expect(readFileSync(join(base, "out/x"), "utf8")).toBe("x");
    // Shape checks keep relative paths and `..` out.
    await expect(ex.readFile("secret", 10)).rejects.toMatchObject({ kind: "policy" });
    await expect(ex.readFile(`${base}/a/../secret`, 10)).rejects.toMatchObject({
      kind: "policy",
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
  const modeArgs = (mode: SandboxMode, tag = "t1") =>
    execArgs("now", { tag, limits: limitsWith(mode) });
  const read = async () => Buffer.from((await ex.readFile("/f", 100))?.data ?? []).toString();

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
      (m) => switches.push(m),
    );
  };
  afterEach(() => ex?.dispose());

  it("runs each command in the effective mode: the device's choice cut to the ceiling", async () => {
    setup();
    expect(ex.mode).toBe("os");
    expect(ex.roots).toBe(sandboxed.roots);
    await ex.exec(modeArgs("auto"), never);
    expect(host.started).toEqual(["now"]);
    await ex.exec(modeArgs("sandbox"), never);
    expect(sandboxed.started).toEqual(["now"]);
    // The machine's own sandbox mode wins over a ceiling that allows auto.
    policy = { ...policy, mode: "sandbox" };
    await ex.exec(modeArgs("auto"), never);
    expect(sandboxed.started).toEqual(["now", "now"]);
    expect(host.started).toEqual(["now"]);
  });

  it("follows the policy at once for file operations and the switch notice", async () => {
    setup();
    expect(await read()).toBe("host");
    expect(switches).toEqual(["auto"]);
    policy = { ...policy, mode: "sandbox" };
    expect(await read()).toBe("sandboxed");
    expect(switches).toEqual(["auto", "sandbox"]);
  });

  it("turning the sandbox back on kills the auto-mode commands", async () => {
    setup();
    await ex.exec(modeArgs("auto"), never);
    expect(host.killed).toEqual([]);
    policy = { ...policy, mode: "sandbox" };
    // The watch notices without another operation.
    const until = Date.now() + 3000;
    while (host.killed.length === 0 && Date.now() < until) await sleep(50);
    expect(host.killed).toEqual([["*"]]);
    expect(switches).toEqual(["auto", "sandbox"]);
    await ex.exec(modeArgs("auto"), never);
    expect(sandboxed.started).toEqual(["now"]);
    expect(host.killed).toEqual([["*"]]);
  });

  it("a failed kill keeps the auto state and is tried again at the next sync", async () => {
    setup();
    expect(await ex.sync()).toBe(true);
    expect(switches).toEqual(["auto"]);
    let fail = true;
    host.killAll = async () => {
      host.killed.push(["*"]);
      if (fail) throw new Error("kill failed");
    };
    policy = { ...policy, mode: "sandbox" };
    // Routing follows the policy at once, but the switch waits for a successful kill.
    expect(await ex.sync()).toBe(false);
    expect(switches).toEqual(["auto"]);
    fail = false;
    expect(await ex.sync()).toBe(false);
    expect(host.killed).toEqual([["*"], ["*"]]);
    expect(switches).toEqual(["auto", "sandbox"]);
    // Settled: no more kills.
    await ex.sync();
    expect(host.killed).toHaveLength(2);
  });

  it("execDecided runs the decision it is given", async () => {
    setup();
    await ex.execDecided(modeArgs("auto"), never, { mode: "auto" }, policy);
    expect(host.started).toEqual(["now"]);
    await ex.execDecided(modeArgs("auto"), never, { mode: "sandbox" }, policy);
    expect(sandboxed.started).toEqual(["now"]);
  });

  it("an auto-mode command whose sandbox came back on while it started is refused", async () => {
    setup();
    let start!: () => void;
    host.startGate = new Promise((r) => {
      start = r;
    });
    const running = ex.exec(modeArgs("auto"), never);
    await sleep(10);
    // the switch back lands while the command is starting: the kill finds nothing yet
    policy = { ...policy, mode: "sandbox" };
    await ex.sync();
    expect(switches).toEqual(["auto", "sandbox"]);
    start();
    await expect(running).rejects.toMatchObject({ kind: "policy", message: SANDBOX_BACK_ON });
    expect(host.started).toEqual([]);
    expect(sandboxed.started).toEqual([]);
  });

  it("file operations follow the commands' decision, not the policy alone", async () => {
    setup();
    await ex.exec(modeArgs("sandbox"), never);
    expect(await read()).toBe("sandboxed");
    await ex.exec(modeArgs("auto"), never);
    expect(await read()).toBe("host");
    // the owner turns the sandbox back on: file operations follow at once
    policy = { ...policy, mode: "sandbox" };
    expect(await read()).toBe("sandboxed");
  });

  it("file operations follow a stale sandbox ceiling only for its window", async () => {
    setup();
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await ex.exec(modeArgs("sandbox"), never);
      expect(await read()).toBe("sandboxed");
      now += FILE_OPS_DECISION_TTL_MS;
      expect(await read()).toBe("sandboxed");
      now += 1;
      // The ceiling is stale: the owner's own auto mode decides again.
      expect(await read()).toBe("host");
    } finally {
      clock.mockRestore();
    }
  });

  it("kills reach both executors' commands", async () => {
    setup();
    await ex.killTagged(["a"]);
    expect(sandboxed.killed).toEqual([["a"]]);
    expect(host.killed).toEqual([["a"]]);
  });
});
