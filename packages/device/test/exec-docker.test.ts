import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceExecArgs, SandboxLimits } from "@capybara-hq/plugin-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  containerName,
  containerUser,
  DockerExecutor,
  SANDBOX_IMAGE,
  SANDBOX_IMAGE_TAG,
} from "../src/exec/docker.js";
import { prepareDeviceDir } from "../src/exec/shared.js";
import { DeviceOpError } from "../src/exec/types.js";
import { DEFAULT_POLICY } from "../src/state.js";

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls `cond` until it holds; the test's own timeout bounds the wait. */
const until = async (cond: () => boolean): Promise<void> => {
  while (!cond()) await sleep(50);
};

const LIMITS: SandboxLimits = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  mode: "sandbox",
  network: { kind: "allowlist", hosts: [] },
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
  } as DeviceExecArgs;
}

describe("docker executor constants", () => {
  it("pins the published sandbox image tag", () => {
    expect(SANDBOX_IMAGE_TAG).toBe("0.1.0-rc.5");
    expect(SANDBOX_IMAGE).toBe("ghcr.io/capybara-hq/capybara-sandbox:0.1.0-rc.5");
    expect(containerName("env_1")).toBe("capybara-device-env_1");
  });
});

describe.skipIf(!hasDocker)("DockerExecutor", () => {
  let base: string;
  let dir: string;
  let envId: string;
  let ex: DockerExecutor;
  const live = new AbortController().signal;

  /**
   * How many `sleep` processes run in the container (its PID 1 is `sleep infinity`); empty while
   * the container is not there yet.
   */
  const sleeps = (): string => {
    const r = spawnSync(
      "docker",
      ["exec", containerName(envId), "sh", "-c", "pgrep -c -x sleep; true"],
      { encoding: "utf8" },
    );
    return r.status === 0 ? r.stdout.trim() : "";
  };

  beforeAll(() => {
    const have = spawnSync("docker", ["image", "inspect", SANDBOX_IMAGE], { stdio: "ignore" });
    if (have.status !== 0) execFileSync("docker", ["pull", SANDBOX_IMAGE], { stdio: "ignore" });
  }, 300_000);

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "device-docker-")));
    dir = join(base, "env");
    mkdirSync(dir);
    envId = `t${randomBytes(6).toString("hex")}`;
    ex = new DockerExecutor({ dir, deviceId: envId, policy: () => DEFAULT_POLICY });
    await ex.ensureRoot();
  });

  afterEach(async () => {
    await ex.dispose();
    spawnSync("docker", ["rm", "-f", containerName(envId)], { stdio: "ignore" });
    rmSync(base, { recursive: true, force: true });
  });

  afterAll(() => {});

  it("docker exec runs in /workspace and files land in the device dir", async () => {
    const r = await ex.exec(execArgs("pwd; id -u; echo hi > made.txt; echo t > /tmp/x"), live);
    expect(r.exitCode).toBe(0);
    // the host user on Linux, the image's sandbox user (1000) elsewhere
    const uid = containerUser().split(":")[0];
    expect(r.stdout.split("\n").slice(0, 2)).toEqual(["/workspace", uid]);
    expect(readFileSync(join(dir, "workspace", "made.txt"), "utf8")).toBe("hi\n");
    expect(readFileSync(join(dir, "tmp", "x"), "utf8")).toBe("t\n");
    expect(ex.mode).toBe("docker");
    expect(ex.roots).toEqual({ workspace: "/workspace", skills: "/skills", tmp: "/tmp" });
    const marker = execFileSync(
      "docker",
      ["exec", containerName(envId), "sh", "-c", "touch /skills/a 2>&1; true"],
      { encoding: "utf8" },
    );
    expect(marker).toMatch(/Read-only/i);
  });

  it("reuses the container and recreates it when the mounts differ", async () => {
    await ex.exec(execArgs("true"), live);
    const id1 = execFileSync("docker", ["inspect", "-f", "{{.Id}}", containerName(envId)], {
      encoding: "utf8",
    });
    const again = new DockerExecutor({ dir, deviceId: envId, policy: () => DEFAULT_POLICY });
    await again.exec(execArgs("true"), live);
    const id2 = execFileSync("docker", ["inspect", "-f", "{{.Id}}", containerName(envId)], {
      encoding: "utf8",
    });
    expect(id2).toBe(id1);
    const other = join(base, "env2");
    mkdirSync(other);
    const moved = new DockerExecutor({ dir: other, deviceId: envId, policy: () => DEFAULT_POLICY });
    await moved.exec(execArgs("touch here"), live);
    expect(existsSync(join(other, "workspace", "here"))).toBe(true);
    await moved.dispose();
  });

  it("hardens the container and recreates one made with other flags", async () => {
    await ex.exec(execArgs("true"), live);
    const inspect = (f: string) =>
      execFileSync("docker", ["inspect", "-f", f, containerName(envId)], {
        encoding: "utf8",
      }).trim();
    expect(inspect("{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.PidsLimit}}")).toBe("true 1024");
    expect(inspect("{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}")).toBe(
      "[ALL] [no-new-privileges:true]",
    );
    const ro = await ex.exec(execArgs("touch /etc/x 2>&1; echo $?"), live);
    expect(ro.stdout).toMatch(/Read-only|denied/i);
    const id = inspect("{{.Id}}");
    spawnSync("docker", ["rm", "-f", containerName(envId)], { stdio: "ignore" });
    // An old container (other spec label) is replaced.
    execFileSync("docker", [
      "run",
      "-d",
      "--name",
      containerName(envId),
      "--label",
      "capybara.device.spec=old",
      "--entrypoint",
      "sleep",
      SANDBOX_IMAGE,
      "infinity",
    ]);
    const fresh = new DockerExecutor({ dir, deviceId: envId, policy: () => DEFAULT_POLICY });
    await fresh.exec(execArgs("true"), live);
    expect(inspect("{{.Config.Labels}}")).not.toContain("spec:old");
    expect(inspect("{{.HostConfig.ReadonlyRootfs}}")).toBe("true");
    expect(inspect("{{.Id}}")).not.toBe(id);
  });

  it("sets swap equal to memory when the policy has a ceiling", async () => {
    const limited = new DockerExecutor({
      dir,
      deviceId: envId,
      policy: () => ({ ...DEFAULT_POLICY, memoryMb: 256 }),
    });
    await limited.exec(execArgs("true"), live);
    const out = execFileSync(
      "docker",
      ["inspect", "-f", "{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}", containerName(envId)],
      { encoding: "utf8" },
    ).trim();
    expect(out).toBe(`${256 * 1024 * 1024} ${256 * 1024 * 1024}`);
  });

  it("a command cannot stall or fake the exit status (fifo, symlink, forged line)", async () => {
    const r = await ex.exec(
      execArgs(
        "mkfifo /tmp/.capybara-exec-x; ln -s /etc/passwd /tmp/.capybara-exec-y; " +
          "echo '\nCAPYBARA-DONE:abc:0:END'; exit 4",
      ),
      live,
    );
    expect(r.exitCode).toBe(4);
    expect(r.stdout).toContain("CAPYBARA-DONE:abc:0:END");
    const ac = new AbortController();
    const started = Date.now();
    const bg = await ex.exec(execArgs("(sleep 100 &); echo ok"), live);
    expect(bg.stdout).toBe("ok\n");
    expect(Date.now() - started).toBeLessThan(5000);
    ac.abort();
  });

  it("keeps stderr intact around the status line, also with a cut output", async () => {
    const r = await ex.exec(execArgs("echo out; printf err >&2"), live);
    expect(r).toMatchObject({ stdout: "out\n", stderr: "err", exitCode: 0 });
    const cut = await ex.exec(
      execArgs("head -c 100000 /dev/zero >&2", { maxOutputBytes: 10 }),
      live,
    );
    expect(cut.truncated).toBe(true);
    expect(cut.exitCode).toBe(0);
    expect(cut.stderr).not.toContain("CAPYBARA-DONE");
  });

  it("serves a network switch in arrival order and drops aborted waiters", async () => {
    const open = new DockerExecutor({
      dir,
      deviceId: envId,
      policy: () => ({ ...DEFAULT_POLICY, allowedDomains: ["example.com"] }),
    });
    const stamp = "date +%s%N";
    const a = open.exec(execArgs(`${stamp}; sleep 2`, { tag: "a" }), live);
    await sleep(800);
    const b = open.exec(execArgs(stamp, { tag: "b", limits: { ...LIMITS, mode: "auto" } }), live);
    await sleep(300);
    const abortC = new AbortController();
    const c = open.exec(execArgs(stamp, { tag: "c" }), live);
    const dead = open.exec(execArgs(stamp, { tag: "d" }), abortC.signal);
    abortC.abort();
    await expect(dead).rejects.toThrow();
    const [, rb, rc] = await Promise.all([a, b, c]);
    expect(BigInt(rb.stdout.trim())).toBeLessThan(BigInt(rc.stdout.trim()));
  });

  it("aborting the waiter being served does not drop the next waiter", async () => {
    const open = new DockerExecutor({
      dir,
      deviceId: envId,
      policy: () => ({ ...DEFAULT_POLICY, allowedDomains: ["example.com"] }),
    });
    await open.exec(execArgs("true"), live); // container exists, network closed
    const ac = new AbortController();
    // The head waiter needs a network switch (docker call); abort it while it is being served.
    const head = open.exec(execArgs("true", { limits: { ...LIMITS, mode: "auto" } }), ac.signal);
    const next = open.exec(execArgs("echo next"), live);
    await sleep(20);
    ac.abort();
    await expect(head).rejects.toThrow();
    expect((await next).stdout).toBe("next\n");
    // The aborted head's slot was given back: another switch still goes through.
    const again = await open.exec(
      execArgs("echo again", { limits: { ...LIMITS, mode: "auto" } }),
      live,
    );
    expect(again.stdout).toBe("again\n");
  });

  it("applies the policy's cpu and memory ceilings", async () => {
    const limited = new DockerExecutor({
      dir,
      deviceId: envId,
      policy: () => ({ ...DEFAULT_POLICY, cpu: 1.5, memoryMb: 256 }),
    });
    await limited.exec(execArgs("true"), live);
    const out = execFileSync(
      "docker",
      ["inspect", "-f", "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}", containerName(envId)],
      { encoding: "utf8" },
    ).trim();
    expect(out).toBe(`1500000000 ${256 * 1024 * 1024}`);
  });

  it("killTagged stops only that tag", async () => {
    const a = ex.exec(execArgs("sleep 60", { tag: "a", timeoutMs: 60_000 }), live);
    const b = ex.exec(execArgs("sleep 2; echo done", { tag: "b", timeoutMs: 60_000 }), live);
    // both commands run (next to the container's own `sleep infinity`): wait for that
    await until(() => sleeps() === "3");
    await ex.killTagged(["a"]);
    const ra = await a;
    expect(ra.exitCode).toBeNull();
    const rb = await b;
    expect(rb.exitCode).toBe(0);
    expect(rb.stdout).toBe("done\n");
  });

  it("lists and scans the workspace inside the container, never the host behind the mount", async () => {
    const ws = join(dir, "workspace");
    mkdirSync(join(ws, "proj/.git"), { recursive: true });
    mkdirSync(join(ws, "proj/src"), { recursive: true });
    mkdirSync(join(base, "host-only/.git"), { recursive: true });
    // a link to a host path: in the container that path does not exist
    symlinkSync(join(base, "host-only"), join(ws, "leak"));
    // a link to a container path: a directory in the container, not on the host
    symlinkSync("/workspace/proj", join(ws, "inner"));
    for (const mode of ["auto", "sandbox"] as const) {
      expect(await ex.list(mode, "/workspace", 10, live)).toEqual({
        entries: [
          { name: "inner", isDir: true },
          { name: "leak", isDir: false },
          { name: "proj", isDir: true },
        ],
        truncated: false,
      });
    }
    expect(await ex.list("auto", "/workspace/inner", 10, live)).toEqual({
      entries: [
        { name: ".git", isDir: true },
        { name: "src", isDir: true },
      ],
      truncated: false,
    });
    expect(await ex.list("auto", "/workspace/leak", 10, live)).toBeNull();
    expect(await ex.list("auto", "/workspace/none", 10, live)).toBeNull();
    expect(await ex.scan("auto", "/workspace", live)).toEqual([
      { path: "/workspace/proj", suggestedName: "proj" },
    ]);
    expect(await ex.scan("auto", "/workspace/none", live)).toEqual([]);
  });

  it("refuses list and scan outside the container's workspace", async () => {
    writeFileSync(join(dir, "workspace", "f"), "x");
    symlinkSync("/etc", join(dir, "workspace", "etc"));
    for (const path of ["/", "/etc", "/skills", "/tmp", "/workspace/../etc"]) {
      const e = await ex.list("auto", path, 10, live).catch((err: unknown) => err);
      expect((e as DeviceOpError).kind, path).toBe("policy");
    }
    // a link out is resolved in the container, then refused
    const out = await ex.list("auto", "/workspace/etc", 10, live).catch((err: unknown) => err);
    expect((out as DeviceOpError).kind).toBe("policy");
    const file = await ex.list("auto", "/workspace/f", 10, live).catch((err: unknown) => err);
    expect((file as DeviceOpError).message).toMatch(/not a directory/);
    const s = await ex.scan("sandbox", "/home", live).catch((err: unknown) => err);
    expect((s as DeviceOpError).kind).toBe("policy");
  });

  // The background children let go of the output, so the command's docker session ends with it
  // (one still attached is killed, and the daemon then takes seconds to release the session).
  it("killTagged reaches background children", async () => {
    const r = await ex.exec(
      execArgs("(sleep 300 >/dev/null 2>&1 &) ; echo started", { tag: "bg" }),
      live,
    );
    expect(r.stdout).toBe("started\n");
    await until(() => sleeps() === "2");
    await ex.killTagged(["bg"]);
    // a killed process lingers until the container's init reaps it: wait for that, not a fixed time
    await until(() => sleeps() === "1");
  });

  it("killAll stops everything, background children included", async () => {
    await ex.exec(execArgs("(sleep 300 >/dev/null 2>&1 &)", { tag: "bg2" }), live);
    await until(() => sleeps() === "2");
    await ex.killAll();
    await until(() => sleeps() === "1");
  });

  it("times out, aborts, and refuses to start on an aborted signal", async () => {
    const t = await ex.exec(execArgs("sleep 30", { timeoutMs: 1000 }), live);
    expect(t.timedOut).toBe(true);
    expect(t.exitCode).toBeNull();
    const ac = new AbortController();
    const p = ex.exec(execArgs("sleep 30", { timeoutMs: 60_000 }), ac.signal);
    await sleep(1000);
    ac.abort();
    expect((await p).exitCode).toBeNull();
    const done = new AbortController();
    done.abort();
    await expect(ex.exec(execArgs("touch never"), done.signal)).rejects.toThrow();
    expect(existsSync(join(dir, "workspace", "never"))).toBe(false);
  });

  it("caps output on a UTF-8 boundary and reports exit codes", async () => {
    const r = await ex.exec(
      execArgs("printf '€€€€€€€€'; echo err >&2; exit 3", { maxOutputBytes: 7 }),
      live,
    );
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBe(3);
    expect(r.stdout).not.toContain("�");
    expect(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(7);
  });

  it("passes env and a cwd inside the roots; refuses a cwd outside", async () => {
    mkdirSync(join(dir, "workspace", "sub"));
    const r = await ex.exec(
      execArgs("pwd; echo $FOO", { cwd: "/workspace/sub", env: { FOO: "a b" } }),
      live,
    );
    expect(r.stdout).toBe("/workspace/sub\na b\n");
    await expect(ex.exec(execArgs("true", { cwd: "/etc" }), live)).rejects.toMatchObject({
      kind: "policy",
    });
    // Auto mode reaches any absolute path in the container.
    expect(
      (await ex.exec(execArgs("pwd", { cwd: "/etc", limits: { ...LIMITS, mode: "auto" } }), live))
        .stdout,
    ).toBe("/etc\n");
    await expect(
      ex.exec(execArgs("true", { env: { "BAD-NAME": "x" } }), live),
    ).rejects.toMatchObject({ kind: "policy" });
  });

  it("auto mode gets the default bridge; sandbox mode has no network", async () => {
    const probe = "getent hosts example.com >/dev/null 2>&1 && echo net || echo nonet";
    const state = async () =>
      execFileSync(
        "docker",
        [
          "inspect",
          "-f",
          "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
          containerName(envId),
        ],
        { encoding: "utf8" },
      ).trim();
    // The device's own sandbox mode wins over an auto ceiling.
    const sandboxed = new DockerExecutor({
      dir,
      deviceId: envId,
      policy: () => ({ ...DEFAULT_POLICY, mode: "sandbox" }),
    });
    expect((await sandboxed.exec(execArgs(probe), live)).stdout).toBe("nonet\n");
    await sandboxed.exec(execArgs("true", { limits: { ...LIMITS, mode: "auto" } }), live);
    expect(await state()).toBe("");
    // An auto-mode device has the container's own network.
    await ex.exec(execArgs("true", { limits: { ...LIMITS, mode: "auto" } }), live);
    expect(await state()).toBe("bridge");
    await ex.exec(execArgs("true"), live);
    expect(await state()).toBe("");
  });

  it("reads, writes and stats files in workspace and tmp, null when missing", async () => {
    await ex.writeFile("/workspace/a/b.txt", Buffer.from("héllo"));
    expect(readFileSync(join(dir, "workspace", "a", "b.txt"), "utf8")).toBe("héllo");
    const r = await ex.readFile("/workspace/a/b.txt", 100);
    expect(Buffer.from(r?.data ?? []).toString()).toBe("héllo");
    expect(r?.truncated).toBe(false);
    const cut = await ex.readFile("/workspace/a/b.txt", 2);
    expect(cut?.data.length).toBe(2);
    expect(cut?.truncated).toBe(true);
    expect(await ex.readFile("/workspace/none", 10)).toBeNull();
    expect(await ex.readFile("/workspace/a", 10)).toBeNull();
    expect(await ex.stat("/workspace/a/b.txt")).toEqual({ size: 6, isDir: false });
    expect(await ex.stat("/workspace/a")).toMatchObject({ isDir: true });
    expect(await ex.stat("/workspace/nope")).toBeNull();
    await ex.writeFile("/tmp/t.bin", new Uint8Array(0));
    expect(await ex.stat("/tmp/t.bin")).toEqual({ size: 0, isDir: false });
  });

  it("refuses paths outside the roots and links that leave them (sandbox mode)", async () => {
    const sandboxed = new DockerExecutor({
      dir,
      deviceId: envId,
      policy: () => ({ ...DEFAULT_POLICY, mode: "sandbox" }),
    });
    await expect(sandboxed.readFile("/etc/passwd", 10)).rejects.toMatchObject({ kind: "policy" });
    await expect(
      sandboxed.writeFile("/workspace/../etc/x", Buffer.from("x")),
    ).rejects.toMatchObject({
      kind: "policy",
    });
    await expect(sandboxed.readFile("relative", 10)).rejects.toBeInstanceOf(DeviceOpError);
    await sandboxed.exec(
      execArgs("ln -s /etc/passwd leak; ln -s /etc etc; ln -s /skills sk"),
      live,
    );
    await expect(sandboxed.readFile("/workspace/leak", 10)).rejects.toMatchObject({
      kind: "policy",
    });
    await expect(sandboxed.stat("/workspace/leak")).rejects.toMatchObject({ kind: "policy" });
    await expect(sandboxed.writeFile("/workspace/leak", Buffer.from("x"))).rejects.toMatchObject({
      kind: "policy",
    });
    await expect(sandboxed.writeFile("/workspace/etc/x", Buffer.from("x"))).rejects.toMatchObject({
      kind: "policy",
    });
    expect(existsSync("/etc/x")).toBe(false);
    // Before any exec decision, file operations use the sandboxed result (safe default).
    await expect(ex.readFile("/etc/passwd", 5)).rejects.toMatchObject({ kind: "policy" });
    // Auto mode: any absolute path in the container, once its decision is fresh.
    await ex.exec(execArgs("true", { limits: { ...LIMITS, mode: "auto" } }), live);
    expect(Buffer.from((await ex.readFile("/etc/passwd", 5))?.data ?? []).toString()).toBe("root:");
  });

  it("skills are read and written through the host directory, with link checks", async () => {
    await ex.writeFile("/skills/s/SKILL.md", Buffer.from("# s"));
    expect(readFileSync(join(dir, "skills", "s", "SKILL.md"), "utf8")).toBe("# s");
    const r = await ex.readFile("/skills/s/SKILL.md", 100);
    expect(Buffer.from(r?.data ?? []).toString()).toBe("# s");
    expect(await ex.stat("/skills/s")).toMatchObject({ isDir: true });
    expect(await ex.readFile("/skills/none", 10)).toBeNull();
    symlinkSync("/etc/passwd", join(dir, "skills", "bad"));
    await expect(ex.readFile("/skills/bad", 10)).rejects.toMatchObject({ kind: "policy" });
    // Commands see the skills read only and cannot plant links there.
    const w = await ex.exec(execArgs("ln -s /etc/passwd /skills/plant"), live);
    expect(w.exitCode).not.toBe(0);
  });

  it("a root removed under the marked directory is gone", async () => {
    rmSync(join(dir, "workspace"), { recursive: true });
    expect(await ex.ensureRoot()).toBe("gone");
    expect(existsSync(join(dir, "workspace"))).toBe(false);
  });

  it("list and scan never recreate a removed root or a vanished directory", async () => {
    await ex.dispose();
    rmSync(join(dir, "workspace"), { recursive: true });
    // a fresh program over the marked directory whose workspace was removed
    ex = new DockerExecutor({ dir, deviceId: envId, policy: () => DEFAULT_POLICY });
    expect(await ex.scan("auto", "/workspace", live)).toEqual([]);
    expect(await ex.list("auto", "/workspace", 10, live)).toBeNull();
    expect(existsSync(join(dir, "workspace"))).toBe(false);
    expect(await ex.ensureRoot()).toBe("gone");
    // the device directory itself is gone: the same answers, nothing created
    rmSync(dir, { recursive: true });
    expect(await ex.list("sandbox", "/workspace", 10, live)).toBeNull();
    expect(await ex.scan("sandbox", "/workspace", live)).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it("list and scan do not create the roots of an unmarked directory", async () => {
    await ex.dispose();
    const fresh = join(base, "fresh");
    mkdirSync(fresh);
    ex = new DockerExecutor({ dir: fresh, deviceId: envId, policy: () => DEFAULT_POLICY });
    expect(await ex.list("auto", "/workspace", 10, live)).toBeNull();
    expect(await ex.scan("auto", "/workspace", live)).toEqual([]);
    expect(readdirSync(fresh)).toEqual([]);
  });

  it("a reused container whose mounts lost the directory is recreated", async () => {
    await ex.writeFile("/workspace/old", Buffer.from("old"));
    const id = () =>
      execFileSync("docker", ["inspect", "-f", "{{.Id}}", containerName(envId)])
        .toString()
        .trim();
    const first = id();
    await ex.dispose();
    // A new program over the same directory reuses the container while its mounts still match.
    ex = new DockerExecutor({ dir, deviceId: envId, policy: () => DEFAULT_POLICY });
    expect(await ex.ensureRoot()).toBe("ok");
    expect((await ex.exec(execArgs("cat /workspace/old"), live)).stdout).toBe("old");
    expect(id()).toBe(first);
    await ex.dispose();
    // The directory is lost and recreated by login: the container must see the new one.
    rmSync(dir, { recursive: true });
    prepareDeviceDir(dir);
    writeFileSync(join(dir, "workspace", "new"), "new");
    ex = new DockerExecutor({ dir, deviceId: envId, policy: () => DEFAULT_POLICY });
    expect(await ex.ensureRoot()).toBe("ok");
    const r = await ex.exec(execArgs("cat /workspace/new; ls /workspace"), live);
    expect(r.stdout).toBe("newnew\n");
    expect(readdirSync(join(dir, "workspace"))).toEqual(["new"]);
  });

  it("ensureRoot creates the marker and roots; a vanished directory is gone", async () => {
    expect(existsSync(join(dir, ".capybara-device"))).toBe(true);
    expect(existsSync(join(dir, "tmp"))).toBe(true);
    writeFileSync(join(dir, "workspace", "k"), "x");
    rmSync(dir, { recursive: true });
    expect(await ex.ensureRoot()).toBe("gone");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("containerUser", () => {
  it("runs as the host user on Linux, never root, and as the image's user elsewhere", async () => {
    expect(containerUser("linux", 1001, 127)).toBe("1001:127");
    expect(containerUser("linux", 0, 0)).toBe("1000:1000");
    expect(containerUser("darwin", 501, 20)).toBe("1000:1000");
  });
});
