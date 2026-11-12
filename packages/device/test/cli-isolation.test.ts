import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { DOCKER_ISOLATION_REFUSED, UNSANDBOXED_RISK_TEXT } from "../src/commands/policy.js";
import { DEFAULT_POLICY, readPolicy, writeCredential, writePolicy } from "../src/state.js";

describe("capybara-device policy set isolation none", () => {
  let home: string;
  let dir: string;
  let out: string[];
  let err: string[];
  let asked: string[];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "device-isolation-cli-"));
    dir = join(home, "cfg", "capybara-device");
    mkdirSync(dir, { recursive: true });
    writePolicy(dir, { ...DEFAULT_POLICY, tier: "open" });
    out = [];
    err = [];
    asked = [];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const cli = (argv: string[], tty: { isTTY: boolean; answer?: string } = { isTTY: false }) =>
    runCli(["policy", ...argv], {
      env: { XDG_CONFIG_HOME: join(home, "cfg") },
      home,
      platform: "darwin",
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      stdinIsTTY: tty.isTTY,
      ask: async (q) => {
        asked.push(q);
        return tty.answer ?? "";
      },
    });

  it("on a terminal prints the risk text and asks; anything but y leaves the sandbox on", async () => {
    expect(await cli(["set", "isolation", "none"], { isTTY: true, answer: "n" })).toBe(1);
    expect(out).toContain(UNSANDBOXED_RISK_TEXT);
    expect(asked).toHaveLength(1);
    expect(err.join("\n")).toContain("capybara-device policy set isolation none --yes");
    expect(readPolicy(dir).isolation).toBe("sandbox");
  });

  it("on a terminal, y turns the sandbox off", async () => {
    expect(await cli(["set", "isolation", "none"], { isTTY: true, answer: "y" })).toBe(0);
    expect(out).toContain(UNSANDBOXED_RISK_TEXT);
    expect(readPolicy(dir).isolation).toBe("none");
  });

  it("without a terminal needs --yes", async () => {
    expect(await cli(["set", "isolation", "none"])).not.toBe(0);
    expect(asked).toEqual([]);
    expect(readPolicy(dir).isolation).toBe("sandbox");
    expect(await cli(["set", "isolation", "none", "--yes"])).toBe(0);
    expect(readPolicy(dir).isolation).toBe("none");
  });

  it("turning the sandbox back on never asks", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, tier: "open", isolation: "none" });
    expect(await cli(["set", "isolation", "sandbox"], { isTTY: true, answer: "n" })).toBe(0);
    expect(asked).toEqual([]);
    expect(readPolicy(dir).isolation).toBe("sandbox");
  });

  it("in Docker mode is refused before any risk text or question", async () => {
    writeCredential(dir, {
      url: "http://x.test",
      connectUrl: "ws://x.test/device/connect",
      credential: "cap_dev_secret",
      orgId: "o",
      deviceId: "e1",
      dir: join(home, "work"),
      mode: "docker",
      reconnectGraceSeconds: 120,
      maxFrameBytes: 1024,
    });
    expect(await cli(["set", "isolation", "none"], { isTTY: true, answer: "y" })).toBe(2);
    expect(err).toEqual([DOCKER_ISOLATION_REFUSED]);
    expect(out).not.toContain(UNSANDBOXED_RISK_TEXT);
    expect(asked).toEqual([]);
    expect(readPolicy(dir).isolation).toBe("sandbox");
  });
});
