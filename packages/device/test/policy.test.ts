import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxLimits } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeCeiling, policyCommand } from "../src/commands/policy.js";
import { effectiveEgress, grantedHosts } from "../src/policy.js";
import {
  DEFAULT_POLICY,
  ownerCeilingOfMode,
  type Policy,
  policyPath,
  readPolicy,
  type SandboxMode,
  writeCredential,
  writePolicy,
} from "../src/state.js";

const net = (
  hosts: string[] = [],
  kind: SandboxLimits["network"]["kind"] = "allowlist",
): SandboxLimits["network"] => ({ kind, hosts });
const policy = (over: Partial<Policy> & { mode?: SandboxMode } = {}): Policy => {
  const { mode, ...rest } = over;
  return {
    ...DEFAULT_POLICY,
    ...rest,
    ...(mode !== undefined && { ownerCeiling: ownerCeilingOfMode(mode) }),
  };
};
const allowlistPolicy = (allowedDomains: string[]): Policy =>
  policy({
    allowedDomains,
    ownerCeiling: {
      outsideSandbox: false,
      network: "allowlist",
      restrictedProjectReach: "workspace",
    },
  });
const openPolicy = (allowedDomains: string[] = []): Policy =>
  policy({
    allowedDomains,
    ownerCeiling: { outsideSandbox: false, network: "open", restrictedProjectReach: "workspace" },
  });
const hostsOf = (e: ReturnType<typeof effectiveEgress>) =>
  e.kind === "allowlist" ? [...e.hosts].sort() : e.kind;

describe("effectiveEgress", () => {
  const org = net(["a.com", "*.b.com", "c.com"]);

  it("an allowlist owner ceiling is the intersection of the device's list and the kernel's", () => {
    const p = allowlistPolicy(["a.com", "x.b.com", "c.com"]);
    expect(hostsOf(effectiveEgress(p, org))).toEqual(["a.com", "c.com", "x.b.com"]);
  });

  it("a wildcard on one side narrows to the narrower entry", () => {
    expect(hostsOf(effectiveEgress(allowlistPolicy(["*.b.com"]), org))).toEqual(["*.b.com"]);
    expect(hostsOf(effectiveEgress(allowlistPolicy(["x.b.com"]), org))).toEqual(["x.b.com"]);
  });

  it("an empty device allowlist allows nothing, whatever the kernel asks", () => {
    expect(effectiveEgress(allowlistPolicy([]), org)).toEqual({ kind: "allowlist", hosts: [] });
    expect(effectiveEgress(allowlistPolicy([]), net([], "open-public"))).toEqual({
      kind: "allowlist",
      hosts: [],
    });
  });

  it("an allowlist owner ceiling keeps its own list against the kernel's open network", () => {
    expect(effectiveEgress(allowlistPolicy(["a.com"]), net([], "open-public"))).toEqual({
      kind: "allowlist",
      hosts: ["a.com"],
    });
  });

  it("the open owner ceiling is open only where the kernel is open too", () => {
    expect(effectiveEgress(openPolicy(["a.com"]), net([], "open-public"))).toEqual({
      kind: "open-public",
    });
    // against a kernel allowlist: exactly the kernel's hosts (the owner's list is not a filter)
    expect(hostsOf(effectiveEgress(openPolicy(["zz.com"]), org))).toEqual([
      "*.b.com",
      "a.com",
      "c.com",
    ]);
  });

  it("adds a command's grants within the kernel's network", () => {
    const grants = { hosts: ["a.com", "evil.com"] };
    expect(hostsOf(effectiveEgress(allowlistPolicy([]), net(["a.com"]), grants))).toEqual([
      "a.com",
    ]);
    expect(hostsOf(effectiveEgress(openPolicy(), net(["a.com"]), grants))).toEqual(["a.com"]);
  });
});

describe("grantedHosts", () => {
  it("keeps only exact hosts the kernel's allowlist admits", () => {
    expect(
      grantedHosts(
        { network: net(["a.com", "*.b.com"]) },
        { hosts: ["a.com", "x.b.com", "evil.com", "*.a.com", "10.0.0.1"] },
      ),
    ).toEqual(["a.com", "x.b.com"]);
  });

  it("admits a public host for an open-public ceiling", () => {
    expect(
      grantedHosts({ network: net([], "open-public") }, { hosts: ["a.com", "10.0.0.1"] }),
    ).toEqual(["a.com"]);
  });

  it("is empty without grants", () => {
    expect(grantedHosts({ network: net(["a.com"]) }, undefined)).toEqual([]);
  });
});

