import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "../src/client.js";
import { drain } from "../src/commands/drain.js";
import { serviceCommand } from "../src/commands/service.js";
import { start } from "../src/commands/start.js";
import { stop } from "../src/commands/stop.js";
import {
  type ProcessInfo,
  type ProcessLookup,
  parsePidFile,
  parsePsOutput,
  pidPath,
  readRunning,
  writePid,
} from "../src/pid.js";
import { plistBinPath, plistContent, plistPath } from "../src/service/launchd.js";
import { startedByServiceManager } from "../src/service/manager.js";
import { unitBinPath, unitContent, unitPath } from "../src/service/systemd.js";
import { writeCredential } from "../src/state.js";
import { FakeExecutor } from "./fake-kernel.js";

/** A `ps` that knows the given processes. */
const psOf =
  (procs: Record<number, ProcessInfo>): ProcessLookup =>
  (pid) =>
    procs[pid];
/** Our program's command line, started long ago. */
const ours = (started = new Date(0)): ProcessInfo => ({
  command:
    "/usr/local/bin/node /usr/local/lib/node_modules/@capybara-hq/device/bin/capybara-device.mjs start",
  started,
});
const alive = (() => true) as typeof process.kill;

let home: string;
let stateDir: string;
let lines: string[];
let calls: string[][];
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "device-control-")));
  stateDir = join(home, ".config", "capybara-device");
  mkdirSync(stateDir, { recursive: true });
  lines = [];
  calls = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const out = (l: string) => void lines.push(l);

describe("a pid file names this program (DV4)", () => {
  it("parses ps output: the start in local time, then the command", () => {
    const info = parsePsOutput(
      "Sat Nov  4 02:11:37 2026 /usr/bin/node /x/bin/capybara-device.mjs start\n",
    );
    expect(info?.command).toBe("/usr/bin/node /x/bin/capybara-device.mjs start");
    expect(info?.started).toEqual(new Date(2026, 10, 4, 2, 11, 37));
    expect(parsePsOutput("")).toBeUndefined();
  });

  it("one parser reads both pid file forms", () => {
    expect(
      parsePidFile('{"pid":12,"version":"1.0.0","startedAt":"2026-11-15T00:00:00.000Z"}\n'),
    ).toEqual({
      pid: 12,
      version: "1.0.0",
      startedAt: "2026-11-15T00:00:00.000Z",
    });
    expect(parsePidFile("12\n")).toEqual({ pid: 12 });
    expect(parsePidFile("nope")).toBeUndefined();
    expect(parsePidFile("{")).toBeUndefined();
  });

  it("trusts a live pid only when ps shows capybara-device started before the file", () => {
    writePid(stateDir, 4242, "1.0.0");
    expect(readRunning(stateDir, { kill: alive, ps: psOf({ 4242: ours() }) })?.pid).toBe(4242);
    // another program now has the pid
    expect(
      readRunning(stateDir, {
        kill: alive,
        ps: psOf({ 4242: { command: "vim notes.md", started: new Date(0) } }),
      }),
    ).toBeUndefined();
    // a capybara-device that started after the file was written: a reused pid
    const later = new Date(Date.now() + 60_000);
    expect(readRunning(stateDir, { kill: alive, ps: psOf({ 4242: ours(later) }) })).toBeUndefined();
    // ps does not know it
    expect(readRunning(stateDir, { kill: alive, ps: psOf({}) })).toBeUndefined();
  });

  it("stop and drain never signal an unverified pid", () => {
    writePid(stateDir, 4242);
    const sent: Array<[number, unknown]> = [];
    const kill = ((pid: number, sig?: string | number) => {
      sent.push([pid, sig]);
      return true;
    }) as typeof process.kill;
    const ps = psOf({ 4242: { command: "/usr/bin/python3 server.py", started: new Date(0) } });
    const errs: string[] = [];
    const noService = { home, platform: "darwin" as const };
    expect(stop(stateDir, out, (l) => errs.push(l), { kill, ps, service: noService })).toBe(1);
    expect(drain(stateDir, out, (l) => errs.push(l), { kill, ps })).toBe(1);
    expect(errs).toEqual(["capybara-device is not running.", "capybara-device is not running."]);
    expect(sent.filter(([, s]) => s !== 0)).toEqual([]);
  });
});

