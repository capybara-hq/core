import {
  type ExecResult,
  SANDBOX_TAG_RE,
  type SandboxActor,
  type SandboxHandle,
  type SandboxProvider,
  validateAllowHost,
  validateSandboxPathShape,
} from "./sandbox.js";

/** The permission profile selected for a conversation. */
export type PermissionProfile = "request-approval" | "approve-for-me" | "full-access";

/** Accepts only the supported permission profile names. */
export function isPermissionProfile(value: unknown): value is PermissionProfile {
  return value === "request-approval" || value === "approve-for-me" || value === "full-access";
}

/** The provider cannot enforce the requested permission profile. */
export class SandboxPermissionUnsupportedError extends Error {
  readonly sandboxPermissionUnsupported = true as const;

  constructor(message: string, opts?: ErrorOptions) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "SandboxPermissionUnsupportedError";
  }
}

/** Recognizes the name and tag across SDK copies without requiring this class's identity. */
export function isSandboxPermissionUnsupportedError(
  e: unknown,
): e is SandboxPermissionUnsupportedError {
  return (
    e instanceof Error &&
    e.name === "SandboxPermissionUnsupportedError" &&
    (e as { sandboxPermissionUnsupported?: unknown }).sandboxPermissionUnsupported === true
  );
}

/** The requested operation is outside the permitted scope. */
export class SandboxScopeDeniedError extends Error {
  readonly sandboxScopeDenied = true as const;

  constructor(message: string, opts?: ErrorOptions) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "SandboxScopeDeniedError";
  }
}

/** Recognizes the name and tag across SDK copies without requiring this class's identity. */
export function isSandboxScopeDeniedError(e: unknown): e is SandboxScopeDeniedError {
  return (
    e instanceof Error &&
    e.name === "SandboxScopeDeniedError" &&
    (e as { sandboxScopeDenied?: unknown }).sandboxScopeDenied === true
  );
}

/** A scope or execution reference is malformed; validate it before performing any effects. */
export class SandboxScopeValidationError extends Error {
  readonly sandboxScopeValidation = true as const;

  constructor(message: string, opts?: ErrorOptions) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "SandboxScopeValidationError";
  }
}

/** Recognizes validation errors across SDK copies. */
export function isSandboxScopeValidationError(e: unknown): e is SandboxScopeValidationError {
  return (
    e instanceof Error &&
    e.name === "SandboxScopeValidationError" &&
    (e as { sandboxScopeValidation?: unknown }).sandboxScopeValidation === true
  );
}

/** An operation was consumed but its outcome is unknown. Never automatically retry with a new ID. */
export class SandboxOperationOutcomeUnknownError extends Error {
  readonly sandboxOperationOutcomeUnknown = true as const;

  constructor(message: string, opts?: ErrorOptions) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "SandboxOperationOutcomeUnknownError";
  }
}

/** Recognizes unknown outcomes across SDK copies; an unknown outcome is not a gone instance. */
export function isSandboxOperationOutcomeUnknownError(
  e: unknown,
): e is SandboxOperationOutcomeUnknownError {
  return (
    e instanceof Error &&
    e.name === "SandboxOperationOutcomeUnknownError" &&
    (e as { sandboxOperationOutcomeUnknown?: unknown }).sandboxOperationOutcomeUnknown === true
  );
}

/** Writable roots are also readable. Device scope uses the device's OS authority, never its host's. */
export type SandboxFileScope =
  | {
      readonly kind: "scoped";
      readonly readRoots: readonly string[];
      readonly writeRoots: readonly string[];
    }
  | { readonly kind: "device" };

/** Environment removes only the agent-specific filter; owner/org/provider ceilings still apply. */
export type SandboxNetworkScope =
  | { readonly kind: "none" }
  | { readonly kind: "allowlist"; readonly hosts: readonly string[] }
  /**
   * The public internet, decided on the resolved address against `AddressClass`
   * (`network-classes.ts`): every class in `OPEN_PUBLIC_DENIED_CLASSES` stays closed.
   */
  | { readonly kind: "open-public" }
  /** Only with `filesystem: { kind: "device" }` (and the reverse): the escalated (outside) call. */
  | { readonly kind: "environment" };

