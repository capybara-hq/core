import { describe, expect, it } from "vitest";
import {
  DeviceProtocolError,
  parseOwnerCeilingNarrowingV3,
  parseOwnerCeilingReportV3,
  parseSandboxPermissionSupportV2,
} from "../src/index.js";

const RESTRICTED = { filesystem: true, network: true, native: true, concurrentScopes: true };

const operationSupport = () => ({
  version: 2,
  boundary: "operation",
  restricted: { ...RESTRICTED },
  network: { openPublic: true, allowlist: true, perOperationHosts: true },
  outsideSandbox: true,
  background: true,
});

const instanceSupport = () => ({
  version: 2,
  boundary: "instance",
  restricted: null,
  network: { openPublic: true, allowlist: true, perOperationHosts: false },
  outsideSandbox: false,
  background: true,
});

describe("parseSandboxPermissionSupportV2", () => {
  it("accepts an operation-boundary and an instance-boundary report and freezes a copy", () => {
    for (const make of [operationSupport, instanceSupport]) {
      const input = make();
      const parsed = parseSandboxPermissionSupportV2(input);
      expect(parsed).toEqual(make());
      input.network.openPublic = false;
      expect(parsed.network.openPublic).toBe(true);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.network)).toBe(true);
    }
    expect(
      parseSandboxPermissionSupportV2({
        ...operationSupport(),
        restricted: null,
        network: { openPublic: false, allowlist: false, perOperationHosts: false },
        outsideSandbox: false,
        unavailableReason: "the OS sandbox is not installed",
      }).unavailableReason,
    ).toBe("the OS sandbox is not installed");
  });

  it.each([
    ["version 1", { version: 1 }],
    ["unknown boundary", { boundary: "process" }],
    ["v1 fullAccess field", { fullAccess: true }],
    ["unknown field", { extra: true }],
    ["incomplete restricted claim", { restricted: { ...RESTRICTED, native: false } }],
    ["restricted extra claim", { restricted: { ...RESTRICTED, more: true } }],
    ["restricted missing claim", { restricted: { filesystem: true, network: true, native: true } }],
    ["missing network", { network: undefined }],
    [
      "network not booleans",
      { network: { openPublic: 1, allowlist: true, perOperationHosts: true } },
    ],
    [
      "network unknown field",
      { network: { openPublic: true, allowlist: true, perOperationHosts: true, lan: true } },
    ],
    [
      "per-operation hosts without the allowlist",
      { network: { openPublic: true, allowlist: false, perOperationHosts: true } },
    ],
    ["outsideSandbox not a boolean", { outsideSandbox: "yes" }],
    ["background missing", { background: undefined }],
    ["empty unavailable reason", { unavailableReason: "" }],
    ["overlong unavailable reason", { unavailableReason: "x".repeat(4097) }],
  ])("rejects %s", (_name, patch) => {
    const value: Record<string, unknown> = { ...operationSupport(), ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete value[k];
    expect(() => parseSandboxPermissionSupportV2(value)).toThrow(DeviceProtocolError);
  });

  it.each([
    ["a restricted claim", { restricted: { ...RESTRICTED } }],
    ["outside-sandbox escalation", { outsideSandbox: true }],
    [
      "per-operation hosts",
      { network: { openPublic: true, allowlist: true, perOperationHosts: true } },
    ],
  ])("rejects an instance boundary claiming %s", (_name, patch) => {
    expect(() => parseSandboxPermissionSupportV2({ ...instanceSupport(), ...patch })).toThrow(
      DeviceProtocolError,
    );
  });

  it.each([
    ["the open network", { openPublic: true, allowlist: false, perOperationHosts: false }],
    ["the allowlist", { openPublic: false, allowlist: true, perOperationHosts: false }],
    ["per-operation hosts", { openPublic: false, allowlist: true, perOperationHosts: true }],
  ])("rejects an operation boundary without restricted support claiming %s", (_name, network) => {
    expect(() =>
      parseSandboxPermissionSupportV2({ ...operationSupport(), restricted: null, network }),
    ).toThrow(DeviceProtocolError);
  });

  it("rejects non-plain objects and accessors", () => {
    for (const bad of [null, [], "x", 1, new (class Report {})()])
      expect(() => parseSandboxPermissionSupportV2(bad)).toThrow(DeviceProtocolError);
    const tricky = operationSupport();
    let reads = 0;
    Object.defineProperty(tricky, "outsideSandbox", {
      enumerable: true,
      get: () => reads++ === 0,
    });
    expect(() => parseSandboxPermissionSupportV2(tricky)).toThrow(DeviceProtocolError);
  });
});

