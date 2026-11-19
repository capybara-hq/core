import type { SandboxBrowseScope, SandboxOperationScope } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  decideOwnerReport,
  ownerFactsOf,
  ownerFactsOfReport,
  ownerModeOf,
  ownerReportRevokes,
  type StoredOwnerReport,
} from "../../src/local-devices/owner-report.js";
import { ownerPolicyRevokes } from "../../src/local-devices/policy-summary.js";
import {
  needsFullCeiling,
  needsWiderDeviceCeiling,
} from "../../src/sandbox/permission-ceiling-writes.js";

const report = (sequence: number, over: Record<string, unknown> = {}) =>
  ({
    version: 3,
    revision: `r${sequence}`,
    sequence,
    outsideSandbox: true,
    network: "open",
    restrictedProjectReach: "os-user",
    allowedDomains: ["a.test"],
    ...over,
  }) as StoredOwnerReport["report"];
const stored = (r: StoredOwnerReport["report"]): StoredOwnerReport => ({
  report: r,
  connectionId: "c",
  observedAt: "2026-11-17T00:00:00.000Z",
  via: "hello",
});
const op = (over: Partial<SandboxOperationScope> = {}) =>
  ({
    profile: "approve-for-me",
    filesystem: { kind: "scoped", readRoots: ["/work"], writeRoots: ["/work"] },
    network: { kind: "allowlist", hosts: ["a.test"] },
    ...over,
  }) as SandboxOperationScope;
const browse = (readRoots: string[]) => ({ readRoots }) as unknown as SandboxBrowseScope;

describe("owner report ordering (B2)", () => {
  it("records higher, repeats same, refuses lower and same-sequence different bytes", () => {
    const s = stored(report(3));
    expect(decideOwnerReport(null, report(0))).toBe("record");
    expect(decideOwnerReport(s, report(4))).toBe("record");
    expect(decideOwnerReport(s, report(3))).toBe("same");
    expect(decideOwnerReport(s, report(2))).toBe("stale");
    expect(decideOwnerReport(s, report(3, { outsideSandbox: false }))).toBe("conflict");
    expect(decideOwnerReport(s, report(3, { revision: "other" }))).toBe("conflict");
  });

  it("reads only the report and fails closed without one", () => {
    expect(
      ownerFactsOf({ owner_report: stored(report(1, { outsideSandbox: false })) }),
    ).toMatchObject({
      state: "report",
      fullAccess: false,
      restrictedProjectReach: "os-user",
      restrictedAllowedDomains: ["a.test"],
      network: "open",
    });
    // protocol 4 has no legacy owner state: no report is missing (the summary's mode is gone)
    expect(ownerFactsOf({})).toMatchObject({
      state: "missing",
      fullAccess: false,
      restrictedProjectReach: "workspace",
      network: "allowlist",
    });
    expect(ownerFactsOf({ owner_report: { junk: true } })).toMatchObject({
      state: "missing",
      fullAccess: false,
    });
    // a protocol 3 (version 2) report is not readable: missing, fail closed
    const v2 = {
      ...stored(report(1)),
      report: {
        version: 2,
        revision: "r1",
        sequence: 1,
        fullAccess: true,
        restrictedProjectReach: "os-user",
        restrictedAllowedDomains: [],
      },
    };
    expect(ownerFactsOf({ owner_report: v2 })).toMatchObject({
      state: "missing",
      fullAccess: false,
    });
    const blocked = { ...stored(report(2)), blocked: { reason: "stale", sequence: 1, at: "x" } };
    expect(ownerFactsOf({ owner_report: blocked })).toMatchObject({
      state: "blocked",
      fullAccess: false,
      restrictedProjectReach: "workspace",
    });
    expect(ownerModeOf({ owner_report: stored(report(1, { outsideSandbox: false })) })).toBe(
      "sandbox",
    );
    expect(ownerModeOf({ owner_report: stored(report(1)) })).toBe("auto");
    expect(ownerModeOf({})).toBe("sandbox");
  });

  it("revokes Full work only on Full removal and restricted work only on what narrows it", () => {
    const facts = (over: Record<string, unknown>) => ownerFactsOfReport(stored(report(1, over)));
    const roots = ["/work"];
    // full execution is the scope's reach (Full access, or an escalated call under its profile)
    const full = op({
      profile: "full-access",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    } as never);
    expect(
      ownerReportRevokes(
        facts({ restrictedProjectReach: "workspace", allowedDomains: [] }),
        full,
        "exec",
        [],
        roots,
      ),
    ).toBe(false);
    expect(ownerReportRevokes(facts({ outsideSandbox: false }), full, "exec", [], roots)).toBe(
      true,
    );
    // restricted: hosts removed (unless independently granted), reach narrowed outside the roots
    expect(ownerReportRevokes(facts({ outsideSandbox: false }), op(), "exec", [], roots)).toBe(
      false,
    );
    expect(ownerReportRevokes(facts({ allowedDomains: [] }), op(), "exec", [], roots)).toBe(true);
    expect(ownerReportRevokes(facts({ allowedDomains: [] }), op(), "exec", ["a.test"], roots)).toBe(
      false,
    );
    const outside = op({
      filesystem: { kind: "scoped", readRoots: ["/home/o/p"], writeRoots: ["/home/o/p"] },
    } as never);
    expect(ownerReportRevokes(facts({}), outside, "readFile", [], roots)).toBe(false);
    expect(
      ownerReportRevokes(
        facts({ restrictedProjectReach: "workspace" }),
        outside,
        "readFile",
        [],
        roots,
      ),
    ).toBe(true);
    expect(
      ownerReportRevokes(facts({ outsideSandbox: false }), browse(["/"]), "browse", [], roots),
    ).toBe(false);
    expect(
      ownerReportRevokes(
        facts({ restrictedProjectReach: "workspace" }),
        browse(["/"]),
        "browse",
        [],
        roots,
      ),
    ).toBe(true);
  });
});