/** An operation locator for idempotent admission and revocation, never a credential. */
export interface SandboxOperationRef {
  readonly operationId: string;
  /** Absolute launch-admission deadline; does not shorten an already started execution's timeout. */
  readonly admitBeforeMs: number;
}

/**
 * A fresh grant for one method invocation. Providers must copy and freeze the input before use.
 * Full access normally uses device/environment; explicit bounded grants may expand other profiles.
 * Validation does not resolve authority or infer a grant from the profile name.
 */
export interface SandboxOperationScope extends SandboxOperationRef {
  readonly deviceId: string;
  readonly rootConversationId: string;
  readonly profileRevision: number;
  readonly ceilingRevision: string;
  readonly profile: PermissionProfile;
  readonly actor: Readonly<SandboxActor>;
  readonly tag: string;
  readonly filesystem: SandboxFileScope;
  readonly network: SandboxNetworkScope;
}

/**
 * Where a provider's sandbox boundary lies: around each operation (the OS sandbox of a local device,
 * the Linux per-operation runtime) or around the whole instance (a cloud container or microVM).
 */
export type SandboxBoundary = "operation" | "instance";

/**
 * Runtime support, version 2 (approval-only profiles design, "SDK and protocol"). `boundary:
 * "instance"` with `restricted: null` is a supported device whose scope is the whole instance.
 * `outsideSandbox` says whether a call can run outside the sandbox (an escalated call). Runtime
 * support, not consent.
 */
export interface SandboxPermissionSupport {
  readonly version: 2;
  readonly boundary: SandboxBoundary;
  readonly restricted: {
    readonly filesystem: true;
    readonly network: true;
    readonly native: true;
    readonly concurrentScopes: true;
  } | null;
  readonly network: {
    readonly openPublic: boolean;
    readonly allowlist: boolean;
    readonly perOperationHosts: boolean;
  };
  readonly outsideSandbox: boolean;
  readonly background: boolean;
  readonly unavailableReason?: string;
}

/** Actor and tag come only from the immutable operation scope. */
export type SandboxExecOptions = Omit<Parameters<SandboxProvider["exec"]>[1], "tag" | "actor">;

/**
 * A lightweight factory result: no worker opens until a method is called. Factory and method
 * signals jointly end the operation. Every method consumes its operation ID before effects;
 * a matching retry returns the recorded result or SandboxOperationOutcomeUnknownError, never
 * repeats effects. Missing operation support has no fallback to the provider's raw methods.
 * Native results and exec abort/timeout/output semantics match the existing provider contract.
 */
