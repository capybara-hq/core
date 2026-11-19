import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCommandLine, UsageError } from "../src/args.js";
import { runCli } from "../src/cli.js";
import { KeepAwake } from "../src/keep-awake.js";
import { DEFAULT_POLICY, policyPath, readPolicy, writePolicy } from "../src/state.js";

/** A fake holder process: records its spawn and whether it was killed. */
class FakeChild extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}
function fakeSpawn() {
  const calls: { command: string; args: string[]; child: FakeChild }[] = [];
  const spawn = ((command: string, args: string[]) => {
    const child = new FakeChild();
    calls.push({ command, args, child });
    return child;
  }) as never;
  return { calls, spawn };
}
const make = (platform: NodeJS.Platform = "darwin") => {
  const f = fakeSpawn();
  return { ...f, ka: new KeepAwake({ platform, pid: 321, spawn: f.spawn }) };
};

describe("KeepAwake", () => {
  it("while-busy holds only while operations run", () => {
    const { ka, calls } = make();
    ka.update({ mode: "while-busy", connected: true, busy: false });
    expect(calls).toHaveLength(0);
    expect(ka.state()).toEqual({ mode: "while-busy", held: false });
    ka.update({ mode: "while-busy", connected: true, busy: true });
    expect(calls.map((c) => [c.command, c.args])).toEqual([
      ["/usr/bin/caffeinate", ["-i", "-w", "321"]],
    ]);
    expect(ka.state().held).toBe(true);
    ka.update({ mode: "while-busy", connected: true, busy: true });
    expect(calls).toHaveLength(1);
    ka.update({ mode: "while-busy", connected: true, busy: false });
    expect(calls[0]?.child.killed).toBe(true);
    expect(ka.state().held).toBe(false);
  });

  it("connected holds while connected", () => {
    const { ka, calls } = make();
    ka.update({ mode: "connected", connected: false, busy: true });
    expect(calls).toHaveLength(0);
    ka.update({ mode: "connected", connected: true, busy: false });
    expect(ka.state()).toEqual({ mode: "connected", held: true });
    ka.update({ mode: "connected", connected: false, busy: false });
    expect(calls[0]?.child.killed).toBe(true);
  });

  it("off never spawns", () => {
    const { ka, calls } = make();
    ka.update({ mode: "off", connected: true, busy: true });
    expect(calls).toHaveLength(0);
    expect(ka.state()).toEqual({ mode: "off", held: false });
  });

  it("a mode change releases a holder the new mode does not want", () => {
    const { ka, calls } = make();
    ka.update({ mode: "connected", connected: true, busy: false });
    ka.update({ mode: "while-busy", connected: true, busy: false });
    expect(calls[0]?.child.killed).toBe(true);
  });

  it("linux uses systemd-inhibit", () => {
    const { ka, calls } = make("linux");
    ka.update({ mode: "connected", connected: true, busy: false });
    expect(calls.map((c) => [c.command, c.args])).toEqual([
      [
        "systemd-inhibit",
        [
          "--what=idle:sleep",
          "--mode=block",
          "--who=capybara-device",
          "--why=Capybara device is serving",
          "sleep",
          "infinity",
        ],
      ],
    ]);
  });

  it("a spawn error is unavailable with the reason", () => {
    const { ka, calls } = make();
    ka.update({ mode: "connected", connected: true, busy: false });
    calls[0]?.child.emit("error", new Error("spawn /usr/bin/caffeinate ENOENT"));
    const s = ka.state();
    expect(s.held).toBe(false);
    expect(s.unavailable).toContain("ENOENT");
    // still wanted: no new spawn and the status stays put
    for (let i = 0; i < 3; i++)
      ka.update({ mode: "connected", connected: true, busy: i % 2 === 0 });
    expect(calls).toHaveLength(1);
    expect(ka.state().unavailable).toContain("ENOENT");
    // nothing wanted, then wanted again: tries again
    ka.update({ mode: "connected", connected: false, busy: false });
    expect(ka.state().unavailable).toBeUndefined();
    ka.update({ mode: "connected", connected: true, busy: false });
    expect(calls).toHaveLength(2);
    // a changed mode also tries again
    calls[1]?.child.emit("exit", 1, null);
    ka.update({ mode: "while-busy", connected: true, busy: true });
    expect(calls).toHaveLength(3);
  });

  it("a synchronous spawn failure and an early exit are unavailable too", () => {
    const f = fakeSpawn();
    const throwing = new KeepAwake({
      platform: "linux",
      pid: 1,
      spawn: (() => {
        throw new Error("EACCES");
      }) as never,
    });
    throwing.update({ mode: "connected", connected: true, busy: false });
    expect(throwing.state()).toMatchObject({
      held: false,
      unavailable: expect.stringContaining("EACCES"),
    });
    const ka = new KeepAwake({ platform: "linux", pid: 1, spawn: f.spawn });
    ka.update({ mode: "connected", connected: true, busy: false });
    f.calls[0]?.child.emit("exit", 1, null);
    expect(ka.state()).toMatchObject({
      held: false,
      unavailable: expect.stringContaining("exit 1"),
    });
  });

  it("an unsupported platform is unavailable", () => {
    const { ka } = make("win32");
    ka.update({ mode: "connected", connected: true, busy: false });
    expect(ka.state().unavailable).toContain("win32");
  });

  it("dispose kills the holder", () => {
    const { ka, calls } = make();
    ka.update({ mode: "connected", connected: true, busy: false });
    ka.dispose();
    expect(calls[0]?.child.killed).toBe(true);
    expect(ka.state().held).toBe(false);
  });
});

