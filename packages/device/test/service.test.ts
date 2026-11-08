import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { serviceCommand } from "../src/commands/service.js";
import { plistContent, plistPath, rotateServiceLog } from "../src/service/launchd.js";
import { unitContent, unitPath } from "../src/service/systemd.js";

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
    expect(p).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    );
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

describe("service command", () => {
  let home: string;
  let calls: string[][];
  let lines: string[];
  const run = (cmd: string, args: string[]) => void calls.push([cmd, ...args]);
  const base = () => ({
    stateDir: join(home, ".config", "capybara-device"),
    home,
    env: { PATH: "/bin" },
    out: (l: string) => void lines.push(l),
    err: (l: string) => void lines.push(l),
    run,
    uid: 501,
    nodePath: "/n/node",
    binPath: "/b/capybara-device.mjs",
  });
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "device-service-")));
    calls = [];
    lines = [];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("macOS install writes the plist and bootstraps it; uninstall boots it out and removes it", () => {
    expect(serviceCommand("install", { ...base(), platform: "darwin" })).toBe(0);
    expect(readFileSync(plistPath(home), "utf8")).toContain("<string>/n/node</string>");
    expect(calls).toEqual([["launchctl", "bootstrap", "gui/501", plistPath(home)]]);
    calls.length = 0;
    expect(serviceCommand("uninstall", { ...base(), platform: "darwin" })).toBe(0);
    expect(calls).toEqual([["launchctl", "bootout", "gui/501/top.capybara.device"]]);
    expect(existsSync(plistPath(home))).toBe(false);
  });

  it("Linux install writes the unit and enables it now; uninstall disables it", () => {
    expect(serviceCommand("install", { ...base(), platform: "linux" })).toBe(0);
    expect(readFileSync(unitPath(home), "utf8")).toContain("Restart=on-failure");
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "capybara-device.service"],
    ]);
    calls.length = 0;
    expect(serviceCommand("uninstall", { ...base(), platform: "linux" })).toBe(0);
    expect(calls[0]).toEqual([
      "systemctl",
      "--user",
      "disable",
      "--now",
      "capybara-device.service",
    ]);
    expect(existsSync(unitPath(home))).toBe(false);
  });

  it("reports a failing system command and exits 1", () => {
    const failing = () => {
      throw new Error("boom");
    };
    expect(serviceCommand("install", { ...base(), platform: "linux", run: failing })).toBe(1);
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
