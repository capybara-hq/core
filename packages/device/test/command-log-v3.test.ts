import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  type DeviceOwnerCeiling,
  type KernelRequest,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { CommandLog } from "../src/command-log.js";
import type { MacOperationBackend } from "../src/exec/mac-operation-backend.js";
import { PolicyStore } from "../src/policy-store.js";
import { type StagedOwnerPolicy, serveOperationV3 } from "../src/server-ops.js";
import { DEFAULT_POLICY, FULL_OWNER_CEILING, writePolicy } from "../src/state.js";

// The local command log under protocol 3: one line per executed operation (its isolation and
// actor) and an audit line per policy change, cloud or CLI. Best effort; never a secret.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "device-command-log-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const never = new AbortController().signal;
const REPORT: DeviceOwnerCeiling = {
  version: 2,
  sequence: 0,
  revision: "rev",
  fullAccess: true,
  restrictedProjectReach: "workspace",
  restrictedAllowedDomains: [],
};
const scope = (profile: "approve-for-me" | "full-access", tag = "t1") => ({
  operationId: `op-${tag}`,
  admitBeforeMs: 1000,
  deviceId: "d",
  rootConversationId: "conv_1",
  profileRevision: 0,
  ceilingRevision: "c",
  profile,
  actor: { accountId: "acc_1", conversationId: "conv_1" },
  tag,
  filesystem:
    profile === "full-access"
      ? { kind: "device" }
      : { kind: "scoped", readRoots: ["/work"], writeRoots: ["/work"] },
  network: profile === "full-access" ? { kind: "environment" } : { kind: "none" },
});
const limits = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  mode: "sandbox",
  network: { kind: "allowlist", hosts: ["api.example.com"] },
};
const request = (op: string, args: unknown, id = "q") =>
  ({ type: "req", id, op, args, deadlineMs: 1000 }) as KernelRequest;
