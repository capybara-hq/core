import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "../src/client.js";
import { drain } from "../src/commands/drain.js";
import { start } from "../src/commands/start.js";
import { stop } from "../src/commands/stop.js";
import { pidPath, writePid } from "../src/pid.js";
import { writeCredential } from "../src/state.js";
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
  environmentId: "e1",
  dir: "/w",
  mode: "os" as const,
  reconnectGraceSeconds: 120,
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

  it("start without a credential exits 1", async () => {
    const err: string[] = [];
    const code = await start({ stateDir: dir, out: () => {}, err: (l) => err.push(l) });
    expect(code).toBe(1);
    expect(err[0]).toContain("Not logged in");
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
