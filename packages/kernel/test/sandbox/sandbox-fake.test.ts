import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isFileSystemGoneError,
  isSandboxScopeDeniedError,
  type SandboxHandle,
  type SandboxOperationScope,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFakeSandbox,
  FAKE_INSTANCE_PERMISSION_SUPPORT,
  FAKE_PERMISSION_SUPPORT,
  fakeFileSystems,
  fakeSandboxMeta,
  fakeSandboxState,
  readFakeSandboxOps,
  removeFakeFileSystem,
  setFakeSandboxPermissionSupport,
} from "../fixtures/plugins/sandbox-fake/index.js";

/** 假沙箱（测试夹具）本身的冒烟测试：T8 的工具测试依赖这些行为。 */

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-fake-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const limits = {
  cpu: 1,
  memoryMb: 1,
  diskMb: 1,
  mode: "sandbox" as const,
  network: { kind: "allowlist" as const, hosts: [] },
};
const sig = () => AbortSignal.timeout(10_000);
const actor = { accountId: "acc-1", conversationId: "conv-1" };

/** A file system and an instance attached to it. */
async function mk(p: SandboxProvider, name: string): Promise<SandboxHandle> {
  const fileSystem = await p.createFileSystem({ name: `fs-${name}`, limits, signal: sig() });
  return p.create({ name, image: "i", limits, fileSystem, signal: sig() });
}

