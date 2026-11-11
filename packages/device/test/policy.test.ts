import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxLimits } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { policyCommand } from "../src/commands/policy.js";
import {
  DENIED_SECRET_PATHS,
  deniedSecretPaths,
  effectiveEgress,
  implicitWritePaths,
  srtConfig,
} from "../src/policy.js";
import { DEFAULT_POLICY, policyPath, readPolicy } from "../src/state.js";

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
