import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "../src/client.js";
import { drain, drainAndWait } from "../src/commands/drain.js";
import { legacyPolicyNotice, start } from "../src/commands/start.js";
import { stop } from "../src/commands/stop.js";
import { pidPath, readRunning, removePid, writePid } from "../src/pid.js";
import type { PolicyStore } from "../src/policy-store.js";
import { DEFAULT_POLICY, writeCredential, writePolicy } from "../src/state.js";
import { FakeExecutor } from "./fake-kernel.js";

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
        createExecutor: () => new FakeExecutor(),
        connect: () => conn,
      }),
    ).toBe(0);
    return out;
  };

  it("says once that policy.json now uses mode, and which mode it runs in", async () => {
    writeCredential(dir, cred);
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ isolation: "none", tier: "open" }));
    const out = await run();
    const notice = legacyPolicyNotice("auto");
    expect(out.filter((l) => l === notice)).toHaveLength(1);
    expect(notice).toBe(
      "policy.json now uses `mode`; this machine runs in auto mode; switch with " +
        "`capybara-device mode`.",
    );
    // An older file that did not ask for no sandbox migrates to sandbox.
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ tier: "dev" }));
    expect(await run()).toContain(legacyPolicyNotice("sandbox"));
  });

  it("says nothing for a current policy", async () => {
    writeCredential(dir, cred);
    writePolicy(dir, DEFAULT_POLICY);
    expect(await run()).not.toContain(legacyPolicyNotice("auto"));
    expect(await run()).not.toContain(legacyPolicyNotice("sandbox"));
  });
});

describe("start without the OS sandbox", () => {
  const fake = (available: boolean) => {
    const ex = new FakeExecutor() as FakeExecutor & {
      available?: boolean;
      unavailableReason?: string;
    };
    ex.available = available;
    if (!available) ex.unavailableReason = "bwrap is missing";
    return ex;
  };
  const run = async (ex: FakeExecutor) => {
    const proc = Object.assign(new EventEmitter(), { pid: 4251 });
    const out: string[] = [];
    const errs: string[] = [];
    const conn: Connection = { done: Promise.resolve(0), drain: () => {}, stop: () => {} };
    const code = await start({
      stateDir: dir,
      out: (l) => out.push(l),
      err: (l) => errs.push(l),
      proc: proc as never,
      createExecutor: () => ex,
      connect: () => conn,
    });
    return { code, out, errs: errs.join("\n") };
  };

  it("serves auto mode silently, and logs the reason for a sandbox policy", async () => {
    writeCredential(dir, cred);
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "auto" });
    const auto = await run(fake(false));
    // The device starts and serves: no error, and the client is connected.
    expect(auto.code).toBe(0);
    expect(auto.errs).not.toContain("OS sandbox is unavailable");
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "sandbox" });
    const sandbox = await run(fake(false));
    expect(sandbox.code).toBe(0);
    expect(sandbox.errs).toContain("OS sandbox is unavailable");
    expect(sandbox.errs).toContain("bwrap is missing");
  });

  it("says nothing when the sandbox is available", async () => {
    writeCredential(dir, cred);
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "sandbox" });
    const ok = await run(fake(true));
    expect(ok.code).toBe(0);
    expect(ok.errs).not.toContain("OS sandbox is unavailable");
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
      createExecutor: () => new FakeExecutor(),
      connect: () => conn,
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

  it("a SIGTERM during executor creation stops without connecting", async () => {
    writeCredential(dir, cred);
    const proc = Object.assign(new EventEmitter(), { pid: 4243 });
    let connected = false;
    const code = await start({
      stateDir: dir,
      out: () => {},
      err: () => {},
      proc: proc as never,
      createExecutor: async () => {
        proc.emit("SIGTERM");
        return new FakeExecutor();
      },
      connect: () => {
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
        createExecutor: () => new FakeExecutor(),
        connect: () => ({ done: Promise.resolve(exit), drain: () => {}, stop: () => {} }),
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
      createExecutor: () => new FakeExecutor(),
      connect: () => {
        throw new Error("must not connect");
      },
    });
    expect(code).toBe(1);
    expect(err[0]).toMatch(/policy\.json is invalid: cpu must/);
  });

  it("the executor gets a policy store that follows policy.json while serving", async () => {
    writeCredential(dir, cred);
    writePolicy(dir, { ...DEFAULT_POLICY, allowedDomains: ["a.com"] });
    let store: PolicyStore | undefined;
    let served: PolicyStore | undefined;
    const code = await start({
      stateDir: dir,
      out: () => {},
      err: () => {},
      proc: Object.assign(new EventEmitter(), { pid: 4500 }) as never,
      createExecutor: (_cred, s) => {
        store = s;
        return new FakeExecutor();
      },
      connect: (_cred, _ex, opts) => {
        served = opts?.policy;
        return { done: Promise.resolve(0), drain: () => {}, stop: () => {} };
      },
    });
    expect(code).toBe(0);
    // The policy op and the hello work on the store the executor reads.
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
        kill,
        noService,
      ),
    ).toBe(1);
    writePid(dir, 777);
    expect(
      stop(
        dir,
        () => {},
        () => {},
        kill,
        noService,
      ),
    ).toBe(0);
    expect(
      drain(
        dir,
        () => {},
        () => {},
        kill,
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
        { kill, sleep, timeoutMs: 60_000 },
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
  it("stop refuses while one is installed, and never signals the program", () => {
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
    expect(
      stop(
        dir,
        () => {},
        (l) => err.push(l),
        kill,
        { home: dir, platform: "darwin" },
      ),
    ).toBe(1);
    expect(err.join("\n")).toContain("capybara-device service stop");
    expect(sent.filter(([, s]) => s !== 0)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the pid file carries the running version, and a bare pid reads as unknown", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "device-pid-")));
    writePid(dir, 1234, "0.1.0-rc.9");
    expect(readRunning(dir, () => true)).toMatchObject({ pid: 1234, version: "0.1.0-rc.9" });
    // a program older than the version field
    writeFileSync(pidPath(dir), "1234\n");
    const old = readRunning(dir, () => true);
    expect(old?.pid).toBe(1234);
    expect(old?.version).toBeUndefined();
    // removePid still matches the JSON form
    removePid(dir, 1234);
    expect(existsSync(pidPath(dir))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
