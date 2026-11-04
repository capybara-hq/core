import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFakeSandbox,
  fakeSandboxState,
  readFakeSandboxOps,
} from "../fixtures/plugins/sandbox-fake/index.js";

/** 假沙箱（测试夹具）本身的冒烟测试：T8 的工具测试依赖这些行为。 */

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-fake-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const limits = { cpu: 1, memoryMb: 1, diskMb: 1, egress: "none" as const, allowHosts: [] };
const sig = () => AbortSignal.timeout(10_000);

describe("sandbox-fake", () => {
  it("exec：沙箱路径映射到实例目录，输出里换回来；退出码、超时、截断", async () => {
    const p = createFakeSandbox(root);
    const h = await p.create({ name: "cap-x", image: "i", limits, signal: sig() });
    const run = (command: string, extra: { timeoutMs?: number; maxOutputBytes?: number } = {}) =>
      p.exec(h, {
        command,
        timeoutMs: extra.timeoutMs ?? 5000,
        maxOutputBytes: extra.maxOutputBytes ?? 10_000,
        signal: sig(),
      });

    const w = await run("echo hi > /workspace/a.txt && cat /workspace/a.txt && pwd");
    expect(w).toEqual({
      exitCode: 0,
      stdout: "hi\n/workspace\n",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
    const f = await p.readFile(h, "/workspace/a.txt", { maxBytes: 100, signal: sig() });
    expect(new TextDecoder().decode(f?.data)).toBe("hi\n");
    expect((await run("exit 3")).exitCode).toBe(3);
    expect((await run("ls /workspace")).stdout).toBe("a.txt\n");

    const slow = await run("sleep 5", { timeoutMs: 100 });
    expect(slow).toMatchObject({ exitCode: null, timedOut: true });
    expect((await run("echo still-ok")).stdout).toBe("still-ok\n");

    const big = await run("printf '%0500d' 0", { maxOutputBytes: 100 });
    expect(big.truncated).toBe(true);
    expect(big.stdout).toHaveLength(100);

    // 契约的自动启动：已停止（休眠）的实例在 exec 时透明地启动
    await p.suspend(h, sig());
    expect((await run("cat /workspace/a.txt")).stdout).toBe("hi\n");
    expect(await fakeSandboxState(root, h.id)).toBe("running");
    expect(
      (await readFakeSandboxOps(root)).some((o) => o[0] === "autostart" && o[1] === h.id),
    ).toBe(true);
  });

  it("killAll 杀掉仍在跑的 exec 命令（前任崩溃遗留的）", async () => {
    const p = createFakeSandbox(root);
    const h = await p.create({ name: "cap-k", image: "i", limits, signal: sig() });
    const left = p.exec(h, {
      command: "sleep 30",
      timeoutMs: 60_000,
      maxOutputBytes: 100,
      signal: sig(),
    });
    await new Promise((r) => setTimeout(r, 200));
    await p.killAll?.(h, sig());
    expect(await left).toMatchObject({ exitCode: null, timedOut: false });
    expect((await readFakeSandboxOps(root)).some((o) => o[0] === "kill-all" && o[1] === h.id)).toBe(
      true,
    );
  });

  it("中止的 exec 杀掉正在跑的命令；已中止的 signal 让调用立即失败", async () => {
    const p = createFakeSandbox(root);
    const h = await p.create({ name: "cap-y", image: "i", limits, signal: sig() });
    const ac = new AbortController();
    const pending = p.exec(h, {
      command: "echo $$ > /workspace/pid; sleep 5",
      timeoutMs: 10_000,
      maxOutputBytes: 1000,
      signal: ac.signal,
    });
    let pid = 0;
    for (let i = 0; i < 100 && pid === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const f = await p.readFile(h, "/workspace/pid", { maxBytes: 100, signal: sig() });
      pid = f ? Number(new TextDecoder().decode(f.data).trim()) : 0;
    }
    expect(pid).toBeGreaterThan(0);
    ac.abort();
    const r = await pending;
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(p.stat(h, "/workspace", ac.signal)).rejects.toThrow();
  });
});

/** Waits until `check` holds (the fake's kills are asynchronous at the OS level). */
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const hostAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The shims background tasks rely on (spec 2026-11-05-background-bash-design §4.2): `setsid`,
 * `timeout`, `pgrep -s` and `pkill -s`, on the fake's PATH so they work on macOS too.
 */
describe("sandbox-fake background task shims", () => {
  const exec = (
    p: ReturnType<typeof createFakeSandbox>,
    h: { id: string },
    command: string,
    timeoutMs = 10_000,
  ) => p.exec(h, { command, timeoutMs, maxOutputBytes: 10_000, signal: sig() });
  /** Starts `sleep 30` in a session of its own and returns the session id. */
  const startSession = async (p: ReturnType<typeof createFakeSandbox>, h: { id: string }) => {
    const r = await exec(p, h, "setsid sh -c 'sleep 30' > /dev/null 2>&1 & echo $!");
    expect(r).toMatchObject({ exitCode: 0, stderr: "" });
    expect(r.stdout).toMatch(/^[1-9][0-9]*\n$/);
    return r.stdout.trim();
  };
  /** The host pids `pgrep -s` finds in the session. */
  const members = async (
    p: ReturnType<typeof createFakeSandbox>,
    h: { id: string },
    sid: string,
  ) => {
    const r = await exec(p, h, `pgrep -s ${sid}`);
    return r.exitCode === 0 ? r.stdout.trim().split("\n").map(Number) : [];
  };

  it("setsid prints nothing and returns at once; pgrep -s finds the session; pkill -s ends it", async () => {
    const p = createFakeSandbox(root);
    const h = await p.create({ name: "cap-s", image: "i", limits, signal: sig() });
    const t0 = Date.now();
    const sid = await startSession(p, h);
    expect(Date.now() - t0).toBeLessThan(5000);
    const pids = await members(p, h, sid);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) expect(hostAlive(pid)).toBe(true);
    // no exec command runs any more (the exec that started the session ended), yet it lives on
    expect(await readdir(join(root, "instances", h.id, "procs"))).toEqual([]);
    for (const pid of pids) expect(hostAlive(pid)).toBe(true);

    expect((await exec(p, h, `pkill -s ${sid}`)).exitCode).toBe(0);
    await until(async () => (await exec(p, h, `pgrep -s ${sid}`)).exitCode === 1);
    for (const pid of pids) await until(() => !hostAlive(pid));
    // nothing left to signal
    expect((await exec(p, h, `pkill -KILL -s ${sid}`)).exitCode).toBe(1);
  });

  it("a sid without a session record matches nothing, even a live host process, at once", async () => {
    const p = createFakeSandbox(root);
    const h = await p.create({ name: "cap-u", image: "i", limits, signal: sig() });
    // this test process: alive, same user, and never started by the fake's setsid
    const t0 = Date.now();
    expect(await exec(p, h, `pgrep -s ${process.pid}`)).toMatchObject({ exitCode: 1, stdout: "" });
    expect((await exec(p, h, `pkill -KILL -s ${process.pid}`)).exitCode).toBe(1);
    expect((await exec(p, h, "pkill -KILL -s 999999")).exitCode).toBe(1);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(hostAlive(process.pid)).toBe(true);
  });

  it("pkill takes a signal: -TERM, -KILL", async () => {
    const p = createFakeSandbox(root);
    const h = await p.create({ name: "cap-sig", image: "i", limits, signal: sig() });
    const a = await startSession(p, h);
    const b = await startSession(p, h);
    expect((await exec(p, h, `pkill -TERM -s ${a}`)).exitCode).toBe(0);
    expect((await exec(p, h, `pkill -KILL -s ${b}`)).exitCode).toBe(0);
    await until(async () => (await members(p, h, a)).length === 0);
    await until(async () => (await members(p, h, b)).length === 0);
  });

  it("timeout passes the exit status through, and ends a command that runs too long", async () => {
    const p = createFakeSandbox(root);
    const h = await p.create({ name: "cap-t", image: "i", limits, signal: sig() });
    expect((await exec(p, h, "timeout 5 sh -c 'echo out; exit 3'; echo $?")).stdout).toBe(
      "out\n3\n",
    );
    const t0 = Date.now();
    expect((await exec(p, h, "timeout -s KILL 0.3 sleep 10; echo $?")).stdout).toBe("137\n");
    expect((await exec(p, h, "timeout 0.3 sh -c 'sleep 10'; echo $?")).stdout).toBe("124\n");
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("a launch like the background tool's: the exit file appears when the session ends", async () => {
    const p = createFakeSandbox(root);
    const h = await p.create({ name: "cap-l", image: "i", limits, signal: sig() });
    const r = await exec(
      p,
      h,
      "mkdir -p .capybara/tasks && printf 'echo hello\\nexit 5\\n' > .capybara/tasks/t.sh && " +
        "setsid nohup sh -c 'timeout -s KILL 30 sh .capybara/tasks/t.sh; echo $? > .capybara/tasks/t.exit' " +
        "> .capybara/tasks/t.out 2>&1 < /dev/null & echo $!",
    );
    expect(r.stdout).toMatch(/^[1-9][0-9]*\n$/);
    const read = async (f: string) => {
      const d = await p.readFile(h, `/workspace/.capybara/tasks/${f}`, {
        maxBytes: 1000,
        signal: sig(),
      });
      return d ? new TextDecoder().decode(d.data) : null;
    };
    await until(async () => (await read("t.exit")) !== null);
    expect(await read("t.exit")).toBe("5\n");
    expect(await read("t.out")).toBe("hello\n");
  });

  it("suspend kills every process the instance started: sessions and exec commands", async () => {
    const p = createFakeSandbox(root);
    const h = await p.create({ name: "cap-sus", image: "i", limits, signal: sig() });
    const sid = await startSession(p, h);
    const pids = await members(p, h, sid);
    const running = exec(p, h, "sleep 30", 60_000);
    await until(async () => (await readdir(join(root, "instances", h.id, "procs"))).length > 0);
    await p.suspend(h, sig());
    expect(await running).toMatchObject({ exitCode: null });
    for (const pid of pids) await until(() => !hostAlive(pid));
  });

  it("destroy kills every process the instance started", async () => {
    const p = createFakeSandbox(root);
    const h = await p.create({ name: "cap-des", image: "i", limits, signal: sig() });
    const sid = await startSession(p, h);
    const pids = await members(p, h, sid);
    expect(pids.length).toBeGreaterThan(0);
    await p.destroy(h, sig());
    for (const pid of pids) await until(() => !hostAlive(pid));
  });
});
