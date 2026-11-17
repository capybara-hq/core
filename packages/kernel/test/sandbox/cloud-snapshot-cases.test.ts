import { describe, expect, it } from "vitest";
import {
  cloudChosenMode,
  cloudSnapshotOf,
  type DeploymentDevicePolicy,
  effectiveDevicePolicy,
  intersectNetworks,
  type OrgDeviceSettings,
  sameAppliedExactly,
} from "../../src/sandbox/modes.js";

/** B1: the cloud snapshot is computed from the OLD effective authority, never from one field. */
const platform = (
  fullAccess: "allowed" | "off" = "allowed",
  egress: "none" | "allowlist" = "allowlist",
): DeploymentDevicePolicy => ({
  fullAccess,
  limits: { egress, allowHosts: ["a.example", "b.example"], orgHosts: "extend" },
});
const OPEN: OrgDeviceSettings = {};
const LIST: OrgDeviceSettings = { cloudNetwork: { mode: "allowlist" } };
const EMPTY: OrgDeviceSettings = { cloudNetwork: { mode: "allowlist", base: "none" } };
const snapshot = (d: DeploymentDevicePolicy, o: OrgDeviceSettings, mode: "sandbox" | null) =>
  cloudSnapshotOf(effectiveDevicePolicy(d, o, mode));

describe("cloudSnapshotOf (old effective authority -> owner ceiling + outer network)", () => {
  it("old auto -> Full on the open public network", () => {
    expect(snapshot(platform(), OPEN, null)).toEqual({
      fullAccess: true,
      outerNetwork: { kind: "open-public", hosts: [] },
    });
  });
  it("old auto under egress:none -> Full on an empty allowlist", () => {
    expect(snapshot(platform("allowed", "none"), OPEN, null)).toEqual({
      fullAccess: true,
      outerNetwork: { kind: "allowlist", hosts: [] },
    });
  });
  it("old sandbox on the open network (platform off, org open) -> restricted, open-public", () => {
    expect(snapshot(platform("off"), OPEN, null)).toEqual({
      fullAccess: false,
      outerNetwork: { kind: "open-public", hosts: [] },
    });
    // the device's own narrowing switch is part of the old effective authority too
    expect(snapshot(platform(), OPEN, "sandbox").fullAccess).toBe(false);
    expect(snapshot(platform(), { fullAccess: "off" }, null).fullAccess).toBe(false);
  });
  it("old sandbox on an allowlist -> restricted, the exact list", () => {
    expect(snapshot(platform("off"), LIST, null)).toEqual({
      fullAccess: false,
      outerNetwork: { kind: "allowlist", hosts: ["a.example", "b.example"] },
    });
  });
  it("old sandbox on an empty allowlist or egress:none -> restricted, empty", () => {
    const empty = { fullAccess: false, outerNetwork: { kind: "allowlist", hosts: [] } };
    expect(snapshot(platform("off"), EMPTY, null)).toEqual(empty);
    expect(snapshot(platform("off", "none"), OPEN, null)).toEqual(empty);
  });
  it("known applied limits narrow the snapshot, never widen it", () => {
    const old = effectiveDevicePolicy(platform(), OPEN, null);
    expect(
      cloudSnapshotOf(old, {
        mode: "sandbox",
        network: { kind: "allowlist", hosts: ["a.example"] },
      }),
    ).toEqual({ fullAccess: false, outerNetwork: { kind: "allowlist", hosts: ["a.example"] } });
    const listed = effectiveDevicePolicy(platform("off"), LIST, null);
    expect(
      cloudSnapshotOf(listed, { mode: "auto", network: { kind: "open-public", hosts: [] } }),
    ).toEqual({
      fullAccess: false,
      outerNetwork: { kind: "allowlist", hosts: ["a.example", "b.example"] },
    });
  });
});

describe("the snapshot as a later ceiling", () => {
  it("an explicit false stays restricted after the platform and the org widen", () => {
    const chosen = cloudChosenMode({ mode: null, owner_full_access: false });
    expect(effectiveDevicePolicy(platform(), { fullAccess: "allowed" }, chosen).mode).toBe(
      "sandbox",
    );
    // an explicit sandbox switch (an old replica's PATCH included) is never overridden
    expect(cloudChosenMode({ mode: "sandbox", owner_full_access: true })).toBe("sandbox");
    expect(cloudChosenMode({ mode: null, owner_full_access: true })).toBeNull();
    expect(cloudChosenMode({ mode: "sandbox", owner_full_access: null })).toBe("sandbox");
  });
  it("the outer network caps a later widening; a later narrowing still applies", () => {
    const outer = { kind: "allowlist" as const, hosts: ["a.example"] };
    expect(effectiveDevicePolicy(platform(), OPEN, null, outer).network).toEqual(outer);
    expect(effectiveDevicePolicy(platform("allowed", "none"), OPEN, null, outer).network).toEqual({
      kind: "allowlist",
      hosts: [],
    });
  });
  it("intersects wildcards both ways and compares host sets exactly", () => {
    expect(
      intersectNetworks(
        { kind: "allowlist", hosts: ["*.x.com", "a.example"] },
        { kind: "allowlist", hosts: ["api.x.com", "B.example"] },
      ),
    ).toEqual({ kind: "allowlist", hosts: ["api.x.com"] });
    const a = {
      mode: "sandbox" as const,
      network: { kind: "allowlist" as const, hosts: ["b", "a"] },
    };
    expect(
      sameAppliedExactly(a, { mode: "sandbox", network: { kind: "allowlist", hosts: ["a", "b"] } }),
    ).toBe(true);
    expect(
      sameAppliedExactly(a, { mode: "sandbox", network: { kind: "allowlist", hosts: ["a"] } }),
    ).toBe(false);
    expect(sameAppliedExactly(null, a)).toBe(false);
  });
});
