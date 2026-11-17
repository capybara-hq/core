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

const report = (sequence: number, over: Record<string, unknown> = {}) =>
  ({
    version: 2,
    revision: `r${sequence}`,
    sequence,
    fullAccess: true,
    restrictedProjectReach: "os-user",
    restrictedAllowedDomains: ["a.test"],
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
    expect(decideOwnerReport(s, report(3, { fullAccess: false }))).toBe("conflict");
    expect(decideOwnerReport(s, report(3, { revision: "other" }))).toBe("conflict");
  });

  it("reads reports first, translates protocol 2 summaries exactly and fails closed", () => {
    expect(ownerFactsOf({ owner_report: stored(report(1, { fullAccess: false })) })).toMatchObject({
      state: "report",
      fullAccess: false,
      restrictedProjectReach: "os-user",
    });
    expect(ownerFactsOf({ local_policy: { mode: "auto", allowedDomains: [] } })).toMatchObject({
      state: "legacy",
      fullAccess: true,
      restrictedProjectReach: "os-user",
    });
    expect(ownerFactsOf({ local_policy: { mode: "sandbox", allowedDomains: [] } })).toMatchObject({
      state: "legacy",
      fullAccess: false,
      restrictedProjectReach: "workspace",
    });
    expect(ownerFactsOf({ owner_report: { junk: true } })).toMatchObject({
      state: "missing",
      fullAccess: false,
    });
    const blocked = { ...stored(report(2)), blocked: { reason: "stale", sequence: 1, at: "x" } };
    expect(ownerFactsOf({ owner_report: blocked })).toMatchObject({
      state: "blocked",
      fullAccess: false,
      restrictedProjectReach: "workspace",
    });
    expect(
      ownerModeOf({
        features: ["mode"],
        local_policy: { mode: "auto", allowedDomains: [] },
        owner_report: stored(report(1, { fullAccess: false })),
      }),
    ).toBe("sandbox");
  });

  it("revokes Full work only on Full removal and restricted work only on what narrows it", () => {
    const facts = (over: Record<string, unknown>) => ownerFactsOfReport(stored(report(1, over)));
    const roots = ["/work"];
    const full = op({ profile: "full-access" } as never);
    expect(
      ownerReportRevokes(
        facts({ restrictedProjectReach: "workspace", restrictedAllowedDomains: [] }),
        full,
        "exec",
        [],
        roots,
      ),
    ).toBe(false);
    expect(ownerReportRevokes(facts({ fullAccess: false }), full, "exec", [], roots)).toBe(true);
    // restricted: hosts removed (unless independently granted), reach narrowed outside the roots
    expect(ownerReportRevokes(facts({ fullAccess: false }), op(), "exec", [], roots)).toBe(false);
    expect(
      ownerReportRevokes(facts({ restrictedAllowedDomains: [] }), op(), "exec", [], roots),
    ).toBe(true);
    expect(
      ownerReportRevokes(facts({ restrictedAllowedDomains: [] }), op(), "exec", ["a.test"], roots),
    ).toBe(false);
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
      ownerReportRevokes(facts({ fullAccess: false }), browse(["/"]), "browse", [], roots),
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
