import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KernelReq, UNSANDBOXED_NOT_ALLOWED_MESSAGE } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandLog } from "../src/command-log.js";
import { DeviceOpError } from "../src/exec/types.js";
import { PolicyStore } from "../src/policy-store.js";
import {
  DOCKER_WIDENING_MESSAGE,
  ISOLATION_REMOTE_MESSAGE,
  logEntryFor,
  policySummary,
  REMOTE_GRANTS_OFF_MESSAGE,
  REMOTE_TIER_OFF_MESSAGE,
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
    serveOp(new FakeExecutor(), r("policy", { source, ...args }), never, {
      policy: store,
      platform: "darwin",
    });

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
          // No exec seen yet: no ceiling known, so the owner's choice, else dev.
          effectiveTier: "dev",
          isolation: "sandbox",
          localhost: "on",
          unixSockets: "roots",
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

  it("removes hosts ignoring case and switches the tier", async () => {
    seed({ allowedDomains: ["A.com", "b.com"] });
    const { res, detail } = await policyOp({ remove: ["a.com"], tier: "open" });
    expect(res).toMatchObject({
      ok: true,
      result: {
        policy: { tier: "open", effectiveTier: "open", allowedDomains: ["b.com"] },
      },
    });
    expect(readPolicy(dir).tier).toBe("open");
    expect(detail).toBe("policy remove a.com; tier open by Ada (acc_1) via web, approval apr_1");
  });

  it("tier null follows the org again; isolation may only turn the sandbox on", async () => {
    seed({ tier: "dev" });
    const { res } = await policyOp({ tier: null, isolation: "sandbox" });
    expect(res).toMatchObject({ ok: true, result: { policy: { isolation: "sandbox" } } });
    expect(readPolicy(dir).tier).toBeUndefined();
    expect(JSON.parse(readFileSync(policyPath(dir), "utf8"))).not.toHaveProperty("tier");
    const off = await policyOp({ isolation: "none" });
    expect(off.res).toMatchObject({ ok: false });
  });

  it("under remoteGrants off refuses every widening and changes nothing", async () => {
    seed({ allowedDomains: ["a.com"], remoteGrants: "off" });
    const before = readFileSync(policyPath(dir), "utf8");
    for (const [args, what, message] of [
      [{ add: ["b.com"] }, "add b.com", REMOTE_GRANTS_OFF_MESSAGE],
      [{ tier: "open" }, "tier open", REMOTE_TIER_OFF_MESSAGE],
      // The org's default is not known on the device: a tier when the file has none may widen.
      [{ tier: "dev" }, "tier dev", REMOTE_TIER_OFF_MESSAGE],
      // A request with any widening is refused whole, its narrowing part too.
      [{ add: ["b.com"], remove: ["a.com"] }, "add b.com; remove a.com", REMOTE_GRANTS_OFF_MESSAGE],
      [{ add: ["a.com"] }, "add a.com", REMOTE_GRANTS_OFF_MESSAGE],
    ] as const) {
      const { res, detail } = await policyOp(args);
      expect(res).toEqual({
        type: "res",
        id: "x",
        ok: false,
        error: { kind: "policy", message },
      });
      // The attempt is recorded locally.
      expect(detail).toBe(`policy refused ${what} by Ada (acc_1) via web, approval apr_1`);
    }
    expect(REMOTE_GRANTS_OFF_MESSAGE).toBe(
      "This device does not accept network changes from the deployment; allow it locally: " +
        "capybara-device policy add allowedDomains <host>",
    );
    expect(REMOTE_TIER_OFF_MESSAGE).toBe(
      "This device does not accept a higher tier from the deployment; raise it locally: " +
        "capybara-device policy set tier <tier>",
    );
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
  });

  it("under remoteGrants off refuses a higher tier and the org default over a set tier", async () => {
    seed({ tier: "dev", remoteGrants: "off" });
    const before = readFileSync(policyPath(dir), "utf8");
    for (const tier of ["open", null]) {
      const { res, detail } = await policyOp({ tier });
      expect(res).toMatchObject({
        ok: false,
        error: { kind: "policy", message: REMOTE_TIER_OFF_MESSAGE },
      });
      expect(detail).toMatch(/^policy refused tier (open|org default) by /);
    }
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
    // The same tier, and a lower one, apply.
    expect((await policyOp({ tier: "dev" })).res).toMatchObject({ ok: true });
    const { res, detail } = await policyOp({ tier: "strict" });
    expect(res).toMatchObject({ ok: true, result: { policy: { tier: "strict" } } });
    expect(detail).toBe("policy tier strict by Ada (acc_1) via web, approval apr_1");
    expect(readPolicy(dir).tier).toBe("strict");
  });

  it("under remoteGrants owner applies a higher tier", async () => {
    seed({ tier: "strict" });
    const { res, detail } = await policyOp({ tier: "open" });
    expect(res).toMatchObject({ ok: true, result: { policy: { tier: "open" } } });
    expect(detail).toBe("policy tier open by Ada (acc_1) via web, approval apr_1");
  });

  it("never turns the sandbox off, whatever remoteGrants says and however the op is shaped", async () => {
    seed({ tier: "open" });
    const before = readFileSync(policyPath(dir), "utf8");
    for (const isolation of ["none", "NONE", null, false, "", { none: true }, ["none"]]) {
      const { res, detail } = await policyOp({ isolation });
      expect(res, JSON.stringify(isolation)).toEqual({
        type: "res",
        id: "x",
        ok: false,
        error: { kind: "policy", message: ISOLATION_REMOTE_MESSAGE },
      });
      expect(detail).toMatch(/^policy refused isolation /);
    }
    // Bundled with an allowed change, the whole op is refused.
    const both = await policyOp({ remove: ["a.com"], tier: "strict", isolation: "none" });
    expect(both.res).toMatchObject({ ok: false, error: { message: ISOLATION_REMOTE_MESSAGE } });
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
    expect(readPolicy(dir).isolation).toBe("sandbox");
    expect(ISOLATION_REMOTE_MESSAGE).toBe(
      "This device turns its sandbox off only on the machine itself (capybara-device policy set " +
        'isolation none); the deployment may only set isolation to "sandbox".',
    );
  });

  it("turns the sandbox back on, also under remoteGrants off", async () => {
    seed({ tier: "open", isolation: "none", remoteGrants: "off" });
    const { res, detail } = await policyOp({ isolation: "sandbox" });
    expect(res).toMatchObject({ ok: true, result: { policy: { isolation: "sandbox" } } });
    expect(detail).toBe("policy isolation sandbox by Ada (acc_1) via web, approval apr_1");
    expect(readPolicy(dir).isolation).toBe("sandbox");
  });

  it("any tier change from the deployment turns an unsandboxed device's sandbox back on", async () => {
    for (const [from, to, remoteGrants] of [
      ["open", "dev", "off"],
      ["open", null, "off"],
      ["dev", "open", "owner"],
      [undefined, "open", "owner"],
      ["strict", null, "owner"],
    ] as const) {
      seed({
        ...(from !== undefined && { tier: from }),
        isolation: "none",
        remoteGrants,
      });
      const { res, detail } = await policyOp({ tier: to });
      expect(res, `${from} -> ${to}`).toMatchObject({
        ok: true,
        result: { policy: { isolation: "sandbox" } },
      });
      expect(detail).toBe(
        `policy tier ${to ?? "org default"}; isolation sandbox (tier changed by the deployment) ` +
          "by Ada (acc_1) via web, approval apr_1",
      );
      expect(readPolicy(dir)).toMatchObject({ isolation: "sandbox" });
      if (to === null) expect(readPolicy(dir).tier).toBeUndefined();
      else expect(readPolicy(dir).tier).toBe(to);
    }
  });

  it("the same tier, or no tier change, leaves an unsandboxed device alone", async () => {
    seed({ tier: "open", isolation: "none" });
    for (const args of [{ tier: "open" }, { add: ["b.com"] }, { remove: ["a.com"] }]) {
      const { res } = await policyOp(args);
      expect(res).toMatchObject({ ok: true, result: { policy: { isolation: "none" } } });
    }
    expect(readPolicy(dir)).toMatchObject({ tier: "open", isolation: "none" });
  });

  it("following the org's default from open is never widening", async () => {
    seed({ tier: "open", remoteGrants: "off" });
    const { res } = await policyOp({ tier: null });
    expect(res).toMatchObject({ ok: true });
    expect(readPolicy(dir).tier).toBeUndefined();
  });

  it("refuses an unknown tier with an audit line", async () => {
    const { res, detail } = await policyOp({ tier: "wide" });
    expect(res).toMatchObject({
      ok: false,
      error: { kind: "policy", message: "unknown tier wide" },
    });
    expect(detail).toBe("policy refused tier wide by Ada (acc_1) via web, approval apr_1");
  });

  it("in docker mode refuses added hosts (the container cannot limit single domains), not tiers", async () => {
    seed({ allowedDomains: ["a.com", "b.com"], tier: "dev" });
    const docker = new FakeExecutor();
    (docker as { mode: string }).mode = "docker";
    const before = readFileSync(policyPath(dir), "utf8");
    for (const args of [{ add: ["c.com"] }, { add: ["c.com"], remove: ["a.com"] }]) {
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
    // A tier change follows remoteGrants, and narrowing applies.
    const up = await serveOp(docker, r("policy", { source, tier: "open" }), never, {
      policy: store,
    });
    expect(up.res).toMatchObject({ ok: true, result: { policy: { tier: "open" } } });
    const { res } = await serveOp(
      docker,
      r("policy", { source, remove: ["a.com"], tier: "strict" }),
      never,
      { policy: store },
    );
    expect(res).toMatchObject({
      ok: true,
      result: { policy: { tier: "strict", allowedDomains: ["b.com"] } },
    });
  });

  it("under remoteGrants off always applies narrowing", async () => {
    seed({ allowedDomains: ["a.com", "b.com"], tier: "open", remoteGrants: "off" });
    const { res } = await policyOp({ remove: ["a.com"], tier: "strict" });
    expect(res).toMatchObject({
      ok: true,
      result: { policy: { tier: "strict", allowedDomains: ["b.com"], remoteGrants: "off" } },
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

describe("tiers in the summary and the command log", () => {
  let dir: string;
  const never = new AbortController().signal;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "device-tiers-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withTier = (tier: string, defaultTier?: string) => ({
    ...execArgs("now"),
    limits: {
      ...execArgs("now").limits,
      tier,
      ...(defaultTier !== undefined && { defaultTier }),
      allowUnsandboxed: true,
    },
  });

  it("the summary uses the latest exec's ceiling and default, and the proxy guard", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, tier: "open" });
    const store = new PolicyStore(dir);
    const seen: SeenState = {};
    const ex = new FakeExecutor();
    let proxy = false;
    (ex as { proxyGuard?: () => { detected: boolean; reasons: string[] } }).proxyGuard = () => ({
      detected: proxy,
      reasons: [],
    });
    const ctx = { policy: store, seen, platform: "darwin" as const };
    await serveOp(ex, r("exec", withTier("dev", "strict")), never, ctx);
    expect(seen.limits).toEqual({ tier: "dev", defaultTier: "strict" });
    let { res } = await serveOp(
      ex,
      r("policy", { source: { accountId: "a", accountName: "A", via: "web" } }),
      never,
      ctx,
    );
    expect(res).toMatchObject({
      ok: true,
      result: {
        policy: { tier: "open", effectiveTier: "dev", localhost: "on", unixSockets: "roots" },
      },
    });
    proxy = true;
    ({ res } = await serveOp(
      ex,
      r("policy", { source: { accountId: "a", accountName: "A", via: "web" } }),
      never,
      ctx,
    ));
    expect(res).toMatchObject({ result: { policy: { localhost: "off-proxy-detected" } } });
  });

  it("reports isolation none in OS mode and sandbox in Docker mode", () => {
    const p = { ...DEFAULT_POLICY, tier: "open" as const, isolation: "none" as const };
    const limits = { tier: "open" as const };
    expect(policySummary(p, { mode: "os", limits, platform: "linux" })).toMatchObject({
      effectiveTier: "open",
      isolation: "none",
    });
    expect(policySummary(p, { mode: "docker", limits })).toMatchObject({ isolation: "sandbox" });
  });

  it("the executor runs the decision the log records", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, tier: "open", isolation: "none" });
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
    const out = await serveOp(ex, r("exec", withTier("open")), never, { policy: store });
    expect(out.run).toEqual({ tier: "open", isolation: "none" });
    expect(seenBy).toEqual([{ how: out.run, policy: store.current() }]);
    expect(ex.started).toEqual([]);
  });

  it("every exec is logged with its tier and isolation", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, tier: "open", isolation: "none" });
    const store = new PolicyStore(dir);
    const ex = new FakeExecutor();
    const req = r("exec", withTier("open"));
    const open = await serveOp(ex, req, never, { policy: store });
    expect(open.run).toEqual({ tier: "open", isolation: "none" });
    expect(logEntryFor(req, open.res, new Date(0), open.detail, open.run)).toMatchObject({
      op: "exec",
      tier: "open",
      isolation: "none",
    });
    // Without a tier, the org's default cut to the ceiling.
    writePolicy(dir, DEFAULT_POLICY);
    const dflt = await serveOp(ex, r("exec", withTier("open", "dev")), never, { policy: store });
    expect(dflt.run).toEqual({ tier: "dev", isolation: "sandbox" });
    // A refused exec is logged too, and the executor never sees it.
    writePolicy(dir, { ...DEFAULT_POLICY, tier: "open", isolation: "none" });
    const before = ex.started.length;
    const refused = await serveOp(ex, r("exec", withTier("dev")), never, { policy: store });
    expect(refused.res).toMatchObject({
      ok: false,
      error: { kind: "policy", message: expect.stringContaining("at most the dev tier") },
    });
    expect(refused.run).toMatchObject({ tier: "dev", isolation: "none" });
    expect(ex.started).toHaveLength(before);
    // The kernel does not allow this command to run unsandboxed: refused with its text.
    const notAllowed = withTier("open");
    notAllowed.limits.allowUnsandboxed = false;
    const na = await serveOp(ex, r("exec", notAllowed), never, { policy: store });
    expect(na.res).toMatchObject({
      ok: false,
      error: { kind: "policy", message: UNSANDBOXED_NOT_ALLOWED_MESSAGE },
    });
    expect(na.run).toMatchObject({ tier: "open", isolation: "none" });
    expect(ex.started).toHaveLength(before);
    // Docker mode ignores isolation.
    const docker = new FakeExecutor();
    (docker as { mode: string }).mode = "docker";
    const d = await serveOp(docker, r("exec", withTier("open")), never, { policy: store });
    expect(d.run).toEqual({ tier: "open", isolation: "sandbox" });
  });
});