describe("keep-awake command", () => {
  let root: string;
  let state: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "device-keep-awake-"));
    state = join(root, "capybara-device");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = async (argv: string[], opts: { tty?: string } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    const code = await runCli(["keep-awake", ...argv], {
      env: { XDG_CONFIG_HOME: root },
      home: join(root, "home"),
      platform: "darwin",
      stdinIsTTY: opts.tty !== undefined,
      ask: async (q) => {
        asked.push(q);
        return opts.tty ?? "";
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out, err, asked };
  };

  it("keepAwake defaults to while-busy and a bad value is refused", () => {
    expect(readPolicy(state).keepAwake).toBe("while-busy");
    writePolicy(state, { ...DEFAULT_POLICY, keepAwake: "connected" });
    expect(readPolicy(state).keepAwake).toBe("connected");
    const file = JSON.parse(readFileSync(policyPath(state), "utf8"));
    writePolicy(state, DEFAULT_POLICY);
    writeFileSync(policyPath(state), JSON.stringify({ ...file, keepAwake: "always" }));
    expect(() => readPolicy(state)).toThrow(/keepAwake must be/);
    expect(() => parseCommandLine(["keep-awake", "always"])).toThrow(UsageError);
  });

  it("show prints the mode, as JSON with --json", async () => {
    expect((await run([])).out[0]).toBe("Keep-awake: while-busy");
    const j = await run(["show", "--json"]);
    expect(JSON.parse(j.out[0] ?? "")).toEqual({ keepAwake: "while-busy" });
  });

  it("raising without a tty needs --yes", async () => {
    const r = await run(["connected"]);
    expect(r.code).toBe(2);
    expect(readPolicy(state).keepAwake).toBe("while-busy");
    const ok = await run(["connected", "--yes"]);
    expect(ok.code).toBe(0);
    expect(readPolicy(state).keepAwake).toBe("connected");
    expect(readFileSync(join(state, "commands.log"), "utf8")).toContain("keep-awake set connected");
  });

  it("raising on a tty asks, and only y applies", async () => {
    const no = await run(["connected"], { tty: "n" });
    expect(no.asked).toEqual(["Keep this computer awake more often? [y/N] "]);
    expect(no.code).toBe(1);
    expect(readPolicy(state).keepAwake).toBe("while-busy");
    expect((await run(["connected"], { tty: "y" })).code).toBe(0);
    expect(readPolicy(state).keepAwake).toBe("connected");
  });

  it("lowering applies without asking", async () => {
    writePolicy(state, { ...DEFAULT_POLICY, keepAwake: "connected" });
    const r = await run(["off"]);
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([]);
    expect(readPolicy(state).keepAwake).toBe("off");
  });
});
