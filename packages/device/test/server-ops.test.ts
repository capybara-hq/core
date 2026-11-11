import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelReq } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandLog } from "../src/command-log.js";
import { DeviceOpError } from "../src/exec/types.js";
import { PolicyStore } from "../src/policy-store.js";
import {
  DOCKER_WIDENING_MESSAGE,
  REMOTE_GRANTS_OFF_MESSAGE,
  runOp,
  serveOp,
} from "../src/server-ops.js";
import {
  DEFAULT_POLICY,
  type Policy,
  policyLockPath,
  policyPath,
  readPolicy,
  writePolicy,
} from "../src/state.js";
import { execArgs, FakeExecutor } from "./fake-kernel.js";

const r = (op: KernelReq["op"], args: unknown): KernelReq => ({
  type: "req",
  id: "x",
  op,
  args,
  deadlineMs: 1000,
});

describe("runOp", () => {
  it("maps an executor failure to an error answer, keeping a DeviceOpError kind", async () => {
    const ex = new FakeExecutor();
    ex.stat = async () => {
      throw new DeviceOpError("policy", "blocked by local policy");
    };
    const res = await runOp(ex, r("stat", { path: "/p" }), new AbortController().signal);
    expect(res).toEqual({
      type: "res",
      id: "x",
      ok: false,
      error: { kind: "policy", message: "blocked by local policy" },
    });
    ex.stat = async () => {
      throw new Error("boom");
    };
    expect(await runOp(ex, r("stat", { path: "/p" }), new AbortController().signal)).toMatchObject({
      error: { kind: "error", message: "boom" },
    });
  });

  it("answers stop without touching the root", async () => {
    const ex = new FakeExecutor();
    ex.root = "gone";
    expect(await runOp(ex, r("stop", { reason: "deleted" }), new AbortController().signal)).toEqual(
      {
        type: "res",
        id: "x",
        ok: true,
        result: null,
      },
    );
  });

  it("runs an exec through the executor", async () => {
    const res = await runOp(
      new FakeExecutor(),
      r("exec", execArgs("now")),
      new AbortController().signal,
    );
    expect(res).toMatchObject({ ok: true, result: { exitCode: 0 } });
  });
});

