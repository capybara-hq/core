import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunningOperations } from "../src/activity.js";
import type { Connection } from "../src/client.js";
import { CommandLog } from "../src/command-log.js";
import { drain, drainAndWait } from "../src/commands/drain.js";
import { legacyPolicyNotice, MISSING_POLICY_NOTICE, start } from "../src/commands/start.js";
import { stop } from "../src/commands/stop.js";
import { queryControl } from "../src/control/client.js";
import { controlSocketPath } from "../src/control/protocol.js";
import { type ProcessLookup, pidPath, readRunning, removePid, writePid } from "../src/pid.js";
import type { PolicyStore } from "../src/policy-store.js";
import type { StagedDevice } from "../src/staged-device.js";
import {
  DEFAULT_POLICY,
  FULL_OWNER_CEILING,
  MISSING_POLICY_OWNER_CEILING,
  readPolicy,
  SANDBOX_OWNER_CEILING,
  writeCredential,
  writePolicy,
} from "../src/state.js";
import { WakeDetector } from "../src/wake.js";

/** `ps` for a test: every pid is a capybara-device that started long ago. */
const ps: ProcessLookup = () => ({
  command: "node /x/bin/capybara-device.mjs start",
  started: new Date(0),
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "device-start-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cred = {
  url: "http://x.test",
  connectUrl: "ws://x.test/device/connect",
  credential: "cap_dev_a",
  orgId: "o",
  deviceId: "e1",
  dir: "/w",
  mode: "os" as const,
  reconnectGraceSeconds: 120,
  maxFrameBytes: 16 * 1024 * 1024,
};

/** A staged program's parts as start sees them: the binder's recovery and the disposal. */
const stagedParts = (calls: string[] = []) =>
  ({
    binder: {
      recover: async () => {
        calls.push("recover");
        return undefined;
      },
    },
    dispose: async () => {
      calls.push("dispose");
    },
  }) as unknown as StagedDevice;

describe("start: legacy policy notice", () => {
  const run = async () => {
    const proc = Object.assign(new EventEmitter(), { pid: 4250 });
    const out: string[] = [];
    const conn: Connection = { done: Promise.resolve(0), drain: () => {}, stop: () => {} };
    expect(
      await start({
        stateDir: dir,
        out: (l) => out.push(l),
        err: () => {},
        proc: proc as never,
        createStaged: () => stagedParts(),
        connectStaged: () => conn,
      }),
    ).toBe(0);
    return out;
  };

  it("says once that policy.json was converted to version 3, and how to open the network", async () => {
    writeCredential(dir, cred);
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ isolation: "none", tier: "open" }));
    const out = await run();
    const open = legacyPolicyNotice(FULL_OWNER_CEILING);
    expect(out.filter((l) => l === open)).toHaveLength(1);
    expect(open).toBe(
      "policy.json now uses the version 3 owner ceiling: commands run in the sandbox under every " +
        "profile; outside the sandbox on, network open; see `capybara-device ceiling show`.",
    );
    // a version 2 file that denied Full access keeps the allowlist and learns how to open it
    writeFileSync(
      join(dir, "policy.json"),
      JSON.stringify({
        version: 2,
        allowedDomains: ["a.test"],
        ownerCeiling: { fullAccess: false, restrictedProjectReach: "workspace" },
      }),
    );
    const allowlist = legacyPolicyNotice(SANDBOX_OWNER_CEILING);
    expect(await run()).toContain(allowlist);
    expect(allowlist).toContain("capybara-device ceiling set --network open");
    expect(readPolicy(dir)).toMatchObject({
      allowedDomains: ["a.test"],
      ownerCeiling: SANDBOX_OWNER_CEILING,
    });
  });

  it("a device without policy.json (set up before rc.58) gets the closed allowlist, never open", async () => {
    writeCredential(dir, cred);
    const out = await run();
    expect(out).toContain(MISSING_POLICY_NOTICE);
    expect(MISSING_POLICY_NOTICE).toContain("capybara-device ceiling set --network open");
    // written once: no host, no running outside the sandbox, the workspace reach
    expect(JSON.parse(readFileSync(join(dir, "policy.json"), "utf8"))).toMatchObject({
      version: 3,
      allowedDomains: [],
      ownerCeiling: { outsideSandbox: false, network: "allowlist" },
    });
    expect(readPolicy(dir).ownerCeiling).toEqual(MISSING_POLICY_OWNER_CEILING);
    // the next start finds the file and says nothing
    expect((await run()).some((l) => l === MISSING_POLICY_NOTICE)).toBe(false);
  });

  it("says nothing for a current policy", async () => {
    writeCredential(dir, cred);
    writePolicy(dir, DEFAULT_POLICY);
    const out = await run();
    expect(out.some((l) => l.startsWith("policy.json now uses"))).toBe(false);
  });
});

