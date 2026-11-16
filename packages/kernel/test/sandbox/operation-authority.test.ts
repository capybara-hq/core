import { describe, expect, it } from "vitest";
import { intersectPermissionScope } from "../../src/sandbox/operation-authority.js";
import { permissionScopeHash } from "../../src/sandbox/permission-facts.js";

describe("operation authority intersection", () => {
  const base = {
    deviceId: "device",
    rootConversationId: "root",
    profileRevision: 1,
    ceilingRevision: "epoch",
    operationId: "operation",
    admitBeforeMs: 1000,
    actor: { accountId: "owner", conversationId: "root" },
    tag: "operation",
    workingRoot: "/work",
    readRoots: ["/work"],
    writeRoots: ["/work"],
    allowedHosts: ["api.example.com"],
    fullAccessCeiling: true,
  };
  it("both restricted profiles keep independently bounded roots and hosts", () => {
    for (const profile of ["request-approval", "approve-for-me"] as const)
      expect(intersectPermissionScope({ ...base, profile })).toMatchObject({
        profile,
        filesystem: { kind: "scoped", readRoots: ["/work"], writeRoots: ["/work"] },
        network: { kind: "allowlist", hosts: ["api.example.com"] },
      });
  });
  it("Full uses the environment only with explicit matching consent and current ceiling", () => {
    expect(() =>
      intersectPermissionScope({ ...base, profile: "full-access", fullConsent: false }),
    ).toThrow();
    expect(() =>
      intersectPermissionScope({
        ...base,
        profile: "full-access",
        fullConsent: true,
        fullAccessCeiling: false,
      }),
    ).toThrow();
    expect(
      intersectPermissionScope({ ...base, profile: "full-access", fullConsent: true }),
    ).toMatchObject({ filesystem: { kind: "device" }, network: { kind: "environment" } });
  });
  it("empty restricted allowance denies network and returned grants are immutable copies", () => {
    const readRoots = ["/work"];
    const scope = intersectPermissionScope({
      ...base,
      profile: "approve-for-me",
      allowedHosts: [],
      readRoots,
    });
    readRoots.push("/secret");
    expect(scope.filesystem).toEqual({
      kind: "scoped",
      readRoots: ["/work"],
      writeRoots: ["/work"],
    });
    expect(scope.network).toEqual({ kind: "none" });
    expect(Object.isFrozen(scope)).toBe(true);
  });
});

it("preserves canonical permission scope fingerprints across object key order and omitted fields", () => {
  expect(
    permissionScopeHash({ z: null, a: ["workspace", { y: 2, x: 1 }], omitted: undefined }),
  ).toBe("f92f26a2fd2af84edb3a43e5d7436e73dc3e80891a35ca22cf013ab2b107b397");
  expect(permissionScopeHash({ a: ["workspace", { x: 1, y: 2 }], z: null })).toBe(
    "f92f26a2fd2af84edb3a43e5d7436e73dc3e80891a35ca22cf013ab2b107b397",
  );
});
