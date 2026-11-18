import type { SandboxRoots } from "@capybara-hq/plugin-sdk";
import type { PermissionContextV1 } from "../conversations/events.js";

/**
 * The complete identity a recorded permission context is read for: the calling conversation, its
 * run and the run's actor. Kernel-private; shared by the authority projection below runtime and the
 * runtime recorder above it, so neither imports the other's service.
 */
export interface PermissionContextSubject {
  orgId: string;
  conversationId: string;
  runId: string;
  accountId: string;
}

/**
 * What a managed operation entry already holds for the device it entered (Task 8 producer): the
 * installed instance incarnation and binding, its roots and the working root of the shared base
 * facts. Never read from model or tool input, never cached across operations.
 */
export interface HeldDeviceContextEvidence {
  deviceId: string;
  provider: string;
  instanceId: string;
  instanceGeneration: string;
  bindingId: string;
  roots: SandboxRoots;
  workingRoot: string;
}

/** The outer boundary a recorded context reports, as the applied environment proves it. */
export type AppliedOuterNetwork = NonNullable<PermissionContextV1["scope"]>["outerNetwork"];

/**
 * The installed environment of a device's current instance, proved by its installed binding and
 * current runtime attestation (B1 adapter). Null from the reader means unproved: the context is
 * unprobed and carries no scope.
 */
export interface AppliedEnvironment {
  location: "local" | "cloud";
  /** The provider of the installed instance (its row and its installed binding agree). */
  provider: string;
  instanceId: string;
  instanceGeneration: string;
  bindingId: string;
  roots: SandboxRoots;
  outerNetwork: AppliedOuterNetwork;
}

/**
 * The root or device the caller discovered before taking the authority locks is no longer the
 * conversation's: the held locks do not cover the current subject. The caller releases its
 * transaction and rediscovers (once); it never adds a lock under the existing ones.
 */
export class PermissionContextSubjectChanged extends Error {
  override readonly name = "PermissionContextSubjectChanged";
  constructor() {
    super("The conversation's root or device changed before its permission context was read");
  }
}

/**
 * The paired activation of the recorded permission context (Gate 9.4 with Task 8 phase 8.6): the
 * one explicit gate for both live producers, the request boundary (`RunSteps`) and the managed
 * device context writer (`BuiltinTools` into `common.ts`). Production provides nothing and reads
 * {@link PERMISSION_CONTEXT_ACTIVE}; tests provide this token to exercise either state.
 */
export const PERMISSION_CONTEXT_ACTIVATION = Symbol("PERMISSION_CONTEXT_ACTIVATION");

/** The production state of the gate: on since the paired activation (device protocol 3). */
export const PERMISSION_CONTEXT_ACTIVE = true;

/** Whether the live producers are on: an injected test value, else {@link PERMISSION_CONTEXT_ACTIVE}. */
export function permissionContextActive(injected: boolean | undefined): boolean {
  return injected ?? PERMISSION_CONTEXT_ACTIVE;
}
