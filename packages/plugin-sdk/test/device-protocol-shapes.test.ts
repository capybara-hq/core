import { describe, expect, it } from "vitest";
import {
  DeviceProtocolError,
  parseDeviceFrame,
  parseOperationResult,
  parseOwnerCeilingReport,
  parseSandboxPermissionSupport,
} from "../src/device-protocol.js";

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

describe("parseSandboxPermissionSupport", () => {
  it("accepts an operation-boundary and an instance-boundary report and freezes a copy", () => {
    for (const make of [operationSupport, instanceSupport]) {
      const input = make();
      const parsed = parseSandboxPermissionSupport(input);
      expect(parsed).toEqual(make());
      input.network.openPublic = false;
      expect(parsed.network.openPublic).toBe(true);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.network)).toBe(true);
    }
    expect(
      parseSandboxPermissionSupport({
        ...operationSupport(),
        restricted: null,
        network: { openPublic: false, allowlist: false, perOperationHosts: false },
        outsideSandbox: false,
        unavailableReason: "the OS sandbox is not installed",
      }).unavailableReason,
    ).toBe("the OS sandbox is not installed");
  });

  it("keeps limitedBy naming the owner for a closed crossing only", () => {
    const closed = {
      ...operationSupport(),
      network: { openPublic: false, allowlist: true, perOperationHosts: true },
      outsideSandbox: false,
      limitedBy: { outsideSandbox: "owner", openPublic: "owner" },
    };
    expect(parseSandboxPermissionSupport(closed).limitedBy).toEqual({
      outsideSandbox: "owner",
      openPublic: "owner",
    });
    expect(parseSandboxPermissionSupport({ ...closed, limitedBy: {} })).not.toHaveProperty(
      "limitedBy",
    );
    for (const limitedBy of [{ outsideSandbox: "provider" }, { network: "owner" }, "owner"])
      expect(() => parseSandboxPermissionSupport({ ...closed, limitedBy })).toThrow(
        DeviceProtocolError,
      );
    // an open crossing names no limit
    expect(() =>
      parseSandboxPermissionSupport({
        ...operationSupport(),
        limitedBy: { outsideSandbox: "owner" },
      }),
    ).toThrow(DeviceProtocolError);
    expect(() =>
      parseSandboxPermissionSupport({ ...operationSupport(), limitedBy: { openPublic: "owner" } }),
    ).toThrow(DeviceProtocolError);
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
    expect(() => parseSandboxPermissionSupport(value)).toThrow(DeviceProtocolError);
  });

  it.each([
    ["a restricted claim", { restricted: { ...RESTRICTED } }],
    ["outside-sandbox escalation", { outsideSandbox: true }],
    [
      "per-operation hosts",
      { network: { openPublic: true, allowlist: true, perOperationHosts: true } },
    ],
  ])("rejects an instance boundary claiming %s", (_name, patch) => {
    expect(() => parseSandboxPermissionSupport({ ...instanceSupport(), ...patch })).toThrow(
      DeviceProtocolError,
    );
  });

  it.each([
    ["the open network", { openPublic: true, allowlist: false, perOperationHosts: false }],
    ["the allowlist", { openPublic: false, allowlist: true, perOperationHosts: false }],
    ["per-operation hosts", { openPublic: false, allowlist: true, perOperationHosts: true }],
  ])("rejects an operation boundary without restricted support claiming %s", (_name, network) => {
    expect(() =>
      parseSandboxPermissionSupport({ ...operationSupport(), restricted: null, network }),
    ).toThrow(DeviceProtocolError);
  });

  it("rejects non-plain objects and accessors", () => {
    for (const bad of [null, [], "x", 1, new (class Report {})()])
      expect(() => parseSandboxPermissionSupport(bad)).toThrow(DeviceProtocolError);
    const tricky = operationSupport();
    let reads = 0;
    Object.defineProperty(tricky, "outsideSandbox", {
      enumerable: true,
      get: () => reads++ === 0,
    });
    expect(() => parseSandboxPermissionSupport(tricky)).toThrow(DeviceProtocolError);
  });
});

const ceiling = () => ({
  version: 3,
  sequence: 4,
  revision: "rev-4",
  outsideSandbox: false,
  network: "open",
  allowedDomains: ["example.com", "*.example.org"],
  projectReach: "workspace",
});

describe("parseOwnerCeilingReport", () => {
  it("accepts both network modes and freezes a copy", () => {
    const input = ceiling();
    const parsed = parseOwnerCeilingReport(input);
    expect(parsed).toEqual(ceiling());
    input.allowedDomains.push("evil.example");
    expect(parsed.allowedDomains).toEqual(["example.com", "*.example.org"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.allowedDomains)).toBe(true);
    expect(
      parseOwnerCeilingReport({
        ...ceiling(),
        network: "allowlist",
        allowedDomains: [],
        outsideSandbox: true,
        projectReach: "machine",
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
    ["unknown reach", { projectReach: "device" }],
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
    expect(() => parseOwnerCeilingReport(value)).toThrow(DeviceProtocolError);
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
    const parsed = parseOwnerCeilingReport({ ...ceiling(), allowedDomains: tricky });
    expect(parsed.allowedDomains).toEqual(["example.com"]);
    expect(reads).toBe(1);
  });
});

describe("protocol 6 bodies", () => {
  it("parseDeviceFrame rejects a body with a policy op: the deployment changes no machine policy", () => {
    const source = { accountId: "a", accountName: "A", via: "web" };
    for (const body of [
      { op: "policy", args: { opId: "op", source, remove: ["api.example.com"] } },
      { op: "policy", args: { opId: "op", source, ownerCeiling: { outsideSandbox: false } } },
      { op: "policyStatus", args: { opId: "op" } },
    ])
      expect(() => parseDeviceFrame(body, "req"), body.op).toThrow(DeviceProtocolError);
    expect(() =>
      parseOperationResult("policy" as "exec", { policy: { allowedDomains: [] } }),
    ).toThrow(DeviceProtocolError);
  });
});