export interface SandboxOperation {
  exec(args: SandboxExecOptions): Promise<ExecResult>;
  readFile(
    path: string,
    opts: { maxBytes: number; signal: AbortSignal },
  ): Promise<{ data: Uint8Array; truncated: boolean } | null>;
  writeFile(path: string, data: Uint8Array, signal: AbortSignal): Promise<void>;
  stat(path: string, signal: AbortSignal): Promise<{ size: number; isDir: boolean } | null>;
  /** List and scan are optional together; without both, projects are unavailable. */
  list?(
    path: string,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<{ entries: { name: string; isDir: boolean }[]; truncated: boolean } | null>;
  scan?(
    base: string,
    opts: { signal: AbortSignal },
  ): Promise<{ path: string; suggestedName: string }[]>;
}

/** Trusted staging only: providers validate purpose-specific roots; user tools never supply this grant. */
export interface SandboxPreparationScope {
  readonly operationId: string;
  readonly deviceId: string;
  readonly purpose: "skills" | "attachments";
  readonly writeRoots: readonly string[];
  readonly tag: string;
}

/** Marker reads and writes inside trusted preparation roots, with no exec or network capability. */
export type SandboxPreparation = Pick<SandboxOperation, "readFile" | "writeFile" | "stat">;

/** Owner-authenticated browsing, independent of a conversation or its profile/consent. */
export interface SandboxBrowseScope extends SandboxOperationRef {
  readonly deviceId: string;
  readonly accountId: string;
  readonly ceilingRevision: string;
  readonly readRoots: readonly string[];
  readonly tag: string;
}

/** Browsing exposes metadata only: no file contents, writes, preparation or execution. */
export type SandboxBrowse = Pick<SandboxOperation, "stat"> &
  Required<Pick<SandboxOperation, "list" | "scan">>;

/** An opaque locator over authenticated transport; validate generation before status, tail or stop. */
export interface SandboxExecutionRef {
  readonly executionId: string;
  readonly operationId: string;
  readonly instanceId: string;
  readonly instanceGeneration: string;
}

/** A lost supervisor never binds this reference to a reused PID. */
export type SandboxExecutionStatus =
  | { state: "running" }
  | { state: "exited"; exitCode: number | null; timedOut: boolean }
  | { state: "lost" };

/** Atomically claimed terminal outcome; retries preserve it, including a prior natural exit. */
export type SandboxStopResult =
  | { outcome: "already-exited"; exitCode: number | null; timedOut: boolean }
  | { outcome: "stopped" }
  | { outcome: "cancel-pending" }
  | { outcome: "lost" };

/** Trusted exact-execution supervision. Status, tail and stop never provision or resume an instance. */
export interface SandboxBackground {
  /**
   * Persist exact ownership before acknowledging; retries of the same generation/operation/input
   * return the same reference. Retain starting grants for the lifetime of the owned execution.
   * Validate outputPath inside the scope. retainUntilMs bounds status/output record retention.
   * instanceGeneration is the kernel's generation of the held instance `h` (the kernel always
   * passes it, and allocates it only after `create` returns): a provider that keeps no generation
   * of its own (a cloud provider) returns it in the reference and keys start idempotency by it.
   */
  start(
    h: SandboxHandle,
    scope: SandboxOperationScope,
    args: SandboxExecOptions & {
      taskId: string;
      outputPath: string;
      retainUntilMs: number;
      instanceGeneration?: string;
    },
  ): Promise<SandboxExecutionRef>;
  status(
    h: SandboxHandle,
    ref: SandboxExecutionRef,
    signal: AbortSignal,
  ): Promise<SandboxExecutionStatus>;
  /** At most 65,536 bytes, preserving UTF-8 boundaries and existing final-line limits; no caller path. */
  tail(
    h: SandboxHandle,
    ref: SandboxExecutionRef,
    opts: { maxBytes: number; signal: AbortSignal },
  ): Promise<{ data: Uint8Array; truncated: boolean } | { unavailable: "lost" | "expired" }>;
  /**
   * Read retained raw merged-output bytes by exact reference, without a caller path, new scope,
   * exec, provisioning or resume. Validate before I/O: offset is a nonnegative safe integer;
   * maxBytes is an integer in [0, 65_536], including zero for a metadata-only probe. Invalid
   * bounds throw SandboxScopeDeniedError. The byte budget includes any caller-requested overlap.
   *
   * totalBytes is one committed append-only prefix snapshot pinned at read admission. Return
   * exactly min(maxBytes, max(totalBytes - offset, 0)) bytes starting at the requested offset,
   * without UTF-8 trimming or decoding; retry short reads or report lost. nextOffset equals
   * offset + data.byteLength. At/past the snapshot end, return empty data with unchanged offset.
   * Reads are non-destructive and repeatable; concurrent appends cannot change returned bytes
   * or this snapshot. Safe-integer position overflow fails collection rather than rounding.
   *
   * Missing/untrustworthy retained storage returns lost; a known expired record returns expired.
   * Exact-ref/device/generation mismatches remain scope-denied errors; aborts propagate.
   * Unlike tail, terminal reads retain every line. Current task access checks still apply.
   */
  readOutput(
    h: SandboxHandle,
    ref: SandboxExecutionRef,
    opts: { offset: number; maxBytes: number; signal: AbortSignal },
  ): Promise<
    | { data: Uint8Array; offset: number; nextOffset: number; totalBytes: number }
    | { unavailable: "lost" | "expired" }
  >;
  /** Persist pending cancellation while unreachable; apply it before an explicit resume can run work. */
  stop(
    h: SandboxHandle,
    ref: SandboxExecutionRef,
    opts: { graceMs: number; signal: AbortSignal },
  ): Promise<SandboxStopResult>;
}

function invalid(field: string, requirement: string): never {
  throw new SandboxScopeValidationError(
    `Invalid ${field}: ${requirement}. Supply a valid scope or reference before retrying.`,
  );
}

function record(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(field, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return invalid(field, "expected a plain object");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key))
      return invalid(field, "unknown fields are not allowed");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor))
      return invalid(field, "accessor fields are not allowed");
    result[key] = descriptor.value;
  }
  return result;
}

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return invalid(field, "expected a nonempty string of at most 128 characters");
  }
  return value;
}