describe("sandbox-fake", () => {
  it("exec：沙箱路径映射到实例目录，输出里换回来；退出码、超时、截断", async () => {
    const p = createFakeSandbox(root);
    const h = await mk(p, "cap-x");
    const run = (command: string, extra: { timeoutMs?: number; maxOutputBytes?: number } = {}) =>
      p.exec(h, {
        command,
        timeoutMs: extra.timeoutMs ?? 5000,
        maxOutputBytes: extra.maxOutputBytes ?? 10_000,
        signal: sig(),
        tag: "t",
        actor,
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
    const h = await mk(p, "cap-k");
    const left = p.exec(h, {
      command: "sleep 30",
      timeoutMs: 60_000,
      maxOutputBytes: 100,
      signal: sig(),
      tag: "t",
      actor,
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
    const h = await mk(p, "cap-y");
    const ac = new AbortController();
    const pending = p.exec(h, {
      command: "echo $$ > /workspace/pid; sleep 5",
      timeoutMs: 10_000,
      maxOutputBytes: 1000,
      signal: ac.signal,
      tag: "t",
      actor,
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
  ) => p.exec(h, { command, timeoutMs, maxOutputBytes: 10_000, signal: sig(), tag: "t", actor });
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
    const h = await mk(p, "cap-s");
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
    const h = await mk(p, "cap-u");
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
    const h = await mk(p, "cap-sig");
    const a = await startSession(p, h);
    const b = await startSession(p, h);
    expect((await exec(p, h, `pkill -TERM -s ${a}`)).exitCode).toBe(0);
    expect((await exec(p, h, `pkill -KILL -s ${b}`)).exitCode).toBe(0);
    await until(async () => (await members(p, h, a)).length === 0);
    await until(async () => (await members(p, h, b)).length === 0);
  });

  it("timeout passes the exit status through, and ends a command that runs too long", async () => {
    const p = createFakeSandbox(root);
    const h = await mk(p, "cap-t");
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
    const h = await mk(p, "cap-l");
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
    const h = await mk(p, "cap-sus");
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
    const h = await mk(p, "cap-des");
    const sid = await startSession(p, h);
    const pids = await members(p, h, sid);
    expect(pids.length).toBeGreaterThan(0);
    await p.destroy(h, sig());
    for (const pid of pids) await until(() => !hostAlive(pid));
  });

  it("destroy keeps the file system", async () => {
    const p = createFakeSandbox(root);
    const fileSystem = await p.createFileSystem({ name: "cap-device-keep", limits, signal: sig() });
    const h1 = await p.create({ name: "keep-1", limits, fileSystem, signal: sig() });
    await p.writeFile(h1, "/workspace/a", new TextEncoder().encode("kept"), sig());
    await p.destroy(h1, sig());
    const h2 = await p.create({ name: "keep-2", limits, fileSystem, signal: sig() });
    const f = await p.readFile(h2, "/workspace/a", { maxBytes: 100, signal: sig() });
    expect(new TextDecoder().decode(f?.data)).toBe("kept");
    expect((await fakeSandboxMeta(root, h2.id))?.image).toBeNull();
    // idempotent by name
    expect(await p.createFileSystem({ name: "cap-device-keep", limits, signal: sig() })).toEqual(
      fileSystem,
    );
  });

  it("create on a removed file system throws FileSystemGoneError", async () => {
    const p = createFakeSandbox(root);
    const fileSystem = await p.createFileSystem({ name: "cap-device-gone", limits, signal: sig() });
    await removeFakeFileSystem(root, fileSystem.id);
    expect(await fakeFileSystems(root)).not.toContain(fileSystem.id);
    await expect(p.create({ name: "gone-1", limits, fileSystem, signal: sig() })).rejects.toSatisfy(
      isFileSystemGoneError,
    );
  });

  it("exec records its actor", async () => {
    const p = createFakeSandbox(root);
    const h = await mk(p, "cap-actor");
    await p.exec(h, {
      command: "true",
      timeoutMs: 5000,
      maxOutputBytes: 100,
      signal: sig(),
      tag: "actor-tag",
      actor,
    });
    const ops = await readFakeSandboxOps(root);
    expect(
      ops.some((o) => o[0] === "exec" && o[1] === h.id && o.slice(5).join(" ") === "acc-1 conv-1"),
    ).toBe(true);
  });

  it("destroyFileSystemByName removes a legacy-named file system", async () => {
    const p = createFakeSandbox(root);
    const fileSystem = await p.createFileSystem({ name: "legacy-name", limits, signal: sig() });
    await p.destroyFileSystemByName("legacy-name", sig());
    expect(await fakeFileSystems(root)).not.toContain(fileSystem.id);
    await p.destroyFileSystemByName("legacy-name", sig());
  });
});

const ADMIT_BEFORE_MS = Date.now() + 3_600_000;
/** The scope of one operation (fixture tests only; a retry reuses the same scope). */
function scopeOf(
  operationId: string,
  filesystem: SandboxOperationScope["filesystem"],
): SandboxOperationScope {
  return {
    operationId,
    admitBeforeMs: ADMIT_BEFORE_MS,
    deviceId: "dev-1",
    rootConversationId: "conv-1",
    profileRevision: 1,
    ceilingRevision: "c1",
    profile: filesystem.kind === "device" ? "full-access" : "approve-for-me",
    actor,
    tag: operationId,
    filesystem,
    // the device filesystem pairs only with the environment network (the escalated call)
    network: filesystem.kind === "device" ? { kind: "environment" } : { kind: "none" },
  };
}
const scoped = (write: string[], read: string[] = []): SandboxOperationScope["filesystem"] => ({
  kind: "scoped",
  readRoots: read,
  writeRoots: write,
});

describe("sandbox-fake permission-scoped surface", () => {
  it("reports restricted and Full support with background ownership, overridable", async () => {
    const p = createFakeSandbox(root);
    const h = await mk(p, "cap-perm");
    expect(await p.permissionSupport?.(h, sig())).toEqual(FAKE_PERMISSION_SUPPORT);
    await setFakeSandboxPermissionSupport(root, { ...FAKE_PERMISSION_SUPPORT, restricted: null });
    try {
      expect((await p.permissionSupport?.(h, sig()))?.restricted).toBeNull();
    } finally {
      await setFakeSandboxPermissionSupport(root, null);
    }
  });

  it("enforces the scope's roots on native operations and commands", async () => {
    const p = createFakeSandbox(root);
    const h = await mk(p, "cap-scope");
    const op = (id: string, fs = scoped(["/workspace/a"], ["/skills"])) =>
      (p.operation as NonNullable<SandboxProvider["operation"]>)(h, scopeOf(id, fs), sig());
    const data = new TextEncoder().encode("x");
    await (await op("op-w1")).writeFile("/workspace/a/f.txt", data, sig());
    await expect((await op("op-w2")).writeFile("/workspace/b.txt", data, sig())).rejects.toSatisfy(
      isSandboxScopeDeniedError,
    );
    // a read root is readable, never writable
    expect(await (await op("op-r1")).stat("/skills", sig())).toMatchObject({ isDir: true });
    await expect((await op("op-w3")).writeFile("/skills/s.txt", data, sig())).rejects.toSatisfy(
      isSandboxScopeDeniedError,
    );
    // a command outside the roots (its working directory, or a root its text names) is denied
    const exec = async (id: string, command: string, cwd = "/workspace/a") =>
      (await op(id)).exec({ command, cwd, timeoutMs: 5000, maxOutputBytes: 1000, signal: sig() });
    expect((await exec("op-e1", "cat f.txt")).stdout).toBe("x");
    await expect(exec("op-e2", "pwd", "/workspace")).rejects.toSatisfy(isSandboxScopeDeniedError);
    await expect(exec("op-e3", "ls /tmp")).rejects.toSatisfy(isSandboxScopeDeniedError);
    // Full access (device scope) reaches what the raw provider reaches
    const full = await op("op-f1", { kind: "device" });
    expect(await full.stat("/workspace/b.txt", sig())).toBeNull();
  });

  it("an operation boundary refuses a raw read outside the roots; an operation's scope reaches it", async () => {
    const p = createFakeSandbox(root);
    const h = await mk(p, "cap-raw-roots");
    const data = new TextEncoder().encode("x");
    // the kernel's raw provider calls (no operation) stay under /workspace, /skills and /tmp
    await expect(
      p.readFile(h, "/home/u/project/f", { maxBytes: 9, signal: sig() }),
    ).rejects.toThrow(/outside the instance roots/);
    await expect(p.writeFile(h, "/home/u/project/f", data, sig())).rejects.toThrow(
      /outside the instance roots/,
    );
    await expect(p.stat(h, "/etc", sig())).rejects.toThrow(/outside the instance roots/);
    await expect(
      p.exec(h, {
        command: "true",
        cwd: "/home/u",
        timeoutMs: 5000,
        maxOutputBytes: 9,
        signal: sig(),
        tag: "raw",
        actor,
      }),
    ).rejects.toThrow(/outside the instance roots/);
    // an operation whose scope grants the path reaches it (the scope, not the roots, bounds it)
    const op = await (p.operation as NonNullable<SandboxProvider["operation"]>)(
      h,
      scopeOf("op-raw-1", scoped(["/home/u/project"])),
      sig(),
    );
    await op.writeFile("/home/u/project/f", data, sig());
    const read = await (p.operation as NonNullable<SandboxProvider["operation"]>)(
      h,
      scopeOf("op-raw-2", scoped(["/home/u/project"])),
      sig(),
    );
    expect(
      (await read.readFile("/home/u/project/f", { maxBytes: 9, signal: sig() }))?.data,
    ).toEqual(data);
  });

  it("an instance boundary (a cloud device) puts the whole instance in scope, raw reads included", async () => {
    const p = createFakeSandbox(root);
    const h = await mk(p, "cap-instance");
    await setFakeSandboxPermissionSupport(root, FAKE_INSTANCE_PERMISSION_SUPPORT);
    try {
      expect(await p.permissionSupport?.(h, sig())).toEqual({
        version: 2,
        boundary: "instance",
        restricted: null,
        network: { openPublic: true, allowlist: true, perOperationHosts: false },
        outsideSandbox: false,
        background: true,
      });
      const data = new TextEncoder().encode("y");
      await p.writeFile(h, "/home/u/notes", data, sig());
      expect((await p.readFile(h, "/home/u/notes", { maxBytes: 9, signal: sig() }))?.data).toEqual(
        data,
      );
    } finally {
      await setFakeSandboxPermissionSupport(root, null);
    }
  });

  it("consumes each operation id once: a retry returns the recorded result, other input is denied", async () => {
    const p = createFakeSandbox(root);
    const h = await mk(p, "cap-once");
    const op = () =>
      (p.operation as NonNullable<SandboxProvider["operation"]>)(
        h,
        scopeOf("op-once", scoped(["/workspace"])),
        sig(),
      );
    const run = async (command: string) =>
      (await op()).exec({ command, timeoutMs: 5000, maxOutputBytes: 1000, signal: sig() });
    const first = await run("echo $$");
    expect(await run("echo $$")).toEqual(first);
    await expect(run("echo other")).rejects.toSatisfy(isSandboxScopeDeniedError);
  });

  it("owns background executions by exact reference: output, status, stop and loss", async () => {
    const p = createFakeSandbox(root);
    const h = await mk(p, "cap-bg");
    const bg = p.background as NonNullable<SandboxProvider["background"]>;
    const start = (id: string, command: string, outputPath = `/workspace/${id}.out`) =>
      bg.start(h, scopeOf(id, scoped(["/workspace"])), {
        command,
        cwd: "/workspace",
        timeoutMs: 30_000,
        maxOutputBytes: 1000,
        taskId: id,
        outputPath,
        retainUntilMs: ADMIT_BEFORE_MS,
        instanceGeneration: "1700000000000",
        signal: sig(),
      });
    // the artifact must be writable under the scope
    await expect(start("bg-out", "true", "/tmp/x.out")).rejects.toSatisfy(
      isSandboxScopeDeniedError,
    );
    const done = await start("bg-done", "printf 'a\\nb\\n'; exit 3");
    expect(done.instanceGeneration).toBe("1700000000000");
    // idempotent per operation id
    expect(await start("bg-done", "printf 'a\\nb\\n'; exit 3")).toEqual(done);
    await waitUntil(async () => (await bg.status(h, done, sig())).state === "exited");
    expect(await bg.status(h, done, sig())).toEqual({
      state: "exited",
      exitCode: 3,
      timedOut: false,
    });
    const out = await bg.readOutput(h, done, { offset: 2, maxBytes: 10, signal: sig() });
    expect(out).toMatchObject({ offset: 2, nextOffset: 4, totalBytes: 4 });
    expect(new TextDecoder().decode((out as { data: Uint8Array }).data)).toBe("b\n");
    expect(await bg.stop(h, done, { graceMs: 0, signal: sig() })).toEqual({
      outcome: "already-exited",
      exitCode: 3,
      timedOut: false,
    });
    // another reference to the same operation is denied
    await expect(bg.status(h, { ...done, executionId: "fx-other" }, sig())).rejects.toSatisfy(
      isSandboxScopeDeniedError,
    );
    const running = await start("bg-run", "sleep 30");
    expect(await bg.status(h, running, sig())).toEqual({ state: "running" });
    expect(await bg.stop(h, running, { graceMs: 1000, signal: sig() })).toEqual({
      outcome: "stopped",
    });
    // the claimed outcome is kept on every retry
    expect(await bg.stop(h, running, { graceMs: 0, signal: sig() })).toEqual({
      outcome: "stopped",
    });
    // suspending the instance loses what still ran, its output unavailable
    const lost = await start("bg-lost", "sleep 30");
    await p.suspend(h, sig());
    expect(await bg.status(h, lost, sig())).toEqual({ state: "lost" });
    expect(await bg.tail(h, lost, { maxBytes: 100, signal: sig() })).toEqual({
      unavailable: "lost",
    });
    expect(await fakeSandboxState(root, h.id)).toBe("suspended");
  });
});

async function waitUntil(cond: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 10_000;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}
