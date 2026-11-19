import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceOwnerCeiling, KernelRequest } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandLog } from "../src/command-log.js";
import type { MacOperationBackend } from "../src/exec/mac-operation-backend.js";
import { PolicyStore } from "../src/policy-store.js";
import { ownerCeilingNarrowing, policySummary, serveOperationV3 } from "../src/server-ops.js";
import {
  DEFAULT_POLICY,
  FULL_OWNER_CEILING,
  ownerCeilingOfMode,
  type Policy,
  policyLockPath,
  policyMode,
  policyPath,
  readPolicy,
  writePolicy,
} from "../src/state.js";

/** The policy these tests were written against: outside the sandbox on, the open network. */
const FULL_POLICY = { ...DEFAULT_POLICY, ownerCeiling: { ...FULL_OWNER_CEILING } };
let opSeq = 0;
/** A request; a `policy` op gets a fresh op id unless it names one (each is a new change). */
const r = (op: string, args: unknown) =>
  ({
    type: "req",
    id: "x",
    op,
    args:
      op === "policy" && typeof args === "object" && args !== null && !("opId" in args)
        ? { opId: `op_${++opSeq}`, ...args }
        : args,
    deadlineMs: 1000,
  }) as KernelRequest;
/** A valid owner report; its content is not what these tests are about. */
const REPORT: DeviceOwnerCeiling = {
  version: 2,
  sequence: 0,
  revision: "rev",
  fullAccess: false,
  restrictedProjectReach: "workspace",
  restrictedAllowedDomains: [],
};

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

  const seed = (over: Partial<Policy> & { mode?: "auto" | "sandbox" }) => {
    const { mode, ...rest } = over;
    writePolicy(dir, {
      ...FULL_POLICY,
      ...rest,
      ...(mode !== undefined && { ownerCeiling: ownerCeilingOfMode(mode) }),
    });
  };
  /** Served by the device's one dispatch, with the owner policy controls. */
  const serve = async (req: KernelRequest) => ({
    res: await serveOperationV3({} as MacOperationBackend, { id: "dev" }, req, never, undefined, {
      store,
      report: () => REPORT,
      reconcile: async () => {},
    }),
  });
  const policyOp = (args: Record<string, unknown>) => serve(r("policy", { source, ...args }));

  it("answers unsupported without the owner policy controls", async () => {
    const res = await serveOperationV3(
      {} as MacOperationBackend,
      { id: "dev" },
      r("policy", { source, add: ["a.com"] }),
      never,
    );
    expect(res).toMatchObject({ ok: false, error: { kind: "unsupported" } });
  });

  it("adds a host, writes the file and returns the summary", async () => {
    seed({ allowedDomains: ["a.com"], allowCredentials: ["GH"] });
    const { res } = await policyOp({ add: ["Files.Slack.com"] });
    expect(res).toEqual({
      type: "res",
      id: "x",
      ok: true,
      result: {
        policy: { mode: "auto", allowedDomains: ["a.com", "files.slack.com"] },
        ownerCeiling: REPORT,
      },
    });
    expect(readPolicy(dir)).toMatchObject({
      allowedDomains: ["a.com", "files.slack.com"],
      allowCredentials: ["GH"],
    });
    expect(store.current().allowedDomains).toEqual(["a.com", "files.slack.com"]);
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
    const { res } = await policyOp({ remove: ["a.com"], mode: "sandbox" });
    expect(res).toMatchObject({
      ok: true,
      result: { policy: { mode: "sandbox", allowedDomains: ["b.com"] } },
    });
    expect(policyMode(readPolicy(dir))).toBe("sandbox");
  });

  it("never widens the owner ceiling, whatever the op is shaped like", async () => {
    seed({ mode: "sandbox", allowedDomains: ["a.com"] });
    const before = readFileSync(policyPath(dir), "utf8");
    for (const mode of ["auto", "AUTO", null, false, "", { auto: true }, ["auto"]]) {
      const { res } = await policyOp({ mode });
      expect(res, JSON.stringify(mode)).toMatchObject({ ok: false });
    }
    for (const ownerCeiling of [{ fullAccess: true }, { restrictedProjectReach: "os-user" }]) {
      const { res } = await policyOp({ ownerCeiling });
      expect(res, JSON.stringify(ownerCeiling)).toMatchObject({ ok: false });
    }
    // Bundled with an allowed change, the whole op is refused.
    const both = await policyOp({ remove: ["a.com"], add: ["b.com"], mode: "auto" });
    expect(both.res).toMatchObject({ ok: false });
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
    expect(policyMode(readPolicy(dir))).toBe("sandbox");
  });

  it("a kernel narrowing op cannot widen: each field only narrows, the network is kept", async () => {
    seed({ allowedDomains: ["a.com", "b.com"] });
    // protocol 3: Full access off is outside the sandbox off; the network stays open
    const off = await policyOp({ ownerCeiling: { fullAccess: false } });
    expect(off.res).toMatchObject({ ok: true });
    expect(readPolicy(dir).ownerCeiling).toEqual({
      outsideSandbox: false,
      network: "open",
      restrictedProjectReach: "os-user",
    });
    // protocol 2's mode sandbox: no escalation and the workspace reach, the network kept
    seed({ allowedDomains: ["a.com"] });
    await policyOp({ mode: "sandbox" });
    expect(readPolicy(dir).ownerCeiling).toEqual({
      outsideSandbox: false,
      network: "open",
      restrictedProjectReach: "workspace",
    });
    // nothing a narrowing says turns a narrowed field back on
    seed({
      ownerCeiling: {
        outsideSandbox: false,
        network: "allowlist",
        restrictedProjectReach: "workspace",
      },
    });
    const before = readFileSync(policyPath(dir), "utf8");
    for (const ownerCeiling of [
      { fullAccess: true },
      { outsideSandbox: true },
      { network: "open" },
      { restrictedProjectReach: "os-user" },
      { addAllowedDomains: ["c.com"] },
    ]) {
      const { res } = await policyOp({ ownerCeiling });
      expect(res, JSON.stringify(ownerCeiling)).toMatchObject({ ok: false });
    }
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
  });

  it("reads the protocol 4 narrowing fields as narrowings only", () => {
    expect(
      ownerCeilingNarrowing({
        outsideSandbox: false,
        network: "allowlist",
        removeAllowedDomains: ["A.com", "a.com"],
        restrictedProjectReach: "workspace",
      }),
    ).toEqual({
      outsideSandboxOff: true,
      networkAllowlist: true,
      workspaceReach: true,
      removeAllowedDomains: ["a.com"],
    });
    expect(ownerCeilingNarrowing(undefined)).toEqual({
      outsideSandboxOff: false,
      networkAllowlist: false,
      workspaceReach: false,
      removeAllowedDomains: [],
    });
    for (const widening of [
      null,
      [],
      "allowlist",
      { outsideSandbox: true },
      { outsideSandbox: "false" },
      { network: "open" },
      { network: null },
      { fullAccess: true },
      { restrictedProjectReach: "os-user" },
      { removeAllowedDomains: "a.com" },
      { removeAllowedDomains: [1] },
      { allowedDomains: ["a.com"] },
      { addAllowedDomains: ["a.com"] },
    ])
      expect(ownerCeilingNarrowing(widening), JSON.stringify(widening)).toBeUndefined();
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
        expect(res, `${key} ${JSON.stringify(bad)}`).toMatchObject({ ok: false });
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
    const page = await serve(
      r("policy", {
        source: { accountId: "acc_1", accountName: "Ada", via: "web" },
        add: ["*.slack.com"],
      }),
    );
    expect(page.res).toMatchObject({
      ok: true,
      result: { policy: { allowedDomains: ["*.slack.com"] } },
    });
  });

  it("refuses a page wildcard covering a whole public suffix; removing one is fine", async () => {
    const page = (args: Record<string, unknown>) =>
      serve(
        r("policy", { source: { accountId: "acc_1", accountName: "Ada", via: "web" }, ...args }),
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

describe("the policy summary", () => {
  it("reports the owner's mode, on the machine and in a container", () => {
    expect(
      policySummary({ ...FULL_POLICY, ownerCeiling: ownerCeilingOfMode("auto") }, { mode: "os" }),
    ).toEqual({ mode: "auto", allowedDomains: [] });
    expect(
      policySummary(
        { ...FULL_POLICY, ownerCeiling: ownerCeilingOfMode("sandbox") },
        { mode: "docker" },
      ),
    ).toEqual({ mode: "sandbox", allowedDomains: [] });
  });
});