function integer(value: unknown, minimum: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    return invalid(field, `expected a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function tag(value: unknown): string {
  if (typeof value !== "string" || !SANDBOX_TAG_RE.test(value))
    return invalid("tag", "expected 1–64 lowercase letters, digits or hyphens");
  return value;
}

function strings(
  value: unknown,
  maximum: number,
  check: (value: string) => string[],
  field: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum)
    return invalid(field, `expected an array of at most ${maximum} entries`);
  if (Reflect.ownKeys(value).length !== value.length + 1)
    return invalid(field, "sparse arrays and extra fields are not allowed");
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (!descriptor || !("value" in descriptor))
      return invalid(field, "expected array data entries");
    const item: unknown = descriptor.value;
    if (typeof item !== "string") return invalid(field, "expected string entries");
    const errors = check(item);
    if (errors.length > 0) return invalid(field, errors.join("; "));
    result.push(item);
  }
  return Object.freeze(result);
}

function roots(value: unknown, field: string): readonly string[] {
  return strings(value, 64, validateSandboxPathShape, field);
}

function fileScope(value: unknown): SandboxFileScope {
  const v = record(value, ["kind", "readRoots", "writeRoots"], "filesystem");
  if (v.kind === "device") {
    record(value, ["kind"], "filesystem");
    return Object.freeze({ kind: "device" });
  }
  if (v.kind !== "scoped") return invalid("filesystem.kind", "expected scoped or device");
  return Object.freeze({
    kind: "scoped",
    readRoots: roots(v.readRoots, "filesystem.readRoots"),
    writeRoots: roots(v.writeRoots, "filesystem.writeRoots"),
  });
}

function networkScope(value: unknown): SandboxNetworkScope {
  const v = record(value, ["kind", "hosts"], "network");
  if (v.kind === "none" || v.kind === "open-public" || v.kind === "environment") {
    record(value, ["kind"], "network");
    return Object.freeze({ kind: v.kind });
  }
  if (v.kind !== "allowlist")
    return invalid("network.kind", "expected none, allowlist, open-public or environment");
  return Object.freeze({
    kind: "allowlist",
    hosts: strings(v.hosts, 100, validateAllowHost, "network.hosts"),
  });
}

function actor(value: unknown): Readonly<SandboxActor> {
  const v = record(value, ["accountId", "conversationId", "runId"], "actor");
  return Object.freeze({
    accountId: id(v.accountId, "actor.accountId"),
    conversationId: id(v.conversationId, "actor.conversationId"),
    ...(Object.hasOwn(v, "runId") ? { runId: id(v.runId, "actor.runId") } : {}),
  });
}

function operationRef(v: Record<string, unknown>): SandboxOperationRef {
  return {
    operationId: id(v.operationId, "operationId"),
    admitBeforeMs: integer(v.admitBeforeMs, 1, "admitBeforeMs"),
  };
}

/** Pure structural validation and a frozen copy; no clock lookup or authority resolution. */
export function parseSandboxOperationRef(value: unknown): SandboxOperationRef {
  return Object.freeze(
    operationRef(record(value, ["operationId", "admitBeforeMs"], "operation reference")),
  );
}

/**
 * Validates a scope and returns a deeply frozen copy, throwing SandboxScopeValidationError.
 * IDs and ceiling revisions are bounded to 128 characters; roots to 64 paths of at most 4096 characters;
 * hosts to 100 entries passing validateAllowHost. Empty grants stay empty, including deny-all.
 * Performs no I/O, authority lookup or deadline refresh. Unknown fields are rejected at every level.
 * The `environment` network and the `device` filesystem are accepted only together.
 */
export function parseSandboxOperationScope(value: unknown): SandboxOperationScope {
  const v = record(
    value,
    [
      "operationId",
      "admitBeforeMs",
      "deviceId",
      "rootConversationId",
      "profileRevision",
      "ceilingRevision",
      "profile",
      "actor",
      "tag",
      "filesystem",
      "network",
    ],
    "operation scope",
  );
  if (!isPermissionProfile(v.profile))
    return invalid("profile", "expected request-approval, approve-for-me or full-access");
  const filesystem = fileScope(v.filesystem);
  const network = networkScope(v.network);
  // The device filesystem and the environment network are the two halves of the escalated call:
  // neither ever pairs with a sandboxed counterpart.
  if (network.kind === "environment" && filesystem.kind !== "device")
    return invalid(
      "network.kind: environment requires the device filesystem",
      "a scoped filesystem takes none, allowlist or open-public",
    );
  if (filesystem.kind === "device" && network.kind !== "environment")
    return invalid(
      "filesystem.kind: device requires the environment network",
      "the device filesystem is only the escalated call's",
    );
  return Object.freeze({
    ...operationRef(v),
    deviceId: id(v.deviceId, "deviceId"),
    rootConversationId: id(v.rootConversationId, "rootConversationId"),
    profileRevision: integer(v.profileRevision, 0, "profileRevision"),
    ceilingRevision: id(v.ceilingRevision, "ceilingRevision"),
    profile: v.profile,
    actor: actor(v.actor),
    tag: tag(v.tag),
    filesystem,
    network,
  });
}

/** Validates an owner browsing grant and returns a deeply frozen copy; no conversation is required. */
export function parseSandboxBrowseScope(value: unknown): SandboxBrowseScope {
  const v = record(
    value,
    [
      "operationId",
      "admitBeforeMs",
      "deviceId",
      "accountId",
      "ceilingRevision",
      "readRoots",
      "tag",
    ],
    "browse scope",
  );
  return Object.freeze({
    ...operationRef(v),
    deviceId: id(v.deviceId, "deviceId"),
    accountId: id(v.accountId, "accountId"),
    ceilingRevision: id(v.ceilingRevision, "ceilingRevision"),
    readRoots: roots(v.readRoots, "readRoots"),
    tag: tag(v.tag),
  });
}

/** Validates trusted staging structure and returns a deeply frozen copy; does not authorize its roots. */
export function parseSandboxPreparationScope(value: unknown): SandboxPreparationScope {
  const v = record(
    value,
    ["operationId", "deviceId", "purpose", "writeRoots", "tag"],
    "preparation scope",
  );
  if (v.purpose !== "skills" && v.purpose !== "attachments")
    return invalid("purpose", "expected skills or attachments");
  return Object.freeze({
    operationId: id(v.operationId, "operationId"),
    deviceId: id(v.deviceId, "deviceId"),
    purpose: v.purpose,
    writeRoots: roots(v.writeRoots, "writeRoots"),
    tag: tag(v.tag),
  });
}

/** Validates all four bounded locator fields and returns a frozen copy; does not authenticate the caller. */
export function parseSandboxExecutionRef(value: unknown): SandboxExecutionRef {
  const v = record(
    value,
    ["executionId", "operationId", "instanceId", "instanceGeneration"],
    "execution reference",
  );
  return Object.freeze({
    executionId: id(v.executionId, "executionId"),
    operationId: id(v.operationId, "operationId"),
    instanceId: id(v.instanceId, "instanceId"),
    instanceGeneration: id(v.instanceGeneration, "instanceGeneration"),
  });
}
