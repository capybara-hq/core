import {
  chmodSync,
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
import { join } from "node:path";
import type { SandboxLimits } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeCeiling, policyCommand } from "../src/commands/policy.js";
import { effectiveEgress, grantedHosts } from "../src/policy.js";
import {
  DEFAULT_POLICY,
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
    ...(mode !== undefined && {
      ownerCeiling:
        mode === "auto"
          ? { outsideSandbox: true, network: "open", projectReach: "machine" }
          : { outsideSandbox: false, network: "allowlist", projectReach: "workspace" },
    }),
  };
};
const allowlistPolicy = (allowedDomains: string[]): Policy =>
  policy({
    allowedDomains,
    ownerCeiling: {
      outsideSandbox: false,
      network: "allowlist",
      projectReach: "workspace",
    },
  });
const openPolicy = (allowedDomains: string[] = []): Policy =>
  policy({
    allowedDomains,
    ownerCeiling: { outsideSandbox: false, network: "open", projectReach: "workspace" },
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

  it("adds a command's grants within the kernel's network under the open owner network", () => {
    const grants = { hosts: ["a.com", "evil.com"] };
    expect(hostsOf(effectiveEgress(openPolicy(), net(["a.com"]), grants))).toEqual(["a.com"]);
  });

  it("an owner allowlist bounds the grants: only hosts the owner's list covers", () => {
    const open = net([], "open-public");
    expect(
      hostsOf(effectiveEgress(allowlistPolicy(["a.com"]), open, { hosts: ["evil.example.com"] })),
    ).toEqual(["a.com"]);
    expect(hostsOf(effectiveEgress(allowlistPolicy([]), open, { hosts: ["a.com"] }))).toEqual([]);
    expect(
      hostsOf(effectiveEgress(allowlistPolicy(["*.b.com"]), open, { hosts: ["x.b.com", "c.com"] })),
    ).toEqual(["*.b.com", "x.b.com"]);
    // and still within the kernel's allowlist
    expect(
      hostsOf(
        effectiveEgress(allowlistPolicy(["*.b.com"]), net(["y.b.com"]), { hosts: ["x.b.com"] }),
      ),
    ).toEqual(["y.b.com"]);
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
  let base: string;
  let dir: string;
  let home: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "device-policy-"));
    dir = join(base, "state");
    home = join(base, "home");
    mkdirSync(dir);
    mkdirSync(home);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const run = (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    return policyCommand(
      // The CLI parser turns the arguments into the command; this is the same shape.
      parse(argv),
      {
        stateDir: dir,
        stateRoot: dir,
        home,
        cwd: base,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      },
    ).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
  };

  const login = (workDir = join(base, "device"), mode: "os" | "docker" = "os") =>
    writeCredential(dir, {
      url: "https://x.test",
      connectUrl: "wss://x.test/device/connect",
      credential: "cap_dev_abc",
      orgId: "o",
      deviceId: "e",
      dir: workDir,
      mode,
      reconnectGraceSeconds: 120,
      maxFrameBytes: 1_000_000,
    });
  const otherConnection = (id: string, workDir: string) => {
    const connDir = join(dir, "connections", id);
    mkdirSync(connDir, { recursive: true });
    writeCredential(connDir, {
      url: "https://y.test",
      connectUrl: "wss://y.test/device/connect",
      credential: "cap_dev_other",
      orgId: "o2",
      deviceId: id,
      dir: workDir,
      mode: "os",
      reconnectGraceSeconds: 120,
      maxFrameBytes: 1_000_000,
    });
    return connDir;
  };
  const project = (name: string) => {
    const p = join(base, name);
    mkdirSync(p, { recursive: true });
    return p;
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

  it("show prints the closed missing-file policy when there is no file", async () => {
    const r = await run(["show"]);
    expect(r.code).toBe(0);
    // no file (a device set up before rc.58): no running outside the sandbox, the allowlist
    // network with no host, the workspace reach; never the open default
    expect(r.out).toContain('"outsideSandbox": false');
    expect(r.out).toContain('"network": "allowlist"');
    expect(r.out).toContain('"projectReach": "workspace"');
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
    expect(auto[3]).toMatch(/whole machine except secrets/);
    const paths = describeCeiling(
      policy({ ownerCeiling: { outsideSandbox: false, network: "open", projectReach: "paths" } }),
    );
    expect(paths[3]).toMatch(/the device's workspace and the projectPaths list/);
    const sandbox = describeCeiling(policy({ mode: "sandbox" }));
    expect(sandbox[1]).toMatch(/outside the sandbox off/);
    expect(sandbox[2]).toMatch(/Sandbox network: allowlist/);
    expect(sandbox[3]).toMatch(/stay in the device's workspace/);
    expect(describeCeiling(policy({ mode: "sandbox" })).at(-1)).toMatch(
      /capybara-device ceiling set .*--project-reach machine\|paths\|workspace/,
    );
  });

  it("add projectPaths stores the real absolute path, deduped", async () => {
    login();
    writePolicy(dir, DEFAULT_POLICY);
    const a = project("a");
    const r = await run(["add", "projectPaths", "./a"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(readPolicy(dir).projectPaths).toEqual([realpathSync.native(a)]);
    // a link is stored by its real path, so adding it again finds the same entry
    symlinkSync(a, join(base, "link"));
    const again = await run(["add", "projectPaths", join(base, "link")]);
    expect(again.code).toBe(0);
    expect(again.out).toContain(`${realpathSync.native(a)} is already in projectPaths.`);
    expect(readPolicy(dir).projectPaths).toEqual([realpathSync.native(a)]);
  });

  it("add refuses a missing directory, a file, a secret path and another connection's directory", async () => {
    login();
    writePolicy(dir, DEFAULT_POLICY);
    const otherWork = project("other-work");
    otherConnection("other", otherWork);
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(base, "file.txt"), "x");
    const before = readFileSync(policyPath(dir), "utf8");
    const cases: [string, RegExp][] = [
      [join(base, "missing"), /does not exist/],
      [join(base, "file.txt"), /is not a directory/],
      [join(home, ".ssh"), /holds secrets/],
      [dir, /holds secrets/],
      [otherWork, /belongs to another connection/],
    ];
    for (const [path, reason] of cases) {
      const r = await run(["add", "projectPaths", path]);
      expect(r.code, path).toBe(2);
      expect(r.err, path).toMatch(reason);
    }
    // set validates each entry the same way
    const set = await run(["set", "projectPaths", `${project("ok")},${join(home, ".ssh")}`]);
    expect(set.code).toBe(2);
    expect(set.err).toMatch(/holds secrets/);
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
  });

  it("add refuses while another connection cannot be read", async () => {
    login();
    writePolicy(dir, DEFAULT_POLICY);
    const connDir = otherConnection("bad", project("bad-work"));
    chmodSync(join(connDir, "credential.json"), 0o644);
    const before = readFileSync(policyPath(dir), "utf8");
    const r = await run(["add", "projectPaths", project("a")]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Cannot read connections\/bad .*capybara-device logout -c bad/);
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
  });

  it("add checks secrets and the state directory when not logged in", async () => {
    mkdirSync(join(home, ".aws"));
    const r = await run(["add", "projectPaths", join(home, ".aws")]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/holds secrets/);
    expect((await run(["add", "projectPaths", project("a")])).code).toBe(0);
  });

  it("add refuses a case variant of a denied directory on a case-insensitive volume", async (ctx) => {
    writeFileSync(join(base, "Probe"), "");
    if (!existsSync(join(base, "probe"))) ctx.skip();
    login();
    writePolicy(dir, DEFAULT_POLICY);
    const otherWork = project("other-work");
    otherConnection("other", otherWork);
    mkdirSync(join(home, ".ssh"));
    const before = readFileSync(policyPath(dir), "utf8");
    const secret = await run(["add", "projectPaths", join(home, ".SSH")]);
    expect(secret.code).toBe(2);
    expect(secret.err).toMatch(/holds secrets/);
    const other = await run(["add", "projectPaths", join(base, "OTHER-WORK")]);
    expect(other.code).toBe(2);
    expect(other.err).toMatch(/belongs to another connection/);
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
  });

  it("notes that denied directories inside an added path stay unreadable", async () => {
    login();
    writePolicy(dir, DEFAULT_POLICY);
    const note =
      "Secrets, capybara-device's own state and other connections inside it stay unreadable.";
    const inside = await run(["add", "projectPaths", home]);
    expect(inside.code).toBe(0);
    expect(inside.out).toContain(note);
    // a parent of the state root
    const parent = await run(["add", "projectPaths", base]);
    expect(parent.code).toBe(0);
    expect(parent.out).toContain(note);
    const plain = await run(["add", "projectPaths", project("a")]);
    expect(plain.code).toBe(0);
    expect(plain.out).not.toContain(note);
  });

  it("add checks other connections when not logged in", async () => {
    const otherWork = project("other-work");
    otherConnection("other", otherWork);
    const r = await run(["add", "projectPaths", otherWork]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/belongs to another connection/);
    const connDir = otherConnection("bad", project("bad-work"));
    chmodSync(join(connDir, "credential.json"), 0o644);
    const bad = await run(["add", "projectPaths", project("a")]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/Cannot read connections\/bad .*capybara-device logout -c bad/);
    expect(existsSync(policyPath(dir))).toBe(false);
  });

  it("says project paths do not apply in Docker mode", async () => {
    login(join(base, "device"), "docker");
    writePolicy(dir, {
      ...DEFAULT_POLICY,
      ownerCeiling: { ...DEFAULT_POLICY.ownerCeiling, projectReach: "paths" },
    });
    const r = await run(["add", "projectPaths", project("a")]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "Project paths do not apply in Docker mode: sandboxed work runs in the device's container.",
    );
    expect(r.out).not.toContain("Project paths apply while");
  });

  it("remove takes any listed entry", async () => {
    login();
    const a = realpathSync.native(project("a"));
    writePolicy(dir, { ...DEFAULT_POLICY, projectPaths: ["/gone/away", a] });
    const r = await run(["remove", "projectPaths", "/gone/away"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Removed /gone/away from projectPaths.");
    expect(readPolicy(dir).projectPaths).toEqual([a]);
  });

  it("set projectPaths replaces the list with the validated real paths", async () => {
    login();
    writePolicy(dir, { ...DEFAULT_POLICY, projectPaths: ["/gone/away"] });
    const a = project("a");
    const b = project("b");
    expect((await run(["set", "projectPaths", `${a},./b,${a}`])).code).toBe(0);
    expect(readPolicy(dir).projectPaths).toEqual([realpathSync.native(a), realpathSync.native(b)]);
  });

  it("says the list applies only under the paths reach", async () => {
    login();
    writePolicy(dir, DEFAULT_POLICY); // projectReach: machine
    const note =
      "Project paths apply while the project reach is paths (capybara-device ceiling set " +
      "--project-reach paths).";
    const r = await run(["add", "projectPaths", project("a")]);
    expect(r.out).toContain(note);
    writePolicy(dir, {
      ...DEFAULT_POLICY,
      ownerCeiling: { ...DEFAULT_POLICY.ownerCeiling, projectReach: "paths" },
    });
    const under = await run(["add", "projectPaths", project("b")]);
    expect(under.code).toBe(0);
    expect(under.out).not.toContain(note);
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
