import { describe, expect, it } from "vitest";
import {
  DEVICE_DIAL_IN_PROTOCOL,
  DEVICE_PROTOCOL_VERSION,
  DeviceProtocolError,
  parseDeviceFrame,
  parseOperationResult,
  parseOwnerCeilingReport,
} from "../src/device-protocol.js";
import { DIAL_IN_PROTOCOL_RE } from "../src/dial-in.js";

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
  filesystem: { kind: "scoped", projectRoot: "/work", writeRoots: ["/work"] },
  network: { kind: "none" },
};
/** A request body (the envelope's `req` carries it with its id and deadline). */
const frame = (op: string, args: unknown) => ({ op, args });
describe("protocol 5 operations", () => {
  it("carries every typed operation failure, an invalid scope included", () => {
    for (const kind of [
      "denied",
      "unsupported",
      "unsettled",
      "unknown",
      "invalid",
      "gone",
      "fs_gone",
    ]) {
      const res = { ok: false, error: { kind, message: "m" } };
      expect(parseDeviceFrame(res, "res")).toEqual(res);
    }
    expect(parseDeviceFrame({ ok: true, result: null }, "res")).toEqual({ ok: true, result: null });
    for (const bad of [
      { ok: false, error: { kind: "bogus", message: "m" } },
      { ok: true, result: null, id: "r" },
      { type: "res", ok: true, result: null },
      { ok: "yes" },
    ])
      expect(() => parseDeviceFrame(bad, "res"), JSON.stringify(bad)).toThrow(DeviceProtocolError);
  });
  it("speaks protocol 5 and requires fresh user scopes", () => {
    expect(DEVICE_PROTOCOL_VERSION).toBe(5);
    expect(DEVICE_DIAL_IN_PROTOCOL).toBe("capybara-device/5");
    expect(DIAL_IN_PROTOCOL_RE.test(DEVICE_DIAL_IN_PROTOCOL)).toBe(true);
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
      expect(parseDeviceFrame(frame(op, args), "req").op).toBe(op);
      expect(() => parseDeviceFrame(frame(op, { ...args, scope: undefined }), "req")).toThrow();
      expect(() => parseDeviceFrame(frame(op, { ...args, untrusted: true }), "req")).toThrow();
      // a protocol 4 scope (read roots, no project root) is not a protocol 5 frame
      const legacy = {
        ...scope,
        filesystem: { kind: "scoped", readRoots: ["/work"], writeRoots: [] },
      };
      expect(() => parseDeviceFrame(frame(op, { ...args, scope: legacy }), "req")).toThrow();
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
      parseDeviceFrame(frame("prepareStat", { scope: prep, path: "/skills/file" }), "req").op,
    ).toBe("prepareStat");
    expect(parseDeviceFrame(frame("browseScan", { scope: browse, base: "/work" }), "req").op).toBe(
      "browseScan",
    );
    expect(() =>
      parseDeviceFrame(frame("prepareStat", { scope: browse, path: "/skills/file" }), "req"),
    ).toThrow();
    expect(() =>
      parseDeviceFrame(
        frame("backgroundStop", {
          ref: { executionId: "e", operationId: "o", instanceId: "i", instanceGeneration: "g" },
          graceMs: -1,
        }),
        "req",
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
      "req",
    );
    expect(req.op).toBe("exec");
    expect(Object.isFrozen(req.args)).toBe(true);
    expect(req.args.grants).toEqual({
      hosts: ["api.example.com"],
      source: { kind: "run", id: "run", accountId: "a" },
    });
  });
});
it("keeps absent runtime identity unprobed and refuses incomplete or mismatched evidence", () => {
  const hello = {
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
  expect(parseDeviceFrame(hello, "hello").instanceGeneration).toBe("g");
  const identity = {
    runtimeHash: "a".repeat(64),
    helperHash: "b".repeat(64),
    imageFingerprint: "c".repeat(64),
    instanceGeneration: "g",
  };
  expect(
    parseDeviceFrame({ ...hello, runtimeIdentity: identity }, "hello").runtimeIdentity,
  ).toEqual(identity);
  for (const bad of [
    { ...identity, helperHash: undefined },
    { ...identity, instanceGeneration: "other" },
    { ...identity, runtimeHash: "exists" },
  ])
    expect(() => parseDeviceFrame({ ...hello, runtimeIdentity: bad }, "hello")).toThrow();
});

const outputRef = { instanceId: "d", instanceGeneration: "g", operationId: "o", executionId: "e" };
it("accepts positional managed output and rejects unknown request authority", () => {
  expect(
    parseDeviceFrame(
      frame("backgroundReadOutput", { ref: outputRef, offset: 70000, maxBytes: 3072 }),
      "req",
    ).op,
  ).toBe("backgroundReadOutput");
  for (const extra of [{ path: "/tmp/output" }, { scope }, { grants: {} }, { actor: {} }])
    expect(() =>
      parseDeviceFrame(
        frame("backgroundReadOutput", { ref: outputRef, offset: 0, maxBytes: 1, ...extra }),
        "req",
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
        "req",
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

it("refuses the removed broad kills and any body that is not JSON data", () => {
  for (const op of ["killAll", "killTagged"])
    expect(() =>
      parseDeviceFrame(frame(op, op === "killAll" ? {} : { tags: ["old"] }), "req"),
    ).toThrow();
  expect(() => parseDeviceFrame(undefined, "req")).toThrow("not JSON data");
  expect(() => parseDeviceFrame({ op: "stat", args: {}, id: "r" }, "req")).toThrow("Unknown field");
  expect(() => parseDeviceFrame({}, "nope" as "req")).toThrow(DeviceProtocolError);
});
it("parses a copy: the caller's objects are neither frozen nor read twice", () => {
  const args = { reason: "deleted" };
  const parsed = parseDeviceFrame({ op: "stop", args }, "req");
  expect(Object.isFrozen(parsed.args)).toBe(true);
  expect(Object.isFrozen(args)).toBe(false);
});
it("canonical unbound hello remains unprobed and owner reports require independent reach", () => {
  const hello = {
    mode: "os",
    roots: { workspace: "/w", skills: "/s", tmp: "/t" },
    sessionIsolation: false,
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
  expect(parseDeviceFrame(hello, "hello")).toMatchObject({
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
        { ...hello, permissionSupport: { ...hello.permissionSupport, ...claim } },
        "hello",
      ),
    ).toThrow();
  // the program facts and the recent policy ops are not part of the body: the envelope carries
  // the facts, and the deployment changes no policy on the machine
  for (const extra of [
    { type: "hello" },
    { protocol: 5 },
    { programVersion: "fixture" },
    { os: "darwin" },
    { arch: "arm64" },
    { bootId: "b" },
    { programRunId: "r" },
    { transport: { maxFrameBytes: 69632 } },
    { recentOps: [] },
  ])
    expect(() => parseDeviceFrame({ ...hello, ...extra }, "hello")).toThrow("Unknown field");
  expect(() =>
    parseDeviceFrame(
      {
        ...hello,
        permissionSupport: {
          version: 1,
          restricted: null,
          fullAccess: false,
          background: false,
          unavailableReason: "x",
        },
      },
      "hello",
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
      parseDeviceFrame({ ...hello, ownerCeiling: { ...hello.ownerCeiling, ...extra } }, "hello"),
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
    const parsed = parseDeviceFrame(frame("bindInstance", request), "req");
    expect(parsed).toEqual({ op: "bindInstance", args: request });
    expect(
      parseDeviceFrame(
        frame("bindInstance", { ...request, expectedPreviousGeneration: null }),
        "req",
      ).op,
    ).toBe("bindInstance");
    for (const extra of [
      { manifestPath: "/tmp/m.json" },
      { policy: {} },
      { runtimeIdentity: identity },
      { scope },
    ])
      expect(() =>
        parseDeviceFrame(frame("bindInstance", { ...request, ...extra }), "req"),
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
        parseDeviceFrame(frame("bindInstance", { ...request, ...bad }), "req"),
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
  it("carries the report in the owner's change event", () => {
    const event = parseDeviceFrame(
      { type: "policy", policy: { allowedDomains: [] }, ownerCeiling: report },
      "event",
    );
    expect(event).toEqual({ type: "policy", policy: { allowedDomains: [] }, ownerCeiling: report });
    // an unreadable summary is dropped; the owner report is required
    expect(
      parseDeviceFrame({ type: "policy", policy: { x: 1 }, ownerCeiling: report }, "event"),
    ).toEqual({ type: "policy", ownerCeiling: report });
    for (const bad of [
      { type: "policy" },
      { type: "other", ownerCeiling: report },
      { type: "policy", ownerCeiling: report, extra: true },
    ])
      expect(() => parseDeviceFrame(bad, "event"), JSON.stringify(bad)).toThrow(
        DeviceProtocolError,
      );
  });
});
describe("writeFile payload check", () => {
  const write = (dataB64: string) => () =>
    parseDeviceFrame(frame("writeFile", { scope, path: "/work/f", dataB64 }), "req");
  it("accepts a valid base64 payload larger than 5 MB", () => {
    const bytes = Buffer.alloc(6 * 1024 * 1024 + 1, 7);
    // repeated parses: the check must not depend on a regex engine's backtracking stack
    for (let i = 0; i < 3; i++) expect(write(bytes.toString("base64"))).not.toThrow();
  });
  it("accepts canonical padding and the empty payload", () => {
    for (const ok of ["", "YWJj", "YWI=", "YQ==", "YWJjZA==", "+/+/"])
      expect(write(ok)).not.toThrow();
  });
  it("refuses invalid characters, bad lengths and misplaced padding", () => {
    for (const bad of [
      "YWJ",
      "YWJjZ",
      "Y===",
      "====",
      "YW=j",
      "=YWJ",
      "YQ==YWJj",
      "YW J",
      "YW-j",
      "YW_j",
      "YWJj\n",
      `${"A".repeat(6 * 1024 * 1024)}*AAA`,
    ])
      expect(write(bad), JSON.stringify(bad.slice(0, 20))).toThrow(DeviceProtocolError);
  });
});
