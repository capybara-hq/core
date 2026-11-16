import { describe, expect, it } from "vitest";
import { DEVICE_PROTOCOL_VERSION } from "../src/device-protocol.js";
import { parseDeviceFrameV3 } from "../src/device-protocol-v3.js";

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
describe("staged v3", () => {
  it("keeps current protocol v2 and requires fresh user scopes", () => {
    expect(DEVICE_PROTOCOL_VERSION).toBe(2);
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
      expect(parseDeviceFrameV3(frame(op, args), "kernel").type).toBe("req");
      expect(() =>
        parseDeviceFrameV3(frame(op, { ...args, scope: undefined }), "kernel"),
      ).toThrow();
      expect(() => parseDeviceFrameV3(frame(op, { ...args, untrusted: true }), "kernel")).toThrow();
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
      parseDeviceFrameV3(frame("prepareStat", { scope: prep, path: "/skills/file" }), "kernel")
        .type,
    ).toBe("req");
    expect(
      parseDeviceFrameV3(frame("browseScan", { scope: browse, base: "/work" }), "kernel").type,
    ).toBe("req");
    expect(() =>
      parseDeviceFrameV3(frame("prepareStat", { scope: browse, path: "/skills/file" }), "kernel"),
    ).toThrow();
    expect(() =>
      parseDeviceFrameV3(
        frame("backgroundStop", {
          ref: { executionId: "e", operationId: "o", instanceId: "i", instanceGeneration: "g" },
          graceMs: -1,
        }),
        "kernel",
      ),
    ).toThrow();
  });
  it("preserves authenticated exec grants and freezes validated scopes", () => {
    const req = parseDeviceFrameV3(
      frame("exec", {
        scope,
        command: "true",
        timeoutMs: 100,
        maxOutputBytes: 100,
        limits: {
          cpu: 1,
          memoryMb: 512,
          diskMb: 1024,
          mode: "sandbox",
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
    protocol: 3,
    programVersion: "test-1",
    os: "darwin",
    arch: "arm64",
    mode: "os",
    roots: { workspace: "/work", skills: "/skills", tmp: "/tmp" },
    sessionIsolation: false,
    permissionSupport: { version: 1, restricted: null, fullAccess: false, background: false },
    ownerCeiling: { revision: "r", fullAccess: false, restrictedAllowedDomains: [] },
    instanceGeneration: "g",
  };
  expect(parseDeviceFrameV3(JSON.stringify(hello), "device").type).toBe("hello");
  const identity = {
    runtimeHash: "a".repeat(64),
    helperHash: "b".repeat(64),
    imageFingerprint: "c".repeat(64),
    instanceGeneration: "g",
  };
  expect(
    parseDeviceFrameV3(JSON.stringify({ ...hello, runtimeIdentity: identity }), "device").type,
  ).toBe("hello");
  for (const bad of [
    { ...identity, helperHash: undefined },
    { ...identity, instanceGeneration: "other" },
    { ...identity, runtimeHash: "exists" },
  ])
    expect(() =>
      parseDeviceFrameV3(JSON.stringify({ ...hello, runtimeIdentity: bad }), "device"),
    ).toThrow();
});
