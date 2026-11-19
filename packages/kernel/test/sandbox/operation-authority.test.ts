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
    outsideSandboxCeiling: true,
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
        outsideSandboxCeiling: false,
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

import type { PermissionReviewSnapshot } from "../../src/sandbox/permission-call-types.js";
import {
  approverForProfile,
  buildPermissionCandidate,
  ESCALATION_CEILING_WHY,
  ESCALATION_JUSTIFICATION_MISSING_TEXT,
  escalationRefusedText,
} from "../../src/sandbox/review/permission-candidate.js";

describe("per-call sandbox escalation", () => {
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
    allowedHosts: [],
    outsideSandboxCeiling: true,
  };
  it("an escalated restricted operation gets full execution and keeps its profile", () => {
    for (const profile of ["request-approval", "approve-for-me"] as const)
      expect(intersectPermissionScope({ ...base, profile, escalated: true })).toMatchObject({
        profile,
        filesystem: { kind: "device" },
        network: { kind: "environment" },
      });
  });
  it("an escalation is refused without the Full access ceiling, like Full access", () => {
    expect(() =>
      intersectPermissionScope({
        ...base,
        profile: "approve-for-me",
        escalated: true,
        outsideSandboxCeiling: false,
      }),
    ).toThrow(/ceiling/);
  });
  it("the profile chooses the approver: person, review model or none", () => {
    expect(approverForProfile("request-approval")).toBe("person");
    expect(approverForProfile("approve-for-me")).toBe("review-model");
    expect(approverForProfile("full-access")).toBe("none");
  });

  const facts = (over: Partial<PermissionReviewSnapshot> = {}): PermissionReviewSnapshot => ({
    orgId: "org",
    rootConversationId: "root",
    conversationId: "root",
    deviceId: "device",
    accountId: "owner",
    runId: "run",
    callId: "call",
    profile: "approve-for-me",
    profileRevision: 1,
    scopeRevision: "scope",
    authorityRevision: "authority",
    baseReadDirectories: ["/work"],
    baseWriteDirectories: ["/work"],
    baseHosts: [],
    workingRoot: "/work",
    outsideSandboxCeiling: true,
    broadProjectReach: false,
    unattended: false,
    fullConsent: false,
    availability: { state: "supported" },
    escalationRefusal: null,
    policy: {
      mode: "auto",
      allowedMode: "auto",
      localAllowedDomains: [],
      network: { kind: "allowlist", hosts: [] },
    },
    ...over,
  });
  const build = (input: Record<string, unknown>, over: Partial<PermissionReviewSnapshot> = {}) =>
    buildPermissionCandidate(
      { toolKey: "Bash", specHash: "bash-spec", rawInput: input, validatedInput: input },
      facts(over),
    );
  const escalated = {
    command: "cd /outside && npm run dev",
    sandbox: "escalated",
    justification: "The dev server must bind a port on the machine.",
  };
  it("proposes exactly one escalation bound to the call input, never a directory expansion", () => {
    const built = build(escalated);
    if (built.kind !== "proposal") throw new Error(JSON.stringify(built));
    expect(built.candidate).toMatchObject({
      scopeKind: "sandbox-escalation",
      escalation: { justification: escalated.justification },
      permissionScope: { readDirectories: [], writeDirectories: [], hosts: [] },
      binding: { toolKey: "Bash", callId: "call", profile: "approve-for-me" },
    });
    // a changed input is another binding: the grant of one call never covers another input
    const other = build({ ...escalated, command: "npm run build" });
    if (other.kind !== "proposal") throw new Error("Expected proposal");
    expect(other.candidate.binding.callInputHash).not.toBe(built.candidate.binding.callInputHash);
    expect(other.candidate.candidateHash).not.toBe(built.candidate.candidateHash);
  });
  it("a missing justification is refused with what to pass", () => {
    expect(build({ command: "make", sandbox: "escalated" })).toEqual({
      kind: "unsupported",
      code: "escalation-unavailable",
      message: ESCALATION_JUSTIFICATION_MISSING_TEXT,
    });
    expect(build({ command: "make", sandbox: "escalated", justification: "  " }).kind).toBe(
      "unsupported",
    );
  });
  it("a ceiling or an unattended run refuses it with an actionable text", () => {
    expect(build(escalated, { escalationRefusal: ESCALATION_CEILING_WHY })).toEqual({
      kind: "unsupported",
      code: "escalation-unavailable",
      message: escalationRefusedText(ESCALATION_CEILING_WHY, "/work"),
    });
    const unattended = build(escalated, { unattended: true });
    expect(unattended.kind).toBe("unsupported");
    expect(unattended.kind === "unsupported" && unattended.message).toMatch(/unattended/);
  });
  it("no approver (Full access): proposed for its auto-grant within the ceiling, refused past it", () => {
    expect(build(escalated, { profile: "full-access" })).toMatchObject({
      kind: "proposal",
      candidate: { scopeKind: "sandbox-escalation" },
    });
    expect(
      build(escalated, { profile: "full-access", escalationRefusal: ESCALATION_CEILING_WHY }).kind,
    ).toBe("unsupported");
  });
});
