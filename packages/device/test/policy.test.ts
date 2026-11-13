import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxLimits } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOCKER_DOMAIN_NOTE, describeMode, policyCommand } from "../src/commands/policy.js";
import {
  DENIED_SECRET_PATHS,
  deniedSecretPaths,
  effectiveEgress,
  effectiveMode,
  grantedHosts,
  implicitWritePaths,
  srtConfig,
} from "../src/policy.js";
import {
  DEFAULT_POLICY,
  type Policy,
  policyPath,
  readPolicy,
  writeCredential,
  writePolicy,
} from "../src/state.js";

const limits = (
  mode: SandboxLimits["mode"],
  hosts: string[] = [],
  kind: SandboxLimits["network"]["kind"] = "allowlist",
): Pick<SandboxLimits, "mode" | "network"> => ({
  mode,
  network: { kind, hosts },
});
const policy = (over: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, ...over });

describe("effectiveMode", () => {
  it("cuts the device's choice to the kernel's ceiling", () => {
    expect(effectiveMode(policy({ mode: "auto" }), limits("auto"))).toBe("auto");
    expect(effectiveMode(policy({ mode: "sandbox" }), limits("auto"))).toBe("sandbox");
    expect(effectiveMode(policy({ mode: "auto" }), limits("sandbox"))).toBe("sandbox");
    expect(effectiveMode(policy({ mode: "sandbox" }), limits("sandbox"))).toBe("sandbox");
  });
});

describe("effectiveEgress", () => {
  const sandbox = limits("sandbox", ["a.com", "*.b.com", "c.com"]);

  it("is the intersection of the device's list and the kernel's", () => {
    const p = policy({ mode: "sandbox", allowedDomains: ["a.com", "x.b.com", "c.com"] });
    expect(effectiveEgress(p, sandbox).sort()).toEqual(["a.com", "c.com", "x.b.com"]);
  });

  it("a wildcard on one side narrows to the narrower entry", () => {
    expect(
      effectiveEgress(policy({ mode: "sandbox", allowedDomains: ["*.b.com"] }), sandbox),
    ).toEqual(["*.b.com"]);
    expect(
      effectiveEgress(policy({ mode: "sandbox", allowedDomains: ["x.b.com"] }), sandbox),
    ).toEqual(["x.b.com"]);
  });

  it("an empty device list allows nothing, whatever the kernel asks", () => {
    expect(effectiveEgress(policy({ mode: "sandbox", allowedDomains: [] }), sandbox)).toEqual([]);
  });

  it("auto mode ignores both lists: the command has the machine's network", () => {
    expect(
      effectiveEgress(policy({ mode: "auto", allowedDomains: ["a.com"] }), limits("auto")),
    ).toEqual([]);
    expect(
      effectiveEgress(
        policy({ mode: "auto", allowedDomains: ["a.com"] }),
        limits("auto", ["a.com"]),
      ),
    ).toEqual([]);
  });

  it("a local sandbox-mode device keeps its own list even for an open-public ceiling", () => {
    expect(
      effectiveEgress(
        policy({ mode: "sandbox", allowedDomains: ["a.com"] }),
        limits("sandbox", [], "open-public"),
      ),
    ).toEqual(["a.com"]);
  });

  it("adds a command's grants within the kernel's network", () => {
    const grants = { hosts: ["a.com", "evil.com"] };
    expect(
      effectiveEgress(policy({ mode: "sandbox", allowedDomains: ["a.com"] }), sandbox, grants),
    ).toEqual(["a.com"]);
  });
});

describe("grantedHosts", () => {
  it("keeps only exact hosts the kernel's allowlist admits", () => {
    expect(
      grantedHosts(limits("sandbox", ["a.com", "*.b.com"]), {
        hosts: ["a.com", "x.b.com", "evil.com", "*.a.com", "10.0.0.1"],
      }),
    ).toEqual(["a.com", "x.b.com"]);
  });

  it("admits a public host for an open-public ceiling", () => {
    expect(
      grantedHosts(limits("sandbox", [], "open-public"), { hosts: ["a.com", "10.0.0.1"] }),
    ).toEqual(["a.com"]);
  });

  it("is empty without grants", () => {
    expect(grantedHosts(limits("sandbox", ["a.com"]), undefined)).toEqual([]);
  });
});

