import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecResult, SANDBOX_RUNTIME_SOURCE } from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createDockerOperationBackend, hostAddresses } from "../src/exec/docker-operations.js";
import { LINUX_DEVICE_AGENT } from "../src/exec/linux-agent.js";
import { linuxOperationWorker, protectedWriteTargets } from "../src/exec/linux-operation-worker.js";
import { type LinuxAgentTransport, probeLinuxRuntime } from "../src/exec/linux-runtime.js";
import type { MacWorkerRequest } from "../src/exec/operation-worker.js";
import { privateTempParentName } from "../src/exec/read-model.js";

/**
 * A scripted stand-in for the Linux operation agent (a real child process speaking the agent's
 * line protocol): it logs every line it receives to LOG and behaves as BEHAVIOUR says.
 */
const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const log = (line) => fs.appendFileSync(process.env.LOG, line + "\n");
const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const behaviour = process.env.BEHAVIOUR;
// exit only once everything written has reached the pipe
const done = (code) => process.stdout.write("", () => process.exit(code));
let first = true;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  log(line);
  const message = JSON.parse(line);
  if (first) {
    first = false;
    // the private temporary directory as the command would find it: its mode, and a file in it
    const temp = message.env && message.env.TMPDIR;
    if (temp && fs.existsSync(temp)) {
      fs.writeFileSync(temp + "/made-by-command", "x");
      fs.writeFileSync(process.env.LOG + ".temp", JSON.stringify({ temp, mode: fs.statSync(temp).mode & 0o777 }));
    }
    if (message.op === "probe") {
      if (behaviour === "probe-garbage") process.stdout.write("not json\n");
      else if (behaviour === "probe-partial")
        send({ event: "probe", result: { restricted: { filesystem: true }, reason: "partial" } });
      else if (behaviour === "probe-refused")
        send({ event: "refused", code: "UNAVAILABLE", message: "no digest" });
      else send({ event: "probe", result: { restricted: null, reason: "Landlock ABI 3 is below the required 6" } });
      done(0);
    }
    if (message.op === "reap") {
      send({ event: "reaped", killed: 1 });
      done(0);
    }
    if (behaviour === "refuse-unavailable") {
      send({ event: "refused", code: "UNAVAILABLE", message: "unsupported kernel" });
      done(125);
    }
    if (behaviour === "refuse-denied") {
      send({ event: "refused", code: "ROOT_CHANGED", message: "root swapped" });
      done(125);
    }
    send({ event: "launched", pid: process.pid, session: { sid: 4242, start: 777 } });
    if (behaviour === "lost") done(9);
    if (behaviour === "output") {
      const big = Buffer.alloc(150000, 97).toString("base64");
      send({ event: "output", stream: 1, data: big });
      send({ event: "output", stream: 1, data: Buffer.from("tail").toString("base64") });
      send({ event: "exit", exitCode: 0, timedOut: false, cancelled: false });
      done(0);
    }
    if (behaviour === "output-hold") {
      send({ event: "output", stream: 1, data: Buffer.from("x").toString("base64") });
      return;
    }
    if (behaviour === "exit") {
      send({ event: "output", stream: 1, data: Buffer.from("hello").toString("base64") });
      send({ event: "output", stream: 2, data: Buffer.from("warn").toString("base64") });
      send({ event: "exit", exitCode: 3, timedOut: false, cancelled: false });
      done(0);
    }
    return;
  }
  if (message.op === "cancel" && behaviour !== "deaf") {
    send({ event: "exit", exitCode: null, timedOut: false, cancelled: true });
    done(0);
  }
});
`;

/** This file's device: its private temporary parent lies in this process's temp dir. */
const DEVICE = `linux-worker-${process.pid}`;
const tempParent = join(realpathSync(tmpdir()), privateTempParentName(DEVICE));
const dirs: string[] = [tempParent];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  dirs.push(tempParent);
});

async function fakeTransport(behaviour: string) {
  const dir = await mkdtemp(join(tmpdir(), "cap-fake-agent-"));
  dirs.push(dir);
  const log = join(dir, "log");
  let spawned = 0;
  const transport: LinuxAgentTransport = {
    kind: "host",
    bundle: { runtime: {}, expect: { "linux-sandbox.py": "x", "native-files.py": "y" } },
    spawn: async () => {
      spawned++;
      return spawn(process.execPath, ["-e", FAKE_AGENT], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, LOG: log, BEHAVIOUR: behaviour },
      });
    },
  };
  const lines = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  /** What the fake agent saw of the command's TMPDIR, if it was given one that existed. */
  const temp = async () =>
    JSON.parse(await readFile(`${log}.temp`, "utf8")) as { temp: string; mode: number };
  return {
    transport,
    lines,
    temp,
    spawned: () => spawned,
    filesLock: "/state/operation-files.lock",
  };
}

const grant = (full: boolean) => ({
  full,
  readRoots: full ? ["/"] : [],
  writeRoots: full ? ["/"] : ["/work"],
  hosts: [],
  deniedReadRoots: [],
  revision: "r",
});

function execRequest(
  full: boolean,
  overrides: Partial<MacWorkerRequest> = {},
): MacWorkerRequest & { identities: unknown[] } {
  const identities: unknown[] = [];
  return {
    kind: "exec",
    scope: { operationId: "op", deviceId: DEVICE } as never,
    grant: grant(full),
    stateDir: "/unused",
    pythonPath: "/usr/bin/python3",
    runtimeHash: "hash",
    args: { command: "work", cwd: "/work", timeoutMs: 10_000, maxOutputBytes: 1 << 20 },
    beforeLaunch: async () => {},
    onLaunch: async (identity) => {
      identities.push(identity);
    },
    ...overrides,
    identities,
  } as MacWorkerRequest & { identities: unknown[] };
}

const gate = async () => ({ release: () => {} });
const env = () => ({ PATH: "/bin" });

describe("Linux operation worker", () => {
  it("records the agent's session as the owned identity and returns the exit", async () => {
    const fake = await fakeTransport("exit");
    const request = execRequest(false);
    const handle = await linuxOperationWorker({ ...fake, baseEnv: env, acquireRuntime: gate })(
      request,
      new AbortController().signal,
    );
    await handle.ready;
    expect(await handle.completion).toEqual({
      exitCode: 3,
      stdout: "hello",
      stderr: "warn",
      truncated: false,
      timedOut: false,
    });
    expect(request.identities).toEqual([
      expect.objectContaining({ session: { sid: 4242, start: 777 }, process: expect.any(String) }),
    ]);
    const [sent] = await fake.lines();
    const seen = await fake.temp();
    expect(sent).toMatchObject({
      op: "exec",
      full: false,
      writeRoots: ["/work", seen.temp],
      network: { kind: "allowlist", hosts: [] },
      env: { PATH: "/bin", HOME: "/work", TMPDIR: seen.temp, TMP: seen.temp, TEMP: seen.temp },
      expect: { "linux-sandbox.py": "x" },
      filesLock: "/state/operation-files.lock",
    });
    // its own directory, never the first write root: in the device's private parent, private
    expect(seen.temp.startsWith(`${tempParent}/op-${process.pid}-`)).toBe(true);
    expect(seen.mode).toBe(0o700);
    expect((await stat(tempParent)).mode & 0o777).toBe(0o700);
    expect(sent?.readRoots).toEqual([seen.temp]);
    // removed with what the command left in it once the operation ended
    await expect(stat(seen.temp)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("each restricted exec gets a fresh private temp; a dead device process's leftovers go", async () => {
    // a crashed device process's temp (a PID above every system's maximum is never alive)
    await mkdir(tempParent, { recursive: true, mode: 0o700 });
    const stale = join(tempParent, "op-4194305-stale");
    await mkdir(stale);
    await writeFile(join(stale, "left"), "x");
    // a live process's temp is kept
    const live = join(tempParent, `op-${process.ppid}-live`);
    await mkdir(live);
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      const fake = await fakeTransport("exit");
      await (
        await linuxOperationWorker({ ...fake, baseEnv: env, acquireRuntime: gate })(
          execRequest(false),
          new AbortController().signal,
        )
      ).completion;
      seen.push((await fake.temp()).temp);
    }
    expect(seen[0]).not.toBe(seen[1]);
    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(live)).isDirectory()).toBe(true);
  });

  it("refuses a restricted exec whose private temp parent is denied, a link, or another's", async () => {
    // the owner denies the parent: refused before anything is made there or an agent runs
    const denied = await fakeTransport("exit");
    const deniedHandle = await linuxOperationWorker({
      ...denied,
      baseEnv: env,
      acquireRuntime: gate,
    })(
      execRequest(false, { grant: { ...grant(false), deniedReadRoots: [tempParent] } }),
      new AbortController().signal,
    );
    await expect(deniedHandle.completion).rejects.toMatchObject({
      name: "SandboxScopeDeniedError",
    });
    expect(denied.spawned()).toBe(0);
    await expect(stat(tempParent)).rejects.toMatchObject({ code: "ENOENT" });
    // a link in its place (another process could point it anywhere)
    const elsewhere = await mkdtemp(join(tmpdir(), "cap-temp-elsewhere-"));
    dirs.push(elsewhere);
    await symlink(elsewhere, tempParent);
    const linked = await fakeTransport("exit");
    const linkedHandle = await linuxOperationWorker({
      ...linked,
      baseEnv: env,
      acquireRuntime: gate,
    })(execRequest(false), new AbortController().signal);
    await expect(linkedHandle.completion).rejects.toThrow(/is a symbolic link/);
    expect(linked.spawned()).toBe(0);
  });

  it("a command in the device's container keeps its first write root as TMPDIR, nothing made here", async () => {
    const fake = await fakeTransport("exit");
    await (
      await linuxOperationWorker({
        ...fake,
        transport: { ...fake.transport, kind: "docker" },
        baseEnv: env,
        acquireRuntime: gate,
      })(execRequest(false), new AbortController().signal)
    ).completion;
    const [sent] = await fake.lines();
    expect(sent).toMatchObject({ writeRoots: ["/work"], env: { TMPDIR: "/work" } });
    expect(sent?.env).not.toHaveProperty("TMP");
    await expect(stat(tempParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a restricted exec gets the version manager variables and reads their directories", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "cap-tool-home-")));
    dirs.push(home);
    await mkdir(join(home, ".asdf"));
    await mkdir(join(home, ".ssh"));
    await writeFile(join(home, ".tool-versions"), "nodejs 22.12.0\n");
    const fake = await fakeTransport("exit");
    const request = execRequest(false, {
      grant: { ...grant(false), readRoots: ["/repo"], deniedReadRoots: [join(home, ".ssh")] },
    });
    const handle = await linuxOperationWorker({
      ...fake,
      baseEnv: env,
      acquireRuntime: gate,
      // the device's environment leaves ASDF_DATA_DIR unset and sets VOLTA_HOME
      toolHome: { home, env: { VOLTA_HOME: "/opt/volta" } },
    })(request, new AbortController().signal);
    await handle.completion;
    const [sent] = await fake.lines();
    const { temp } = await fake.temp();
    expect(sent).toMatchObject({
      // the carve returns its roots sorted by code point
      readRoots: [join(home, ".asdf"), "/repo", temp].sort(),
      readFiles: [join(home, ".tool-versions")],
      writeRoots: ["/work", temp],
      env: {
        PATH: "/bin",
        HOME: "/work",
        ASDF_DATA_DIR: join(home, ".asdf"),
        VOLTA_HOME: "/opt/volta",
      },
    });
    // read only: never a write root
    expect(sent?.writeRoots).not.toContain(join(home, ".asdf"));
  });

  it("a machine-reach exec sends carved read roots, never /", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "cap-tool-home-")));
    dirs.push(home);
    await mkdir(join(home, ".asdf"));
    // a stand-in machine (the real one would make the walk depend on this host): the denied
    // secret and the device's state lie under it, beside readable directories and a link
    const tree: Record<string, Record<string, "dir" | "link" | "file">> = {
      "/": { h: "dir", usr: "dir", state: "dir", "top.txt": "file" },
      "/h": { u: "dir" },
      "/h/u": { ".ssh": "dir", src: "dir", link: "link" },
    };
    const kind = (path: string) => {
      if (path === "/") return "dir";
      const at = path.lastIndexOf("/");
      return tree[at === 0 ? "/" : path.slice(0, at)]?.[path.slice(at + 1)];
    };
    const carveFs = {
      readdir: (path: string) => {
        const entries = tree[path];
        if (!entries) throw new Error("ENOENT");
        return Object.keys(entries);
      },
      lstat: (path: string) => {
        const k = kind(path);
        if (!k) throw new Error("ENOENT");
        return { isDirectory: () => k === "dir", isSymbolicLink: () => k === "link" };
      },
      canOpen: () => true,
    };
    const denied = ["/h/u/.ssh", "/state"];
    const fake = await fakeTransport("exit");
    await (
      await linuxOperationWorker({
        ...fake,
        baseEnv: env,
        acquireRuntime: gate,
        toolHome: { home, env: {} },
        carveFs,
      })(
        execRequest(false, {
          grant: { ...grant(false), readRoots: ["/"], deniedReadRoots: denied },
        }),
        new AbortController().signal,
      )
    ).completion;
    const [sent] = await fake.lines();
    const roots = sent?.readRoots as string[];
    expect(roots).not.toContain("/");
    for (const root of roots)
      for (const d of denied) {
        expect(root === d || root.startsWith(`${d}/`), `${root} inside ${d}`).toBe(false);
        expect(d.startsWith(`${root}/`), `${root} holds ${d}`).toBe(false);
      }
    // beside the denied paths, and the tool homes and the private temp (clear of every denied
    // path) kept whole
    expect(roots).toEqual(
      ["/h/u/src", "/usr", join(home, ".asdf"), (await fake.temp()).temp].sort(),
    );
    // native work keeps the reach as granted: the agent checks each resolved path against denied
    const native = await fakeTransport("exit");
    await (
      await linuxOperationWorker({
        ...native,
        baseEnv: env,
        acquireRuntime: gate,
        toolHome: { home, env: {} },
        carveFs,
      })(
        {
          ...execRequest(false, {
            grant: { ...grant(false), readRoots: ["/"], deniedReadRoots: denied },
          }),
          kind: "native",
          native: { method: "readFile", path: "/h/u/src/a" },
          purpose: "operation",
        } as unknown as MacWorkerRequest,
        new AbortController().signal,
      )
    ).completion.catch(() => {});
    const [nativeSent] = await native.lines();
    expect(nativeSent).toMatchObject({ op: "native", readRoots: ["/"], denied });
  });

  it("a container's worker refuses a grant with denied paths rather than carve this host", async () => {
    const fake = await fakeTransport("exit");
    const handle = await linuxOperationWorker({
      ...fake,
      transport: { ...fake.transport, kind: "docker" },
      baseEnv: env,
      acquireRuntime: gate,
    })(
      execRequest(false, {
        grant: { ...grant(false), readRoots: ["/workspace"], deniedReadRoots: ["/workspace/s"] },
      }),
      new AbortController().signal,
    );
    await expect(handle.completion).rejects.toMatchObject({ name: "SandboxScopeDeniedError" });
    expect(fake.spawned()).toBe(0);
  });

  it("a restricted exec on the host has the device's sandbox home: HOME, XDG, read and write", async () => {
    const device = await realpath(await mkdtemp(join(tmpdir(), "cap-sandbox-home-")));
    dirs.push(device);
    const home = join(device, "home");
    const fake = await fakeTransport("exit");
    await (
      await linuxOperationWorker({
        ...fake,
        baseEnv: env,
        acquireRuntime: gate,
        sandboxHome: home,
      })(
        execRequest(false, {
          grant: { ...grant(false), readRoots: ["/repo"] },
          args: {
            command: "work",
            cwd: "/repo",
            timeoutMs: 10_000,
            maxOutputBytes: 1 << 20,
            // the call's own environment wins
            env: { XDG_CACHE_HOME: "/repo/.cache" },
          },
        }),
        new AbortController().signal,
      )
    ).completion;
    const [sent] = await fake.lines();
    const { temp } = await fake.temp();
    expect(sent).toMatchObject({
      readRoots: [home, "/repo", temp].sort(),
      writeRoots: ["/work", home, temp],
      env: {
        HOME: home,
        XDG_CACHE_HOME: "/repo/.cache",
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_STATE_HOME: join(home, ".local/state"),
        TMPDIR: temp,
      },
    });
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    // an escalated call keeps the OS user's environment and gets no extra root
    const full = await fakeTransport("exit");
    await (
      await linuxOperationWorker({
        ...full,
        baseEnv: () => ({ PATH: "/bin", HOME: "/home/owner" }),
        acquireRuntime: gate,
        sandboxHome: home,
      })(execRequest(true), new AbortController().signal)
    ).completion;
    const [fullSent] = await full.lines();
    expect(fullSent).not.toHaveProperty("writeRoots");
    expect(fullSent?.env).toEqual({ PATH: "/bin", HOME: "/home/owner" });
  });

  it("Full access and a worker without a host home add no version manager roots", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "cap-tool-home-")));
    dirs.push(home);
    await mkdir(join(home, ".asdf"));
    const full = await fakeTransport("exit");
    await (
      await linuxOperationWorker({
        ...full,
        baseEnv: env,
        acquireRuntime: gate,
        toolHome: { home, env: {} },
      })(execRequest(true), new AbortController().signal)
    ).completion;
    const [fullSent] = await full.lines();
    expect(fullSent).not.toHaveProperty("readRoots");
    expect(fullSent?.env).not.toHaveProperty("ASDF_DATA_DIR");
    // a container's worker (no toolHome) keeps the restricted env as it was
    const container = await fakeTransport("exit");
    await (
      await linuxOperationWorker({ ...container, baseEnv: env, acquireRuntime: gate })(
        execRequest(false),
        new AbortController().signal,
      )
    ).completion;
    const [containerSent] = await container.lines();
    expect(containerSent).toMatchObject({ readRoots: [(await container.temp()).temp] });
    expect(containerSent).not.toHaveProperty("readFiles");
    expect(containerSent?.env).not.toHaveProperty("ASDF_DATA_DIR");
  });

  it("an open-network grant asks for the open forwarder and denies the protected home targets", async () => {
    // a dotfile manager's links: ~/.config and ~/.bashrc resolve into a project directory
    const home = await realpath(await mkdtemp(join(tmpdir(), "cap-dotfiles-")));
    dirs.push(home);
    await mkdir(join(home, "dotfiles", "config"), { recursive: true });
    await writeFile(join(home, "dotfiles", "bashrc"), "");
    await symlink(join(home, "dotfiles", "config"), join(home, ".config"));
    await symlink(join(home, "dotfiles", "bashrc"), join(home, ".bashrc"));
    const fake = await fakeTransport("exit");
    const request = execRequest(false, { grant: { ...grant(false), openNetwork: true } });
    await (
      await linuxOperationWorker({
        ...fake,
        baseEnv: env,
        acquireRuntime: gate,
        toolHome: { home, env: {} },
      })(request, new AbortController().signal)
    ).completion;
    const [sent] = await fake.lines();
    expect(sent).toMatchObject({ network: { kind: "open", hosts: [] } });
    const denies = sent?.writeDenies as string[];
    for (const target of ["config/systemd", "config/autostart", "config/git/config", "bashrc"])
      expect(denies).toContain(join(home, "dotfiles", target));
    // the literal locations are the policy's own denies; only differing targets are added
    expect(denies).not.toContain(join(home, ".config", "systemd"));
    expect(denies).not.toContain(join(home, ".zshrc"));
    // an allowlist grant keeps the allowlist; Full has the escalated call's own network
    const allow = await fakeTransport("exit");
    await (
      await linuxOperationWorker({ ...allow, baseEnv: env, acquireRuntime: gate })(
        execRequest(false, { grant: { ...grant(false), hosts: ["a.example"] } }),
        new AbortController().signal,
      )
    ).completion;
    const [allowSent] = await allow.lines();
    expect(allowSent).toMatchObject({ network: { kind: "allowlist", hosts: ["a.example"] } });
    expect(allowSent).not.toHaveProperty("writeDenies");
  });

  it("protected home targets: every link of a chain and the target of a dangling link", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-chain-")));
    dirs.push(root);
    const home = join(root, "home");
    await mkdir(join(root, "w", "v1"), { recursive: true });
    await mkdir(join(root, "w", "dotfiles", "config"), { recursive: true });
    await mkdir(home);
    await writeFile(join(root, "w", "v1", "zshrc"), "");
    await symlink("v1", join(root, "w", "current"));
    await symlink(join(root, "w", "current", "zshrc"), join(home, ".zshrc"));
    await symlink(join(root, "w", "dotfiles", "config"), join(home, ".config"));
    // the target's ancestor moved away outside the sandbox: the link dangles
    await rename(join(root, "w", "dotfiles"), join(root, "w", "gone"));
    const denies = protectedWriteTargets(home);
    expect(denies).toEqual(
      expect.arrayContaining([
        join(home, ".zshrc"),
        join(root, "w", "current"),
        join(root, "w", "v1", "zshrc"),
        join(home, ".config"),
        join(root, "w", "dotfiles", "config", "systemd"),
      ]),
    );
    // a location reached without a link adds nothing
    expect(denies).not.toContain(join(home, ".bashrc"));
    // the home-anchored ~/bin is always denied, also where it is missing
    expect(denies).toContain(join(home, "bin"));
    // and at its target when it is a link
    await symlink(join(root, "w", "v1"), join(home, "bin"));
    expect(protectedWriteTargets(home)).toEqual(
      expect.arrayContaining([join(home, "bin"), join(root, "w", "v1")]),
    );
  });

  it("a container's worker closes the host's own addresses to the forwarder", async () => {
    const fake = await fakeTransport("exit");
    await (
      await linuxOperationWorker({
        ...fake,
        baseEnv: env,
        acquireRuntime: gate,
        closedAddresses: () => ["203.0.113.7", "2001:db8::7"],
      })(
        execRequest(false, { grant: { ...grant(false), openNetwork: true } }),
        new AbortController().signal,
      )
    ).completion;
    const [sent] = await fake.lines();
    expect(sent).toMatchObject({ closedAddresses: ["203.0.113.7", "2001:db8::7"] });
  });

  it("the host's own addresses are every interface address but loopback", () => {
    const addresses = hostAddresses({
      lo0: [{ address: "127.0.0.1", internal: true } as never],
      en0: [
        { address: "198.51.100.4", internal: false } as never,
        { address: "fe80::1", internal: false, scopeid: 4 } as never,
      ],
    });
    expect(addresses).toEqual(["198.51.100.4", "fe80::1"]);
  });

  it("an abort sends one immediate cancel; a second cancel is coalesced", async () => {
    const fake = await fakeTransport("hold");
    const abort = new AbortController();
    const handle = await linuxOperationWorker({ ...fake, baseEnv: env, acquireRuntime: gate })(
      execRequest(true),
      abort.signal,
    );
    await handle.ready;
    abort.abort();
    await handle.cancel("again", 0);
    const result = (await handle.completion) as ExecResult;
    expect(result.exitCode).toBeNull();
    const cancels = (await fake.lines()).filter((l) => l.op === "cancel");
    expect(cancels).toEqual([{ op: "cancel", graceMs: 0 }]);
  });

  it("a cancel passes the grace period to the agent", async () => {
    const fake = await fakeTransport("hold");
    const handle = await linuxOperationWorker({ ...fake, baseEnv: env, acquireRuntime: gate })(
      execRequest(true),
      new AbortController().signal,
    );
    await handle.ready;
    await handle.cancel("stop", 250);
    expect((await fake.lines()).filter((l) => l.op === "cancel")).toEqual([
      { op: "cancel", graceMs: 250 },
    ]);
  });

  it("an agent that ignores a cancel is killed and its recorded session reaped", async () => {
    const fake = await fakeTransport("deaf");
    const handle = await linuxOperationWorker({
      ...fake,
      baseEnv: env,
      acquireRuntime: gate,
      cancelSettleMs: 50,
    })(execRequest(true), new AbortController().signal);
    await handle.ready;
    await handle.cancel("stop", 0);
    await expect(handle.completion).rejects.toBeDefined();
    expect((await fake.lines()).find((l) => l.op === "reap")).toMatchObject({
      session: { sid: 4242, start: 777 },
    });
  });

  it("a lost agent fails the operation and reaps its recorded session", async () => {
    const fake = await fakeTransport("lost");
    const handle = await linuxOperationWorker({ ...fake, baseEnv: env, acquireRuntime: gate })(
      execRequest(true),
      new AbortController().signal,
    );
    await expect(handle.completion).rejects.toThrow(/agent was lost/);
    // the reap ran through a fresh agent, with exactly the recorded session
    expect(fake.spawned()).toBe(2);
    expect((await fake.lines()).find((l) => l.op === "reap")).toMatchObject({
      op: "reap",
      session: { sid: 4242, start: 777 },
    });
  });

  it("maps refusals to typed errors (unsupported, scope denied)", async () => {
    for (const [behaviour, name] of [
      ["refuse-unavailable", "SandboxPermissionUnsupportedError"],
      ["refuse-denied", "SandboxScopeDeniedError"],
    ] as const) {
      const fake = await fakeTransport(behaviour);
      const handle = await linuxOperationWorker({ ...fake, baseEnv: env, acquireRuntime: gate })(
        execRequest(false),
        new AbortController().signal,
      );
      await expect(handle.completion).rejects.toMatchObject({ name });
    }
  });

  it("refuses a restricted launch whose runtime hash is not the sealed one, before any agent", async () => {
    const fake = await fakeTransport("exit");
    // the real gate (W1-B): nothing was verified and sealed in this process for this hash
    const handle = await linuxOperationWorker({ ...fake, baseEnv: env })(
      execRequest(false, { runtimeHash: "f".repeat(64) }),
      new AbortController().signal,
    );
    await expect(handle.completion).rejects.toMatchObject({
      name: "SandboxPermissionUnsupportedError",
    });
    expect(fake.spawned()).toBe(0);
  });

  it("delivers managed output in bounded frames, in order, and a failed sink cancels", async () => {
    const fake = await fakeTransport("output");
    const frames: number[] = [];
    const handle = await linuxOperationWorker({ ...fake, baseEnv: env, acquireRuntime: gate })(
      execRequest(true, {
        managedOutput: { outputPath: "/work/out", artifactRoot: "/work" },
        onOutput: async (bytes) => {
          frames.push(bytes.length);
        },
      }),
      new AbortController().signal,
    );
    await handle.completion;
    expect(frames).toEqual([65536, 65536, 150000 - 131072, 4]);
    const [sent] = await fake.lines();
    expect(String(sent?.command)).toBe("exec /bin/bash -c 'work' 2>&1");

    const failing = await fakeTransport("output-hold");
    const broken = await linuxOperationWorker({ ...failing, baseEnv: env, acquireRuntime: gate })(
      execRequest(true, {
        managedOutput: { outputPath: "/work/out", artifactRoot: "/work" },
        onOutput: async () => {
          throw new Error("sink full");
        },
      }),
      new AbortController().signal,
    );
    // the sink's failure cancels the owned work at once and fails the operation
    await expect(broken.completion).rejects.toThrow(/sink full/);
    expect((await failing.lines()).filter((l) => l.op === "cancel")).toEqual([
      { op: "cancel", graceMs: 0 },
    ]);
  });
});

describe("Linux runtime probe", () => {
  it("fails closed on an unsupported kernel, a broken report, partial claims or a refusal", async () => {
    for (const [behaviour, reason] of [
      ["probe-null", /Landlock ABI 3/],
      ["probe-garbage", /gave no answer/],
      ["probe-partial", /partial/],
      ["probe-refused", /no digest/],
    ] as const) {
      const fake = await fakeTransport(behaviour);
      const probe = await probeLinuxRuntime(fake.transport);
      expect(probe.restricted).toBeNull();
      expect(probe.reason).toMatch(reason);
    }
  });
});

describe("local-Docker skill preparation", () => {
  it("writes the host skills directory behind the read-only mount through the native helper", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cap-docker-skills-")));
    dirs.push(dir);
    const hostRoots = { workspace: join(dir, "w"), skills: join(dir, "s"), tmp: join(dir, "t") };
    await mkdir(hostRoots.skills);
    const state = join(dir, "state");
    await mkdir(state, { mode: 0o700 });
    const backend = await createDockerOperationBackend(
      {
        deviceId: "d",
        instanceGeneration: "g",
        stateDir: state,
        pythonPath: "/usr/bin/python3",
        runtimeHash: "hash",
        hostRoots,
        readOwnerCeiling: async () => ({
          revision: "one",
          outsideSandbox: false,
          network: "allowlist",
          roots: hostRoots,
          projectReach: "workspace",
          allowedDomains: [],
          projectPaths: [],
          secretAndStateDenies: [],
          otherConnectionDenies: [],
          unreadableConnections: [],
          restrictedDeniedReadRoots: [],
          preparation: {
            skillsRoot: hostRoots.skills,
            attachmentsBase: join(hostRoots.workspace, "attachments"),
          },
        }),
        container: {
          operationContainer: async () => {
            throw new Error("skill preparation never enters the container");
          },
        },
      },
      {
        probe: async () => ({
          restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
        }),
        acquireRuntime: gate,
      },
    );
    const signal = new AbortController().signal;
    const prepare = await backend.prepare(
      { id: "d" },
      {
        operationId: "prep",
        deviceId: "d",
        purpose: "skills",
        writeRoots: ["/skills/new"],
        tag: "t",
      },
      signal,
    );
    await prepare.writeFile("/skills/new/SKILL.md", new TextEncoder().encode("skill"), signal);
    expect(await readFile(join(hostRoots.skills, "new", "SKILL.md"), "utf8")).toBe("skill");
  });
});

describe("Linux agent read files", () => {
  it("appends to exactly the SDK launcher's default system roots", () => {
    const tuple = (source: string, name: string) =>
      new RegExp(`^${name} = \\(([^)]*)\\)`, "m").exec(source)?.[1];
    const launcher = SANDBOX_RUNTIME_SOURCE.files.find((f) => f.name === "linux-sandbox.py");
    const sdk = tuple(launcher?.source ?? "", "DEFAULT_SYSTEM_ROOTS");
    expect(sdk).toBeDefined();
    expect(tuple(LINUX_DEVICE_AGENT, "LAUNCHER_SYSTEM_ROOTS")).toBe(sdk);
  });
});
