import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxLimits } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import {
  OPEN_TIER_RISK,
  policyCommand,
  policyRisk,
  TIER_CHANGE_SANDBOX_ON,
  UNSANDBOXED_RISK_TEXT,
} from "../src/commands/policy.js";
import {
  DENIED_SECRET_PATHS,
  deniedSecretPaths,
  deviceTier,
  effectiveEgress,
  grantedHosts,
  implicitWritePaths,
  srtConfig,
  tierFacts,
} from "../src/policy.js";
import {
  DEFAULT_POLICY,
  policyPath,
  readPolicy,
  writeCredential,
  writePolicy,
} from "../src/state.js";

const limits = (
  egress: SandboxLimits["egress"],
  allowHosts: string[] = [],
  tier: SandboxLimits["tier"] = "open",
  devHosts: string[] = [],
): SandboxLimits => ({
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  egress,
  allowHosts,
  tier,
  devHosts,
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

describe("deviceTier", () => {
  it("is the owner's choice, else the org's default, else strict, cut to the ceiling", () => {
    const p = (tier?: "strict" | "dev" | "open") => ({ ...DEFAULT_POLICY, ...(tier && { tier }) });
    expect(deviceTier(p(), { tier: "open" })).toBe("strict");
    expect(deviceTier(p(), { tier: "open", defaultTier: "dev" })).toBe("dev");
    expect(deviceTier(p("open"), { tier: "dev", defaultTier: "strict" })).toBe("dev");
    expect(deviceTier(p("strict"), { tier: "open", defaultTier: "open" })).toBe("strict");
    expect(deviceTier(p("open"), { tier: "open" })).toBe("open");
  });
});

describe("effectiveEgress per tier", () => {
  const D = ["registry.npmjs.org", "pypi.org"];
  const p = (tier: "strict" | "dev" | "open", allowedDomains: string[] = ["a.com"]) => ({
    ...DEFAULT_POLICY,
    allowedDomains,
    tier,
  });
  const ceiling = ["a.com", "b.com", "registry.npmjs.org"];

  it("strict: the ceiling and the local list", () => {
    expect(effectiveEgress(p("strict"), limits("allowlist", ceiling, "open", D))).toEqual([
      "a.com",
    ]);
  });

  it("dev: the ceiling and the local list plus the dev hosts", () => {
    expect(effectiveEgress(p("dev"), limits("allowlist", ceiling, "open", D))).toEqual([
      "a.com",
      "registry.npmjs.org",
    ]);
    // an open ceiling: the local list and the dev hosts themselves
    expect(effectiveEgress(p("dev", []), limits("open", [], "open", D))).toEqual(D);
  });

  it("open: the ceiling itself, any host when it is open", () => {
    expect(effectiveEgress(p("open"), limits("allowlist", ceiling, "open", D))).toEqual(ceiling);
    expect(effectiveEgress(p("open"), limits("open", [], "open", D))).toEqual(["*"]);
  });

  it("the ceiling's tier cuts the device's choice; none is none in every tier", () => {
    expect(effectiveEgress(p("open"), limits("allowlist", ceiling, "dev", D))).toEqual([
      "a.com",
      "registry.npmjs.org",
    ]);
    expect(effectiveEgress(p("dev"), limits("allowlist", ceiling, "strict", D))).toEqual(["a.com"]);
    for (const t of ["strict", "dev", "open"] as const) {
      expect(effectiveEgress(p(t), limits("none", ceiling, "open", D))).toEqual([]);
    }
  });

  it("no tier on the device: the org's default", () => {
    const l = { ...limits("allowlist", ceiling, "open", D), defaultTier: "dev" as const };
    expect(effectiveEgress(policy(["a.com"]), l)).toEqual(["a.com", "registry.npmjs.org"]);
  });
});

describe("tierFacts", () => {
  const open = { ...DEFAULT_POLICY, tier: "open" as const };
  const os = { proxyDetected: false, mode: "os" as const };

  it("macOS: strict has neither; dev and open have localhost unless a proxy was found", () => {
    const mac = { ...os, platform: "darwin" as const };
    expect(tierFacts(DEFAULT_POLICY, { tier: "strict" }, mac)).toEqual({
      effectiveTier: "strict",
      localhost: "off",
      unixSockets: "off",
    });
    expect(tierFacts(open, { tier: "dev" }, mac)).toEqual({
      effectiveTier: "dev",
      localhost: "on",
      unixSockets: "roots",
    });
    expect(tierFacts(open, { tier: "open" }, { ...mac, proxyDetected: true })).toEqual({
      effectiveTier: "open",
      localhost: "off-proxy-detected",
      unixSockets: "roots",
    });
    expect(
      tierFacts({ ...open, localhost: "allow" }, { tier: "open" }, { ...mac, proxyDetected: true })
        .localhost,
    ).toBe("on");
  });

  it("before any exec: the owner's choice, else dev", () => {
    const mac = { ...os, platform: "darwin" as const };
    expect(tierFacts(DEFAULT_POLICY, undefined, mac).effectiveTier).toBe("dev");
    expect(tierFacts(open, undefined, mac).effectiveTier).toBe("open");
  });

  it("Linux: its own loopback, sockets blocked; Docker: the container's own", () => {
    expect(tierFacts(open, { tier: "open" }, { ...os, platform: "linux" })).toEqual({
      effectiveTier: "open",
      localhost: "on",
      unixSockets: "off",
    });
    expect(
      tierFacts(open, { tier: "dev" }, { proxyDetected: true, mode: "docker", platform: "darwin" }),
    ).toEqual({ effectiveTier: "dev", localhost: "on", unixSockets: "all-masked" });
  });
});

describe("effectiveEgress: tier open", () => {
  const open = (allowedDomains: string[] = []) => ({
    ...DEFAULT_POLICY,
    allowedDomains,
    tier: "open" as const,
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
    const p = { ...DEFAULT_POLICY, tier: "open" as const };
    expect(effectiveEgress(p, limits("open"), grants("b.com"))).toEqual(["*"]);
    expect(effectiveEgress(p, limits("allowlist", ["b.com"]), grants("b.com"))).toEqual(["b.com"]);
  });
});

describe("srtConfig", () => {
  const roots = { workspace: "/e/workspace", skills: "/e/skills", tmp: "/e/tmp" };

  it("writes only under workspace and tmp, skills read only, secrets unreadable", () => {
    const c = srtConfig(DEFAULT_POLICY, roots, ["b.com"], { home: "/h" });
    expect(c.filesystem.allowWrite).toEqual(["/e/workspace", "/e/tmp"]);
    // git hooks and config under every writable root, wherever this program was started
    const git = (r: string) => [
      `${r}/.git/hooks/**`,
      `${r}/**/.git/hooks/**`,
      `${r}/.git/config`,
      `${r}/**/.git/config`,
    ];
    expect(c.filesystem.denyWrite).toEqual([
      "/e/skills",
      ...implicitWritePaths(),
      ...git("/e/workspace"),
      ...git("/e/tmp"),
    ]);
    expect(c.filesystem.denyRead).toEqual(deniedSecretPaths("/h"));
    expect(c.network).toEqual({
      allowedDomains: ["b.com"],
      deniedDomains: [],
      allowLocalBinding: false,
    });
  });

  const dev = {
    home: "/h",
    tier: "dev" as const,
    socketDir: "/private/tmp/cap-12345678",
    cacheDir: "/e/cache",
  };

  it("dev and open allow writing .git/config (git works); strict does not", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const strict = srtConfig(DEFAULT_POLICY, roots, [], { ...dev, tier: "strict", platform });
      expect(strict.filesystem.allowGitConfig).toBe(false);
      expect(strict.filesystem.denyWrite).toContain("/e/workspace/**/.git/config");
      // a root that reads as a glob cannot be anchored: no pattern is built on it
      const odd = srtConfig(DEFAULT_POLICY, { ...roots, workspace: "/e/w[1]" }, [], {
        ...dev,
        tier: "strict",
        platform,
      });
      expect(odd.filesystem.denyWrite.some((d) => d.startsWith("/e/w[1]"))).toBe(false);
      for (const tier of ["dev", "open"] as const) {
        const c = srtConfig(DEFAULT_POLICY, roots, [], { ...dev, tier, platform });
        expect(c.filesystem.allowGitConfig).toBe(true);
        // hooks stay denied under every writable root, config is not
        for (const root of c.filesystem.allowWrite) {
          expect(c.filesystem.denyWrite).toContain(`${root}/**/.git/hooks/**`);
          expect(c.filesystem.denyWrite).not.toContain(`${root}/**/.git/config`);
        }
      }
    }
  });

  it("strict: no local binding and no unix sockets on any platform", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const c = srtConfig(DEFAULT_POLICY, roots, [], { ...dev, tier: "strict", platform });
      expect(c.network.allowLocalBinding).toBe(false);
      expect(c.network.allowUnixSockets).toBeUndefined();
      expect(c.filesystem.allowWrite).toEqual(["/e/workspace", "/e/tmp"]);
    }
  });

  it("dev and open on macOS: localhost, sockets under the roots and the socket dir, caches", () => {
    for (const tier of ["dev", "open"] as const) {
      const c = srtConfig(DEFAULT_POLICY, roots, [], { ...dev, tier, platform: "darwin" });
      expect(c.network.allowLocalBinding).toBe(true);
      expect(c.network.allowUnixSockets).toEqual([
        "/e/tmp",
        "/e/workspace",
        "/private/tmp/cap-12345678",
      ]);
      expect(c.network).not.toHaveProperty("allowAllUnixSockets");
      expect(c.filesystem.allowWrite).toEqual([
        "/e/workspace",
        "/e/tmp",
        "/private/tmp/cap-12345678",
        "/e/cache",
      ]);
    }
  });

  it("macOS dev: a detected local proxy turns local binding off unless localhost is allow", () => {
    const o = { ...dev, platform: "darwin" as const, proxyDetected: true };
    expect(srtConfig(DEFAULT_POLICY, roots, [], o).network.allowLocalBinding).toBe(false);
    expect(
      srtConfig({ ...DEFAULT_POLICY, localhost: "allow" }, roots, [], o).network.allowLocalBinding,
    ).toBe(true);
  });

  it("dev on Linux: caches, but unix sockets stay blocked and no socket dir", () => {
    const c = srtConfig(DEFAULT_POLICY, roots, [], { ...dev, platform: "linux" });
    expect(c.network.allowLocalBinding).toBe(false);
    expect(c.network.allowUnixSockets).toBeUndefined();
    expect(c.filesystem.allowWrite).toEqual(["/e/workspace", "/e/tmp", "/e/cache"]);
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
      platform: "darwin",
      detectProxy: async () => proxy,
    });
  let proxy = { detected: false, reasons: [] as string[] };

  it("show prints the defaults when there is no file", async () => {
    expect(await run({ command: "policy", action: "show" })).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toEqual(DEFAULT_POLICY);
    expect(out.at(-1)).toMatch(/cpu and memoryMb are not enforced.*no local credentials/);
  });

  it("show says what the tier gives on this machine", async () => {
    expect(await run({ command: "policy", action: "show" })).toBe(0);
    let text = out.join("\n");
    expect(text).toMatch(/Tier: the organization's default/);
    expect(text).toMatch(/At tier dev on this machine: localhost commands can listen/);
    expect(text).toMatch(/Unix sockets: allowed under the device's workspace/);
    out.length = 0;
    proxy = { detected: true, reasons: ["a listener on 127.0.0.1:7890"] };
    await run({ command: "policy", action: "show" });
    text = out.join("\n");
    expect(text).toMatch(
      /localhost off: a local proxy was detected \(a listener on 127\.0\.0\.1:7890\)/,
    );
    expect(text).toContain("capybara-device policy set localhost allow");
    proxy = { detected: false, reasons: [] };
    writeFileSync(policyPath(dir), JSON.stringify({ ...DEFAULT_POLICY, tier: "strict" }));
    out.length = 0;
    await run({ command: "policy", action: "show" });
    text = out.join("\n");
    expect(text).toMatch(/Tier: strict \(set on this device/);
    expect(text).toMatch(/localhost off\./);
    expect(text).toMatch(/Unix sockets: blocked/);
  });

  it("allowing a domain on a docker-mode device warns that it opens all network", async () => {
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
    expect(
      await run({ command: "policy", action: "add", key: "allowedDomains", value: "a.com" }),
    ).toBe(0);
    expect(out.join("\n")).toMatch(/Docker mode.*whole internet/);
    out.length = 0;
    expect(
      await run({ command: "policy", action: "remove", key: "allowedDomains", value: "a.com" }),
    ).toBe(0);
    expect(out.join("\n")).not.toMatch(/Docker mode/);
    writeCredential(dir, { ...docker, mode: "os" });
    out.length = 0;
    expect(
      await run({ command: "policy", action: "add", key: "allowedDomains", value: "a.com" }),
    ).toBe(0);
    expect(out.join("\n")).not.toMatch(/Docker mode/);
  });

  it("show prints tier and remoteGrants", async () => {
    writeFileSync(
      policyPath(dir),
      JSON.stringify({ ...DEFAULT_POLICY, tier: "open", remoteGrants: "off" }),
    );
    expect(await run({ command: "policy", action: "show" })).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ tier: "open", remoteGrants: "off" });
  });

  it("set allowedDomains stores the list; show prints it", async () => {
    expect(
      await run({
        command: "policy",
        action: "set",
        key: "allowedDomains",
        value: "a.com,*.b.com",
      }),
    ).toBe(0);
    expect(readPolicy(dir).allowedDomains).toEqual(["a.com", "*.b.com"]);
    out.length = 0;
    await run({ command: "policy", action: "show" });
    expect(JSON.parse(out[0] ?? "").allowedDomains).toEqual(["a.com", "*.b.com"]);
  });

  it("set cpu and memoryMb take a positive number or none", async () => {
    expect(await run({ command: "policy", action: "set", key: "cpu", value: "2" })).toBe(0);
    expect(await run({ command: "policy", action: "set", key: "memoryMb", value: "1024" })).toBe(0);
    expect(readPolicy(dir)).toMatchObject({ cpu: 2, memoryMb: 1024 });
    expect(await run({ command: "policy", action: "set", key: "cpu", value: "none" })).toBe(0);
    expect(readPolicy(dir).cpu).toBeNull();
    expect(await run({ command: "policy", action: "set", key: "memoryMb", value: "-1" })).toBe(2);
  });

  it("set refuses an unknown key and an invalid domain", async () => {
    expect(await run({ command: "policy", action: "set", key: "egress", value: "open" })).toBe(2);
    expect(await run({ command: "policy", action: "set", key: "network", value: "open" })).toBe(2);
    expect(err.join("\n")).toMatch(/network is replaced by tier/);
    expect(
      await run({
        command: "policy",
        action: "set",
        key: "allowedDomains",
        value: "https://a.com",
      }),
    ).toBe(2);
    expect(err.join("\n")).toMatch(/https:\/\/a\.com/);
    expect(readPolicy(dir)).toEqual(DEFAULT_POLICY);
  });

  it("set says the running program applies it at the next command, never to restart", async () => {
    expect(await run({ command: "policy", action: "set", key: "cpu", value: "2" })).toBe(0);
    const text = out.join("\n");
    expect(text).not.toMatch(/Restart/i);
    expect(text).toMatch(/applies it at the next command/);
  });

  it("add and remove allowedDomains: validated, lowercased, deduped, idempotent", async () => {
    expect(
      await run({ command: "policy", action: "add", key: "allowedDomains", value: "A.com" }),
    ).toBe(0);
    expect(
      await run({ command: "policy", action: "add", key: "allowedDomains", value: "*.b.com" }),
    ).toBe(0);
    expect(readPolicy(dir).allowedDomains).toEqual(["a.com", "*.b.com"]);
    out.length = 0;
    expect(
      await run({ command: "policy", action: "add", key: "allowedDomains", value: "a.com" }),
    ).toBe(0);
    expect(out.join("\n")).toMatch(/already/);
    expect(readPolicy(dir).allowedDomains).toEqual(["a.com", "*.b.com"]);
    expect(
      await run({ command: "policy", action: "remove", key: "allowedDomains", value: "A.COM" }),
    ).toBe(0);
    expect(readPolicy(dir).allowedDomains).toEqual(["*.b.com"]);
    out.length = 0;
    expect(
      await run({ command: "policy", action: "remove", key: "allowedDomains", value: "a.com" }),
    ).toBe(0);
    expect(out.join("\n")).toMatch(/not in allowedDomains/);
    expect(out.join("\n")).not.toMatch(/Restart/i);
  });

  it("add and remove compare domains ignoring case; remove takes any spelling", async () => {
    writeFileSync(
      policyPath(dir),
      JSON.stringify({ ...DEFAULT_POLICY, allowedDomains: ["Mixed.COM", "10.0.0.5"] }),
    );
    out.length = 0;
    expect(
      await run({ command: "policy", action: "add", key: "allowedDomains", value: "mixed.com" }),
    ).toBe(0);
    expect(out.join("\n")).toMatch(/already/);
    expect(readPolicy(dir).allowedDomains).toEqual(["Mixed.COM", "10.0.0.5"]);
    // A hand-written entry add would refuse can still be removed.
    expect(
      await run({
        command: "policy",
        action: "remove",
        key: "allowedDomains",
        value: " 10.0.0.5 ",
      }),
    ).toBe(0);
    expect(
      await run({ command: "policy", action: "remove", key: "allowedDomains", value: "MIXED.com" }),
    ).toBe(0);
    expect(readPolicy(dir).allowedDomains).toEqual([]);
  });

  it("add refuses an invalid host and leaves the file alone", async () => {
    expect(
      await run({ command: "policy", action: "add", key: "allowedDomains", value: "10.0.0.5" }),
    ).toBe(2);
    expect(err.join("\n")).toMatch(/10\.0\.0\.5/);
    expect(readPolicy(dir)).toEqual(DEFAULT_POLICY);
  });

  it("add and remove work on allowCredentials and refuse other keys", async () => {
    expect(
      await run({ command: "policy", action: "add", key: "allowCredentials", value: "gh" }),
    ).toBe(0);
    expect(readPolicy(dir).allowCredentials).toEqual(["gh"]);
    expect(
      await run({ command: "policy", action: "remove", key: "allowCredentials", value: "gh" }),
    ).toBe(0);
    expect(readPolicy(dir).allowCredentials).toEqual([]);
    expect(await run({ command: "policy", action: "add", key: "cpu", value: "2" })).toBe(2);
    expect(err.join("\n")).toMatch(/allowedDomains/);
  });

  it("a change keeps keys this version does not know", async () => {
    writeFileSync(policyPath(dir), JSON.stringify({ ...DEFAULT_POLICY, futureKey: "x" }));
    expect(
      await run({ command: "policy", action: "add", key: "allowedDomains", value: "a.com" }),
    ).toBe(0);
    expect(JSON.parse(readFileSync(policyPath(dir), "utf8")).futureKey).toBe("x");
  });

  it("a change refuses to overwrite an unreadable file", async () => {
    writeFileSync(policyPath(dir), "{nope");
    expect(
      await run({ command: "policy", action: "add", key: "allowedDomains", value: "a.com" }),
    ).toBe(1);
    expect(readFileSync(policyPath(dir), "utf8")).toBe("{nope");
  });

  it("show reports an unreadable policy file instead of throwing", async () => {
    writeFileSync(policyPath(dir), "{nope");
    expect(await run({ command: "policy", action: "show" })).toBe(1);
    expect(err.join("\n")).toMatch(/policy\.json/);
  });
});

