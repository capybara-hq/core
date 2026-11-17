import type { PermissionProfile } from "@capybara-hq/plugin-sdk";
import type { EffectiveDevicePolicy } from "./modes.js";

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
  | { source: "review-model"; reviewEventSeq: number; decidedBy: null };
export type PermissionCandidate = Readonly<{
  binding: PermissionCallBinding;
  permissionScope: PermissionExpansion;
  targetPath?: string;
  scopeKind: "directories-and-hosts";
  candidateHash: string;
}>;
export type PermissionCandidateResult =
  | { kind: "in-scope" }
  | { kind: "proposal"; candidate: PermissionCandidate }
  | { kind: "unsupported"; code: "unbounded-scope"; message: string };
export type PermissionReviewSnapshot = Readonly<
  Omit<PermissionCallBinding, "toolKey" | "specHash" | "callInputHash" | "resolvedInputHash"> & {
    baseReadDirectories: readonly string[];
    baseWriteDirectories: readonly string[];
    baseHosts: readonly string[];
    workingRoot: string;
    fullAccessCeiling: boolean;
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
    policy: EffectiveDevicePolicy;
  }
>;