describe("the policy op", () => {
  let dir: string;
  let store: PolicyStore;
  const never = new AbortController().signal;
  const source = {
    approvalId: "apr_1",
    accountId: "acc_1",
    accountName: "Ada",
    via: "web" as const,
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "device-policy-op-"));
    store = new PolicyStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const seed = (over: Partial<Policy>) => {
    writePolicy(dir, { ...DEFAULT_POLICY, ...over });
  };
  const policyOp = (args: Record<string, unknown>) =>
    serveOp(new FakeExecutor(), r("policy", { source, ...args }), never, { policy: store });

  it("answers unsupported without a policy store", async () => {
    const res = await runOp(new FakeExecutor(), r("policy", { source, add: ["a.com"] }), never);
    expect(res).toMatchObject({ ok: false, error: { kind: "error" } });
  });

  it("adds a host under remoteGrants owner, writes the file and returns the summary", async () => {
    seed({ allowedDomains: ["a.com"], allowCredentials: ["GH"] });
    const { res, detail } = await policyOp({ add: ["Files.Slack.com"] });
    expect(res).toEqual({
      type: "res",
      id: "x",
      ok: true,
      result: {
        policy: {
          network: "allowlist",
          allowedDomains: ["a.com", "files.slack.com"],
          remoteGrants: "owner",
        },
      },
    });
    expect(readPolicy(dir)).toMatchObject({
      allowedDomains: ["a.com", "files.slack.com"],
      allowCredentials: ["GH"],
    });
    expect(store.current().allowedDomains).toEqual(["a.com", "files.slack.com"]);
    expect(detail).toBe("policy add files.slack.com by Ada (acc_1) via web, approval apr_1");
  });

  it("is idempotent", async () => {
    seed({ allowedDomains: ["a.com"] });
    await policyOp({ add: ["a.com", "b.com"] });
    const { res } = await policyOp({ add: ["b.com", "A.COM"], remove: ["zz.com"] });
    expect(res).toMatchObject({
      ok: true,
      result: { policy: { allowedDomains: ["a.com", "b.com"] } },
    });
  });

  it("removes hosts ignoring case and switches network", async () => {
    seed({ allowedDomains: ["A.com", "b.com"] });
    const { res, detail } = await policyOp({ remove: ["a.com"], network: "open" });
    expect(res).toMatchObject({
      ok: true,
      result: { policy: { network: "open", allowedDomains: ["b.com"], remoteGrants: "owner" } },
    });
    expect(readPolicy(dir).network).toBe("open");
    expect(detail).toBe("policy remove a.com; network open by Ada (acc_1) via web, approval apr_1");
  });

  it("under remoteGrants off refuses every widening and changes nothing", async () => {
    seed({ allowedDomains: ["a.com"], remoteGrants: "off" });
    const before = readFileSync(policyPath(dir), "utf8");
    for (const [args, what] of [
      [{ add: ["b.com"] }, "add b.com"],
      [{ network: "open" }, "network open"],
      // A request with any widening is refused whole, its narrowing part too.
      [{ add: ["b.com"], remove: ["a.com"] }, "add b.com; remove a.com"],
      [{ add: ["a.com"] }, "add a.com"],
    ] as const) {
      const { res, detail } = await policyOp(args);
      expect(res).toEqual({
        type: "res",
        id: "x",
        ok: false,
        error: { kind: "policy", message: REMOTE_GRANTS_OFF_MESSAGE },
      });
      // The attempt is recorded locally.
      expect(detail).toBe(`policy refused ${what} by Ada (acc_1) via web, approval apr_1`);
    }
    expect(REMOTE_GRANTS_OFF_MESSAGE).toBe(
      "This device does not accept network changes from the deployment; allow it locally: " +
        "capybara-device policy add allowedDomains <host>",
    );
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
  });

  it("in docker mode refuses every widening: the container cannot limit single domains", async () => {
    seed({ allowedDomains: ["a.com", "b.com"], network: "open" });
    const docker = new FakeExecutor();
    (docker as { mode: string }).mode = "docker";
    const before = readFileSync(policyPath(dir), "utf8");
    for (const args of [
      { add: ["c.com"] },
      { network: "open" },
      { add: ["c.com"], remove: ["a.com"] },
    ]) {
      const { res, detail } = await serveOp(docker, r("policy", { source, ...args }), never, {
        policy: store,
      });
      expect(res).toEqual({
        type: "res",
        id: "x",
        ok: false,
        error: { kind: "policy", message: DOCKER_WIDENING_MESSAGE },
      });
      expect(detail).toMatch(/^policy refused /);
    }
    expect(DOCKER_WIDENING_MESSAGE).toBe(
      "This device runs commands in Docker mode, which cannot limit network access per domain; " +
        "switch the device to OS mode to allow single domains.",
    );
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
    // Narrowing still applies.
    const { res } = await serveOp(
      docker,
      r("policy", { source, remove: ["a.com"], network: "allowlist" }),
      never,
      { policy: store },
    );
    expect(res).toMatchObject({
      ok: true,
      result: { policy: { network: "allowlist", allowedDomains: ["b.com"] } },
    });
  });

  it("under remoteGrants off always applies narrowing", async () => {
    seed({ allowedDomains: ["a.com", "b.com"], network: "open", remoteGrants: "off" });
    const { res } = await policyOp({ remove: ["a.com"], network: "allowlist" });
    expect(res).toMatchObject({
      ok: true,
      result: { policy: { network: "allowlist", allowedDomains: ["b.com"], remoteGrants: "off" } },
    });
  });

  it("reads remoteGrants from the file as it is now, not a stale copy", async () => {
    // The store saw owner; the person switched it off locally since.
    expect(store.current().remoteGrants).toBe("owner");
    seed({ remoteGrants: "off" });
    const { res } = await policyOp({ add: ["b.com"] });
    expect(res).toMatchObject({ ok: false, error: { kind: "policy" } });
  });

  it("validates every host", async () => {
    for (const bad of [
      "10.0.0.1",
      "intranet",
      "a.local",
      "https://a.com",
      "a.com:443",
      "",
      "a\nb.com",
    ]) {
      for (const key of ["add", "remove"]) {
        const { res } = await policyOp({ [key]: [bad] });
        expect(res, `${key} ${JSON.stringify(bad)}`).toMatchObject({
          ok: false,
          error: { kind: "policy" },
        });
      }
    }
    expect(store.current().allowedDomains).toEqual([]);
  });

  it("refuses a wildcard from an approval, accepts one from the device page", async () => {
    const { res } = await policyOp({ add: ["*.slack.com"] });
    expect(res).toMatchObject({
      ok: false,
      error: { kind: "policy", message: expect.stringMatching(/exact host/) },
    });
    const page = await serveOp(
      new FakeExecutor(),
      r("policy", {
        source: { accountId: "acc_1", accountName: "Ada", via: "web" },
        add: ["*.slack.com"],
      }),
      never,
      { policy: store },
    );
    expect(page.res).toMatchObject({
      ok: true,
      result: { policy: { allowedDomains: ["*.slack.com"] } },
    });
    expect(page.detail).toBe("policy add *.slack.com by Ada (acc_1) via web");
  });

  it("refuses a host both added and removed", async () => {
    const { res } = await policyOp({ add: ["a.com"], remove: ["A.com"] });
    expect(res).toMatchObject({ ok: false, error: { kind: "policy" } });
  });

  it("does not need the device directory", async () => {
    const ex = new FakeExecutor();
    ex.root = "gone";
    const { res } = await serveOp(ex, r("policy", { source, add: ["a.com"] }), never, {
      policy: store,
    });
    expect(res).toMatchObject({ ok: true });
  });

  it("keeps the audit line clean: control characters stripped, the name capped", async () => {
    const { detail } = await serveOp(
      new FakeExecutor(),
      r("policy", {
        source: {
          accountId: "acc\n_1",
          accountName: `Ada\n\u0007\u202e Lovelace${"x".repeat(200)}`,
          via: "im",
          approvalId: "apr\r1",
        },
        remove: ["a.com"],
      }),
      never,
      { policy: store },
    );
    const name = `Ada Lovelace${"x".repeat(200)}`.slice(0, 100);
    expect(detail).toBe(`policy remove a.com by ${name} (acc_1) via im, approval apr1`);
  });

  it("writes under policy.json.lock: a held lock fails the op without writing", async () => {
    writeFileSync(policyLockPath(dir), String(process.pid));
    const { res } = await policyOp({ add: ["a.com"] });
    expect(res).toMatchObject({
      ok: false,
      error: { kind: "error", message: expect.stringMatching(/is held/) },
    });
    expect(() => statSync(policyPath(dir))).toThrow();
  }, 10_000);
});