const ceiling = () => ({
  version: 3,
  sequence: 4,
  revision: "rev-4",
  outsideSandbox: false,
  network: "open",
  allowedDomains: ["example.com", "*.example.org"],
  restrictedProjectReach: "workspace",
});

describe("parseOwnerCeilingReportV3", () => {
  it("accepts both network modes and freezes a copy", () => {
    const input = ceiling();
    const parsed = parseOwnerCeilingReportV3(input);
    expect(parsed).toEqual(ceiling());
    input.allowedDomains.push("evil.example");
    expect(parsed.allowedDomains).toEqual(["example.com", "*.example.org"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.allowedDomains)).toBe(true);
    expect(
      parseOwnerCeilingReportV3({
        ...ceiling(),
        network: "allowlist",
        allowedDomains: [],
        outsideSandbox: true,
        restrictedProjectReach: "os-user",
      }).network,
    ).toBe("allowlist");
  });

  it.each([
    ["version 2", { version: 2 }],
    ["the v2 fullAccess field", { fullAccess: false }],
    ["the v2 domain field", { restrictedAllowedDomains: [] }],
    ["unknown network", { network: "open-public" }],
    ["missing network", { network: undefined }],
    ["outsideSandbox not a boolean", { outsideSandbox: "off" }],
    ["unknown reach", { restrictedProjectReach: "device" }],
    ["negative sequence", { sequence: -1 }],
    ["fractional sequence", { sequence: 1.5 }],
    ["empty revision", { revision: "" }],
    ["overlong revision", { revision: "r".repeat(513) }],
    ["a URL host", { allowedDomains: ["https://example.com"] }],
    ["a loopback host", { allowedDomains: ["127.0.0.1"] }],
    ["too many hosts", { allowedDomains: Array(101).fill("example.com") }],
    ["hosts not an array", { allowedDomains: "example.com" }],
    ["unknown field", { extra: 1 }],
  ])("rejects %s", (_name, patch) => {
    const value: Record<string, unknown> = { ...ceiling(), ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete value[k];
    expect(() => parseOwnerCeilingReportV3(value)).toThrow(DeviceProtocolError);
  });
});

describe("parseOwnerCeilingNarrowingV3", () => {
  it("accepts every narrowing, alone and together, and freezes a copy", () => {
    for (const narrowing of [
      {},
      { outsideSandbox: false },
      { network: "allowlist" },
      { removeAllowedDomains: ["example.com"] },
      { removeAllowedDomains: [] },
      { restrictedProjectReach: "workspace" },
      {
        outsideSandbox: false,
        network: "allowlist",
        removeAllowedDomains: ["example.com", "*.example.org"],
        restrictedProjectReach: "workspace",
      },
    ]) {
      const parsed = parseOwnerCeilingNarrowingV3(narrowing);
      expect(parsed).toEqual(narrowing);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
  });

  // Each field can only narrow: the widening value of every field, and every way to add hosts.
  it.each([
    ["outsideSandbox on", { outsideSandbox: true }],
    ["network open", { network: "open" }],
    ["network unknown", { network: "none" }],
    ["reach widened", { restrictedProjectReach: "os-user" }],
    ["hosts replaced", { allowedDomains: ["example.com"] }],
    ["hosts added", { addAllowedDomains: ["example.com"] }],
    ["removal not an array", { removeAllowedDomains: "example.com" }],
    ["removal of an invalid host", { removeAllowedDomains: ["https://example.com"] }],
    ["removal too long", { removeAllowedDomains: Array(101).fill("example.com") }],
    ["the v2 fullAccess field", { fullAccess: false }],
    ["a revision", { revision: "r" }],
    ["null field", { network: null }],
  ])("rejects %s", (_name, narrowing) => {
    expect(() => parseOwnerCeilingNarrowingV3(narrowing)).toThrow(DeviceProtocolError);
  });

  it("rejects non-objects", () => {
    for (const bad of [null, [], "allowlist", false])
      expect(() => parseOwnerCeilingNarrowingV3(bad)).toThrow(DeviceProtocolError);
  });
});

describe("host lists are read once", () => {
  it("snapshots the length of an allowedDomains array", () => {
    const hosts = ["example.com"];
    let reads = 0;
    const tricky = new Proxy(hosts, {
      get(target, key, receiver) {
        if (key === "length") return reads++ === 0 ? 1 : 1000;
        return Reflect.get(target, key, receiver);
      },
    });
    const parsed = parseOwnerCeilingReportV3({ ...ceiling(), allowedDomains: tricky });
    expect(parsed.allowedDomains).toEqual(["example.com"]);
    expect(reads).toBe(1);
  });
});
