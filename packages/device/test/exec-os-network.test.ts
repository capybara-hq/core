import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceExecArgs, SandboxLimits } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY, type Policy } from "../src/state.js";

// A stand-in for sandbox-runtime: commands run unsandboxed, the test controls the violations.
const sbx = vi.hoisted(() => {
  const state = {
    askCallbackDenyReason: true as boolean,
    initialize: vi.fn(async (_config: unknown, _ask?: unknown) => {}),
    commandIds: [] as string[],
    violations: new Map<string, string[]>(),
    /** The violations the next wrapped command will have. */
    pending: undefined as string[] | undefined,
    throwOnLookup: false,
    lookups: [] as string[],
    registered: [] as Array<{ id: string; allowedDomains: string[] }>,
  };
  return state;
});

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    get askCallbackDenyReason() {
      return sbx.askCallbackDenyReason;
    },
    isSupportedPlatform: () => true,
    checkDependencies: () => ({ errors: [], warnings: [] }),
    initialize: sbx.initialize,
    wrapWithSandbox: async (
      command: string,
      _shell: string,
      _custom: unknown,
      _signal: unknown,
      opts: { commandId: string },
    ) => {
      sbx.commandIds.push(opts.commandId);
      if (sbx.pending !== undefined) sbx.violations.set(opts.commandId, sbx.pending);
      sbx.pending = undefined;
      return command;
    },
    registerCommandNetworkLists: (id: string, lists: { allowedDomains: string[] }) => {
      sbx.registered.push({ id, allowedDomains: [...lists.allowedDomains] });
    },
    unregisterCommandNetworkLists: () => {},
    cleanupAfterCommand: () => {},
    reset: async () => {},
    getSandboxViolationStore: () => ({
      getViolationsForCommand: (id: string) => {
        sbx.lookups.push(id);
        if (sbx.throwOnLookup) throw new Error("store broke");
        return (sbx.violations.get(id) ?? []).map((line) => ({ line }));
      },
    }),
  },
}));

const { createOsExecutor } = await import("../src/exec/os.js");

const LIMITS: SandboxLimits = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  egress: "allowlist",
  allowHosts: ["files.slack.com"],
};

function execArgs(command: string, over: Partial<DeviceExecArgs> = {}): DeviceExecArgs {
  return {
    command,
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    tag: "t1",
    actor: { accountId: "acc", conversationId: "conv" },
    limits: LIMITS,
    ...over,
  };
}

const deny = (target: string, reason = "host is not on the allow list") =>
  `deny network-outbound ${target} (${reason})`;

let base: string;
let policy: Policy;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "device-osnet-")));
  mkdirSync(join(base, "env"));
  policy = { ...DEFAULT_POLICY };
  sbx.askCallbackDenyReason = true;
  sbx.initialize.mockClear();
  sbx.commandIds.length = 0;
  sbx.violations.clear();
  sbx.pending = undefined;
  sbx.lookups.length = 0;
  sbx.registered.length = 0;
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const make = () => createOsExecutor({ dir: join(base, "env"), policy: () => policy });
const never = new AbortController().signal;

