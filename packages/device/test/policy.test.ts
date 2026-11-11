import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxLimits } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import {
  OPEN_NETWORK_NEEDS_YES,
  OPEN_NETWORK_PROMPT,
  OPEN_NETWORK_RISK,
  policyCommand,
} from "../src/commands/policy.js";
import {
  DENIED_SECRET_PATHS,
  deniedSecretPaths,
  effectiveEgress,
  grantedHosts,
  implicitWritePaths,
  srtConfig,
} from "../src/policy.js";
import { DEFAULT_POLICY, policyPath, readPolicy, writeCredential } from "../src/state.js";

const limits = (egress: SandboxLimits["egress"], allowHosts: string[] = []): SandboxLimits => ({
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  egress,
  allowHosts,
});
const policy = (allowedDomains: string[]) => ({ ...DEFAULT_POLICY, allowedDomains });

describe("effectiveEgress", () => {
  it("egress is the intersection", () => {
    const p = policy(["a.com", "b.com"]);
    expect(effectiveEgress(p, limits("allowlist", ["b.com", "c.com"]))).toEqual(["b.com"]);
    expect(effectiveEgress(p, limits("open"))).toEqual(["a.com", "b.com"]);
    expect(effectiveEgress(p, limits("none", ["a.com"]))).toEqual([]);
  });

  it("a policy wildcard admits the device's subdomains, never the apex", () => {
    const p = policy(["*.github.com"]);
    expect(
      effectiveEgress(p, limits("allowlist", ["api.github.com", "github.com", "x.org"])),
    ).toEqual(["api.github.com"]);
    // The narrower of two wildcards wins, whichever side it is on.
    expect(effectiveEgress(p, limits("allowlist", ["*.api.github.com"]))).toEqual([
      "*.api.github.com",
    ]);
    expect(
      effectiveEgress(policy(["raw.github.com"]), limits("allowlist", ["*.github.com"])),
    ).toEqual(["raw.github.com"]);
  });

  it("an empty policy allows nothing, whatever the cloud asks", () => {
    expect(effectiveEgress(policy([]), limits("open"))).toEqual([]);
    expect(effectiveEgress(policy([]), limits("allowlist", ["a.com"]))).toEqual([]);
  });
});

describe("effectiveEgress: network open", () => {
  const open = (allowedDomains: string[] = []) => ({
    ...DEFAULT_POLICY,
    allowedDomains,
    network: "open" as const,
  });

  it("is exactly the org's egress: its list, any host, or nothing", () => {
    expect(effectiveEgress(open(["x.com"]), limits("allowlist", ["A.com", "*.b.com"]))).toEqual([
      "a.com",
      "*.b.com",
    ]);
    // The runtime's per-command lists refuse "*": the executor turns it into an open command.
    expect(effectiveEgress(open(), limits("open"))).toEqual(["*"]);
    expect(effectiveEgress(open(["x.com"]), limits("none", ["a.com"]))).toEqual([]);
  });
});