/** `launchctl`: `print` fails while unloaded, and names the running pid when there is one. */
function fakeLaunchctl(state: { loaded: boolean; pid?: number; onKickstart?: () => void }) {
  return (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (args[0] === "print") {
      if (!state.loaded) throw Object.assign(new Error("Could not find service"), { status: 113 });
      return `top.capybara.device = {\n\tstate = ${state.pid ? "running" : "not running"}\n${
        state.pid ? `\tpid = ${state.pid}\n` : ""
      }\tlast exit code = 0\n}\n`;
    }
    if (args[0] === "kickstart") state.onKickstart?.();
    if (args[0] === "bootout") {
      state.loaded = false;
      delete state.pid;
    }
    return "";
  };
}

/** `systemctl --user`: `is-active` fails while inactive; `show MainPID` names the pid (0 = none). */
function fakeSystemctl(state: { active: boolean; pid?: number; onStart?: () => void }) {
  return (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (args.includes("is-active")) {
      if (!state.active) throw Object.assign(new Error("inactive"), { status: 3 });
      return "";
    }
    if (args.includes("MainPID")) return `${state.pid ?? 0}\n`;
    if (args.includes("start") || args.includes("restart")) state.onStart?.();
    return "";
  };
}

const installPlist = (binPath = "/b/bin/capybara-device.mjs") => {
  mkdirSync(dirname(plistPath(home)), { recursive: true });
  writeFileSync(
    plistPath(home),
    plistContent({ nodePath: "/n/node", binPath, stateDir, env: { PATH: "/bin" } }),
  );
};
const installUnit = (binPath = "/b/bin/capybara-device.mjs") => {
  mkdirSync(dirname(unitPath(home)), { recursive: true });
  writeFileSync(
    unitPath(home),
    unitContent({ nodePath: "/n/node", binPath, stateDir, env: { PATH: "/bin" } }),
  );
};

describe("stop under a service (DV2)", () => {
  const darwin = { home, platform: "darwin" as const };
  const signalled = () => calls.filter((c) => c[0] === "kill");
  const kill = ((pid: number, sig?: string | number) => {
    if (sig !== 0) calls.push(["kill", String(pid), String(sig)]);
    return true;
  }) as typeof process.kill;

  it("refuses when launchd has the service loaded and runs the pid file's program", () => {
    installPlist();
    writePid(stateDir, 4242);
    const errs: string[] = [];
    const code = stop(stateDir, out, (l) => errs.push(l), {
      kill,
      ps: psOf({ 4242: ours() }),
      service: { ...darwin, home },
      run: fakeLaunchctl({ loaded: true, pid: 4242 }),
    });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("capybara-device service stop");
    expect(signalled()).toEqual([]);
  });

  it("signals a terminal program while the service is installed but not loaded, or runs another pid", () => {
    installPlist();
    writePid(stateDir, 5151);
    const ps = psOf({ 5151: ours() });
    expect(
      stop(stateDir, out, out, {
        kill,
        ps,
        service: { ...darwin, home },
        run: fakeLaunchctl({ loaded: false }),
      }),
    ).toBe(0);
    expect(
      stop(stateDir, out, out, {
        kill,
        ps,
        service: { ...darwin, home },
        run: fakeLaunchctl({ loaded: true }),
      }),
    ).toBe(0);
    expect(signalled()).toEqual([
      ["kill", "5151", "SIGTERM"],
      ["kill", "5151", "SIGTERM"],
    ]);
  });

  it("follows systemd's active state and MainPID on Linux", () => {
    installUnit();
    writePid(stateDir, 4242);
    const ps = psOf({ 4242: ours() });
    const linux = { home, platform: "linux" as const };
    expect(
      stop(stateDir, out, out, {
        kill,
        ps,
        service: linux,
        run: fakeSystemctl({ active: true, pid: 4242 }),
      }),
    ).toBe(1);
    expect(
      stop(stateDir, out, out, { kill, ps, service: linux, run: fakeSystemctl({ active: false }) }),
    ).toBe(0);
    expect(signalled()).toEqual([["kill", "4242", "SIGTERM"]]);
  });

  it("service start refuses while a program started outside it runs", async () => {
    installPlist();
    writePid(stateDir, 5151);
    const base = {
      stateDir,
      home,
      env: { PATH: "/bin" },
      out,
      err: out,
      sleep: async () => {},
      uid: 501,
      kill: alive,
      ps: psOf({ 5151: ours() }),
    };
    expect(
      await serviceCommand("start", {
        ...base,
        platform: "darwin",
        run: fakeLaunchctl({ loaded: false }),
      }),
    ).toBe(1);
    expect(lines.join("\n")).toContain("Stop it first: capybara-device stop");
    expect(calls.filter((c) => c[1] === "bootstrap")).toEqual([]);

    installUnit();
    lines.length = 0;
    expect(
      await serviceCommand("start", {
        ...base,
        platform: "linux",
        run: fakeSystemctl({ active: false }),
      }),
    ).toBe(1);
    expect(lines.join("\n")).toContain("Stop it first: capybara-device stop");
    expect(calls.filter((c) => c.includes("start"))).toEqual([]);
  });

  it("start prints the service hint only when the service manager did not start it", async () => {
    installPlist();
    writeCredential(stateDir, {
      url: "http://x.test",
      connectUrl: "ws://x.test/device/connect",
      credential: "cap_dev_a",
      orgId: "o",
      deviceId: "e1",
      dir: "/w",
      mode: "os",
      reconnectGraceSeconds: 120,
      maxFrameBytes: 16 * 1024 * 1024,
    });
    const run = async (env: Record<string, string>) => {
      const printed: string[] = [];
      const conn: Connection = { done: Promise.resolve(0), drain: () => {}, stop: () => {} };
      await start({
        stateDir,
        out: (l) => printed.push(l),
        err: () => {},
        env,
        service: { home, platform: "darwin" },
        proc: Object.assign(new EventEmitter(), { pid: 4600 }) as never,
        createExecutor: () => new FakeExecutor(),
        connect: () => conn,
      });
      return printed.some((l) => l.includes("runs as a login service"));
    };
    expect(await run({ XPC_SERVICE_NAME: "0" })).toBe(true);
    expect(await run({ XPC_SERVICE_NAME: "top.capybara.device" })).toBe(false);
    expect(startedByServiceManager({ INVOCATION_ID: "abc" }, 7)).toBe(true);
    expect(startedByServiceManager({ INVOCATION_ID: "abc", SYSTEMD_EXEC_PID: "7" }, 7)).toBe(true);
    // a shell in a terminal that systemd started inherits INVOCATION_ID, not the exec pid
    expect(startedByServiceManager({ INVOCATION_ID: "abc", SYSTEMD_EXEC_PID: "3" }, 7)).toBe(false);
    expect(startedByServiceManager({}, 7)).toBe(false);
  });
});

