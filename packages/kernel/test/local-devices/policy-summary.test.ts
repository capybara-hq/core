import { describe, expect, it } from "vitest";
import {
  deviceFeaturesOf,
  localPolicyOf,
  opExplainsOwnerChange,
  type PendingPolicyOp,
  pendingPolicyOpsOf,
} from "../../src/local-devices/policy-summary.js";

/**
 * The local policy summary the kernel keeps from a device's hello or `policy` op (auto mode spec
 * §4.1): the device is the authority, so the kernel keeps what it reads and never throws over it.
 */
describe("localPolicyOf", () => {
  it("keeps the mode and the allowlist, and nothing else a device reports", () => {
    expect(
      localPolicyOf({
        mode: "auto",
        allowedDomains: ["a.com"],
        projects: [{ name: "core", path: "/w/core" }],
      }),
    ).toEqual({ mode: "auto", allowedDomains: ["a.com"] });
  });

  it("refuses a summary without a valid mode or allowlist", () => {
    expect(localPolicyOf({ mode: "open", allowedDomains: [] })).toBeNull();
    expect(localPolicyOf({ mode: "sandbox", allowedDomains: [1] })).toBeNull();
    expect(localPolicyOf(null)).toBeNull();
  });
});

describe("deviceFeaturesOf", () => {
  it("knows the projects feature", () => {
    expect(deviceFeaturesOf(["projects", "mode", "teleport"])).toEqual(["mode", "projects"]);
  });
});

describe("opExplainsOwnerChange (a v3 owner report the platform's narrowing op explains)", () => {
  const op = (ownerCeiling?: PendingPolicyOp["ownerCeiling"]): PendingPolicyOp => ({
    id: "op",
    add: [],
    remove: [],
    ...(ownerCeiling && { ownerCeiling }),
    source: { accountId: "a", via: "web", approvalId: null },
    status: "sent",
    sentAt: 0,
    resolveAt: 0,
    until: 0,
  });
  const facts = (fullAccess: boolean, restrictedProjectReach: "workspace" | "os-user") => ({
    fullAccess,
    restrictedProjectReach,
  });

  it("explains exactly the narrowing the op asked for", () => {
    const full = op({ fullAccess: false });
    expect(opExplainsOwnerChange(full, facts(true, "os-user"), facts(false, "os-user"))).toBe(true);
    // the reach changed too, which this op did not ask for
    expect(opExplainsOwnerChange(full, facts(true, "os-user"), facts(false, "workspace"))).toBe(
      false,
    );
    const both = op({ fullAccess: false, restrictedProjectReach: "workspace" });
    expect(opExplainsOwnerChange(both, facts(true, "os-user"), facts(false, "workspace"))).toBe(
      true,
    );
    const reach = op({ restrictedProjectReach: "workspace" });
    expect(opExplainsOwnerChange(reach, facts(true, "os-user"), facts(true, "workspace"))).toBe(
      true,
    );
  });

  it("never explains a widening, an op without a narrowing, or no change", () => {
    expect(
      opExplainsOwnerChange(
        op({ fullAccess: false }),
        facts(false, "os-user"),
        facts(true, "os-user"),
      ),
    ).toBe(false);
    expect(opExplainsOwnerChange(op(), facts(true, "os-user"), facts(false, "os-user"))).toBe(
      false,
    );
    expect(
      opExplainsOwnerChange(
        op({ fullAccess: false }),
        facts(true, "os-user"),
        facts(true, "os-user"),
      ),
    ).toBe(false);
  });

  it("keeps a stored op's narrowing and drops anything wider", () => {
    const base = {
      id: "op",
      add: [],
      remove: [],
      source: { accountId: "a", via: "web", approvalId: null },
      status: "sent",
      sentAt: 0,
      resolveAt: 0,
      until: 1,
    };
    expect(
      pendingPolicyOpsOf([
        { ...base, ownerCeiling: { fullAccess: false, restrictedProjectReach: "workspace" } },
      ])[0]?.ownerCeiling,
    ).toEqual({ fullAccess: false, restrictedProjectReach: "workspace" });
    expect(
      pendingPolicyOpsOf([
        { ...base, ownerCeiling: { fullAccess: true, restrictedProjectReach: "os-user" } },
      ])[0]?.ownerCeiling,
    ).toBeUndefined();
  });
});
