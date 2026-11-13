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
    updateConfig: vi.fn((_config: unknown) => {}),
    commandIds: [] as string[],
    violations: new Map<string, string[]>(),
    /** The violations the next wrapped command will have. */
    pending: undefined as string[] | undefined,
    throwOnLookup: false,
    lookups: [] as string[],
    registered: [] as Array<{ id: string; allowedDomains: string[] }>,
    unregistered: [] as string[],
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
    updateConfig: sbx.updateConfig,
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
    unregisterCommandNetworkLists: (id: string) => {
      sbx.unregistered.push(id);
    },
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

const { createOsExecutor, launchedGroup } = await import("../src/exec/os.js");
const { BACKGROUND_LAUNCH_LINE } = await import("@capybara-hq/plugin-sdk");

const LIMITS: SandboxLimits = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  mode: "sandbox",
  network: { kind: "allowlist", hosts: ["files.slack.com"] },
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
  sbx.updateConfig.mockClear();
  sbx.commandIds.length = 0;
  sbx.violations.clear();
  sbx.pending = undefined;
  sbx.lookups.length = 0;
  sbx.registered.length = 0;
  sbx.unregistered.length = 0;
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const make = () =>
  createOsExecutor({
    dir: join(base, "env"),
    policy: () => policy,
  });
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
    // Sandbox mode never allows from the callback (auto mode runs without the OS sandbox).
    expect(await ask?.({ host: "anything.example.org", port: 443 })).toMatchObject({
      allow: false,
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
    const p = ex.exec(
      execArgs("true", { limits: { ...LIMITS, network: { kind: "allowlist", hosts: [] } } }),
      never,
    );
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

  it("adds run grants to the command's list, within the kernel's network", async () => {
    const ex = await make();
    await ex.ensureRoot();
    policy = { ...policy, allowedDomains: ["a.com"] };
    const limits = {
      ...LIMITS,
      network: { kind: "allowlist" as const, hosts: ["a.com", "files.slack.com"] },
    };
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

  it("an open-public ceiling admits a granted host", async () => {
    const ex = await make();
    await ex.ensureRoot();
    policy = { ...policy, allowedDomains: ["a.com"] };
    const limits = { ...LIMITS, network: { kind: "open-public" as const, hosts: [] } };
    await ex.exec(
      execArgs("true", { limits, grants: grants("files.slack.com", "evil.com") }),
      never,
    );
    // Any public host is within an open-public ceiling.
    expect(sbx.registered.at(-1)?.allowedDomains).toEqual(["a.com", "files.slack.com", "evil.com"]);
    await ex.dispose();
  });

  it("the sandbox config is the strict profile and does not follow the policy", async () => {
    const ex = await make();
    await ex.ensureRoot();
    const init = sbx.initialize.mock.calls[0]?.[0] as {
      filesystem: { allowWrite: string[]; denyWrite: string[] };
      network: Record<string, unknown>;
    };
    expect(init.filesystem.allowWrite).toEqual([
      join(base, "env", "workspace"),
      join(base, "env", "tmp"),
    ]);
    expect(init.filesystem.denyWrite).toContain(join(base, "env", "skills"));
    expect(init.network).not.toHaveProperty("allowLocalBinding");
    expect(init.network).not.toHaveProperty("allowUnixSockets");
    // A policy change does not change the sandbox's filesystem or local permissions.
    policy = { ...policy, mode: "sandbox", allowedDomains: ["a.com"] };
    await ex.exec(execArgs("true"), never);
    expect(sbx.updateConfig).not.toHaveBeenCalled();
    await ex.dispose();
  });

  it("a background task keeps its launch's network until its process group ends (macOS)", async () => {
    expect(launchedGroup("started\n4242\n", "darwin")).toBe(4242);
    expect(launchedGroup("4242\n", "linux")).toBeUndefined();
    expect(launchedGroup("no sid here\n", "darwin")).toBeUndefined();
    if (process.platform !== "darwin") return;
    const ex = await make();
    await ex.ensureRoot();
    policy = { ...policy, allowedDomains: ["a.com"] };
    const listed = { ...LIMITS, network: { kind: "allowlist" as const, hosts: ["a.com"] } };
    // A launch like the kernel's: the task leads a group of its own and outlives the launch,
    // whose last line is the group id.
    let n = 0;
    const launch = (seconds: number) => {
      const f = join(base, `sid${n++}`);
      return (
        `${BACKGROUND_LAUNCH_LINE}\n` +
        `perl -e 'use POSIX; POSIX::setsid(); open(F, ">", "${f}.tmp"); print F $$; close F; ` +
        `rename("${f}.tmp", "${f}"); sleep ${seconds}' > /dev/null 2>&1 < /dev/null &\n` +
        `while [ ! -s ${f} ]; do sleep 0.02; done; cat ${f}; echo`
      );
    };
    const r = await ex.exec(execArgs(launch(30), { limits: listed }), never);
    expect(r.exitCode).toBe(0);
    const id = sbx.commandIds.at(-1) as string;
    // The launch returned, the task runs: its list stays registered.
    expect(sbx.unregistered).not.toContain(id);
    // A short task releases its list once its group ends.
    const short = await ex.exec(execArgs(launch(1.5), { limits: listed }), never);
    expect(short.exitCode).toBe(0);
    const shortId = sbx.commandIds.at(-1) as string;
    expect(sbx.unregistered).not.toContain(shortId);
    await new Promise((res) => setTimeout(res, 2000));
    (ex as unknown as { prune(): void }).prune();
    expect(sbx.unregistered).toContain(shortId);
    expect(sbx.unregistered).not.toContain(id);
    // A foreground command still releases at its end.
    await ex.exec(execArgs("true", { limits: listed }), never);
    expect(sbx.unregistered).toContain(sbx.commandIds.at(-1));
    // Stopping everything (drain, dispose) releases the rest.
    await ex.killAll();
    expect(sbx.unregistered).toContain(id);
    await ex.dispose();
  });
});
