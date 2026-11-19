import type { PermissionProfile } from "@capybara-hq/plugin-sdk";
import type { HostGrantCeiling } from "./device-sandbox.js";
import type { EffectiveDevicePolicy } from "./modes.js";
import type { AppliedOuterNetwork } from "./permission-context-types.js";

export type PermissionCallRef = { runId: string; callId: string };
export type PermissionExpansion = Readonly<{
  readDirectories: readonly string[];
  writeDirectories: readonly string[];
  hosts: readonly string[];
}>;
export type PermissionCallBinding = Readonly<{
  orgId: string;
  rootConversationId: string;
  conversationId: string;
  deviceId: string;
  accountId: string;
  runId: string;
  callId: string;
  toolKey: string;
  specHash: string;
  callInputHash: string;
  resolvedInputHash: string;
  profile: PermissionProfile;
  profileRevision: number;
  scopeRevision: string;
  authorityRevision: string;
}>;
export type PermissionGrantDecision =
  | { source: "human"; approvalId: string; decidedBy: string }
  | { source: "review-model"; reviewEventSeq: number; decidedBy: null }
  | PermissionFullAccessGrantDecision;
/**
 * Full access granted the crossing within the device's ceilings (approval-only profiles design,
 * "Kernel: decision, admission and records"): its evidence is the `permission_reviewed` event
 * (outcome allow, decision source `full-access`) written with an audit row
 * `permission.crossing_auto_granted` and the grant in one fenced transaction.
 */
export type PermissionFullAccessGrantDecision = {
  source: "full-access";
  reviewEventSeq: number;
  decidedBy: null;
};
/** Where a grant's evidence came from: the person, the review model or a Full access auto-grant. */
export type PermissionGrantSource = PermissionGrantDecision["source"];
/**
 * The kind of one boundary crossing, as `ReviewRecord.crossing` records it: a directory outside the
 * scope, a new host on an allowlist, running one call outside the sandbox, or a sensitive command.
 */
export type PermissionCrossingKind = "directory" | "host" | "outside-sandbox" | "sensitive";
/**
 * What a call grant authorizes: an exact directory and host expansion of the restricted scope, or
 * one Bash call run outside the OS sandbox (per-call sandbox escalation: full execution for that
 * call only, within the device's Full access ceiling).
 */
export type PermissionScopeKind = "directories-and-hosts" | "sandbox-escalation";
/**
 * The model's stated reason for one escalated call, shown to the person and the review model. A
 * background start (`run_in_background`) also says so: its process keeps running outside the
 * sandbox until it exits or is stopped, at most `maxSeconds` (the task's deadline).
 */
export type PermissionEscalation = Readonly<{
  justification: string;
  background?: true;
  maxSeconds?: number;
}>;
export type PermissionCandidate = Readonly<{
  binding: PermissionCallBinding;
  /** Empty for an escalation: the call runs with full execution, no expansion is named. */
  permissionScope: PermissionExpansion;
  targetPath?: string;
  scopeKind: PermissionScopeKind;
  /** Present exactly when `scopeKind` is `sandbox-escalation`. */
  escalation?: PermissionEscalation;
  candidateHash: string;
}>;
export type PermissionCandidateResult =
  | { kind: "in-scope" }
  | { kind: "proposal"; candidate: PermissionCandidate }
  | {
      kind: "unsupported";
      /** `protected-path`: its text already names the outside-sandbox escalation (no retry hint). */
      code: "unbounded-scope" | "escalation-unavailable" | "protected-path";
      message: string;
    };
export type PermissionReviewSnapshot = Readonly<
  Omit<PermissionCallBinding, "toolKey" | "specHash" | "callInputHash" | "resolvedInputHash"> & {
    baseReadDirectories: readonly string[];
    baseWriteDirectories: readonly string[];
    baseHosts: readonly string[];
    workingRoot: string;
    /**
     * The call's sandbox network (the device sandbox within the applied outer boundary): `open-public`,
     * `allowlist` (the base hosts plus accepted host grants) or `none`. Absent reads as `none`.
     */
    network?: "open-public" | "allowlist" | "none";
    /** The provider's boundary; absent reads as `operation`. */
    boundary?: "operation" | "instance";
    outsideSandboxCeiling: boolean;
    /** Restricted directory expansions beyond the working root (B2 broad project reach). */
    broadProjectReach: boolean;
    unattended: boolean;
    fullConsent: boolean;
    availability: { state: string; reason?: string };
    /**
     * The reason admission refuses this device (B-16): the recorded permission context withholds
     * its scope for the same state. Null or absent when admission may proceed.
     */
    admissionRefusal?: string | null;
    /**
     * The applied outer boundary of the device's installed environment (B-15): restricted hosts
     * outside a cloud allowlist are cut from the base, accepted additions and new proposals alike.
     * Null or absent when not proved.
     */
    outerNetwork?: AppliedOuterNetwork | null;
    policy: EffectiveDevicePolicy;
    /**
     * The per-call host grant ceiling (`device-sandbox.ts` `hostGrantCeiling`): the org's
     * exclusions and its hard allowlist ceiling. Absent: read `policy.network`.
     */
    hostCeiling?: HostGrantCeiling;
    /** Why a host is unavailable per call, naming who can add it; null when grantable. */
    hostRefusal?: (host: string) => string | null;
    /**
     * Why this call could not run outside the sandbox (per-call escalation): an unattended run, a
     * device, org or platform Full access ceiling that forbids it, or a runtime that cannot run
     * Full access now. Null or absent when an escalation may be reviewed.
     */
    escalationRefusal?: string | null;
  }
>;
