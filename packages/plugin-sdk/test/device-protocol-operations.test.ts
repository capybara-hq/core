import { describe, expect, it } from "vitest";
import {
  DEVICE_PROTOCOL_VERSION,
  DeviceProtocolError,
  LEGACY_DEVICE_PROTOCOL_VERSION,
  POLICY_ADD_REFUSED,
  parseDeviceFrame,
  parseOperationResult,
  parseOwnerCeilingReport,
} from "../src/device-protocol.js";

const scope = {
  operationId: "op",
  admitBeforeMs: 1000,
  deviceId: "d",
  rootConversationId: "r",
  profileRevision: 1,
  ceilingRevision: "c",
  profile: "approve-for-me",
  actor: { accountId: "a", conversationId: "r" },
  tag: "op",
  filesystem: { kind: "scoped", readRoots: ["/work"], writeRoots: ["/work"] },
  network: { kind: "none" },
};
const frame = (op: string, args: unknown) =>
  JSON.stringify({ type: "req", id: "request", op, args, deadlineMs: 1000 });
describe("protocol 4 operations", () => {
  it("carries every typed operation failure, an invalid scope included", () => {
    for (const kind of ["denied", "unsupported", "unknown", "invalid", "gone", "fs_gone"]) {
      const res = { type: "res", id: "request", ok: false, error: { kind, message: "m" } };
      expect(parseDeviceFrame(JSON.stringify(res), "device")).toEqual(res);
    }
    expect(() =>
      parseDeviceFrame(
        JSON.stringify({ type: "res", id: "r", ok: false, error: { kind: "bogus", message: "m" } }),
        "device",
      ),
    ).toThrow(DeviceProtocolError);
  });
  it("speaks protocol 4 and requires fresh user scopes", () => {
    expect(DEVICE_PROTOCOL_VERSION).toBe(4);
    expect(LEGACY_DEVICE_PROTOCOL_VERSION).toBe(3);
    for (const op of ["readFile", "writeFile", "stat", "list", "scan"]) {
      const args = {
        scope,
        path: "/work/file",
        ...(op === "readFile"
          ? { maxBytes: 10 }
          : op === "writeFile"
            ? { dataB64: "YQ==" }
            : op === "list"
              ? { limit: 10 }
              : op === "scan"
                ? { base: "/work" }
                : {}),
      };
      if (op === "scan") delete (args as { path?: string }).path;
      expect(parseDeviceFrame(frame(op, args), "kernel").type).toBe("req");
      expect(() => parseDeviceFrame(frame(op, { ...args, scope: undefined }), "kernel")).toThrow();
      expect(() => parseDeviceFrame(frame(op, { ...args, untrusted: true }), "kernel")).toThrow();
    }
  });
  it("separates preparation, browse and background references", () => {
    const prep = {
      operationId: "p",
      deviceId: "d",
      purpose: "skills",
      writeRoots: ["/skills"],
      tag: "p",
    };
    const browse = {
      operationId: "b",
      deviceId: "d",
      accountId: "a",
      admitBeforeMs: 1000,
      ceilingRevision: "c",
      readRoots: ["/work"],
      tag: "b",
    };
    expect(
      parseDeviceFrame(frame("prepareStat", { scope: prep, path: "/skills/file" }), "kernel").type,
    ).toBe("req");
    expect(
      parseDeviceFrame(frame("browseScan", { scope: browse, base: "/work" }), "kernel").type,
    ).toBe("req");
    expect(() =>
      parseDeviceFrame(frame("prepareStat", { scope: browse, path: "/skills/file" }), "kernel"),
    ).toThrow();
    expect(() =>
      parseDeviceFrame(
        frame("backgroundStop", {
          ref: { executionId: "e", operationId: "o", instanceId: "i", instanceGeneration: "g" },
          graceMs: -1,
        }),
        "kernel",
      ),
    ).toThrow();
  });
  it("preserves authenticated exec grants and freezes validated scopes", () => {
    const req = parseDeviceFrame(
      frame("exec", {
        scope,
        command: "true",
        timeoutMs: 100,
        maxOutputBytes: 100,
        limits: {
          cpu: 1,
          memoryMb: 512,
          diskMb: 1024,
          network: { kind: "allowlist", hosts: ["api.example.com"] },
        },
        grants: { hosts: ["api.example.com"], source: { kind: "run", id: "run", accountId: "a" } },
      }),
      "kernel",
    );
    expect(req.type).toBe("req");
    if (req.type !== "req") throw Error();
    expect(Object.isFrozen(req.args)).toBe(true);
    expect(req.args.grants).toEqual({
      hosts: ["api.example.com"],
      source: { kind: "run", id: "run", accountId: "a" },
    });
  });
});
it("keeps absent runtime identity unprobed and refuses incomplete or mismatched evidence", () => {
  const hello = {
    type: "hello",
    protocol: 4,
    transport: { maxFrameBytes: 69632 },
    programVersion: "test-1",
    os: "darwin",
    arch: "arm64",
    mode: "os",
    roots: { workspace: "/work", skills: "/skills", tmp: "/tmp" },
    sessionIsolation: false,
    permissionSupport: {
      version: 2,
      boundary: "operation",
      restricted: null,
      network: { openPublic: false, allowlist: false, perOperationHosts: false },
      outsideSandbox: false,
      background: false,
    },
    ownerCeiling: {
      version: 3,
      sequence: 0,
      revision: "r",
      outsideSandbox: false,
      network: "allowlist",
      allowedDomains: [],
      restrictedProjectReach: "workspace",
    },
    instanceGeneration: "g",
  };
  expect(parseDeviceFrame(JSON.stringify(hello), "device").type).toBe("hello");
  const identity = {
    runtimeHash: "a".repeat(64),
    helperHash: "b".repeat(64),
    imageFingerprint: "c".repeat(64),
    instanceGeneration: "g",
  };
  expect(
    parseDeviceFrame(JSON.stringify({ ...hello, runtimeIdentity: identity }), "device").type,
  ).toBe("hello");
  for (const bad of [
    { ...identity, helperHash: undefined },
    { ...identity, instanceGeneration: "other" },
    { ...identity, runtimeHash: "exists" },
  ])
    expect(() =>
      parseDeviceFrame(JSON.stringify({ ...hello, runtimeIdentity: bad }), "device"),
    ).toThrow();
});