describe("OsExecutor network explanations (mocked runtime)", () => {
  it("passes an ask callback that denies with a capybara reason", async () => {
    const ex = await make();
    const ask = sbx.initialize.mock.calls[0]?.[1] as
      | ((p: { host: string; port: number }) => Promise<unknown>)
      | undefined;
    expect(ask).toBeTypeOf("function");
    // Before any command there are no limits: only the device layer can be judged.
    expect(await ask?.({ host: "files.slack.com", port: 443 })).toEqual({
      allow: false,
      reason: "capybara: files.slack.com is not in this device's allowed domains",
    });
    await ex.ensureRoot();
    await ex.exec(execArgs("true"), never);
    expect(await ask?.({ host: "api.foo.com", port: 443 })).toEqual({
      allow: false,
      reason: "capybara: api.foo.com is not in the organization's network allowlist",
    });
    // The policy is read at the call: a host the device now allows is not blamed on it.
    policy = { ...policy, allowedDomains: ["files.slack.com"] };
    expect(await ask?.({ host: "files.slack.com", port: 443 })).toEqual({
      allow: false,
      reason: "capybara: files.slack.com is not allowed by the network policy",
    });
    await ex.dispose();
  });

  it("passes no ask callback to a runtime that cannot carry a deny reason", async () => {
    sbx.askCallbackDenyReason = false;
    const ex = await make();
    expect(sbx.initialize).toHaveBeenCalledTimes(1);
    expect(sbx.initialize.mock.calls[0]?.[1]).toBeUndefined();
    await ex.dispose();
  });

  it("appends the trailer for the command's own violations to stderr", async () => {
    const ex = await make();
    await ex.ensureRoot();
    // The violations are keyed by the commandId the wrap was given.
    sbx.pending = [
      deny("files.slack.com:443"),
      "deny file-read-data /x",
      deny("files.slack.com:80"),
      deny("api.foo.com:443"),
      deny("10.0.0.5:22"),
    ];
    sbx.violations.set("someone-else", [deny("other.com:443")]);
    const first = ex.exec(execArgs("echo out; echo err >&2; exit 7"), never);
    const r = await first;
    expect(sbx.lookups).toEqual([sbx.commandIds[0]]);
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe(
      [
        "err",
        "[capybara-device] Network access was blocked:",
        "- files.slack.com:443: not in this device's allowed domains. Only the device owner can allow it (capybara-device policy add allowedDomains files.slack.com, or the device page).",
        "- api.foo.com:443: not in the organization's network allowlist. Only an organization admin can add it.",
        "- 10.0.0.5:22: a private or local address; commands can never reach it.",
      ].join("\n"),
    );
    await ex.dispose();
  });

  it("separates the trailer with a newline when stderr does not end with one", async () => {
    const ex = await make();
    await ex.ensureRoot();
    sbx.pending = [deny("api.foo.com:443")];
    const p = ex.exec(execArgs("printf partial >&2"), never);
    const r = await p;
    expect(r.stderr.split("\n").slice(0, 2)).toEqual([
      "partial",
      "[capybara-device] Network access was blocked:",
    ]);
    await ex.dispose();
  });

  it("classifies against the exec's own limits and the policy now", async () => {
    const ex = await make();
    await ex.ensureRoot();
    policy = { ...policy, allowedDomains: ["files.slack.com"] };
    sbx.pending = [deny("files.slack.com:443")];
    const p = ex.exec(execArgs("true", { limits: { ...LIMITS, egress: "none" } }), never);
    const r = await p;
    expect(r.stderr).toContain(
      "- files.slack.com:443: not in the organization's network allowlist.",
    );
    await ex.dispose();
  });

  it("a failure while explaining refusals still resolves the command", async () => {
    const ex = await make();
    await ex.ensureRoot();
    sbx.throwOnLookup = true;
    try {
      const r = await ex.exec(execArgs("echo err >&2; exit 3"), never);
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toBe("err\n");
    } finally {
      sbx.throwOnLookup = false;
      await ex.dispose();
    }
  });

  it("adds nothing without network violations", async () => {
    const ex = await make();
    await ex.ensureRoot();
    sbx.pending = ["deny file-write-create /etc/x"];
    const p = ex.exec(execArgs("echo err >&2"), never);
    const r = await p;
    expect(r.stderr).toBe("err\n");
    await ex.dispose();
  });

  it("the file helper never reads violations", async () => {
    const ex = await make();
    await ex.ensureRoot();
    await ex.writeFile(join(ex.roots.workspace, "a.txt"), Buffer.from("hi"));
    expect(sbx.commandIds.length).toBeGreaterThan(0);
    expect(sbx.lookups).toEqual([]);
    await ex.dispose();
  });

  it("reports the classified refusals in the result's network field", async () => {
    const ex = await make();
    await ex.ensureRoot();
    sbx.pending = [deny("files.slack.com:443"), deny("api.foo.com:443"), deny("10.0.0.5:22")];
    const r = await ex.exec(execArgs("true"), never);
    expect(r.network).toEqual({
      blocked: [
        { host: "files.slack.com", port: 443, layer: "device" },
        { host: "api.foo.com", port: 443, layer: "org" },
        { host: "10.0.0.5", port: 22, layer: "address" },
      ],
    });
    sbx.pending = ["deny file-read-data /x"];
    const quiet = await ex.exec(execArgs("true"), never);
    expect(quiet.network).toBeUndefined();
    expect("network" in quiet).toBe(false);
    await ex.dispose();
  });

  const grants = (...hosts: string[]) => ({
    hosts,
    source: { kind: "run" as const, id: "run_1", accountId: "acc" },
  });

  it("adds run grants to the command's list under remoteGrants owner, within the org", async () => {
    const ex = await make();
    await ex.ensureRoot();
    policy = { ...policy, allowedDomains: ["a.com"] };
    const limits = { ...LIMITS, allowHosts: ["a.com", "files.slack.com"] };
    await ex.exec(
      execArgs("true", { limits, grants: grants("files.slack.com", "evil.com") }),
      never,
    );
    expect(sbx.registered.at(-1)?.allowedDomains).toEqual(["a.com", "files.slack.com"]);
    // A granted host that is still refused is not blamed on the device.
    sbx.pending = [deny("files.slack.com:443")];
    const r = await ex.exec(execArgs("true", { limits, grants: grants("files.slack.com") }), never);
    expect(r.network?.blocked).toEqual([{ host: "files.slack.com", port: 443, layer: "unknown" }]);
    await ex.dispose();
  });

  it("ignores grants under remoteGrants off", async () => {
    const ex = await make();
    await ex.ensureRoot();
    policy = { ...policy, allowedDomains: ["a.com"], remoteGrants: "off" };
    const limits = { ...LIMITS, allowHosts: ["a.com", "files.slack.com"] };
    sbx.pending = [deny("files.slack.com:443")];
    const r = await ex.exec(execArgs("true", { limits, grants: grants("files.slack.com") }), never);
    expect(sbx.registered.at(-1)?.allowedDomains).toEqual(["a.com"]);
    expect(r.network?.blocked).toEqual([{ host: "files.slack.com", port: 443, layer: "device" }]);
    await ex.dispose();
  });

  it("network open with an org allowlist registers the org's list", async () => {
    const ex = await make();
    await ex.ensureRoot();
    policy = { ...policy, network: "open" };
    await ex.exec(execArgs("true"), never);
    expect(sbx.registered.at(-1)?.allowedDomains).toEqual(["files.slack.com"]);
    await ex.dispose();
  });

  it("network open with an org that is open: no list, the ask callback allows public hosts", async () => {
    const ex = await make();
    await ex.ensureRoot();
    const ask = sbx.initialize.mock.calls[0]?.[1] as (p: {
      host: string;
      port: number;
    }) => Promise<unknown>;
    policy = { ...policy, network: "open" };
    const open = { ...LIMITS, egress: "open" as const, allowHosts: [] };
    await ex.exec(execArgs("true", { limits: open }), never);
    // The runtime refuses "*" in a per-command list: it is never registered.
    expect(sbx.registered.every((x) => !x.allowedDomains.includes("*"))).toBe(true);
    expect(await ask({ host: "anything.example.org", port: 443 })).toBe(true);
    expect(await ask({ host: "Anything.Example.org.", port: 443 })).toBe(true);
    // Addresses and internal names stay refused.
    for (const host of ["10.0.0.5", "127.0.0.1", "intranet", "printer.local", "::1"]) {
      expect(await ask({ host, port: 443 }), host).toMatchObject({ allow: false });
    }
    // Narrowing applies at once: back to allowlist, or a later command under an org list.
    policy = { ...policy, network: "allowlist" };
    expect(await ask({ host: "anything.example.org", port: 443 })).toMatchObject({ allow: false });
    policy = { ...policy, network: "open" };
    await ex.exec(execArgs("true"), never);
    expect(await ask({ host: "anything.example.org", port: 443 })).toMatchObject({ allow: false });
    await ex.dispose();
  });

  it("remoteGrants does not matter for a device that is open already", async () => {
    const ex = await make();
    await ex.ensureRoot();
    policy = { ...policy, network: "open", remoteGrants: "off" };
    await ex.exec(execArgs("true"), never);
    expect(sbx.registered.at(-1)?.allowedDomains).toEqual(["files.slack.com"]);
    await ex.dispose();
  });
});