describe("srtConfig", () => {
  const roots = { workspace: "/d/w", skills: "/d/s", tmp: "/d/t" };

  it("is the strict profile: workspace and tmp writable, skills read only", () => {
    const c = srtConfig(roots, ["a.com"], { home: "/home/u" });
    expect(c.filesystem.allowWrite).toEqual(["/d/w", "/d/t"]);
    expect(c.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        "/d/s",
        "/tmp/claude",
        "/private/tmp/claude",
        "/home/u/.npm/_logs",
        "/home/u/.claude/debug",
        "/d/w/.git/hooks/**",
        "/d/w/.git/config",
        "/d/t/**/.git/hooks/**",
        "/d/t/**/.git/config",
      ]),
    );
    expect(c.filesystem.denyRead).toEqual(expect.arrayContaining(deniedSecretPaths("/home/u")));
    expect(c.network.allowedDomains).toEqual(["a.com"]);
    expect(c.network.deniedDomains).toEqual([]);
    expect(c.network).not.toHaveProperty("allowLocalBinding");
    expect(c.network).not.toHaveProperty("allowUnixSockets");
    expect(c.filesystem).not.toHaveProperty("allowGitConfig");
  });

  it("adds extra denied paths (the program's own state directory)", () => {
    const c = srtConfig(roots, [], { denyRead: ["/state"] });
    expect(c.filesystem.denyRead).toContain("/state");
  });

  it("keeps the spec's secret paths and browser profiles", () => {
    for (const p of [
      "~/.ssh",
      "~/.aws",
      "~/.config/gcloud",
      "~/.azure",
      "~/.kube",
      "~/.docker/config.json",
      "~/.netrc",
      "~/.gnupg",
      "~/.config/gh",
      "~/.git-credentials",
      "~/.npmrc",
      "~/Library/Keychains",
      "~/Library/Safari",
    ]) {
      expect(DENIED_SECRET_PATHS).toContain(p);
    }
    expect(deniedSecretPaths("/home/u")).toContain("/home/u/.ssh");
    expect(implicitWritePaths("/home/u")).toContain("/home/u/.npm/_logs");
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
    expect(r.out).toContain('"mode": "auto"');
    expect(r.out).toContain("Mode: auto.");
  });

  it("describeMode explains auto and sandbox, on the machine and in a container", () => {
    expect(describeMode(policy({ mode: "auto" }))[0]).toMatch(/Commands run as you/);
    expect(describeMode(policy({ mode: "auto" }), "docker")[0]).toMatch(/container/);
    expect(describeMode(policy({ mode: "sandbox" }))[0]).toMatch(/OS sandbox|Only the workspace/);
    expect(describeMode(policy({ mode: "sandbox" }), "docker")[0]).toMatch(
      /container with no network/,
    );
  });

  it("a Docker-mode device says allowed domains do not apply there", async () => {
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
    expect(r.out).toContain(DOCKER_DOMAIN_NOTE);
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

  it("set refuses the removed keys and points at the mode command", async () => {
    for (const key of ["tier", "isolation", "localhost", "remoteGrants", "network"]) {
      const r = await run(["set", key, "open"]);
      expect(r.code, key).toBe(2);
      expect(r.err).toMatch(/capybara-device mode auto\|sandbox/);
    }
    const mode = await run(["set", "mode", "sandbox"]);
    expect(mode.code).toBe(2);
    expect(mode.err).toMatch(/capybara-device mode auto\|sandbox/);
  });

  it("set refuses an unknown key and an invalid domain", async () => {
    expect((await run(["set", "bogus", "x"])).code).toBe(2);
    expect((await run(["set", "allowedDomains", "https://a.com"])).code).toBe(2);
  });

  it("says the running program applies it at the next command, never to restart", async () => {
    const r = await run(["set", "cpu", "2"]);
    expect(r.out).toMatch(/applies it at the next command/);
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
