import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
import {
  LAUNCHD_THROTTLE_INTERVAL_SECONDS,
  plistContent,
  plistPath,
  rotateServiceLog,
} from "../src/service/launchd.js";
import { SYSTEMD_UNIT, unitContent, unitPath } from "../src/service/systemd.js";

const spec = {
  nodePath: "/opt/node 22/bin/node",
  binPath: "/usr/lib/node_modules/@capybara-hq/device/bin/capybara-device.mjs",
  stateDir: "/home/u/.config/capybara-device",
  env: { PATH: "/usr/local/bin:/usr/bin", XDG_CONFIG_HOME: "/home/u/.config" },
};

describe("service files", () => {
  it("launchd plist runs start with the node path", () => {
    const p = plistContent(spec);
    expect(p).toContain("<key>Label</key>\n  <string>top.capybara.device</string>");
    expect(p).toContain(
      "<string>/opt/node 22/bin/node</string>\n    <string>/usr/lib/node_modules/@capybara-hq/device/bin/capybara-device.mjs</string>\n    <string>start</string>",
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
    expect(p).toContain("<string>/home/u/.config/capybara-device/service.log</string>");
    expect(p).toContain("<key>PATH</key>");
    expect(plistPath("/Users/u")).toBe("/Users/u/Library/LaunchAgents/top.capybara.device.plist");
  });

  it("escapes XML in paths", () => {
    expect(plistContent({ ...spec, nodePath: "/a&b/<n>" })).toContain("/a&amp;b/&lt;n&gt;");
  });

  it("systemd unit restarts on failure", () => {
    const u = unitContent(spec);
    expect(u).toContain(
      'ExecStart="/opt/node 22/bin/node" "/usr/lib/node_modules/@capybara-hq/device/bin/capybara-device.mjs" start',
    );
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("WantedBy=default.target");
    expect(u).toContain('Environment="PATH=/usr/local/bin:/usr/bin"');
    expect(unitPath("/home/u")).toBe("/home/u/.config/systemd/user/capybara-device.service");
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
  const label = "gui/501/top.capybara.device";
  const base = () => ({
    stateDir: join(home, ".config", "capybara-device"),
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
        if (!loaded) throw failed(113, `Could not find service "top.capybara.device" in domain`);
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
    expect(readFileSync(plistPath(home), "utf8")).toContain("<string>/n/node</string>");
    // nothing loaded: no bootout
    expect(calls).toEqual([
      ["launchctl", "print", label],
      ["launchctl", "bootstrap", "gui/501", plistPath(home)],
    ]);
    calls.length = 0;
    expect(
      await serviceCommand("uninstall", { ...base(), run: launchctl, platform: "darwin" }),
    ).toBe(0);
    expect(calls).toEqual([
      ["launchctl", "bootout", label],
      ["launchctl", "print", label],
    ]);
    expect(existsSync(plistPath(home))).toBe(false);
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
      ["launchctl", "bootstrap", "gui/501", plistPath(home)],
    ]);
    expect(slept).toEqual([SERVICE_POLL_MS, SERVICE_POLL_MS, SERVICE_POLL_MS]);
  });

  it("macOS install over a loaded agent rewrites the plist and loads the new one", async () => {
    mkdirSync(dirname(plistPath(home)), { recursive: true });
    writeFileSync(plistPath(home), "old plist");
    const launchctl = fakeLaunchctl({ loaded: true });
    expect(await serviceCommand("install", { ...base(), run: launchctl, platform: "darwin" })).toBe(
      0,
    );
    // bootout before the write, bootstrap after it: launchd reads the new plist at bootstrap.
    expect(calls.map((c) => c[1])).toEqual(["bootout", "print", "bootstrap"]);
    const written = readFileSync(plistPath(home), "utf8");
    expect(written).not.toContain("old plist");
    expect(written).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(written).toContain(
      `<key>ThrottleInterval</key>\n  <integer>${LAUNCHD_THROTTLE_INTERVAL_SECONDS}</integer>`,
    );
  });

  const installPlist = () => {
    mkdirSync(dirname(plistPath(home)), { recursive: true });
    writeFileSync(plistPath(home), plistContent(spec));
  };
  const installUnit = () => {
    mkdirSync(dirname(unitPath(home)), { recursive: true });
    writeFileSync(unitPath(home), unitContent(spec));
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
    expect(calls).toContainEqual(["systemctl", "--user", "start", SYSTEMD_UNIT]);
    lines.length = 0;
    calls.length = 0;
    expect(await serviceCommand("restart", { ...base(), run: running, platform: "linux" })).toBe(0);
    expect(calls).toContainEqual(["systemctl", "--user", "restart", SYSTEMD_UNIT]);
    lines.length = 0;
    calls.length = 0;
    expect(await serviceCommand("stop", { ...base(), run: running, platform: "linux" })).toBe(0);
    expect(calls).toContainEqual(["systemctl", "--user", "stop", SYSTEMD_UNIT]);
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
    expect(calls.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", plistPath(home)]);
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
      ["systemctl", "--user", "enable", "capybara-device.service"],
      ["systemctl", "--user", "restart", "capybara-device.service"],
    ]);
    calls.length = 0;
    expect(await serviceCommand("uninstall", { ...base(), platform: "linux" })).toBe(0);
    expect(calls[0]).toEqual([
      "systemctl",
      "--user",
      "disable",
      "--now",
      "capybara-device.service",
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

  it("is wired into the CLI", async () => {
    const out: string[] = [];
    const code = await runCli(["service", "install"], {
      home,
      platform: "linux",
      env: { PATH: "/bin" },
      out: (l) => void out.push(l),
      err: (l) => void out.push(l),
      runSystem: run,
    });
    expect(code).toBe(0);
    expect(existsSync(unitPath(home))).toBe(true);
  });
});
