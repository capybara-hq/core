import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecResult, SANDBOX_RUNTIME_SOURCE } from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createDockerOperationBackend } from "../src/exec/docker-operations.js";
import { LINUX_DEVICE_AGENT } from "../src/exec/linux-agent.js";
import { linuxOperationWorker } from "../src/exec/linux-operation-worker.js";
import { type LinuxAgentTransport, probeLinuxRuntime } from "../src/exec/linux-runtime.js";
import type { MacWorkerRequest } from "../src/exec/operation-worker.js";

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

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
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
  return { transport, lines, spawned: () => spawned };
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
    scope: { operationId: "op" } as never,
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
    expect(sent).toMatchObject({
      op: "exec",
      full: false,
      writeRoots: ["/work"],
      network: { kind: "allowlist", hosts: [] },
      env: { PATH: "/bin", HOME: "/work", TMPDIR: "/work" },
      expect: { "linux-sandbox.py": "x" },
    });
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
    expect(sent).toMatchObject({
      readRoots: ["/repo", join(home, ".asdf")],
      readFiles: [join(home, ".tool-versions")],
      writeRoots: ["/work"],
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
    expect(containerSent).toMatchObject({ readRoots: [] });
    expect(containerSent).not.toHaveProperty("readFiles");
    expect(containerSent?.env).not.toHaveProperty("ASDF_DATA_DIR");
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
          fullAccess: false,
          roots: hostRoots,
          restrictedProjectReach: "workspace",
          restrictedAllowedDomains: [],
          restrictedDeniedReadRoots: [],
          preparation: {
            skillsRoot: hostRoots.skills,
            attachmentsBase: join(hostRoots.workspace, "attachments"),
          },
          fullNetwork: "environment",
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
