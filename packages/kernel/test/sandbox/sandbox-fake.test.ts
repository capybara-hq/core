import { mkdtemp, rm } from "node:fs/promises";
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