const outputRef = { instanceId: "d", instanceGeneration: "g", operationId: "o", executionId: "e" };
it("accepts positional managed output and rejects unknown request authority", () => {
  expect(
    parseDeviceFrame(
      frame("backgroundReadOutput", { ref: outputRef, offset: 70000, maxBytes: 3072 }),
      "kernel",
    ).type,
  ).toBe("req");
  for (const extra of [{ path: "/tmp/output" }, { scope }, { grants: {} }, { actor: {} }])
    expect(() =>
      parseDeviceFrame(
        frame("backgroundReadOutput", { ref: outputRef, offset: 0, maxBytes: 1, ...extra }),
        "kernel",
      ),
    ).toThrow();
  for (const bad of [
    { offset: -1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { maxBytes: 65537 },
    { maxBytes: 1.5 },
    { ref: { ...outputRef, path: "/tmp" } },
  ])
    expect(() =>
      parseDeviceFrame(
        frame("backgroundReadOutput", { ref: outputRef, offset: 0, maxBytes: 1, ...bad }),
        "kernel",
      ),
    ).toThrow();
});
it("validates exact canonical output range metadata against the request", () => {
  const request = { offset: 10, maxBytes: 1 };
  const good = { dataB64: "YQ==", offset: 10, nextOffset: 11, totalBytes: 11 };
  expect(parseOperationResult("backgroundReadOutput", good, request)).toEqual(good);
  for (const bad of [
    { dataB64: "YR==" },
    { dataB64: "YQ" },
    { offset: 9 },
    { nextOffset: 12 },
    { totalBytes: 10 },
    { extra: true },
    { dataB64: "", nextOffset: 10 },
  ])
    expect(() =>
      parseOperationResult("backgroundReadOutput", { ...good, ...bad }, request),
    ).toThrow();
  expect(
    parseOperationResult(
      "backgroundReadOutput",
      { dataB64: "", offset: 20, nextOffset: 20, totalBytes: 11 },
      { offset: 20, maxBytes: 1 },
    ),
  ).toEqual({ dataB64: "", offset: 20, nextOffset: 20, totalBytes: 11 });
  expect(parseOperationResult("backgroundReadOutput", { unavailable: "expired" }, request)).toEqual(
    { unavailable: "expired" },
  );
});

it("strict ready capacity and frame bounds never admit pre-negotiation data", () => {
  const ready = { type: "ready", connectionId: "c", maxFrameBytes: 69632 };
  expect(parseDeviceFrame(JSON.stringify(ready), "kernel", 69632)).toEqual(ready);
  for (const extra of [
    { maxFrameBytes: 0 },
    { maxFrameBytes: 1023 },
    { maxFrameBytes: Number.MAX_SAFE_INTEGER + 1 },
    { maxFrameBytes: 1.5 },
    { connectionId: "" },
    { unexpected: true },
  ])
    expect(() => parseDeviceFrame(JSON.stringify({ ...ready, ...extra }), "kernel")).toThrow();
  expect(() => parseDeviceFrame(JSON.stringify(ready), "device")).toThrow();
  expect(() => parseDeviceFrame(" ".repeat(69633), "kernel", 69632)).toThrow("negotiated capacity");
  for (const op of ["killAll", "killTagged"])
    expect(() =>
      parseDeviceFrame(frame(op, op === "killAll" ? {} : { tags: ["old"] }), "kernel"),
    ).toThrow();
});
it("canonical unbound hello remains unprobed and owner reports require independent reach", () => {
  const hello = {
    type: "hello",
    protocol: 4,
    programVersion: "fixture",
    os: "darwin",
    arch: "arm64",
    mode: "os",
    roots: { workspace: "/w", skills: "/s", tmp: "/t" },
    sessionIsolation: false,
    transport: { maxFrameBytes: 69632 },
    instanceGeneration: null,
    permissionSupport: {
      version: 2,
      boundary: "operation",
      restricted: null,
      network: { openPublic: false, allowlist: false, perOperationHosts: false },
      outsideSandbox: false,
      background: false,
      unavailableReason: "Awaiting instance binding",
    },
    ownerCeiling: {
      version: 3,
      sequence: 1,
      revision: "r",
      outsideSandbox: false,
      network: "open",
      allowedDomains: [],
      restrictedProjectReach: "os-user",
    },
  };
  expect(parseDeviceFrame(JSON.stringify(hello), "device")).toMatchObject({
    instanceGeneration: null,
  });
  for (const claim of [
    { outsideSandbox: true },
    { background: true },
    {
      boundary: "instance",
      network: { openPublic: true, allowlist: false, perOperationHosts: false },
    },
  ])
    expect(() =>
      parseDeviceFrame(
        JSON.stringify({ ...hello, permissionSupport: { ...hello.permissionSupport, ...claim } }),
        "device",
      ),
    ).toThrow();
  // a protocol 3 hello (its version 1 support and version 2 owner report) is refused
  expect(() => parseDeviceFrame(JSON.stringify({ ...hello, protocol: 3 }), "device")).toThrow(
    "Expected protocol 4 hello",
  );
  expect(() =>
    parseDeviceFrame(
      JSON.stringify({
        ...hello,
        permissionSupport: {
          version: 1,
          restricted: null,
          fullAccess: false,
          background: false,
          unavailableReason: "x",
        },
      }),
      "device",
    ),
  ).toThrow(DeviceProtocolError);
  for (const extra of [
    { sequence: -1 },
    { sequence: 0.1 },
    { version: 2 },
    { fullAccess: false },
    { restrictedProjectReach: "all" },
    { unknown: true },
  ])
    expect(() =>
      parseDeviceFrame(
        JSON.stringify({ ...hello, ownerCeiling: { ...hello.ownerCeiling, ...extra } }),
        "device",
      ),
    ).toThrow();
});
describe("bindInstance (B4 post-commit binding)", () => {
  const request = {
    instanceId: "device-1",
    instanceGeneration: "1700000000001",
    bindingId: "6f1e0a52-8f5b-4d5e-9a1c-1f0e2d3c4b5a",
    expectedPreviousGeneration: "1700000000000",
  };
  const identity = {
    runtimeHash: "a".repeat(64),
    helperHash: "b".repeat(64),
    imageFingerprint: "c".repeat(64),
    instanceGeneration: request.instanceGeneration,
  };
  const answer = {
    instanceId: request.instanceId,
    instanceGeneration: request.instanceGeneration,
    bindingId: request.bindingId,
    runtimeIdentity: identity,
    permissionSupport: {
      version: 2,
      boundary: "operation",
      restricted: null,
      network: { openPublic: false, allowlist: false, perOperationHosts: false },
      outsideSandbox: true,
      background: true,
      unavailableReason: "restricted proof pending",
    },
    ownerCeiling: {
      version: 3,
      sequence: 3,
      revision: "r",
      outsideSandbox: true,
      network: "open",
      allowedDomains: [],
      restrictedProjectReach: "workspace",
    },
  };
  it("accepts exactly the committed identifiers and refuses paths, manifests and policies", () => {
    const parsed = parseDeviceFrame(frame("bindInstance", request), "kernel");
    expect(parsed).toMatchObject({ type: "req", op: "bindInstance", args: request });
    expect(
      parseDeviceFrame(
        frame("bindInstance", { ...request, expectedPreviousGeneration: null }),
        "kernel",
      ).type,
    ).toBe("req");
    for (const extra of [
      { manifestPath: "/tmp/m.json" },
      { policy: {} },
      { runtimeIdentity: identity },
      { scope },
    ])
      expect(() =>
        parseDeviceFrame(frame("bindInstance", { ...request, ...extra }), "kernel"),
      ).toThrow("Unknown field");
    for (const bad of [
      { instanceGeneration: "now" },
      { instanceGeneration: "17000000000000000" },
      { bindingId: "not-a-uuid" },
      { expectedPreviousGeneration: request.instanceGeneration },
      { expectedPreviousGeneration: "1800000000000" },
      { instanceId: "" },
    ])
      expect(() =>
        parseDeviceFrame(frame("bindInstance", { ...request, ...bad }), "kernel"),
      ).toThrow();
  });
  it("binds the answer to the exact request; a delayed or foreign answer is refused", () => {
    expect(parseOperationResult("bindInstance", answer, request)).toEqual(answer);
    expect(() => parseOperationResult("bindInstance", answer)).toThrow("exact request");
    for (const wrong of [
      { bindingId: "0f1e0a52-8f5b-4d5e-9a1c-1f0e2d3c4b5a" },
      { instanceGeneration: "1700000000000" },
      { instanceId: "device-2" },
      { runtimeIdentity: { ...identity, instanceGeneration: "1700000000000" } },
      { runtimeIdentity: { ...identity, helperHash: "B".repeat(64) } },
      { extra: true },
    ])
      expect(() =>
        parseOperationResult("bindInstance", { ...answer, ...wrong }, request),
      ).toThrow();
    const { runtimeIdentity: _, ...withoutIdentity } = answer;
    expect(() => parseOperationResult("bindInstance", withoutIdentity, request)).toThrow(
      "Expected an object",
    );
  });
});

describe("owner reports (B2)", () => {
  const report = {
    version: 3,
    revision: "r1",
    sequence: 3,
    outsideSandbox: false,
    network: "allowlist",
    allowedDomains: ["*.example.com"],
    restrictedProjectReach: "os-user",
  };
  it("parses one strict report and refuses extra fields, bad reach or sequence", () => {
    expect(parseOwnerCeilingReport(report)).toEqual(report);
    for (const bad of [
      { ...report, mode: "auto" },
      { ...report, restrictedProjectReach: "home" },
      { ...report, sequence: -1 },
      { ...report, sequence: 1.5 },
      { ...report, version: 2 },
      { ...report, outsideSandbox: "true" },
      { ...report, fullAccess: false },
      { ...report, network: "open-public" },
    ])
      expect(() => parseOwnerCeilingReport(bad)).toThrow(DeviceProtocolError);
  });
  it("carries the report in policy frames, policy answers and applied statuses", () => {
    const frame = parseDeviceFrame(
      JSON.stringify({
        type: "policy",
        policy: { allowedDomains: [] },
        ownerCeiling: report,
      }),
      "device",
    );
    expect(frame).toMatchObject({ type: "policy", ownerCeiling: report });
    expect(() =>
      parseDeviceFrame(JSON.stringify({ type: "policy", policy: undefined }), "device"),
    ).toThrow(DeviceProtocolError);
    expect(
      parseOperationResult("policy", {
        policy: { allowedDomains: [] },
        ownerCeiling: report,
      }),
    ).toMatchObject({ ownerCeiling: report });
    expect(() => parseOperationResult("policy", { policy: { allowedDomains: [] } })).toThrow(
      DeviceProtocolError,
    );
    expect(() => parseOperationResult("policyStatus", { outcome: "applied" })).toThrow(
      DeviceProtocolError,
    );
    expect(
      parseOperationResult("policyStatus", { outcome: "applied", ownerCeiling: report }),
    ).toMatchObject({ outcome: "applied", ownerCeiling: report });
    expect(parseOperationResult("policyStatus", { outcome: "unknown" })).toEqual({
      outcome: "unknown",
    });
  });
  it("lets the deployment only narrow the owner ceiling in a policy op", () => {
    const req = (ownerCeiling: unknown) =>
      JSON.stringify({
        type: "req",
        id: "1",
        op: "policy",
        deadlineMs: 1000,
        args: {
          opId: "op",
          source: { accountId: "a", accountName: "A", via: "web" },
          ownerCeiling,
        },
      });
    for (const good of [
      { outsideSandbox: false },
      { network: "allowlist" },
      { removeAllowedDomains: ["api.example.com"] },
      { restrictedProjectReach: "workspace" },
    ])
      expect(parseDeviceFrame(req(good), "kernel")).toMatchObject({
        op: "policy",
        args: { ownerCeiling: good },
      });
    for (const bad of [
      { outsideSandbox: true },
      { network: "open" },
      { restrictedProjectReach: "os-user" },
      // the protocol 3 key is gone
      { fullAccess: false },
      { x: 1 },
    ])
      expect(() => parseDeviceFrame(req(bad), "kernel")).toThrow(DeviceProtocolError);
  });
  it("refuses a policy op that adds hosts or carries the protocol 3 mode: widening is on the machine", () => {
    const req = (extra: Record<string, unknown>) =>
      JSON.stringify({
        type: "req",
        id: "1",
        op: "policy",
        deadlineMs: 1000,
        args: { opId: "op", source: { accountId: "a", accountName: "A", via: "web" }, ...extra },
      });
    expect(parseDeviceFrame(req({ remove: ["api.example.com"] }), "kernel")).toMatchObject({
      op: "policy",
    });
    expect(() => parseDeviceFrame(req({ add: ["api.example.com"] }), "kernel")).toThrow(
      POLICY_ADD_REFUSED,
    );
    expect(() => parseDeviceFrame(req({ add: [] }), "kernel")).toThrow(POLICY_ADD_REFUSED);
    expect(() => parseDeviceFrame(req({ mode: "sandbox" }), "kernel")).toThrow(
      "not part of device protocol 4",
    );
  });
});
