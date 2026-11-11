import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "../src/client.js";
import { drain } from "../src/commands/drain.js";
import { start } from "../src/commands/start.js";
import { stop } from "../src/commands/stop.js";
import { pidPath, writePid } from "../src/pid.js";
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
    expect(
      stop(
        dir,
        () => {},
        (l) => err.push(l),
        kill,
      ),
    ).toBe(1);
    writePid(dir, 777);
    expect(
      stop(
        dir,
        () => {},
        () => {},
        kill,
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
});