describe("effectiveEgress: grants", () => {
  const grants = (...hosts: string[]) => ({
    hosts,
    source: { kind: "run" as const, id: "run1", accountId: "acc" },
  });
  const off = (allowedDomains: string[] = []) => ({
    ...DEFAULT_POLICY,
    allowedDomains,
    remoteGrants: "off" as const,
  });

  it("adds granted hosts under remoteGrants owner, as far as the org allows", () => {
    const p = policy(["a.com"]);
    const l = limits("allowlist", ["a.com", "files.slack.com", "*.github.com"]);
    expect(effectiveEgress(p, l, grants("files.slack.com", "api.github.com", "evil.com"))).toEqual([
      "a.com",
      "files.slack.com",
      "api.github.com",
    ]);
    expect(effectiveEgress(p, limits("open"), grants("evil.com"))).toEqual(["a.com", "evil.com"]);
    expect(effectiveEgress(p, limits("none"), grants("a.com", "b.com"))).toEqual([]);
  });

  it("are ignored under remoteGrants off", () => {
    expect(effectiveEgress(off(["a.com"]), limits("open"), grants("b.com", "c.com"))).toEqual([
      "a.com",
    ]);
    expect(grantedHosts(off(), limits("open"), grants("b.com"))).toEqual([]);
  });

  it("only valid exact hosts count: wildcards, addresses and junk are ignored", () => {
    const g = grants("*.b.com", "10.0.0.1", "intranet", "x.local", "a b.com", "", "B.COM", "b.com");
    expect(grantedHosts(policy([]), limits("open"), g)).toEqual(["b.com"]);
    expect(effectiveEgress(policy([]), limits("open"), g)).toEqual(["b.com"]);
  });

  it("an org wildcard admits a granted subdomain, never the apex", () => {
    const l = limits("allowlist", ["*.github.com"]);
    expect(grantedHosts(policy([]), l, grants("github.com", "raw.github.com"))).toEqual([
      "raw.github.com",
    ]);
  });

  it("add nothing to a device that is already open", () => {
    const p = { ...DEFAULT_POLICY, network: "open" as const };
    expect(effectiveEgress(p, limits("open"), grants("b.com"))).toEqual(["*"]);
    expect(effectiveEgress(p, limits("allowlist", ["b.com"]), grants("b.com"))).toEqual(["b.com"]);
  });
});

describe("srtConfig", () => {
  const roots = { workspace: "/e/workspace", skills: "/e/skills", tmp: "/e/tmp" };

  it("writes only under workspace and tmp, skills read only, secrets unreadable", () => {
    const c = srtConfig(DEFAULT_POLICY, roots, ["b.com"], { home: "/h" });
    expect(c.filesystem.allowWrite).toEqual(["/e/workspace", "/e/tmp"]);
    expect(c.filesystem.denyWrite).toEqual(["/e/skills", ...implicitWritePaths()]);
    expect(c.filesystem.denyRead).toEqual(deniedSecretPaths("/h"));
    expect(c.network).toEqual({ allowedDomains: ["b.com"], deniedDomains: [] });
  });

  it("the denied list expands ~ and covers the spec's paths and browser profiles", () => {
    const d = deniedSecretPaths("/h");
    for (const p of [
      "/h/.ssh",
      "/h/.aws",
      "/h/.config/gcloud",
      "/h/.azure",
      "/h/.kube",
      "/h/.docker/config.json",
      "/h/.netrc",
      "/h/.gnupg",
      "/h/Library/Application Support/Google/Chrome",
      "/h/Library/Application Support/Firefox",
      "/h/.mozilla",
      "/h/.config/google-chrome",
      "/h/.config/chromium",
      "/h/.config/gh",
      "/h/.git-credentials",
      "/h/.npmrc",
      "/h/.pypirc",
      "/h/Library/Keychains",
      "/h/Library/Cookies",
      "/h/Library/Safari",
      "/h/Library/Application Support/BraveSoftware",
      "/h/Library/Application Support/Microsoft Edge",
      "/h/Library/Application Support/Arc",
      "/h/.config/BraveSoftware",
      "/h/.config/microsoft-edge",
    ]) {
      expect(d).toContain(p);
    }
    expect(d).toHaveLength(25);
    expect(DENIED_SECRET_PATHS).toHaveLength(25);
  });

  it("extra denied paths (the program's own state directory) are added", () => {
    const c = srtConfig(DEFAULT_POLICY, roots, [], {
      home: "/h",
      denyRead: ["/h/.config/capybara-device"],
    });
    expect(c.filesystem.denyRead).toContain("/h/.config/capybara-device");
    expect(c.filesystem.denyRead).toContain("/h/.ssh");
  });
});

