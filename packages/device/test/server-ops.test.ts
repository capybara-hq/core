import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceOwnerCeiling,
  type KernelReq,
  type KernelRequest,
  POLICY_ADD_REFUSED,
} from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandLog } from "../src/command-log.js";
import type { MacOperationBackend } from "../src/exec/mac-operation-backend.js";
import { PolicyStore } from "../src/policy-store.js";
import {
  ownerCeilingNarrowing,
  policySummary,
  serveOperationV3,
  serveOwnerPolicyV3,
} from "../src/server-ops.js";
import {
  DEFAULT_POLICY,
  FULL_OWNER_CEILING,
  ownerCeilingOfMode,
  type Policy,
  policyLockPath,
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
  version: 3,
  sequence: 0,
  revision: "rev",
  outsideSandbox: false,
  network: "allowlist",
  restrictedProjectReach: "workspace",
  allowedDomains: [],
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
  /** The owner policy op behind the frame parser (a request that bypassed it). */
  const serveOperationPolicyDirect = (args: Record<string, unknown>) =>
    serveOwnerPolicyV3(
      { store, report: () => REPORT, reconcile: async () => {} },
      r("policy", { source, ...args }) as unknown as KernelReq,
      never,
    );

  it("answers unsupported without the owner policy controls", async () => {
    const res = await serveOperationV3(
      {} as MacOperationBackend,
      { id: "dev" },
      r("policy", { source, remove: ["a.com"] }),
      never,
    );
    expect(res).toMatchObject({ ok: false, error: { kind: "unsupported" } });
  });

  it("refuses an add and writes nothing: widening happens only on the machine", async () => {
    seed({ allowedDomains: ["a.com"] });
    const before = readFileSync(policyPath(dir), "utf8");
    for (const args of [
      { add: ["b.com"] },
      { add: [] },
      { add: ["b.com"], remove: ["a.com"] },
      { add: ["b.com"], ownerCeiling: { outsideSandbox: false } },
    ]) {
      const { res } = await policyOp(args);
      expect(res, JSON.stringify(args)).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/widening happens only on the machine/) },
      });
    }
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
    expect(store.current().allowedDomains).toEqual(["a.com"]);
  });

  it("refuses an add that bypassed the frame parser, before anything is written", async () => {
    seed({ allowedDomains: ["a.com"] });
    const before = readFileSync(policyPath(dir), "utf8");
    const res = await serveOperationPolicyDirect({ add: ["b.com"], remove: ["a.com"] });
    expect(res).toMatchObject({
      ok: false,
      error: { kind: "policy", message: POLICY_ADD_REFUSED },
    });
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
  });

  it("removes hosts ignoring case, writes the file and returns the summary", async () => {
    seed({ allowedDomains: ["A.com", "b.com"], allowCredentials: ["GH"] });
    const { res } = await policyOp({ remove: ["a.com"] });
    expect(res).toEqual({
      type: "res",
      id: "x",
      ok: true,
      result: { policy: { allowedDomains: ["b.com"] }, ownerCeiling: REPORT },
    });
    expect(readPolicy(dir)).toMatchObject({ allowedDomains: ["b.com"], allowCredentials: ["GH"] });
    expect(store.current().allowedDomains).toEqual(["b.com"]);
  });

  it("is idempotent", async () => {
    seed({ allowedDomains: ["a.com", "b.com"] });
    await policyOp({ remove: ["a.com"] });
    const { res } = await policyOp({ remove: ["A.COM", "zz.com"] });
    expect(res).toMatchObject({ ok: true, result: { policy: { allowedDomains: ["b.com"] } } });
  });

  it("refuses the protocol 3 mode: protocol 4 narrows through ownerCeiling", async () => {
    seed({ allowedDomains: ["a.com"] });
    const before = readFileSync(policyPath(dir), "utf8");
    for (const mode of ["sandbox", "auto"]) {
      const { res } = await policyOp({ remove: ["a.com"], mode });
      expect(res, mode).toMatchObject({ ok: false });
    }
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
  });

  it("never widens the owner ceiling, whatever the op is shaped like", async () => {
    seed({ mode: "sandbox", allowedDomains: ["a.com"] });
    const before = readFileSync(policyPath(dir), "utf8");
    for (const mode of ["auto", "AUTO", null, false, "", { auto: true }, ["auto"]]) {
      const { res } = await policyOp({ mode });
      expect(res, JSON.stringify(mode)).toMatchObject({ ok: false });
    }
    for (const ownerCeiling of [
      { outsideSandbox: true },
      { network: "open" },
      { restrictedProjectReach: "os-user" },
    ]) {
      const { res } = await policyOp({ ownerCeiling });
      expect(res, JSON.stringify(ownerCeiling)).toMatchObject({ ok: false });
    }
    // Bundled with an allowed change, the whole op is refused.
    const both = await policyOp({ remove: ["a.com"], ownerCeiling: { outsideSandbox: true } });
    expect(both.res).toMatchObject({ ok: false });
    expect(readFileSync(policyPath(dir), "utf8")).toBe(before);
    expect(readPolicy(dir).ownerCeiling.outsideSandbox).toBe(false);
  });

  it("a kernel narrowing op cannot widen: each field only narrows, the network is kept", async () => {
    seed({ allowedDomains: ["a.com", "b.com"] });
    // outside the sandbox off; the network stays open, the reach as it was
    const off = await policyOp({ ownerCeiling: { outsideSandbox: false } });
    expect(off.res).toMatchObject({ ok: true });
    expect(readPolicy(dir).ownerCeiling).toEqual({
      outsideSandbox: false,
      network: "open",
      restrictedProjectReach: "os-user",
    });
    // the network to the allowlist and the reach to the workspace, each on its own
    await policyOp({ ownerCeiling: { network: "allowlist", restrictedProjectReach: "workspace" } });
    expect(readPolicy(dir).ownerCeiling).toEqual({
      outsideSandbox: false,
      network: "allowlist",
      restrictedProjectReach: "workspace",
    });
    // removing hosts through the narrowing
    const removed = await policyOp({ ownerCeiling: { removeAllowedDomains: ["b.com"] } });
    expect(removed.res).toMatchObject({ ok: true });
    expect(readPolicy(dir).allowedDomains).toEqual(["a.com"]);
    // nothing a narrowing says turns a narrowed field back on
    const before = readFileSync(policyPath(dir), "utf8");
    for (const ownerCeiling of [
      // the protocol 3 key is gone, in either direction
      { fullAccess: true },
      { fullAccess: false },
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
      { fullAccess: false },
      { restrictedProjectReach: "os-user" },
      { removeAllowedDomains: "a.com" },
      { removeAllowedDomains: [1] },
      { allowedDomains: ["a.com"] },
      { addAllowedDomains: ["a.com"] },
    ])
      expect(ownerCeilingNarrowing(widening), JSON.stringify(widening)).toBeUndefined();
  });

  it("validates every host to remove", async () => {
    for (const bad of [
      "10.0.0.1",
      "intranet",
      "a.local",
      "https://a.com",
      "a.com:443",
      "",
      "a\nb.com",
    ]) {
      const { res } = await policyOp({ remove: [bad] });
      expect(res, JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(store.current().allowedDomains).toEqual([]);
  });

  it("removes a wildcard covering a whole public suffix", async () => {
    seed({ allowedDomains: ["*.co.uk"] });
    const page = await serve(
      r("policy", {
        source: { accountId: "acc_1", accountName: "Ada", via: "web" },
        remove: ["*.co.uk"],
      }),
    );
    expect(page.res).toMatchObject({ ok: true, result: { policy: { allowedDomains: [] } } });
  });

  it("writes under policy.json.lock: a held lock fails the op without writing", async () => {
    writeFileSync(policyLockPath(dir), String(process.pid));
    const { res } = await policyOp({ remove: ["a.com"] });
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
  it("reports the sandbox allowlist only, on the machine and in a container", () => {
    expect(
      policySummary({ ...FULL_POLICY, ownerCeiling: ownerCeilingOfMode("auto") }, { mode: "os" }),
    ).toEqual({ allowedDomains: [] });
    expect(
      policySummary(
        { ...FULL_POLICY, ownerCeiling: ownerCeilingOfMode("sandbox") },
        { mode: "docker" },
      ),
    ).toEqual({ allowedDomains: [] });
  });
});
