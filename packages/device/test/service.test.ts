import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import {
  BOOTSTRAP_BACKOFF_MS,
  SERVICE_GONE_TIMEOUT_MS,
  SERVICE_POLL_MS,
  serviceCommand,
} from "../src/commands/service.js";
import { writePid } from "../src/pid.js";
import { hasLoginService } from "../src/service/installed.js";
import {
  LAUNCHD_THROTTLE_INTERVAL_SECONDS,
  launchdLabel,
  plistContent,
  plistPath,
  rotateServiceLog,
} from "../src/service/launchd.js";
import { startedByServiceManager } from "../src/service/manager.js";
import {
  SYSTEMD_TEMPLATE,
  systemdUnit,
  unitContent,
  unitPath,
  unitWantsLink,
} from "../src/service/systemd.js";
import { writeCredential } from "../src/state.js";

const id = "dev-1";
const spec = {
  nodePath: "/opt/node 22/bin/node",
  binPath: "/usr/lib/node_modules/@capybara-hq/device/bin/capybara-device.mjs",
  stateDir: "/home/u/.config/capybara-device/connections/dev-1",
  deviceId: id,
  env: { PATH: "/usr/local/bin:/usr/bin", XDG_CONFIG_HOME: "/home/u/.config" },
};

describe("service files", () => {
  it("launchd plist runs start with the node path", () => {
    const p = plistContent(spec);
    expect(p).toContain("<key>Label</key>\n  <string>top.capybara.device.dev-1</string>");
    expect(p).toContain(
      "<string>/opt/node 22/bin/node</string>\n    <string>/usr/lib/node_modules/@capybara-hq/device/bin/capybara-device.mjs</string>\n    <string>start</string>\n    <string>--connection</string>\n    <string>dev-1</string>",
    );
    expect(p).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    // Only a failing exit restarts the program: exit 0 is a deliberate stop (logout, revoked,
    // drain, not logged in) and stays stopped.
    expect(p).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    );
    expect(p).toMatch(
      new RegExp(
        `<key>ThrottleInterval</key>\\s*<integer>${LAUNCHD_THROTTLE_INTERVAL_SECONDS}</integer>`,
      ),
    );
    expect(LAUNCHD_THROTTLE_INTERVAL_SECONDS).toBeGreaterThanOrEqual(10);
    expect(p).toContain(
      "<string>/home/u/.config/capybara-device/connections/dev-1/service.log</string>",
    );
    expect(p).toContain("<key>PATH</key>");
    expect(plistPath("/Users/u", id)).toBe(
      "/Users/u/Library/LaunchAgents/top.capybara.device.dev-1.plist",
    );
  });

  it("escapes XML in paths", () => {
    expect(plistContent({ ...spec, nodePath: "/a&b/<n>" })).toContain("/a&amp;b/&lt;n&gt;");
  });

  it("systemd unit restarts on failure", () => {
    const u = unitContent(spec);
    expect(u).toContain(
      'ExecStart="/opt/node 22/bin/node" "/usr/lib/node_modules/@capybara-hq/device/bin/capybara-device.mjs" start --connection %i',
    );
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("WantedBy=default.target");
    expect(u).toContain('Environment="PATH=/usr/local/bin:/usr/bin"');
    expect(unitPath("/home/u")).toBe("/home/u/.config/systemd/user/capybara-device@.service");
    expect(unitContent({ ...spec, binPath: "/x/100%/b" })).toContain("100%%");
  });
});

describe("service log", () => {
  it("is copied to .1 and emptied past the limit", () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "device-svclog-")));
    writeFileSync(join(d, "service.log"), "x".repeat(100));
    rotateServiceLog(d, 1000);
    expect(readFileSync(join(d, "service.log"), "utf8")).toHaveLength(100);
    rotateServiceLog(d, 50);
    expect(readFileSync(join(d, "service.log"), "utf8")).toBe("");
    expect(readFileSync(join(d, "service.log.1"), "utf8")).toHaveLength(100);
    rmSync(d, { recursive: true });
  });
});

/** An error like execFileSync's for a failed launchctl call. */
const failed = (status: number, stderr: string) =>
  Object.assign(new Error(`Command failed: launchctl\n${stderr}`), {
    status,
    stderr: Buffer.from(stderr),
  });