describe("exec grants in the command log", () => {
  let dir: string;
  const never = new AbortController().signal;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "device-grants-log-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withGrants = (limits: Record<string, unknown>) => ({
    ...execArgs("now"),
    limits: { cpu: 1, memoryMb: 512, diskMb: 1024, ...limits },
    grants: {
      hosts: ["b.com", "c.com", "evil.com"],
      source: { kind: "run", id: "run_1", accountId: "acc_1" },
    },
  });

  it("names the grants an exec was given and their source", async () => {
    const store = new PolicyStore(dir);
    const { detail } = await serveOp(
      new FakeExecutor(),
      r("exec", withGrants({ egress: "allowlist", allowHosts: ["b.com", "c.com"] })),
      never,
      { policy: store },
    );
    expect(detail).toBe("grants run run_1 by acc_1: b.com, c.com");
  });

  it("logs nothing when no grant applied", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, remoteGrants: "off" });
    const store = new PolicyStore(dir);
    const off = await serveOp(
      new FakeExecutor(),
      r("exec", withGrants({ egress: "open", allowHosts: [] })),
      never,
      { policy: store },
    );
    expect(off.detail).toBeUndefined();
    writePolicy(dir, DEFAULT_POLICY);
    const none = await serveOp(
      new FakeExecutor(),
      r("exec", withGrants({ egress: "none", allowHosts: [] })),
      never,
      { policy: store },
    );
    expect(none.detail).toBeUndefined();
  });

  it("logs nothing in docker mode, which ignores grants", async () => {
    const ex = new FakeExecutor();
    (ex as { mode: string }).mode = "docker";
    const { detail } = await serveOp(
      ex,
      r("exec", withGrants({ egress: "open", allowHosts: [] })),
      never,
      { policy: new PolicyStore(dir) },
    );
    expect(detail).toBeUndefined();
  });
});

describe("CommandLog", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rotates at the size limit", () => {
    dir = mkdtempSync(join(tmpdir(), "device-log-"));
    writeFileSync(join(dir, "commands.log"), "x".repeat(100));
    const log = new CommandLog(dir, 100);
    log.append({ time: "t", op: "exec", tag: "a", actor: null, exitCode: 0 });
    expect(readFileSync(join(dir, "commands.log.1"), "utf8")).toBe("x".repeat(100));
    expect(readFileSync(join(dir, "commands.log"), "utf8")).toContain('"op":"exec"');
  });
});