describe("the owner's sandbox network", () => {
  const facts = (over: Record<string, unknown>) => ownerFactsOfReport(stored(report(1, over)));
  const open = op({ profile: "full-access", network: { kind: "open-public" } } as never);
  it("narrowing to the allowlist revokes open-network executions, under every profile", () => {
    expect(ownerReportRevokes(facts({ network: "allowlist" }), open, "exec", [], ["/work"])).toBe(
      true,
    );
    expect(ownerReportRevokes(facts({ network: "open" }), open, "exec", [], ["/work"])).toBe(false);
    // a sandboxed Full access call is not running outside the sandbox
    expect(ownerReportRevokes(facts({ outsideSandbox: false }), open, "exec", [], ["/work"])).toBe(
      false,
    );
  });
});

describe("a running per-call sandbox escalation loses to every Full ceiling turning off", () => {
  // an escalated call keeps its restricted profile; its reach is full (device, environment)
  const escalated = op({
    profile: "request-approval",
    filesystem: { kind: "device" },
    network: { kind: "environment" },
  } as never);
  const facts = (over: Record<string, unknown>) => ownerFactsOfReport(stored(report(1, over)));

  it.each(["exec", "backgroundStart"])(
    "the owner ceiling dropping Full revokes its %s",
    (method) => {
      expect(
        ownerReportRevokes(facts({ outsideSandbox: false }), escalated, method, [], ["/work"]),
      ).toBe(true);
      expect(ownerReportRevokes(facts({}), escalated, method, [], ["/work"])).toBe(false);
    },
  );

  it("a summary (allowlist only) leaves it to the owner report's writer", () => {
    // protocol 4 summaries carry no mode: dropping Full is the owner report's change (above)
    expect(ownerPolicyRevokes({ allowedDomains: [] }, escalated, "exec", [])).toBe(false);
    expect(ownerPolicyRevokes(null, escalated, "exec", [])).toBe(true);
  });

  it("the org and platform writers' selectors take it (Full execution needs the Full ceiling)", () => {
    expect(needsFullCeiling(escalated)).toBe(true);
    expect(needsWiderDeviceCeiling(escalated, ["/work"])).toBe(true);
    expect(needsFullCeiling(op())).toBe(false);
  });
});