const lines = (): Record<string, unknown>[] => {
  const file = join(dir, "commands.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

function owner(log: CommandLog = new CommandLog(dir)): StagedOwnerPolicy {
  writePolicy(dir, { ...DEFAULT_POLICY, ownerCeiling: { ...FULL_OWNER_CEILING } });
  return { store: new PolicyStore(dir), report: () => REPORT, reconcile: async () => {}, log };
}

/** A backend whose exec answers `result` (or throws it) and whose background start answers a ref. */
function backend(result: unknown) {
  const run = async () => {
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    forExecution: () => ({
      operation: async () => ({ exec: run }),
      background: {
        start: async () => ({ id: "bg_1", operationId: "op-bg", deviceId: "d" }),
      },
    }),
  } as unknown as MacOperationBackend;
}
const OK = { stdout: "", stderr: "", exitCode: 3, truncated: false, timedOut: false };
const execArgs = (profile: "approve-for-me" | "full-access", extra: object = {}) => ({
  scope: scope(profile),
  command: "echo $TOKEN",
  timeoutMs: 100,
  maxOutputBytes: 100,
  env: { TOKEN: "s3cr3t-value" },
  limits,
  ...extra,
});

describe("protocol 3 operations in the command log", () => {
  it("logs a restricted exec with its actor, tag and exit code; never the command or env", async () => {
    const res = await serveOperationV3(
      backend(OK),
      { id: "d" },
      request("exec", execArgs("approve-for-me")),
      never,
      undefined,
      owner(),
    );
    expect(res).toMatchObject({ ok: true });
    expect(lines()).toEqual([
      {
        time: expect.any(String),
        op: "exec",
        tag: "t1",
        actor: { accountId: "acc_1", conversationId: "conv_1" },
        exitCode: 3,
        isolation: "restricted",
      },
    ]);
    const raw = readFileSync(join(dir, "commands.log"), "utf8");
    expect(raw).not.toContain("s3cr3t-value");
    expect(raw).not.toContain("echo");
  });

  it("logs a Full access exec as full, with the grants it was given and their source", async () => {
    await serveOperationV3(
      backend(OK),
      { id: "d" },
      request(
        "exec",
        execArgs("full-access", {
          grants: {
            hosts: ["api.example.com"],
            source: { kind: "run", id: "run_7", accountId: "acc_1" },
          },
        }),
      ),
      never,
      undefined,
      owner(),
    );
    expect(lines()).toEqual([
      expect.objectContaining({
        op: "exec",
        isolation: "full",
        detail: "grants run run_7 by acc_1: api.example.com",
      }),
    ]);
  });

  it("logs an escalated exec as full with its call approval, and the next exec restricted again", async () => {
    // a per-call sandbox escalation: the conversation's restricted profile with full reach
    const escalated = {
      ...scope("approve-for-me", "t2"),
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    };
    const o = owner();
    await serveOperationV3(
      backend(OK),
      { id: "d" },
      request("exec", execArgs("approve-for-me", { scope: escalated })),
      never,
      undefined,
      o,
    );
    await serveOperationV3(
      backend(OK),
      { id: "d" },
      request("exec", execArgs("approve-for-me")),
      never,
      undefined,
      o,
    );
    const [first, second] = lines();
    expect(first).toMatchObject({
      op: "exec",
      tag: "t2",
      isolation: "full",
      grantSource: "call approval",
    });
    expect(second).toMatchObject({ op: "exec", tag: "t1", isolation: "restricted" });
    expect(second).not.toHaveProperty("grantSource");
    expect(readFileSync(join(dir, "commands.log"), "utf8")).not.toContain("echo");
  });

  it("logs a Full access exec without a call approval source", async () => {
    await serveOperationV3(
      backend(OK),
      { id: "d" },
      request("exec", execArgs("full-access")),
      never,
      undefined,
      owner(),
    );
    expect(lines()[0]).toMatchObject({ isolation: "full" });
    expect(lines()[0]).not.toHaveProperty("grantSource");
  });

  it("logs a background start and a failed exec (the error kind only)", async () => {
    const o = owner();
    await serveOperationV3(
      backend(OK),
      { id: "d" },
      request("backgroundStart", {
        ...execArgs("approve-for-me"),
        taskId: "task_1",
        outputPath: "/work/out",
        retainUntilMs: 2000,
      }),
      never,
      undefined,
      o,
    );
    await serveOperationV3(
      backend(new SandboxScopeDeniedError("/secret/path is outside")),
      { id: "d" },
      request("exec", execArgs("approve-for-me")),
      never,
      undefined,
      o,
    );
    expect(lines()).toEqual([
      expect.objectContaining({ op: "backgroundStart", exitCode: null, isolation: "restricted" }),
      expect.objectContaining({ op: "exec", exitCode: null, detail: "failed (denied)" }),
    ]);
    expect(readFileSync(join(dir, "commands.log"), "utf8")).not.toContain("/secret/path");
  });

  it("a log that cannot be written never fails or blocks the operation", async () => {
    const broken = new CommandLog(dir);
    vi.spyOn(broken, "append").mockImplementation(() => {
      throw new Error("disk full");
    });
    const res = await serveOperationV3(
      backend(OK),
      { id: "d" },
      request("exec", execArgs("approve-for-me")),
      never,
      undefined,
      owner(broken),
    );
    expect(res).toMatchObject({ ok: true, result: { exitCode: 3 } });
    // a log path that is a directory: the real log swallows the failure too
    mkdirSync(join(dir, "commands.log"));
    const real = await serveOperationV3(
      backend(OK),
      { id: "d" },
      request("exec", execArgs("approve-for-me")),
      never,
      undefined,
      owner(),
    );
    expect(real).toMatchObject({ ok: true });
  });
});

describe("the log files", () => {
  it("tightens an existing commands.log and commands.log.1 to 0600 when the log is opened", () => {
    for (const name of ["commands.log", "commands.log.1"]) {
      writeFileSync(join(dir, name), "{}\n");
      chmodSync(join(dir, name), 0o644);
    }
    new CommandLog(dir);
    for (const name of ["commands.log", "commands.log.1"])
      expect((statSync(join(dir, name)).mode & 0o777).toString(8), name).toBe("600");
  });
});

describe("policy changes in the command log", () => {
  const source = { accountId: "acc_1", accountName: "Ada", via: "web", approvalId: "apr_1" };

  it("audits a cloud policy change and a refused one, with the deciding account", async () => {
    const o = owner();
    await serveOperationV3(
      {} as MacOperationBackend,
      { id: "d" },
      request("policy", { opId: "op_1", add: ["files.slack.com"], source }),
      never,
      undefined,
      o,
    );
    await serveOperationV3(
      {} as MacOperationBackend,
      { id: "d" },
      request("policy", { opId: "op_2", add: ["a.com"], remove: ["a.com"], source }),
      never,
      undefined,
      o,
    );
    expect(lines()).toEqual([
      expect.objectContaining({
        op: "policy",
        tag: null,
        actor: { accountId: "acc_1" },
        detail: "policy add files.slack.com by Ada (acc_1) via web, approval apr_1",
      }),
      expect.objectContaining({
        op: "policy",
        detail: expect.stringMatching(/^policy refused add a\.com; remove a\.com by Ada/),
      }),
    ]);
  });

  it("audits a policy op that fails for any other reason, also one the frame parser refuses", async () => {
    const o = owner();
    // the policy lock is held: the op fails without a write
    writeFileSync(join(dir, "policy.json.lock"), String(process.pid));
    const held = await serveOperationV3(
      {} as MacOperationBackend,
      { id: "d" },
      request("policy", { opId: "op_3", add: ["b.com"], source }),
      never,
      undefined,
      o,
    );
    expect(held.ok).toBe(false);
    rmSync(join(dir, "policy.json.lock"));
    // a widening the parser refuses before the device's own checks
    const parsed = await serveOperationV3(
      {} as MacOperationBackend,
      { id: "d" },
      request("policy", { opId: "op_4", mode: "auto", source }),
      never,
      undefined,
      o,
    );
    expect(parsed.ok).toBe(false);
    expect(lines()).toEqual([
      expect.objectContaining({
        op: "policy",
        actor: { accountId: "acc_1" },
        detail: expect.stringMatching(/^policy failed \(.*held.*\) by Ada \(acc_1\) via web/),
      }),
      expect.objectContaining({
        op: "policy",
        actor: { accountId: "acc_1" },
        detail: expect.stringMatching(/^policy failed \(.*mode.*\) by Ada \(acc_1\) via web/),
      }),
    ]);
  });

  it("audits a policy change and a ceiling change made with the CLI on the machine", async () => {
    // the state directory is <XDG_CONFIG_HOME>/capybara-device
    const state = join(dir, "capybara-device");
    mkdirSync(state, { recursive: true });
    writePolicy(state, { ...DEFAULT_POLICY });
    const cli = (argv: string[]) =>
      runCli(argv, {
        env: { XDG_CONFIG_HOME: dir },
        home: dir,
        platform: "linux",
        out: () => {},
        err: () => {},
        stdinIsTTY: false,
      });
    try {
      expect(await cli(["policy", "add", "allowedDomains", "a.com"])).toBe(0);
      expect(
        await cli([
          "ceiling",
          "set",
          "--full-access",
          "allow",
          "--project-reach",
          "os-user",
          "--yes",
        ]),
      ).toBe(0);
      const logged = readFileSync(join(state, "commands.log"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const user = userInfo().username;
      expect(logged).toEqual([
        expect.objectContaining({
          op: "policy",
          detail: `policy add allowedDomains a.com by ${user} via cli`,
        }),
        expect.objectContaining({
          op: "policy",
          detail: `ceiling set fullAccess allow, projectReach os-user by ${user} via cli`,
        }),
      ]);
    } finally {
      // removed with dir
    }
  });
});