describe("policy command", () => {
  let dir: string;
  let out: string[];
  let err: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "device-policy-"));
    out = [];
    err = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (cmd: Parameters<typeof policyCommand>[0]) =>
    policyCommand(cmd, {
      stateDir: dir,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });

  it("show prints the defaults when there is no file", () => {
    expect(run({ command: "policy", action: "show" })).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toEqual(DEFAULT_POLICY);
    expect(out[1]).toMatch(/cpu and memoryMb are not enforced.*no local credentials/);
  });

  it("allowing a domain on a docker-mode device warns that it opens all network", () => {
    const docker = {
      url: "http://x.test",
      connectUrl: "ws://x.test/device/connect",
      credential: "cap_dev_x",
      orgId: "o",
      deviceId: "d",
      dir: "/w",
      reconnectGraceSeconds: 120,
      maxFrameBytes: 1024,
    };
    writeCredential(dir, { ...docker, mode: "docker" });
    expect(run({ command: "policy", action: "add", key: "allowedDomains", value: "a.com" })).toBe(
      0,
    );
    expect(out.join("\n")).toMatch(/Docker mode.*whole internet/);
    out.length = 0;
    expect(
      run({ command: "policy", action: "remove", key: "allowedDomains", value: "a.com" }),
    ).toBe(0);
    expect(out.join("\n")).not.toMatch(/Docker mode/);
    writeCredential(dir, { ...docker, mode: "os" });
    out.length = 0;
    expect(run({ command: "policy", action: "add", key: "allowedDomains", value: "a.com" })).toBe(
      0,
    );
    expect(out.join("\n")).not.toMatch(/Docker mode/);
  });

  it("show prints network and remoteGrants", () => {
    writeFileSync(
      policyPath(dir),
      JSON.stringify({ ...DEFAULT_POLICY, network: "open", remoteGrants: "off" }),
    );
    expect(run({ command: "policy", action: "show" })).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ network: "open", remoteGrants: "off" });
  });

  it("set allowedDomains stores the list; show prints it", () => {
    expect(
      run({ command: "policy", action: "set", key: "allowedDomains", value: "a.com,*.b.com" }),
    ).toBe(0);
    expect(readPolicy(dir).allowedDomains).toEqual(["a.com", "*.b.com"]);
    out.length = 0;
    run({ command: "policy", action: "show" });
    expect(JSON.parse(out[0] ?? "").allowedDomains).toEqual(["a.com", "*.b.com"]);
  });

  it("set cpu and memoryMb take a positive number or none", () => {
    expect(run({ command: "policy", action: "set", key: "cpu", value: "2" })).toBe(0);
    expect(run({ command: "policy", action: "set", key: "memoryMb", value: "1024" })).toBe(0);
    expect(readPolicy(dir)).toMatchObject({ cpu: 2, memoryMb: 1024 });
    expect(run({ command: "policy", action: "set", key: "cpu", value: "none" })).toBe(0);
    expect(readPolicy(dir).cpu).toBeNull();
    expect(run({ command: "policy", action: "set", key: "memoryMb", value: "-1" })).toBe(2);
  });

  it("set refuses an unknown key and an invalid domain", () => {
    expect(run({ command: "policy", action: "set", key: "egress", value: "open" })).toBe(2);
    expect(
      run({ command: "policy", action: "set", key: "allowedDomains", value: "https://a.com" }),
    ).toBe(2);
    expect(err.join("\n")).toMatch(/https:\/\/a\.com/);
    expect(readPolicy(dir)).toEqual(DEFAULT_POLICY);
  });

  it("set says the running program applies it at the next command, never to restart", () => {
    expect(run({ command: "policy", action: "set", key: "cpu", value: "2" })).toBe(0);
    const text = out.join("\n");
    expect(text).not.toMatch(/Restart/i);
    expect(text).toMatch(/applies it at the next command/);
  });

  it("add and remove allowedDomains: validated, lowercased, deduped, idempotent", () => {
    expect(run({ command: "policy", action: "add", key: "allowedDomains", value: "A.com" })).toBe(
      0,
    );
    expect(run({ command: "policy", action: "add", key: "allowedDomains", value: "*.b.com" })).toBe(
      0,
    );
    expect(readPolicy(dir).allowedDomains).toEqual(["a.com", "*.b.com"]);
    out.length = 0;
    expect(run({ command: "policy", action: "add", key: "allowedDomains", value: "a.com" })).toBe(
      0,
    );
    expect(out.join("\n")).toMatch(/already/);
    expect(readPolicy(dir).allowedDomains).toEqual(["a.com", "*.b.com"]);
    expect(
      run({ command: "policy", action: "remove", key: "allowedDomains", value: "A.COM" }),
    ).toBe(0);
    expect(readPolicy(dir).allowedDomains).toEqual(["*.b.com"]);
    out.length = 0;
    expect(
      run({ command: "policy", action: "remove", key: "allowedDomains", value: "a.com" }),
    ).toBe(0);
    expect(out.join("\n")).toMatch(/not in allowedDomains/);
    expect(out.join("\n")).not.toMatch(/Restart/i);
  });

  it("add and remove compare domains ignoring case; remove takes any spelling", () => {
    writeFileSync(
      policyPath(dir),
      JSON.stringify({ ...DEFAULT_POLICY, allowedDomains: ["Mixed.COM", "10.0.0.5"] }),
    );
    out.length = 0;
    expect(
      run({ command: "policy", action: "add", key: "allowedDomains", value: "mixed.com" }),
    ).toBe(0);
    expect(out.join("\n")).toMatch(/already/);
    expect(readPolicy(dir).allowedDomains).toEqual(["Mixed.COM", "10.0.0.5"]);
    // A hand-written entry add would refuse can still be removed.
    expect(
      run({ command: "policy", action: "remove", key: "allowedDomains", value: " 10.0.0.5 " }),
    ).toBe(0);
    expect(
      run({ command: "policy", action: "remove", key: "allowedDomains", value: "MIXED.com" }),
    ).toBe(0);
    expect(readPolicy(dir).allowedDomains).toEqual([]);
  });

  it("add refuses an invalid host and leaves the file alone", () => {
    expect(
      run({ command: "policy", action: "add", key: "allowedDomains", value: "10.0.0.5" }),
    ).toBe(2);
    expect(err.join("\n")).toMatch(/10\.0\.0\.5/);
    expect(readPolicy(dir)).toEqual(DEFAULT_POLICY);
  });

  it("add and remove work on allowCredentials and refuse other keys", () => {
    expect(run({ command: "policy", action: "add", key: "allowCredentials", value: "gh" })).toBe(0);
    expect(readPolicy(dir).allowCredentials).toEqual(["gh"]);
    expect(run({ command: "policy", action: "remove", key: "allowCredentials", value: "gh" })).toBe(
      0,
    );
    expect(readPolicy(dir).allowCredentials).toEqual([]);
    expect(run({ command: "policy", action: "add", key: "cpu", value: "2" })).toBe(2);
    expect(err.join("\n")).toMatch(/allowedDomains/);
  });

  it("a change keeps keys this version does not know", () => {
    writeFileSync(policyPath(dir), JSON.stringify({ ...DEFAULT_POLICY, futureKey: "x" }));
    expect(run({ command: "policy", action: "add", key: "allowedDomains", value: "a.com" })).toBe(
      0,
    );
    expect(JSON.parse(readFileSync(policyPath(dir), "utf8")).futureKey).toBe("x");
  });

  it("a change refuses to overwrite an unreadable file", () => {
    writeFileSync(policyPath(dir), "{nope");
    expect(run({ command: "policy", action: "add", key: "allowedDomains", value: "a.com" })).toBe(
      1,
    );
    expect(readFileSync(policyPath(dir), "utf8")).toBe("{nope");
  });

  it("show reports an unreadable policy file instead of throwing", () => {
    writeFileSync(policyPath(dir), "{nope");
    expect(run({ command: "policy", action: "show" })).toBe(1);
    expect(err.join("\n")).toMatch(/policy\.json/);
  });
});