describe("policy set tier, isolation, localhost and remoteGrants", () => {
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
  const OPEN_PROMPT = policyRisk({
    command: "policy",
    action: "set",
    key: "tier",
    value: "open",
  })?.prompt;

  it("the unsandboxed risk text is the spec's English text", () => {
    expect(UNSANDBOXED_RISK_TEXT).toBe(
      "Without a sandbox, agent commands run on this computer as you: they can read and write all your files, use your credentials (SSH keys, cloud accounts, keychain), Docker and any network. Prompt injection can make an agent delete files or send your credentials away. Turn it on only on your own development machine, with agents and material you fully trust. Such commands can also read this program's own credential: if you suspect misuse, run capybara-device logout and log in again.",
    );
  });

  it("tier open without --yes and no terminal: prints the risk, refuses with exit 2 and a hint", async () => {
    expect(await cli(["set", "tier", "open"])).toBe(2);
    expect(out).toContain(OPEN_TIER_RISK);
    expect(err.join("\n")).toContain("capybara-device policy set tier open --yes");
    expect(asked).toEqual([]);
    expect(readPolicy(dir).tier).toBeUndefined();
  });

  it("a tier change turns the sandbox back on; keeping tier open keeps isolation none", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, tier: "open", isolation: "none" });
    expect(await cli(["set", "tier", "open", "--yes"])).toBe(0);
    expect(readPolicy(dir)).toMatchObject({ tier: "open", isolation: "none" });
    expect(await cli(["set", "tier", "dev"])).toBe(0);
    expect(readPolicy(dir)).toMatchObject({ tier: "dev", isolation: "sandbox" });
    expect(out).toContain(TIER_CHANGE_SANDBOX_ON);
    // back to open: still sandboxed, until set isolation none is confirmed again
    expect(await cli(["set", "tier", "open", "--yes"])).toBe(0);
    expect(readPolicy(dir)).toMatchObject({ tier: "open", isolation: "sandbox" });
    writePolicy(dir, { ...DEFAULT_POLICY, tier: "open", isolation: "none" });
    expect(await cli(["set", "tier", "default"])).toBe(0);
    expect(readPolicy(dir).isolation).toBe("sandbox");
  });

  it("tier open with --yes: prints the risk and sets it", async () => {
    expect(await cli(["set", "tier", "open", "--yes"])).toBe(0);
    expect(out).toContain(OPEN_TIER_RISK);
    expect(readPolicy(dir).tier).toBe("open");
    expect(asked).toEqual([]);
  });

  it("tier open on a terminal: asks once; y sets it, anything else leaves it alone", async () => {
    expect(await cli(["set", "tier", "open"], { isTTY: true, answer: "n" })).toBe(1);
    expect(asked).toEqual([OPEN_PROMPT]);
    expect(out).toEqual([OPEN_TIER_RISK]);
    expect(readPolicy(dir).tier).toBeUndefined();

    out.length = 0;
    asked.length = 0;
    expect(await cli(["set", "tier", "open"], { isTTY: true, answer: " Y " })).toBe(0);
    expect(asked).toEqual([OPEN_PROMPT]);
    // the risk is shown once
    expect(out.filter((l) => l === OPEN_TIER_RISK)).toHaveLength(1);
    expect(readPolicy(dir).tier).toBe("open");
  });

  it("strict and dev need no question; default removes the key", async () => {
    writeFileSync(policyPath(dir), JSON.stringify({ ...DEFAULT_POLICY, tier: "open" }));
    expect(await cli(["set", "tier", "dev"], { isTTY: true })).toBe(0);
    expect(readPolicy(dir).tier).toBe("dev");
    expect(await cli(["set", "tier", "STRICT"], { isTTY: true })).toBe(0);
    expect(readPolicy(dir).tier).toBe("strict");
    expect(asked).toEqual([]);
    expect(out).not.toContain(OPEN_TIER_RISK);
    expect(await cli(["set", "tier", "default"])).toBe(0);
    expect(readPolicy(dir).tier).toBeUndefined();
    expect(JSON.parse(readFileSync(policyPath(dir), "utf8"))).not.toHaveProperty("tier");
    expect(out.join("\n")).toMatch(/follows the organization's default tier/);
  });

  it("tier takes strict, dev, open or default only", async () => {
    expect(await cli(["set", "tier", "everything", "--yes"])).toBe(2);
    expect(err.join("\n")).toMatch(/strict, dev, open or default/);
    expect(readPolicy(dir)).toEqual(DEFAULT_POLICY);
  });

  it("isolation none needs tier open set locally first, even with --yes", async () => {
    expect(await cli(["set", "isolation", "none", "--yes"])).toBe(2);
    expect(err.join("\n")).toContain("capybara-device policy set tier open --yes");
    expect(readPolicy(dir).isolation).toBe("sandbox");
    writeFileSync(policyPath(dir), JSON.stringify({ ...DEFAULT_POLICY, tier: "dev" }));
    expect(await cli(["set", "isolation", "none", "--yes"])).toBe(2);
    expect(readPolicy(dir).isolation).toBe("sandbox");
    expect(out).not.toContain(UNSANDBOXED_RISK_TEXT);
  });

  it("isolation none needs --yes and prints the unsandboxed risk; sandbox never asks", async () => {
    writeFileSync(policyPath(dir), JSON.stringify({ ...DEFAULT_POLICY, tier: "open" }));
    expect(await cli(["set", "isolation", "none"])).toBe(2);
    expect(out).toContain(UNSANDBOXED_RISK_TEXT);
    expect(err.join("\n")).toContain("capybara-device policy set isolation none --yes");
    expect(readPolicy(dir).isolation).toBe("sandbox");
    out.length = 0;
    expect(await cli(["set", "isolation", "none", "--yes"])).toBe(0);
    expect(out).toContain(UNSANDBOXED_RISK_TEXT);
    expect(readPolicy(dir).isolation).toBe("none");
    expect(out.join("\n")).toMatch(/without a sandbox/);
    out.length = 0;
    expect(await cli(["set", "isolation", "sandbox"], { isTTY: true })).toBe(0);
    expect(asked).toEqual([]);
    expect(out).not.toContain(UNSANDBOXED_RISK_TEXT);
    expect(readPolicy(dir).isolation).toBe("sandbox");
    expect(await cli(["set", "isolation", "partly"])).toBe(2);
  });

  it("isolation none is refused in Docker mode", async () => {
    writeCredential(dir, {
      url: "http://x.test",
      connectUrl: "ws://x.test/device/connect",
      credential: "cap_dev_x",
      orgId: "o",
      deviceId: "d",
      dir: "/w",
      reconnectGraceSeconds: 120,
      maxFrameBytes: 1024,
      mode: "docker",
    });
    expect(await cli(["set", "isolation", "none", "--yes"])).toBe(2);
    expect(err.join("\n")).toMatch(/Docker mode/);
    expect(readPolicy(dir).isolation).toBe("sandbox");
  });

  it("localhost takes auto or allow", async () => {
    expect(await cli(["set", "localhost", "allow"])).toBe(0);
    expect(readPolicy(dir).localhost).toBe("allow");
    expect(out.join("\n")).toMatch(/even when a local proxy runs/);
    expect(await cli(["set", "localhost", "auto"])).toBe(0);
    expect(readPolicy(dir).localhost).toBe("auto");
    expect(await cli(["set", "localhost", "always"])).toBe(2);
    expect(err.join("\n")).toMatch(/auto or allow/);
  });

  it("remoteGrants takes owner or off; other fields are kept", async () => {
    writeFileSync(
      policyPath(dir),
      JSON.stringify({ ...DEFAULT_POLICY, allowedDomains: ["a.com"], tier: "open" }),
    );
    expect(await cli(["set", "remoteGrants", "off"])).toBe(0);
    expect(readPolicy(dir)).toMatchObject({
      remoteGrants: "off",
      allowedDomains: ["a.com"],
      tier: "open",
    });
    expect(out.join("\n")).toMatch(/can no longer widen/);
    expect(await cli(["set", "remoteGrants", "owner"])).toBe(0);
    expect(readPolicy(dir).remoteGrants).toBe("owner");
    expect(await cli(["set", "remoteGrants", "always"])).toBe(2);
    expect(err.join("\n")).toMatch(/owner or off/);
    expect(readPolicy(dir).remoteGrants).toBe("owner");
  });
});