describe("service status says what is true (DV5)", () => {
  const base = () => ({
    stateDir,
    home,
    env: { PATH: "/bin" },
    out,
    err: out,
    sleep: async () => {},
    uid: 501,
    kill: alive,
    ps: psOf({ 4242: ours() }),
  });

  /** A package at `<home>/pkg` with `version`, whose bin the service file runs. */
  const packageAt = (version: string): string => {
    const root = join(home, "pkg");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
    return join(root, "bin", "capybara-device.mjs");
  };

  it("the service file's bin path is read back", () => {
    const spec = {
      nodePath: "/n",
      binPath: "/a&b/100%/bin/capybara-device.mjs",
      stateDir,
      env: {},
    };
    expect(plistBinPath(plistContent(spec))).toBe(spec.binPath);
    expect(unitBinPath(unitContent(spec))).toBe(spec.binPath);
  });

  it("macOS: not installed, not loaded, loaded but not running, running", async () => {
    const status = async (state: { loaded: boolean; pid?: number }) => {
      lines.length = 0;
      const code = await serviceCommand("status", {
        ...base(),
        platform: "darwin",
        run: fakeLaunchctl(state),
      });
      return { code, text: lines.join("\n") };
    };
    expect(await status({ loaded: false })).toMatchObject({
      code: 1,
      text: expect.stringContaining("is not installed"),
    });

    installPlist(packageAt("1.0.0"));
    expect(await status({ loaded: false })).toMatchObject({
      code: 1,
      text: expect.stringContaining("installed but not loaded"),
    });

    const crashed = await status({ loaded: true });
    expect(crashed.code).toBe(1);
    expect(crashed.text).toContain("not running");
    expect(crashed.text).toContain(join(stateDir, "service.log"));
    expect(crashed.text).toContain("capybara-device service restart");

    writePid(stateDir, 4242, "1.0.0");
    const up = await status({ loaded: true, pid: 4242 });
    expect(up).toMatchObject({
      code: 0,
      text: expect.stringContaining("running (pid 4242, 1.0.0)"),
    });
    expect(up.text).not.toContain("restart");
  });

  it("the restart line compares with the package the service file runs, not this CLI", async () => {
    installPlist(packageAt("2.0.0"));
    writePid(stateDir, 4242, "1.0.0");
    expect(
      await serviceCommand("status", {
        ...base(),
        platform: "darwin",
        run: fakeLaunchctl({ loaded: true, pid: 4242 }),
      }),
    ).toBe(0);
    expect(lines.join("\n")).toContain(
      "installed 2.0.0 — restart it: capybara-device service restart",
    );
  });

  it("a bare pid file reads as version unknown, with the restart line", async () => {
    installPlist(packageAt("1.0.0"));
    // a program older than the version field wrote only its pid
    writeFileSync(pidPath(stateDir), "4242\n");
    expect(
      await serviceCommand("status", {
        ...base(),
        platform: "darwin",
        run: fakeLaunchctl({ loaded: true, pid: 4242 }),
      }),
    ).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("running (pid 4242, version unknown)");
    expect(text).toContain("installed 1.0.0 — restart it: capybara-device service restart");
  });

  it("Linux running takes the unit's MainPID", async () => {
    installUnit(packageAt("1.0.0"));
    writePid(stateDir, 4242, "1.0.0");
    expect(
      await serviceCommand("status", {
        ...base(),
        platform: "linux",
        run: fakeSystemctl({ active: true, pid: 4242 }),
      }),
    ).toBe(0);
    expect(lines.join("\n")).toContain("running (pid 4242, 1.0.0)");
    lines.length = 0;
    expect(
      await serviceCommand("status", {
        ...base(),
        platform: "linux",
        run: fakeSystemctl({ active: true }),
      }),
    ).toBe(1);
    expect(lines.join("\n")).toContain("not running");
  });

  it("stop fails while launchd keeps the service loaded; restart fails when it does not come back", async () => {
    installPlist();
    const stuck = (cmd: string, args: string[]): string => {
      calls.push([cmd, ...args]);
      return args[0] === "print" ? "\tpid = 4242\n" : "";
    };
    expect(await serviceCommand("stop", { ...base(), platform: "darwin", run: stuck })).toBe(1);
    expect(lines.join("\n")).toContain("still has the service loaded");

    lines.length = 0;
    // kickstart -k runs, but the program exits at once: no pid afterwards
    const state: { loaded: boolean; pid?: number; onKickstart?: () => void } = {
      loaded: true,
      pid: 4242,
    };
    state.onKickstart = () => {
      delete state.pid;
    };
    expect(
      await serviceCommand("restart", { ...base(), platform: "darwin", run: fakeLaunchctl(state) }),
    ).toBe(1);
    expect(lines.join("\n")).toContain("not running");
    expect(lines.join("\n")).toContain("service.log");

    lines.length = 0;
    const ok: { loaded: boolean; pid?: number; onKickstart?: () => void } = {
      loaded: true,
      pid: 4242,
    };
    ok.onKickstart = () => {
      ok.pid = 4343;
    };
    expect(
      await serviceCommand("restart", { ...base(), platform: "darwin", run: fakeLaunchctl(ok) }),
    ).toBe(0);
    expect(lines.join("\n")).toContain("Restarted");
  });

  it("start kickstarts a loaded service whose program exited", async () => {
    installPlist();
    const state: { loaded: boolean; pid?: number; onKickstart?: () => void } = { loaded: true };
    state.onKickstart = () => {
      state.pid = 4444;
    };
    expect(
      await serviceCommand("start", { ...base(), platform: "darwin", run: fakeLaunchctl(state) }),
    ).toBe(0);
    expect(calls).toContainEqual(["launchctl", "kickstart", "gui/501/top.capybara.device"]);
    expect(lines.join("\n")).toContain("Started");
  });

  it("Linux stop fails while the unit stays active", async () => {
    installUnit();
    expect(
      await serviceCommand("stop", {
        ...base(),
        platform: "linux",
        run: fakeSystemctl({ active: true, pid: 4242 }),
      }),
    ).toBe(1);
    expect(lines.join("\n")).toContain("still active");
  });
});