describe("policy set network and remoteGrants", () => {
  let home: string;
  let dir: string;
  let out: string[];
  let err: string[];
  let asked: string[];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "device-policy-cli-"));
    dir = join(home, "cfg", "capybara-device");
    mkdirSync(dir, { recursive: true });
    out = [];
    err = [];
    asked = [];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const cli = (argv: string[], tty: { isTTY: boolean; answer?: string } = { isTTY: false }) =>
    runCli(["policy", ...argv], {
      env: { XDG_CONFIG_HOME: join(home, "cfg") },
      home,
      platform: "linux",
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      stdinIsTTY: tty.isTTY,
      ask: async (q) => {
        asked.push(q);
        return tty.answer ?? "";
      },
    });

  it("the risk text is the spec's English text", () => {
    expect(OPEN_NETWORK_RISK).toBe(
      "With no network limit, agent commands on this device can reach any address the organization allows (any public address if the organization has no limit), including uploading files to outside sites. Prompt injection can make an agent do that. Turn it on only on your own development machine, with agents and material you trust.",
    );
  });

  it("open without --yes and no terminal: prints the risk, refuses with exit 2 and a hint", async () => {
    expect(await cli(["set", "network", "open"])).toBe(2);
    expect(out).toContain(OPEN_NETWORK_RISK);
    expect(err.join("\n")).toContain("capybara-device policy set network open --yes");
    expect(asked).toEqual([]);
    expect(readPolicy(dir).network).toBe("allowlist");
  });

  it("open with --yes: prints the risk and opens", async () => {
    expect(await cli(["set", "network", "open", "--yes"])).toBe(0);
    expect(out).toContain(OPEN_NETWORK_RISK);
    expect(readPolicy(dir).network).toBe("open");
    expect(asked).toEqual([]);
  });

  it("open on a terminal: asks once; y opens, anything else leaves it alone", async () => {
    expect(await cli(["set", "network", "open"], { isTTY: true, answer: "n" })).toBe(1);
    expect(asked).toEqual([OPEN_NETWORK_PROMPT]);
    expect(out).toEqual([OPEN_NETWORK_RISK]);
    expect(err).toEqual([OPEN_NETWORK_NEEDS_YES]);
    expect(readPolicy(dir).network).toBe("allowlist");

    out.length = 0;
    asked.length = 0;
    expect(await cli(["set", "network", "open"], { isTTY: true, answer: " Y " })).toBe(0);
    expect(asked).toEqual([OPEN_NETWORK_PROMPT]);
    // the risk is shown once
    expect(out.filter((l) => l === OPEN_NETWORK_RISK)).toHaveLength(1);
    expect(readPolicy(dir).network).toBe("open");
  });

  it("allowlist is always accepted, without a question", async () => {
    writeFileSync(policyPath(dir), JSON.stringify({ ...DEFAULT_POLICY, network: "open" }));
    expect(await cli(["set", "network", "allowlist"], { isTTY: true })).toBe(0);
    expect(asked).toEqual([]);
    expect(out).not.toContain(OPEN_NETWORK_RISK);
    expect(readPolicy(dir).network).toBe("allowlist");
  });

  it("network takes allowlist or open only", async () => {
    expect(await cli(["set", "network", "everything", "--yes"])).toBe(2);
    expect(err.join("\n")).toMatch(/allowlist or open/);
    expect(readPolicy(dir)).toEqual(DEFAULT_POLICY);
  });

  it("remoteGrants takes owner or off; other fields are kept", async () => {
    writeFileSync(
      policyPath(dir),
      JSON.stringify({ ...DEFAULT_POLICY, allowedDomains: ["a.com"], network: "open" }),
    );
    expect(await cli(["set", "remoteGrants", "off"])).toBe(0);
    expect(readPolicy(dir)).toMatchObject({
      remoteGrants: "off",
      allowedDomains: ["a.com"],
      network: "open",
    });
    expect(out.join("\n")).toMatch(/can no longer widen/);
    expect(await cli(["set", "remoteGrants", "owner"])).toBe(0);
    expect(readPolicy(dir).remoteGrants).toBe("owner");
    expect(await cli(["set", "remoteGrants", "always"])).toBe(2);
    expect(err.join("\n")).toMatch(/owner or off/);
    expect(readPolicy(dir).remoteGrants).toBe("owner");
  });
});