describe("policy command", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "device-policy-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    return policyCommand(
      // The CLI parser turns the arguments into the command; this is the same shape.
      parse(argv),
      { stateDir: dir, out: (l) => out.push(l), err: (l) => err.push(l) },
    ).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
  };

  // A minimal parser for the tests: policy [show | set|add|remove key value].
  const parse = (
    argv: string[],
  ): Extract<Parameters<typeof policyCommand>[0], { command: "policy" }> => {
    const [action, key, value] = argv;
    if (action === undefined || action === "show") return { command: "policy", action: "show" };
    if ((action === "set" || action === "add" || action === "remove") && key && value) {
      return { command: "policy", action, key, value };
    }
    throw new Error(`bad test argv ${argv.join(" ")}`);
  };

  it("show prints the defaults when there is no file", async () => {
    const r = await run(["show"]);
    expect(r.code).toBe(0);
    // a new install: no running outside the sandbox, the open network, the workspace reach
    expect(r.out).toContain('"outsideSandbox": false');
    expect(r.out).toContain('"network": "open"');
    expect(r.out).toContain('"restrictedProjectReach": "workspace"');
    expect(r.out).toContain(
      "Commands run in the sandbox under every profile, Full access included.",
    );
    expect(r.out).toContain(
      "Owner ceiling: outside the sandbox off: no call runs outside the sandbox here.",
    );
  });

  it("describeCeiling explains the owner ceiling, on the machine and in a container", () => {
    const auto = describeCeiling(policy({ mode: "auto" }));
    expect(auto[0]).toMatch(/in the sandbox under every profile/);
    expect(auto[1]).toMatch(/one approved call may run as you/);
    expect(describeCeiling(policy({ mode: "auto" }), "docker")[1]).toMatch(/container/);
    expect(auto[2]).toMatch(/Sandbox network: open/);
    expect(auto[3]).toMatch(/outside the device's workspace/);
    const sandbox = describeCeiling(policy({ mode: "sandbox" }));
    expect(sandbox[1]).toMatch(/outside the sandbox off/);
    expect(sandbox[2]).toMatch(/Sandbox network: allowlist/);
    expect(sandbox[3]).toMatch(/stay in the device's workspace/);
    expect(describeCeiling(policy({ mode: "sandbox" })).at(-1)).toMatch(
      /capybara-device ceiling set/,
    );
  });

  it("a change of allowed domains says sandboxed work may reach them, also in Docker mode", async () => {
    writeCredential(dir, {
      url: "https://x.test",
      connectUrl: "wss://x.test/device/connect",
      credential: "cap_dev_abc",
      orgId: "o",
      deviceId: "e",
      dir: "/tmp/d",
      mode: "docker",
      reconnectGraceSeconds: 120,
      maxFrameBytes: 1_000_000,
    });
    const r = await run(["add", "allowedDomains", "a.com"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "Sandboxed work may reach these domains while the network is an allowlist, when the " +
        "organization allows them too.",
    );
  });

  it("set allowedDomains stores the list; show prints it", async () => {
    expect((await run(["set", "allowedDomains", "a.com,b.com"])).code).toBe(0);
    expect(readPolicy(dir).allowedDomains).toEqual(["a.com", "b.com"]);
  });

  it("set cpu and memoryMb take a positive number or none", async () => {
    await run(["set", "cpu", "2"]);
    await run(["set", "memoryMb", "none"]);
    expect(readPolicy(dir)).toMatchObject({ cpu: 2, memoryMb: null });
    expect((await run(["set", "cpu", "0"])).code).toBe(2);
  });

  it("set refuses the removed keys and points at the ceiling command", async () => {
    for (const key of ["tier", "isolation", "localhost", "remoteGrants", "network"]) {
      const r = await run(["set", key, "open"]);
      expect(r.code, key).toBe(2);
      expect(r.err).toMatch(/capybara-device ceiling set/);
    }
    const mode = await run(["set", "mode", "sandbox"]);
    expect(mode.code).toBe(2);
    expect(mode.err).toMatch(/capybara-device ceiling set/);
  });

  it("set refuses an unknown key and an invalid domain", async () => {
    expect((await run(["set", "bogus", "x"])).code).toBe(2);
    expect((await run(["set", "allowedDomains", "https://a.com"])).code).toBe(2);
  });

  it("says the running program applies it at the next operation, never to restart", async () => {
    const r = await run(["set", "cpu", "2"]);
    expect(r.out).toMatch(/applies it at the next operation/);
  });

  it("add and remove allowedDomains: validated, lowercased, deduped, idempotent", async () => {
    expect((await run(["add", "allowedDomains", "A.com,b.com"])).code).toBe(0);
    expect(readPolicy(dir).allowedDomains).toEqual(["a.com", "b.com"]);
    const again = await run(["add", "allowedDomains", "A.com"]);
    expect(again.out).toContain("a.com is already in allowedDomains.");
    await run(["remove", "allowedDomains", "A.COM"]);
    expect(readPolicy(dir).allowedDomains).toEqual(["b.com"]);
  });

  it("add refuses an invalid host and leaves the file alone", async () => {
    await run(["add", "allowedDomains", "a.com"]);
    const before = readFileSync(policyPath(dir), "utf8");
    for (const bad of ["10.0.0.1", "intranet", "a.local", "https://a.com", "a.com:443"]) {
      expect((await run(["add", "allowedDomains", bad])).code, bad).toBe(2);
    }
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
  });

  it("add and remove work on allowCredentials and refuse other keys", async () => {
    expect((await run(["add", "allowCredentials", "GH"])).code).toBe(0);
    expect(readPolicy(dir).allowCredentials).toEqual(["GH"]);
    expect((await run(["add", "cpu", "2"])).code).toBe(2);
  });

  it("a change keeps keys this version does not know", async () => {
    writePolicy(dir, DEFAULT_POLICY, { future: 1 });
    await run(["set", "cpu", "2"]);
    expect(JSON.parse(readFileSync(policyPath(dir), "utf8")).future).toBe(1);
  });

  it("a change refuses to overwrite an unreadable file", async () => {
    writeFileSync(policyPath(dir), "{nope");
    const r = await run(["set", "cpu", "2"]);
    expect(r.code).toBe(1);
    expect(readFileSync(policyPath(dir), "utf8")).toBe("{nope");
  });

  it("show reports an unreadable policy file instead of throwing", async () => {
    writeFileSync(policyPath(dir), "{nope");
    const r = await run(["show"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/policy\.json/);
  });
});