describe("service command", () => {
  let home: string;
  let calls: string[][];
  let lines: string[];
  let slept: number[];
  const run = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    return "";
  };
  const sleep = async (ms: number) => void slept.push(ms);
  const label = "gui/501/top.capybara.device.dev-1";
  const base = () => ({
    stateDir: join(home, ".config", "capybara-device", "connections", id),
    deviceId: id,
    home,
    env: { PATH: "/bin" },
    out: (l: string) => void lines.push(l),
    err: (l: string) => void lines.push(l),
    run,
    sleep,
    uid: 501,
    nodePath: "/n/node",
    binPath: "/b/capybara-device.mjs",
  });
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "device-service-")));
    calls = [];
    lines = [];
    slept = [];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /**
   * A fake launchctl: `print` answers while the service is loaded, naming the program's pid; `bootout`
   * unloads it only after `printsUntilGone` more prints (bootout is asynchronous); `bootstrap` fails
   * with `failures` first, then loads it with a running program; `kickstart` runs a new one.
   */
  function fakeLaunchctl(o: { loaded?: boolean; printsUntilGone?: number; failures?: Error[] }) {
    let loaded = o.loaded ?? false;
    let pid = 4000;
    let goneAfter: number | undefined;
    const failures = [...(o.failures ?? [])];
    return (cmd: string, args: string[]): string => {
      calls.push([cmd, ...args]);
      if (args[0] === "print") {
        if (goneAfter !== undefined && goneAfter-- <= 0) loaded = false;
        if (!loaded)
          throw failed(113, `Could not find service "top.capybara.device.dev-1" in domain`);
        return `\tstate = running\n\tpid = ${pid}\n`;
      }
      if (args[0] === "bootout") {
        if (!loaded) throw failed(3, "Boot-out failed: 3: No such process");
        goneAfter = o.printsUntilGone ?? 0;
        return "";
      }
      if (args[0] === "bootstrap") {
        const f = failures.shift();
        if (f) throw f;
        loaded = true;
        goneAfter = undefined;
      }
      if (args[0] === "kickstart") pid++;
      return "";
    };
  }

  it("macOS install writes the plist and bootstraps it; uninstall boots it out and removes it", async () => {
    const launchctl = fakeLaunchctl({});
    expect(await serviceCommand("install", { ...base(), run: launchctl, platform: "darwin" })).toBe(
      0,
    );
    expect(readFileSync(plistPath(home, id), "utf8")).toContain("<string>/n/node</string>");
    // nothing loaded: no bootout
    expect(calls).toEqual([
      ["launchctl", "print", label],
      ["launchctl", "bootstrap", "gui/501", plistPath(home, id)],
    ]);
    calls.length = 0;
    expect(
      await serviceCommand("uninstall", { ...base(), run: launchctl, platform: "darwin" }),
    ).toBe(0);
    expect(calls).toEqual([
      ["launchctl", "bootout", label],
      ["launchctl", "print", label],
    ]);
    expect(existsSync(plistPath(home, id))).toBe(false);
  });

  it("macOS install waits until the old service is gone after bootout, then bootstraps", async () => {
    const launchctl = fakeLaunchctl({ loaded: true, printsUntilGone: 3 });
    expect(await serviceCommand("install", { ...base(), run: launchctl, platform: "darwin" })).toBe(
      0,
    );
    expect(calls).toEqual([
      ["launchctl", "print", label],
      ["launchctl", "bootout", label],
      ["launchctl", "print", label],
      ["launchctl", "print", label],
      ["launchctl", "print", label],
      ["launchctl", "print", label],
      ["launchctl", "bootstrap", "gui/501", plistPath(home, id)],
    ]);
    expect(slept).toEqual([SERVICE_POLL_MS, SERVICE_POLL_MS, SERVICE_POLL_MS]);
  });

  it("macOS install over a loaded agent rewrites the plist and loads the new one", async () => {
    mkdirSync(dirname(plistPath(home, id)), { recursive: true });
    writeFileSync(plistPath(home, id), "old plist");
    const launchctl = fakeLaunchctl({ loaded: true });
    expect(await serviceCommand("install", { ...base(), run: launchctl, platform: "darwin" })).toBe(
      0,
    );
    // bootout before the write, bootstrap after it: launchd reads the new plist at bootstrap.
    expect(calls.map((c) => c[1])).toEqual(["bootout", "print", "bootstrap"]);
    const written = readFileSync(plistPath(home, id), "utf8");
    expect(written).not.toContain("old plist");
    expect(written).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(written).toContain(
      `<key>ThrottleInterval</key>\n  <integer>${LAUNCHD_THROTTLE_INTERVAL_SECONDS}</integer>`,
    );
  });

  const installPlist = () => {
    mkdirSync(dirname(plistPath(home, id)), { recursive: true });
    writeFileSync(plistPath(home, id), plistContent(spec));
  };
  const installUnit = () => {
    mkdirSync(dirname(unitPath(home)), { recursive: true });
    writeFileSync(unitPath(home), unitContent(spec));
    mkdirSync(dirname(unitWantsLink(home, id)), { recursive: true });
    symlinkSync(unitPath(home), unitWantsLink(home, id));
  };

  it("macOS start: refuses without an install, bootstraps an installed one, no-ops when loaded", async () => {
    const launchctl = fakeLaunchctl({});
    expect(await serviceCommand("start", { ...base(), run: launchctl, platform: "darwin" })).toBe(
      1,
    );
    expect(lines.join("\n")).toContain("capybara-device service install");

    installPlist();
    lines.length = 0;
    expect(await serviceCommand("start", { ...base(), run: launchctl, platform: "darwin" })).toBe(
      0,
    );
    expect(calls.filter((c) => c[1] === "bootstrap")).toHaveLength(1);
    expect(lines.join("\n")).toContain("Started the capybara-device login service.");

    lines.length = 0;
    expect(
      await serviceCommand("start", {
        ...base(),
        run: fakeLaunchctl({ loaded: true }),
        platform: "darwin",
      }),
    ).toBe(0);
    expect(lines.join("\n")).toContain("already running");
  });

  it("macOS stop unloads the service and never signals", async () => {
    expect(
      await serviceCommand("stop", { ...base(), run: fakeLaunchctl({}), platform: "darwin" }),
    ).toBe(1);
    expect(lines.join("\n")).toContain("capybara-device service install");

    installPlist();
    lines.length = 0;
    expect(
      await serviceCommand("stop", { ...base(), run: fakeLaunchctl({}), platform: "darwin" }),
    ).toBe(0);
    expect(lines.join("\n")).toContain("not running");

    const launchctl = fakeLaunchctl({ loaded: true });
    lines.length = 0;
    expect(await serviceCommand("stop", { ...base(), run: launchctl, platform: "darwin" })).toBe(0);
    expect(calls.filter((c) => c[1] === "bootout")).toHaveLength(1);
    expect(lines.join("\n")).toContain("capybara-device service start");
  });

  it("macOS restart reloads a loaded service, and bootstraps an unloaded one", async () => {
    installPlist();
    const launchctl = fakeLaunchctl({ loaded: true });
    expect(await serviceCommand("restart", { ...base(), run: launchctl, platform: "darwin" })).toBe(
      0,
    );
    expect(calls.filter((c) => c[1] === "kickstart")).toHaveLength(1);
    expect(calls.find((c) => c[1] === "kickstart")).toEqual([
      "launchctl",
      "kickstart",
      "-k",
      label,
    ]);

    lines.length = 0;
    calls.length = 0;
    expect(
      await serviceCommand("restart", {
        ...base(),
        run: fakeLaunchctl({}),
        platform: "darwin",
      }),
    ).toBe(0);
    expect(calls.filter((c) => c[1] === "bootstrap")).toHaveLength(1);
    expect(lines.join("\n")).toContain("Restarted the capybara-device login service.");
  });

  it("macOS restart refuses without an install", async () => {
    expect(
      await serviceCommand("restart", {
        ...base(),
        run: fakeLaunchctl({}),
        platform: "darwin",
      }),
    ).toBe(1);
    expect(lines.join("\n")).toContain("capybara-device service install");
  });

  it("Linux start, stop and restart are systemctl verbs", async () => {
    /** Records the call; answers `is-active` with `active`. */
    const systemctl = (initial: boolean) => {
      let active = initial;
      let pid = 4000;
      return (cmd: string, args: string[]): string => {
        calls.push([cmd, ...args]);
        if (args.includes("is-active") && !active) throw failed(3, "inactive");
        if (args.includes("MainPID")) return active ? `${pid}\n` : "0\n";
        if (args.includes("start") || args.includes("restart")) {
          active = true;
          pid++;
        }
        if (args.includes("stop")) active = false;
        return "";
      };
    };
    const inactive = systemctl(false);
    const running = systemctl(true);
    expect(await serviceCommand("start", { ...base(), run: inactive, platform: "linux" })).toBe(1);
    installUnit();
    lines.length = 0;
    calls.length = 0;
    expect(await serviceCommand("start", { ...base(), run: inactive, platform: "linux" })).toBe(0);
    expect(calls).toContainEqual(["systemctl", "--user", "start", systemdUnit(id)]);
    lines.length = 0;
    calls.length = 0;
    expect(await serviceCommand("restart", { ...base(), run: running, platform: "linux" })).toBe(0);
    expect(calls).toContainEqual(["systemctl", "--user", "restart", systemdUnit(id)]);
    lines.length = 0;
    calls.length = 0;
    expect(await serviceCommand("stop", { ...base(), run: running, platform: "linux" })).toBe(0);
    expect(calls).toContainEqual(["systemctl", "--user", "stop", systemdUnit(id)]);
  });

  it("macOS install stops waiting for the old service at the time limit", async () => {
    // print keeps answering: the bootout never takes
    const launchctl = (cmd: string, args: string[]): string => {
      calls.push([cmd, ...args]);
      return "";
    };
    expect(await serviceCommand("install", { ...base(), run: launchctl, platform: "darwin" })).toBe(
      0,
    );
    const total = slept.reduce((a, b) => a + b, 0);
    expect(total).toBe(SERVICE_GONE_TIMEOUT_MS);
    expect(calls.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", plistPath(home, id)]);
  });

  it("macOS install retries a bootstrap that fails with error 5", async () => {
    const io = () => failed(5, "Bootstrap failed: 5: Input/output error");
    const launchctl = fakeLaunchctl({ failures: [io(), io()] });
    expect(await serviceCommand("install", { ...base(), run: launchctl, platform: "darwin" })).toBe(
      0,
    );
    expect(calls.filter((c) => c[1] === "bootstrap")).toHaveLength(3);
    expect(slept.filter((ms) => ms !== SERVICE_POLL_MS)).toEqual(BOOTSTRAP_BACKOFF_MS.slice(0, 2));
    expect(lines.join("\n")).toContain("Installed");
  });

  it("macOS install explains an error 5 that persists", async () => {
    const io = () => failed(5, "Bootstrap failed: 5: Input/output error");
    const launchctl = fakeLaunchctl({ failures: Array.from({ length: 10 }, io) });
    expect(await serviceCommand("install", { ...base(), run: launchctl, platform: "darwin" })).toBe(
      1,
    );
    expect(calls.filter((c) => c[1] === "bootstrap")).toHaveLength(BOOTSTRAP_BACKOFF_MS.length + 1);
    const text = lines.join("\n");
    expect(text).toContain("Input/output error");
    expect(text).toContain(`launchctl print ${label}`);
  });

  it("macOS install does not retry other bootstrap errors", async () => {
    const launchctl = fakeLaunchctl({
      failures: [failed(122, "Bootstrap failed: 122: Path had bad ownership/permissions")],
    });
    expect(await serviceCommand("install", { ...base(), run: launchctl, platform: "darwin" })).toBe(
      1,
    );
    expect(calls.filter((c) => c[1] === "bootstrap")).toHaveLength(1);
    expect(lines.join("\n")).toContain("bad ownership");
  });

  it("Linux install writes the unit, enables it and (re)starts it; uninstall disables it", async () => {
    expect(await serviceCommand("install", { ...base(), platform: "linux" })).toBe(0);
    expect(readFileSync(unitPath(home), "utf8")).toContain("Restart=on-failure");
    // restart: a unit already running picks up the new file too
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "capybara-device@dev-1.service"],
      ["systemctl", "--user", "restart", "capybara-device@dev-1.service"],
    ]);
    calls.length = 0;
    expect(await serviceCommand("uninstall", { ...base(), platform: "linux" })).toBe(0);
    expect(calls[0]).toEqual([
      "systemctl",
      "--user",
      "disable",
      "--now",
      "capybara-device@dev-1.service",
    ]);
    expect(existsSync(unitPath(home))).toBe(false);
  });

  it("reports a failing system command and exits 1", async () => {
    const failing = () => {
      throw new Error("boom");
    };
    expect(await serviceCommand("install", { ...base(), platform: "linux", run: failing })).toBe(1);
    expect(lines.join("\n")).toContain("boom");
  });

  it("status --json: not installed", async () => {
    expect(await serviceCommand("status", { ...base(), platform: "linux" }, { json: true })).toBe(
      1,
    );
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      installed: false,
      loaded: false,
      running: false,
      binExists: false,
    });
  });

  it("status --json: binExists is false when the unit's bin path is gone", async () => {
    installUnit();
    const systemctl = (cmd: string, args: string[]): string => {
      calls.push([cmd, ...args]);
      return args.includes("MainPID") ? "4000\n" : "";
    };
    expect(
      await serviceCommand(
        "status",
        { ...base(), run: systemctl, platform: "linux" },
        { json: true },
      ),
    ).toBe(0);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      installed: true,
      loaded: true,
      running: true,
      pid: 4000,
      nodePath: spec.nodePath,
      binPath: spec.binPath,
      binExists: false,
    });
  });

  it("status --json: binExists is true and the installed version is read from the package", async () => {
    const pkg = join(home, "pkg");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "bin", "capybara-device.mjs"), "");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "1.2.3" }));
    mkdirSync(dirname(unitPath(home)), { recursive: true });
    writeFileSync(
      unitPath(home),
      unitContent({ ...spec, binPath: join(pkg, "bin", "capybara-device.mjs") }),
    );
    mkdirSync(dirname(unitWantsLink(home, id)), { recursive: true });
    symlinkSync(unitPath(home), unitWantsLink(home, id));
    const systemctl = (_cmd: string, args: string[]): string => {
      if (args.includes("is-active")) throw failed(3, "inactive");
      return "";
    };
    expect(
      await serviceCommand(
        "status",
        { ...base(), run: systemctl, platform: "linux" },
        { json: true },
      ),
    ).toBe(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      installed: true,
      loaded: false,
      running: false,
      installedVersion: "1.2.3",
      binExists: true,
    });
  });

  it("status --json: a running program with a matching pid reports pid and runningVersion", async () => {
    installUnit();
    const stateDir = base().stateDir;
    writePid(stateDir, 4000, "9.9.9");
    const systemctl = (_cmd: string, args: string[]): string =>
      args.includes("MainPID") ? "4000\n" : "";
    expect(
      await serviceCommand(
        "status",
        {
          ...base(),
          run: systemctl,
          platform: "linux",
          kill: (() => true) as unknown as typeof process.kill,
          ps: () => ({ command: "node /x/bin/capybara-device.mjs start", started: new Date(0) }),
        },
        { json: true },
      ),
    ).toBe(0);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      running: true,
      pid: 4000,
      runningVersion: "9.9.9",
    });
  });

  it("status --json on an unsupported platform fails like the human path", async () => {
    expect(await serviceCommand("status", { ...base(), platform: "win32" }, { json: true })).toBe(
      1,
    );
    expect(lines.join("\n")).toContain("needs macOS (launchd) or Linux (systemd)");
    expect(lines.join("\n")).not.toContain("{");
  });

  it("the plist's label and arguments name the connection", () => {
    const c = plistContent({
      ...spec,
      deviceId: "dev-2",
      stateDir: join(home, "connections", "dev-2"),
    });
    expect(c).toContain("<string>top.capybara.device.dev-2</string>");
    expect(c).toMatch(
      /<string>start<\/string>\s*<string>--connection<\/string>\s*<string>dev-2<\/string>/,
    );
    expect(c).toContain(join(home, "connections", "dev-2", "service.log"));
  });

  it("two connections install two agents side by side; uninstalling one leaves the other", async () => {
    const launchctl = fakeLaunchctl({});
    const two = { ...base(), deviceId: "dev-2", stateDir: join(home, "c2") };
    await serviceCommand("install", { ...base(), run: launchctl, platform: "darwin" });
    await serviceCommand("install", { ...two, run: launchctl, platform: "darwin" });
    expect(calls).toContainEqual(["launchctl", "bootstrap", "gui/501", plistPath(home, "dev-2")]);
    expect(existsSync(plistPath(home, "dev-1"))).toBe(true);
    expect(existsSync(plistPath(home, "dev-2"))).toBe(true);
    calls.length = 0;
    await serviceCommand("uninstall", { ...base(), run: launchctl, platform: "darwin" });
    expect(existsSync(plistPath(home, "dev-1"))).toBe(false);
    expect(existsSync(plistPath(home, "dev-2"))).toBe(true);
    expect(calls.flat().some((a) => a.includes("dev-2"))).toBe(false);
  });

  it("systemd: one template, one enabled instance per connection", async () => {
    const two = { ...base(), deviceId: "dev-2", stateDir: join(home, "c2") };
    await serviceCommand("install", { ...base(), platform: "linux" });
    await serviceCommand("install", { ...two, platform: "linux" });
    expect(readFileSync(unitPath(home), "utf8")).toMatch(/ExecStart=.* start --connection %i$/m);
    expect(calls).toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "capybara-device@dev-1.service",
    ]);
    expect(calls).toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "capybara-device@dev-2.service",
    ]);
    expect(hasLoginService(home, "linux", "dev-1")).toBe(true);
    expect(hasLoginService(home, "linux", "dev-2")).toBe(true);
    // a non-last instance keeps the template; the last one removes it
    await serviceCommand("uninstall", { ...base(), platform: "linux" });
    expect(existsSync(unitPath(home))).toBe(true);
    expect(hasLoginService(home, "linux", "dev-1")).toBe(false);
    expect(hasLoginService(home, "linux", "dev-2")).toBe(true);
    await serviceCommand("uninstall", { ...two, platform: "linux" });
    expect(existsSync(unitPath(home))).toBe(false);
    expect(SYSTEMD_TEMPLATE).toBe("capybara-device@.service");
  });

  it("startedByServiceManager matches only this connection's label", () => {
    expect(startedByServiceManager({ XPC_SERVICE_NAME: launchdLabel("dev-1") }, "dev-1")).toBe(
      true,
    );
    expect(startedByServiceManager({ XPC_SERVICE_NAME: launchdLabel("dev-2") }, "dev-1")).toBe(
      false,
    );
    expect(startedByServiceManager({ XPC_SERVICE_NAME: "top.capybara.device" }, "dev-1")).toBe(
      false,
    );
  });

  it("an invalid device id is refused before any path, label or unit is built", async () => {
    for (const bad of ["../../x", "a/b", "", "a%i", "x".repeat(129)]) {
      expect(() => launchdLabel(bad)).toThrow(/Invalid device id/);
      expect(() => plistPath(home, bad)).toThrow(/Invalid device id/);
      expect(() => systemdUnit(bad)).toThrow(/Invalid device id/);
      expect(() => unitWantsLink(home, bad)).toThrow(/Invalid device id/);
      for (const platform of ["darwin", "linux"] as const) {
        const deps = { ...base(), deviceId: bad, platform };
        expect(await serviceCommand("install", deps)).toBe(1);
        expect(await serviceCommand("uninstall", deps)).toBe(1);
      }
    }
    expect(calls).toEqual([]);
    expect(existsSync(join(home, "Library"))).toBe(false);
    expect(existsSync(join(home, ".config", "systemd"))).toBe(false);
  });

  it("the old top.capybara.device agent and capybara-device.service unit are never touched", async () => {
    const oldPlist = join(home, "Library", "LaunchAgents", "top.capybara.device.plist");
    mkdirSync(dirname(oldPlist), { recursive: true });
    writeFileSync(oldPlist, "old plist");
    const oldUnit = join(home, ".config", "systemd", "user", "capybara-device.service");
    mkdirSync(dirname(oldUnit), { recursive: true });
    writeFileSync(oldUnit, "old unit");
    const launchctl = fakeLaunchctl({});
    await serviceCommand("install", { ...base(), run: launchctl, platform: "darwin" });
    await serviceCommand("uninstall", { ...base(), run: launchctl, platform: "darwin" });
    await serviceCommand("install", { ...base(), platform: "linux" });
    await serviceCommand("uninstall", { ...base(), platform: "linux" });
    const args = calls.flat();
    expect(args).not.toContain("gui/501/top.capybara.device");
    expect(args).not.toContain("capybara-device.service");
    expect(readFileSync(oldPlist, "utf8")).toBe("old plist");
    expect(readFileSync(oldUnit, "utf8")).toBe("old unit");
  });

  it("is wired into the CLI", async () => {
    const out: string[] = [];
    const env = { PATH: "/bin", XDG_CONFIG_HOME: join(home, "xdg") };
    writeCredential(join(home, "xdg", "capybara-device"), {
      url: "http://x.test",
      connectUrl: "ws://x.test/device/connect",
      credential: "cap_dev_a",
      orgId: "o",
      deviceId: id,
      dir: "/w",
      mode: "os",
      reconnectGraceSeconds: 120,
      maxFrameBytes: 16 * 1024 * 1024,
    });
    const code = await runCli(["service", "install"], {
      home,
      platform: "linux",
      env,
      out: (l) => void out.push(l),
      err: (l) => void out.push(l),
      runSystem: run,
    });
    expect(code).toBe(0);
    expect(existsSync(unitPath(home))).toBe(true);
  });
});
