import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelReq } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandLog } from "../src/command-log.js";
import { DeviceOpError } from "../src/exec/types.js";
import { PolicyStore } from "../src/policy-store.js";
import {
  logEntryFor,
  MODE_ON_DEVICE_MESSAGE,
  policySummary,
  runOp,
  type SeenState,
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

let opSeq = 0;
/** A request; a `policy` op gets a fresh op id unless it names one (each is a new change). */
const r = (op: KernelReq["op"], args: unknown): KernelReq => ({
  type: "req",
  id: "x",
  op,
  args:
    op === "policy" && typeof args === "object" && args !== null && !("opId" in args)
      ? { opId: `op_${++opSeq}`, ...args }
      : args,
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

  it("adds a host, writes the file and returns the summary", async () => {
    seed({ allowedDomains: ["a.com"], allowCredentials: ["GH"] });
    const { res, detail } = await policyOp({ add: ["Files.Slack.com"] });
    expect(res).toEqual({
      type: "res",
      id: "x",
      ok: true,
      result: {
        policy: { mode: "auto", allowedDomains: ["a.com", "files.slack.com"] },
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

  it("removes hosts ignoring case and narrows the mode", async () => {
    seed({ allowedDomains: ["A.com", "b.com"], mode: "auto" });
    const { res, detail } = await policyOp({ remove: ["a.com"], mode: "sandbox" });
    expect(res).toMatchObject({
      ok: true,
      result: { policy: { mode: "sandbox", allowedDomains: ["b.com"] } },
    });
    expect(readPolicy(dir).mode).toBe("sandbox");
    expect(detail).toBe("policy remove a.com; mode sandbox by Ada (acc_1) via web, approval apr_1");
  });

  it("never turns auto mode on, whatever the op is shaped like", async () => {
    seed({ mode: "sandbox", allowedDomains: ["a.com"] });
    const before = readFileSync(policyPath(dir), "utf8");
    for (const mode of ["auto", "AUTO", null, false, "", { auto: true }, ["auto"]]) {
      const { res, detail } = await policyOp({ mode });
      expect(res, JSON.stringify(mode)).toEqual({
        type: "res",
        id: "x",
        ok: false,
        error: { kind: "policy", message: MODE_ON_DEVICE_MESSAGE },
      });
      expect(detail).toMatch(/^policy refused mode /);
    }
    // Bundled with an allowed change, the whole op is refused.
    const both = await policyOp({ remove: ["a.com"], add: ["b.com"], mode: "auto" });
    expect(both.res).toMatchObject({ ok: false, error: { message: MODE_ON_DEVICE_MESSAGE } });
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
    expect(readPolicy(dir).mode).toBe("sandbox");
    expect(MODE_ON_DEVICE_MESSAGE).toBe(
      "The device's mode can only be changed on the machine: run `capybara-device mode auto`.",
    );
  });

  it("applies mode sandbox even when the summary already says sandbox", async () => {
    seed({ mode: "auto", allowedDomains: ["a.com", "b.com"] });
    const { res } = await policyOp({ remove: ["a.com"], mode: "sandbox" });
    expect(res).toMatchObject({
      ok: true,
      result: { policy: { mode: "sandbox", allowedDomains: ["b.com"] } },
    });
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

  it("refuses a page wildcard covering a whole public suffix; removing one is fine", async () => {
    const page = (args: Record<string, unknown>) =>
      serveOp(
        new FakeExecutor(),
        r("policy", { source: { accountId: "acc_1", accountName: "Ada", via: "web" }, ...args }),
        never,
        { policy: store },
      );
    for (const pattern of ["*.com", "*.co.uk", "*.github.io", "*.COM.cn"]) {
      const { res } = await page({ add: [pattern] });
      expect(res).toMatchObject({
        ok: false,
        error: {
          kind: "policy",
          message: `Use a narrower domain; ${pattern.toLowerCase()} covers a whole public suffix.`,
        },
      });
    }
    expect(readPolicy(dir).allowedDomains).toEqual([]);
    expect((await page({ add: ["*.example.co.uk"] })).res).toMatchObject({ ok: true });
    seed({ allowedDomains: ["*.co.uk"] });
    expect((await page({ remove: ["*.co.uk"] })).res).toMatchObject({
      ok: true,
      result: { policy: { allowedDomains: [] } },
    });
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
          accountName: `Ada\n\u0007‮ Lovelace${"x".repeat(200)}`,
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

  const withGrants = (over: Record<string, unknown>) => ({
    ...execArgs("now"),
    limits: {
      cpu: 1,
      memoryMb: 512,
      diskMb: 1024,
      mode: "sandbox",
      network: { kind: "allowlist", hosts: [] },
      ...over,
    },
    grants: {
      hosts: ["b.com", "c.com", "evil.com"],
      source: { kind: "run", id: "run_1", accountId: "acc_1" },
    },
  });

  it("names the grants an exec was given and their source", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "sandbox" });
    const store = new PolicyStore(dir);
    const { detail } = await serveOp(
      new FakeExecutor(),
      r("exec", withGrants({ network: { kind: "allowlist", hosts: ["b.com", "c.com"] } })),
      never,
      { policy: store },
    );
    expect(detail).toBe("grants run run_1 by acc_1: b.com, c.com");
  });

  it("logs nothing when no grant applied", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "sandbox" });
    const store = new PolicyStore(dir);
    const none = await serveOp(
      new FakeExecutor(),
      r("exec", withGrants({ network: { kind: "allowlist", hosts: [] } })),
      never,
      { policy: store },
    );
    expect(none.detail).toBeUndefined();
    // auto mode ignores grants: the machine's own network
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "auto" });
    const auto = await serveOp(
      new FakeExecutor(),
      r("exec", withGrants({ mode: "auto", network: { kind: "open-public", hosts: [] } })),
      never,
      { policy: store },
    );
    expect(auto.detail).toBeUndefined();
  });

  it("logs nothing in docker mode, which ignores grants", async () => {
    const ex = new FakeExecutor();
    (ex as { mode: string }).mode = "docker";
    const { detail } = await serveOp(
      ex,
      r("exec", withGrants({ network: { kind: "open-public", hosts: [] } })),
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

describe("modes in the summary and the command log", () => {
  let dir: string;
  const never = new AbortController().signal;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "device-modes-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withMode = (mode: "auto" | "sandbox") => ({
    ...execArgs("now"),
    limits: { ...execArgs("now").limits, mode },
  });

  it("the summary keeps the owner's choice after an exec's ceiling", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "auto", allowedDomains: ["a.com"] });
    const store = new PolicyStore(dir);
    const seen: SeenState = {};
    const ex = new FakeExecutor();
    const ctx = { policy: store, seen };
    await serveOp(ex, r("exec", withMode("sandbox")), never, ctx);
    expect(seen.limits).toEqual({ mode: "sandbox" });
    const { res } = await serveOp(
      ex,
      r("policy", { source: { accountId: "a", accountName: "A", via: "web" } }),
      never,
      ctx,
    );
    expect(res).toMatchObject({
      ok: true,
      result: { policy: { mode: "auto", allowedDomains: ["a.com"] } },
    });
  });

  it("reports the owner's mode, before and after an exec's ceiling", () => {
    expect(policySummary({ ...DEFAULT_POLICY, mode: "auto" }, { mode: "os" })).toEqual({
      mode: "auto",
      allowedDomains: [],
    });
    expect(policySummary({ ...DEFAULT_POLICY, mode: "sandbox" }, { mode: "docker" })).toEqual({
      mode: "sandbox",
      allowedDomains: [],
    });
    expect(
      policySummary(
        { ...DEFAULT_POLICY, mode: "auto" },
        { mode: "os", limits: { mode: "sandbox" } },
      ),
      // The kernel takes min(allowed, reported): an org that later allows auto follows at once.
    ).toEqual({ mode: "auto", allowedDomains: [] });
  });

  it("the executor runs the decision the log records", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "auto" });
    const store = new PolicyStore(dir);
    const ex = new FakeExecutor();
    const seenBy: unknown[] = [];
    (ex as { execDecided?: unknown }).execDecided = async (
      _args: unknown,
      _signal: AbortSignal,
      how: unknown,
      policy: unknown,
    ) => {
      seenBy.push({ how, policy });
      return { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false };
    };
    const out = await serveOp(ex, r("exec", withMode("auto")), never, { policy: store });
    expect(out.run).toEqual({ mode: "auto" });
    expect(seenBy).toEqual([{ how: out.run, policy: store.current() }]);
    expect(ex.started).toEqual([]);
  });

  it("every exec is logged with its mode", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "sandbox" });
    const store = new PolicyStore(dir);
    const ex = new FakeExecutor();
    const req = r("exec", withMode("auto"));
    // The device's own sandbox mode wins over an auto ceiling.
    const sandboxed = await serveOp(ex, req, never, { policy: store });
    expect(sandboxed.run).toEqual({ mode: "sandbox" });
    expect(
      logEntryFor(req, sandboxed.res, new Date(0), sandboxed.detail, sandboxed.run),
    ).toMatchObject({
      op: "exec",
      mode: "sandbox",
    });
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "auto" });
    const auto = await serveOp(ex, r("exec", withMode("auto")), never, { policy: store });
    expect(auto.run).toEqual({ mode: "auto" });
    // The ceiling can only narrow.
    const capped = await serveOp(ex, r("exec", withMode("sandbox")), never, { policy: store });
    expect(capped.run).toEqual({ mode: "sandbox" });
  });
});