describe("start, stop, drain", () => {
  it("start writes the pid file, maps signals, and removes the pid file at the end", async () => {
    writeCredential(dir, cred);
    const proc = Object.assign(new EventEmitter(), { pid: 4242 });
    const calls: string[] = [];
    let finish!: (code: number) => void;
    const conn: Connection = {
      done: new Promise<number>((r) => {
        finish = r;
      }),
      drain: () => calls.push("drain"),
      stop: () => {
        calls.push("stop");
        finish(0);
      },
    };
    const out: string[] = [];
    const p = start({
      stateDir: dir,
      out: (l) => out.push(l),
      err: () => {},
      proc: proc as never,
      createStaged: () => stagedParts(),
      connectStaged: () => conn,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(pidPath(dir))).toBe(true);
    proc.emit("SIGUSR2");
    proc.emit("SIGTERM");
    expect(await p).toBe(0);
    expect(calls).toEqual(["drain", "stop"]);
    expect(existsSync(pidPath(dir))).toBe(false);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });

  it("a SIGTERM while the program is built stops without connecting", async () => {
    writeCredential(dir, cred);
    const proc = Object.assign(new EventEmitter(), { pid: 4243 });
    let connected = false;
    const code = await start({
      stateDir: dir,
      out: () => {},
      err: () => {},
      proc: proc as never,
      createStaged: async () => {
        proc.emit("SIGTERM");
        return stagedParts();
      },
      connectStaged: () => {
        connected = true;
        throw new Error("must not connect");
      },
    });
    expect(code).toBe(0);
    expect(connected).toBe(false);
    expect(existsSync(pidPath(dir))).toBe(false);
  });

  it("start without a credential exits 0 (terminal: a service does not restart it)", async () => {
    const err: string[] = [];
    const code = await start({ stateDir: dir, out: () => {}, err: (l) => err.push(l) });
    expect(code).toBe(0);
    expect(err[0]).toContain("Not logged in");
  });

  it("start passes the connection's exit code through: 0 terminal, 1 transient", async () => {
    writeCredential(dir, cred);
    for (const exit of [0, 1]) {
      const code = await start({
        stateDir: dir,
        out: () => {},
        err: () => {},
        proc: Object.assign(new EventEmitter(), { pid: 4300 + exit }) as never,
        createStaged: () => stagedParts(),
        connectStaged: () => ({ done: Promise.resolve(exit), drain: () => {}, stop: () => {} }),
      });
      expect(code).toBe(exit);
    }
  });

  it("an invalid policy.json stops start with a non-zero exit naming the file", async () => {
    writeCredential(dir, cred);
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ cpu: "lots" }));
    const err: string[] = [];
    const code = await start({
      stateDir: dir,
      out: () => {},
      err: (l) => err.push(l),
      proc: Object.assign(new EventEmitter(), { pid: 4400 }) as never,
      createStaged: () => stagedParts(),
      connectStaged: () => {
        throw new Error("must not connect");
      },
    });
    expect(code).toBe(1);
    expect(err[0]).toMatch(/policy\.json is invalid: cpu must/);
  });

  it("the staged parts get a policy store that follows policy.json while serving", async () => {
    writeCredential(dir, cred);
    writePolicy(dir, { ...DEFAULT_POLICY, allowedDomains: ["a.com"] });
    let store: PolicyStore | undefined;
    let served: PolicyStore | undefined;
    const code = await start({
      stateDir: dir,
      out: () => {},
      err: () => {},
      proc: Object.assign(new EventEmitter(), { pid: 4500 }) as never,
      createStaged: (_cred, s) => {
        store = s;
        return { ...stagedParts(), policy: s } as unknown as StagedDevice;
      },
      connectStaged: (device) => {
        served = (device as unknown as { policy: PolicyStore }).policy;
        return { done: Promise.resolve(0), drain: () => {}, stop: () => {} };
      },
    });
    expect(code).toBe(0);
    // The policy op and the hello work on the store the staged parts were built with.
    expect(served).toBe(store);
    expect(store?.current().allowedDomains).toEqual(["a.com"]);
    writePolicy(dir, { ...DEFAULT_POLICY, allowedDomains: ["b.com"] });
    expect(store?.current().allowedDomains).toEqual(["b.com"]);
  });

  it("stop and drain signal the running pid, and fail when none runs", () => {
    const sent: Array<[number, string | number | undefined]> = [];
    const kill = ((pid: number, sig?: string | number) => {
      sent.push([pid, sig]);
      return true;
    }) as typeof process.kill;
    const err: string[] = [];
    const noService = { home: dir, platform: "darwin" as const };
    expect(
      stop(
        dir,
        () => {},
        (l) => err.push(l),
        { kill, ps, service: noService },
      ),
    ).toBe(1);
    writePid(dir, 777);
    expect(
      stop(
        dir,
        () => {},
        () => {},
        { kill, ps, service: noService },
      ),
    ).toBe(0);
    expect(
      drain(
        dir,
        () => {},
        () => {},
        { kill, ps },
      ),
    ).toBe(0);
    expect(sent.filter(([, s]) => s !== 0)).toEqual([
      [777, "SIGTERM"],
      [777, "SIGUSR2"],
    ]);
  });

  it("drain --wait waits until the program has exited, within the time limit", async () => {
    writePid(dir, 778);
    let checks = 0;
    // the program answers signal 0 three times, then is gone
    const kill = ((_pid: number, sig?: string | number) => {
      if (sig === 0 && ++checks > 3) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return true;
    }) as typeof process.kill;
    const out: string[] = [];
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    expect(
      await drainAndWait(
        dir,
        (l) => out.push(l),
        () => {},
        { kill, ps, sleep, timeoutMs: 60_000 },
      ),
    ).toBe(0);
    expect(out).toEqual(["Draining capybara-device.", "capybara-device has stopped."]);
    expect(slept.length).toBeGreaterThan(0);

    // still running at the time limit: exit 1 with a reason
    const forever = (() => true) as typeof process.kill;
    const err: string[] = [];
    slept.length = 0;
    expect(
      await drainAndWait(
        dir,
        () => {},
        (l) => err.push(l),
        {
          kill: forever,
          ps,
          sleep,
          timeoutMs: 2000,
        },
      ),
    ).toBe(1);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(2000);
    expect(err.join("\n")).toContain("still draining after 2 s");
  });
});

describe("a login service", () => {
  it("stop refuses while the service runs the program, and never signals it", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "device-service-stop-")));
    const sent: Array<[number, string | number | undefined]> = [];
    const kill = ((pid: number, sig?: string | number) => {
      sent.push([pid, sig]);
      return true;
    }) as typeof process.kill;
    // the service file launchd would have written
    mkdirSync(join(dir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(dir, "Library", "LaunchAgents", "top.capybara.device.plist"), "plist");
    writePid(dir, 4242);
    const err: string[] = [];
    // launchd has the agent loaded and runs the pid file's program
    const run = (_cmd: string, args: string[]): string =>
      args[0] === "print" ? "\tstate = running\n\tpid = 4242\n" : "";
    expect(
      stop(
        dir,
        () => {},
        (l) => err.push(l),
        {
          kill,
          ps,
          run,
          service: { home: dir, platform: "darwin" },
        },
      ),
    ).toBe(1);
    expect(err.join("\n")).toContain("capybara-device service stop");
    expect(sent.filter(([, s]) => s !== 0)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the pid file carries the running version, and a bare pid reads as unknown", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "device-pid-")));
    writePid(dir, 1234, "0.1.0-rc.9");
    const checks = { kill: (() => true) as typeof process.kill, ps };
    expect(readRunning(dir, checks)).toMatchObject({ pid: 1234, version: "0.1.0-rc.9" });
    // a program older than the version field
    writeFileSync(pidPath(dir), "1234\n");
    const old = readRunning(dir, checks);
    expect(old?.pid).toBe(1234);
    expect(old?.version).toBeUndefined();
    // removePid still matches the JSON form
    removePid(dir, 1234);
    expect(existsSync(pidPath(dir))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("start: the staged protocol (W3-M)", () => {
  /** A staged program's parts as start sees them: only the binder's recovery is called. */
  const fakeStaged = (calls: string[]) =>
    ({
      binder: {
        recover: async () => {
          calls.push("recover");
          return undefined;
        },
      },
    }) as unknown as StagedDevice;

  it("start always serves the protocol 3 program", async () => {
    writeCredential(dir, cred);
    const calls: string[] = [];
    const conn: Connection = { done: Promise.resolve(0), drain: () => {}, stop: () => {} };
    const code = await start({
      stateDir: dir,
      out: () => {},
      err: () => {},
      proc: Object.assign(new EventEmitter(), { pid: 4260 }) as never,
      createStaged: () => {
        calls.push("staged");
        return fakeStaged(calls);
      },
      connectStaged: () => {
        calls.push("connectStaged");
        return conn;
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["staged", "recover", "connectStaged"]);
  });

  it("without the program's parts in the build, start refuses (no other path)", async () => {
    writeCredential(dir, cred);
    const err: string[] = [];
    const code = await start({
      stateDir: dir,
      out: () => {},
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err[0]).toContain("no execution backend");
  });

  it("builds the program's parts, recovers the binding and maps signals", async () => {
    writeCredential(dir, cred);
    const proc = Object.assign(new EventEmitter(), { pid: 4261 });
    const calls: string[] = [];
    let finish!: (code: number) => void;
    const conn: Connection = {
      done: new Promise<number>((r) => {
        finish = r;
      }),
      drain: () => calls.push("drain"),
      stop: () => {
        calls.push("stop");
        finish(0);
      },
    };
    let store: PolicyStore | undefined;
    const p = start({
      stateDir: dir,
      out: () => {},
      err: () => {},
      proc: proc as never,
      createStaged: (c, policy) => {
        expect(c.deviceId).toBe("e1");
        store = policy;
        calls.push("staged");
        return fakeStaged(calls);
      },
      connectStaged: (_device, opts) => {
        calls.push("connectStaged");
        // the credential is read again at each reconnect (a new login discards the old state)
        expect(opts?.credential?.()?.credential).toBe("cap_dev_a");
        return conn;
      },
    });
    await vi.waitFor(() => expect(calls).toContain("connectStaged"));
    expect(store?.current().ownerCeiling).toBeDefined();
    proc.emit("SIGUSR2");
    proc.emit("SIGTERM");
    expect(await p).toBe(0);
    expect(calls).toEqual(["staged", "recover", "connectStaged", "drain", "stop"]);
    expect(existsSync(pidPath(dir))).toBe(false);
  });

  it("a stop before the staged program connected disposes what it built (M-5)", async () => {
    writeCredential(dir, cred);
    const proc = Object.assign(new EventEmitter(), { pid: 4262 });
    const calls: string[] = [];
    const code = await start({
      stateDir: dir,
      out: () => {},
      err: () => {},
      proc: proc as never,
      createStaged: () => {
        proc.emit("SIGTERM");
        return {
          ...fakeStaged(calls),
          dispose: async () => {
            calls.push("dispose");
          },
        } as unknown as StagedDevice;
      },
      connectStaged: () => {
        throw new Error("must not connect");
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["recover", "dispose"]);
  });
});

describe("start: the control socket", () => {
  it("the socket exists while serving, answers live status, and is removed after stop", async () => {
    writeCredential(dir, cred);
    const proc = Object.assign(new EventEmitter(), { pid: 4270 });
    const calls: string[] = [];
    let finish!: (code: number) => void;
    let onState: ((s: { connection: "online" | "offline"; reason?: string }) => void) | undefined;
    const conn: Connection = {
      done: new Promise<number>((r) => {
        finish = r;
      }),
      drain: () => calls.push("drain"),
      stop: () => {
        calls.push("stop");
        finish(0);
      },
    };
    const errs: string[] = [];
    const p = start({
      stateDir: dir,
      out: () => {},
      err: (l) => errs.push(l),
      proc: proc as never,
      createStaged: () => stagedParts(),
      connectStaged: (_device, opts) => {
        onState = opts?.onState;
        calls.push("connectStaged");
        return conn;
      },
    });
    await vi.waitFor(() => expect(calls).toContain("connectStaged"));
    expect(existsSync(controlSocketPath(dir))).toBe(true);
    expect(await queryControl(dir, "status")).toMatchObject({
      pid: 4270,
      deviceId: "e1",
      orgId: "o",
      url: "http://x.test",
      mode: "os",
      connection: "starting",
    });
    onState?.({ connection: "offline", reason: "Cannot reach x.test." });
    expect(await queryControl(dir, "status")).toMatchObject({
      connection: "offline",
      offlineReason: "Cannot reach x.test.",
    });
    onState?.({ connection: "online" });
    const live = (await queryControl(dir, "status")) as Record<string, unknown>;
    expect(live.connection).toBe("online");
    expect(live).not.toHaveProperty("offlineReason");
    expect(JSON.stringify(live)).not.toContain("cap_dev_a");
    expect(await queryControl(dir, "running")).toEqual([]);
    expect(await queryControl(dir, "drain")).toBeNull();
    expect(await queryControl(dir, "status")).toMatchObject({ connection: "draining" });
    expect(await queryControl(dir, "stop")).toBeNull();
    expect(await p).toBe(0);
    expect(calls).toEqual(["connectStaged", "drain", "stop"]);
    expect(existsSync(controlSocketPath(dir))).toBe(false);
    expect(errs).toEqual([]);
  });

  it("a control socket that cannot be made leaves the program serving", async () => {
    writeCredential(dir, cred);
    chmodSync(dir, 0o755);
    const errs: string[] = [];
    const code = await start({
      stateDir: dir,
      out: () => {},
      err: (l) => errs.push(l),
      proc: Object.assign(new EventEmitter(), { pid: 4271 }) as never,
      createStaged: () => stagedParts(),
      connectStaged: () => ({ done: Promise.resolve(0), drain: () => {}, stop: () => {} }),
    });
    expect(code).toBe(0);
    expect(errs.join("\n")).toContain("control socket unavailable");
    expect(existsSync(controlSocketPath(dir))).toBe(false);
  });
});

describe("start: keep-awake in the live status", () => {
  it("status shows keepAwake and lastWakeAt", async () => {
    writeCredential(dir, cred);
    writePolicy(dir, DEFAULT_POLICY);
    const proc = Object.assign(new EventEmitter(), { pid: 4280 });
    const running = new RunningOperations();
    const spawned: { args: string[]; killed: boolean }[] = [];
    const spawn = ((_command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        killed: false,
        kill() {
          this.killed = true;
          entry.killed = true;
        },
      });
      const entry = { args, killed: false };
      spawned.push(entry);
      return child;
    }) as never;
    let wall = Date.UTC(2026, 10, 19);
    const mono = 0;
    const wake = new WakeDetector({ now: () => wall, monotonic: () => mono });
    const calls: string[] = [];
    let finish!: (code: number) => void;
    const conn: Connection = {
      done: new Promise<number>((r) => {
        finish = r;
      }),
      drain: () => {},
      stop: () => finish(0),
    };
    const staged = {
      ...stagedParts(calls),
      owner: { running, store: undefined, log: new CommandLog(dir) },
    } as unknown as StagedDevice;
    const p = start({
      stateDir: dir,
      out: () => {},
      err: () => {},
      proc: proc as never,
      service: { home: dir, platform: "darwin" },
      createStaged: () => staged,
      connectStaged: () => {
        calls.push("connectStaged");
        return conn;
      },
      keepAwakeSpawn: spawn,
      wake,
      tickMs: 5,
    });
    await vi.waitFor(() => expect(calls).toContain("connectStaged"));
    expect(await queryControl(dir, "status")).toMatchObject({
      keepAwake: { mode: "while-busy", held: false },
    });
    running.begin(
      { tag: "t", conversationId: "c", accountId: "a", isolation: "full", startedAt: "x" },
      "op1",
    );
    expect(await queryControl(dir, "status")).toMatchObject({
      keepAwake: { mode: "while-busy", held: true },
    });
    expect(spawned.map((s) => s.args)).toEqual([["-i", "-w", "4280"]]);
    running.endOperation("op1");
    expect(spawned[0]?.killed).toBe(true);
    wall += 60_000; // the computer slept for a minute: the monotonic clock did not move
    await vi.waitFor(async () =>
      expect(await queryControl(dir, "status")).toHaveProperty("lastWakeAt"),
    );
    const live = (await queryControl(dir, "status")) as { lastWakeAt: string };
    expect(live.lastWakeAt).toBe(new Date(wall).toISOString());
    expect(readFileSync(join(dir, "commands.log"), "utf8")).toContain('"op":"wake"');
    expect(await queryControl(dir, "stop")).toBeNull();
    expect(await p).toBe(0);
  });
});
