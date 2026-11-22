/**
 * The device protocol: the WebSocket frames between the kernel and a `capybara-device` program
 * (a connected machine that serves as a device). Pure types and hand-written guards.
 *
 * The bodies of the dial-in envelope are parsed by `parseDeviceFrame` (second half of this file);
 * the per-operation argument and result guards of the first half are its value guards.
 */

import {
  parseSandboxBrowseScope,
  parseSandboxExecutionRef,
  parseSandboxOperationRef,
  parseSandboxOperationScope,
  parseSandboxPreparationScope,
  type SandboxPermissionSupport,
} from "./device-operation.js";
import {
  type ExecResult,
  isDeviceProjectName,
  MAX_DEVICE_LIST_ENTRIES,
  MAX_DEVICE_PROJECT_NAME_LENGTH,
  MAX_DEVICE_SCAN_DEPTH,
  MAX_DEVICE_SCAN_RESULTS,
  type NetworkBlockedHost,
  type NetworkBlockLayer,
  type SandboxActor,
  type SandboxLimits,
  type SandboxRoots,
  validateAllowHost,
  validateSandboxPathShape,
} from "./device-provider.js";

/** The major version of {@link DEVICE_DIAL_IN_PROTOCOL}. */
export const DEVICE_PROTOCOL_VERSION = 6;

/**
 * The dial-in protocol `capybara-device` speaks (`<name>/<major>`, see `DIAL_IN_PROTOCOL_RE`): the
 * value of the `X-Capybara-Device-Protocol` header, of the hello envelope's `protocol` and of the
 * sign-in's `protocol`. The provider serving its devices declares it as `permissions.dialIn`.
 * The kernel checks only the envelope (`DialInMachineFrame`); the bodies the envelope carries are
 * this module's ({@link parseDeviceFrame}).
 */
export const DEVICE_DIAL_IN_PROTOCOL = `capybara-device/${DEVICE_PROTOCOL_VERSION}` as const;

/** The operations the kernel asks a device to run. */
export type DeviceOp =
  | "create"
  | "exec"
  | "readFile"
  | "writeFile"
  | "stat"
  | "killTagged"
  | "killAll"
  | "stop"
  | "list"
  | "scan";

/**
 * Optional capabilities a device announces in its hello: `networkReport` means exec results may
 * carry `network`; `projects` means the device serves `list` and `scan` (the provider never sends
 * `list` or `scan` to a device that did not announce `projects`).
 */
export type DeviceFeature = "networkReport" | "projects";
const DEVICE_FEATURES: readonly DeviceFeature[] = ["networkReport", "projects"];

/**
 * What a device knows of its local policy and reports (in the hello or a `policy` event). The owner
 * ceiling travels separately, in the owner report ({@link DeviceOwnerCeiling}).
 */
export interface DeviceLocalPolicySummary {
  /** The device's sandbox allowlist (the owner's `allowedDomains`). */
  allowedDomains: string[];
}

/**
 * A directory a `scan` found that looks like a project (it holds `.git` or `AGENTS.md`): a
 * suggestion, not a project. `path` is absolute ({@link validateSandboxPathShape});
 * `suggestedName` is a guess from its basename ({@link isDeviceProjectName}) the owner may change.
 */
export interface DeviceProjectCandidate {
  path: string;
  suggestedName: string;
}

/** The most blocked hosts an exec result reports; the parser cuts longer lists. */
export const MAX_NETWORK_BLOCKED_HOSTS = 20;

/** The most hosts an exec's `grants` may carry. */
const MAX_POLICY_HOSTS = 100;

/**
 * The identity of a host's OS boot or of a program run: 1 to 128 characters of letters, digits,
 * `.`, `_`, `:` and `-`.
 */
export const DEVICE_BOOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Whether `v` is a well-formed boot or program-run identity ({@link DEVICE_BOOT_ID_RE}). */
export function isDeviceBootId(v: unknown): v is string {
  return typeof v === "string" && DEVICE_BOOT_ID_RE.test(v);
}

/** Error kinds a device reports for a failed request. */
export type DeviceErrorKind = "gone" | "fs_gone" | "policy" | "error";

export interface DeviceExecArgs {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  tag: string;
  actor: SandboxActor;
  limits: SandboxLimits;
  /**
   * Hosts the kernel allows for this command beyond the local policy (a run's "Allow this time" or
   * a
   * scheduled task's grants). A device applies them only in sandbox mode, within `limits`; a
   * device without the feature ignores the field.
   */
  grants?: DeviceExecGrants;
}
/** Extra hosts for one exec and where they come from (logged by the device with the command). */
export interface DeviceExecGrants {
  hosts: string[];
  source: { kind: "run" | "task"; id: string; accountId: string };
}
export type DeviceExecResult = ExecResult;
export interface DeviceReadFileArgs {
  path: string;
  maxBytes: number;
}
export type DeviceReadFileResult = { dataB64: string; truncated: boolean } | null;
export interface DeviceWriteFileArgs {
  path: string;
  dataB64: string;
}
export type DeviceWriteFileResult = null;
export interface DeviceStatArgs {
  path: string;
}
export type DeviceStatResult = { size: number; isDir: boolean } | null;
export interface DeviceKillTaggedArgs {
  tags: string[];
}
export type DeviceKillAllArgs = Record<string, never>;
export interface DeviceCreateArgs {
  limits: SandboxLimits;
}
export interface DeviceCreateResult {
  roots: SandboxRoots;
}
export interface DeviceStopArgs {
  reason: "revoked" | "deleted";
}
/**
 * Lists one directory (absolute `path`, {@link validateSandboxPathShape}): at most `limit` entries
 * (at most {@link MAX_DEVICE_LIST_ENTRIES}), read within the operation's scope. See
 * `DeviceProvider.list` for the semantics.
 */
export interface DeviceListArgs {
  path: string;
  limit: number;
}
/**
 * One entry of a listed directory: `name` is never empty, `.` or `..` and holds no `/`. `isDir`
 * follows symbolic links (stat semantics): a link to a directory is `true`, a dangling link `false`,
 * and so is a link whose target the request's mode cannot reach.
 */
export interface DeviceListEntry {
  name: string;
  isDir: boolean;
}
/**
 * The directory's entries sorted by code unit, `truncated` when more than `limit` exist; null only
 * when the path does not exist and the request's mode could reach it (like `stat` / `readFile`).
 * A file, an unreadable directory, or a path the request's mode cannot reach is an error (the
 * latter a `policy` refusal), never null.
 */
export type DeviceListResult = { entries: DeviceListEntry[]; truncated: boolean } | null;
/**
 * Looks for project-like directories under `base` (absolute, {@link validateSandboxPathShape}),
 * read within the operation's scope. A `base` that does not exist answers `[]`; a `base` that is a
 * file, unreadable, or outside the request's scope is an error. See `DeviceProvider.scan` for the
 * traversal.
 */
export interface DeviceScanArgs {
  base: string;
}
/**
 * `base` itself and the directories at most {@link MAX_DEVICE_SCAN_DEPTH} levels below it that
 * hold a `.git` entry or an `AGENTS.md` file, sorted by `path` in code-unit order and cut to the
 * first {@link MAX_DEVICE_SCAN_RESULTS}. Never file contents. See `DeviceProvider.scan`.
 */
export type DeviceScanResult = DeviceProjectCandidate[];

/** A frame that is not valid device protocol (or came from the wrong side). */
export class DeviceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceProtocolError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new DeviceProtocolError(`field "${k}" must be a string`);
  return v;
}

function nonEmptyStr(o: Record<string, unknown>, k: string): string {
  const v = str(o, k);
  if (v === "") throw new DeviceProtocolError(`field "${k}" must not be empty`);
  return v;
}

function posInt(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new DeviceProtocolError(`field "${k}" must be a positive integer`);
  }
  return v;
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!isRecord(v)) throw new DeviceProtocolError(`${what} must be an object`);
  return v;
}

function bool(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new DeviceProtocolError(`field "${k}" must be a boolean`);
  return v;
}

function strArray(o: Record<string, unknown>, k: string, label: string = k): string[] {
  const v = o[k];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new DeviceProtocolError(`field "${label}" must be an array of strings`);
  }
  return v as string[];
}

/**
 * The exec `limits`: resources and the outer network (no mode: protocol 4 removed it). Unknown
 * keys are refused, so a stale `mode` (or any field the device would ignore) is never accepted.
 */
function parseLimits(v: unknown): SandboxLimits {
  const o = strictRecord(v, ["cpu", "memoryMb", "diskMb", "network"], 'field "limits"');
  const network = strictRecord(o.network, ["kind", "hosts"], 'field "network"');
  const kind = oneOf(network, "kind", ["open-public", "allowlist"] as const);
  const hosts = strArray(network, "hosts", "network.hosts");
  for (const h of hosts) {
    const problems = validateAllowHost(h);
    if (problems.length > 0) {
      throw new DeviceProtocolError(`invalid network host "${h}": ${problems.join("; ")}`);
    }
  }
  return {
    cpu: num(o, "cpu"),
    memoryMb: num(o, "memoryMb"),
    diskMb: num(o, "diskMb"),
    network: { kind, hosts },
  };
}

function oneOf<T extends string>(o: Record<string, unknown>, k: string, values: readonly T[]): T {
  const v = str(o, k);
  if (!(values as readonly string[]).includes(v)) {
    throw new DeviceProtocolError(`unknown ${k} "${v}"`);
  }
  return v as T;
}

function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new DeviceProtocolError(`field "${k}" must be a number`);
  }
  return v;
}

function parseRoots(v: unknown): SandboxRoots {
  if (!isRecord(v)) throw new DeviceProtocolError('field "roots" must be an object');
  const roots = {} as Record<string, string>;
  for (const k of ["workspace", "skills", "tmp"] as const) {
    const p = str(v, k);
    if (!p.startsWith("/")) {
      throw new DeviceProtocolError(`root "${k}" must be an absolute path`);
    }
    // the kernel builds paths as `${root}/…` and checks membership by prefix: a root must be a
    // clean absolute directory path
    const shape = validateSandboxPathShape(p);
    if (shape.length > 0) throw new DeviceProtocolError(`root "${k}": ${shape.join("; ")}`);
    if (p.endsWith("/")) {
      throw new DeviceProtocolError(`root "${k}" must not end with a slash`);
    }
    roots[k] = p;
  }
  return roots as unknown as SandboxRoots;
}

function hostArray(o: Record<string, unknown>, k: string): string[] {
  const v = strArray(o, k);
  if (v.length > MAX_POLICY_HOSTS) {
    throw new DeviceProtocolError(`field "${k}" must have at most ${MAX_POLICY_HOSTS} entries`);
  }
  return v;
}

/** A bounded array field of a result or summary, refused when it is longer than `max`. */
function boundedArray(v: unknown, label: string, max: number, what: string): unknown[] {
  if (!Array.isArray(v)) {
    throw new DeviceProtocolError(`field "${label}" must be an array of ${what}`);
  }
  if (v.length > max) {
    throw new DeviceProtocolError(`field "${label}" must have at most ${max} entries`);
  }
  return v;
}

/** A project name field (see {@link isDeviceProjectName}), named by `what` in the message. */
function projectName(v: unknown, what: string): string {
  if (!isDeviceProjectName(v)) {
    throw new DeviceProtocolError(
      `${what} must be a non-empty name of at most ${MAX_DEVICE_PROJECT_NAME_LENGTH} UTF-16 code units, not "." or "..", without "/", control characters or leading or trailing whitespace`,
    );
  }
  return v;
}

/** An absolute path field ({@link validateSandboxPathShape}), named by `what` in the message. */
function absolutePath(v: unknown, what: string): string {
  if (typeof v !== "string") throw new DeviceProtocolError(`${what} must be a string`);
  const problems = validateSandboxPathShape(v);
  if (problems.length > 0) throw new DeviceProtocolError(`${what}: ${problems.join("; ")}`);
  return v;
}

/** A `list` result: null, or at most {@link MAX_DEVICE_LIST_ENTRIES} named entries. */
function parseListResult(result: unknown): DeviceListResult {
  if (result === null) return null;
  const r = obj(result, "list result");
  const entries = boundedArray(r.entries, "entries", MAX_DEVICE_LIST_ENTRIES, "entries").map(
    (e, i) => {
      const what = `field "entries[${i}]"`;
      if (!isRecord(e)) throw new DeviceProtocolError(`${what} must be an object`);
      const name = e.name;
      if (
        typeof name !== "string" ||
        name === "" ||
        name === "." ||
        name === ".." ||
        name.includes("/")
      ) {
        throw new DeviceProtocolError(
          `${what}.name must be a non-empty string without "/", other than "." and ".."`,
        );
      }
      return { name, isDir: bool(e, "isDir") };
    },
  );
  return { entries, truncated: bool(r, "truncated") };
}

/** A `scan` result: at most {@link MAX_DEVICE_SCAN_RESULTS} candidates. */
function parseScanResult(v: unknown): DeviceScanResult {
  const label = "scan result";
  return boundedArray(v, label, MAX_DEVICE_SCAN_RESULTS, "candidates").map((e, i) => {
    const what = `field "${label}[${i}]"`;
    if (!isRecord(e)) throw new DeviceProtocolError(`${what} must be an object`);
    return {
      path: absolutePath(e.path, `${what}.path`),
      suggestedName: projectName(e.suggestedName, `${what}.suggestedName`),
    };
  });
}

function parsePolicySummary(v: unknown): DeviceLocalPolicySummary {
  const o = obj(v, 'field "policy"');
  return { allowedDomains: strArray(o, "allowedDomains") };
}

/** Optional hello fields: malformed values are ignored so old and new peers interoperate. */
function optionalHelloFields(
  o: Record<string, unknown>,
): Pick<DeviceHello, "features" | "policy" | "home"> {
  const out: Pick<DeviceHello, "features" | "policy" | "home"> = {};
  if (Array.isArray(o.features)) {
    out.features = DEVICE_FEATURES.filter((f) => (o.features as unknown[]).includes(f));
  }
  if (typeof o.home === "string" && validateSandboxPathShape(o.home).length === 0) {
    out.home = o.home;
  }
  return { ...out, ...optionalPolicy(o.policy) };
}

/** A summary field that is dropped when absent or unreadable. */
function optionalPolicy(v: unknown): Pick<DeviceHello, "policy"> {
  if (v === undefined) return {};
  try {
    return { policy: parsePolicySummary(v) };
  } catch {
    // an unreadable summary is the same as none: the kernel learns the policy later
    return {};
  }
}

const BLOCK_LAYERS: readonly NetworkBlockLayer[] = ["device", "org", "address", "unknown"];

/**
 * The valid entries of an exec result's `network.blocked`: a host that fails
 * {@link validateAllowHost} is kept only with layer `address`; anything malformed is dropped;
 * at most {@link MAX_NETWORK_BLOCKED_HOSTS}. Undefined when the field is not a report at all.
 */
function parseNetworkReport(v: unknown): { blocked: NetworkBlockedHost[] } | undefined {
  if (!isRecord(v) || !Array.isArray(v.blocked)) return undefined;
  const blocked: NetworkBlockedHost[] = [];
  for (const e of v.blocked) {
    if (blocked.length >= MAX_NETWORK_BLOCKED_HOSTS) break;
    if (!isRecord(e)) continue;
    const { host, port, layer } = e;
    if (typeof host !== "string" || host === "" || host.length > 255) continue;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (!BLOCK_LAYERS.includes(layer as NetworkBlockLayer)) continue;
    if (layer !== "address" && validateAllowHost(host).length > 0) continue;
    blocked.push({ host, port, layer: layer as NetworkBlockLayer });
  }
  return { blocked };
}

function validateArgs(op: DeviceOp, a: Record<string, unknown>): void {
  switch (op) {
    case "exec": {
      nonEmptyStr(a, "command");
      posInt(a, "timeoutMs");
      posInt(a, "maxOutputBytes");
      str(a, "tag");
      const actor = obj(a.actor, 'field "actor"');
      str(actor, "accountId");
      str(actor, "conversationId");
      if (actor.runId !== undefined) str(actor, "runId");
      parseLimits(a.limits);
      if (a.grants !== undefined) {
        const g = obj(a.grants, 'field "grants"');
        hostArray(g, "hosts");
        const src = obj(g.source, 'field "grants.source"');
        const kind = str(src, "kind");
        if (kind !== "run" && kind !== "task") {
          throw new DeviceProtocolError(`unknown grant source kind "${kind}"`);
        }
        nonEmptyStr(src, "id");
        nonEmptyStr(src, "accountId");
      }
      if (a.cwd !== undefined) str(a, "cwd");
      if (a.env !== undefined) {
        const env = obj(a.env, 'field "env"');
        for (const k of Object.keys(env)) str(env, k);
      }
      return;
    }
    case "readFile": {
      str(a, "path");
      const m = a.maxBytes;
      if (typeof m !== "number" || !Number.isInteger(m) || m < 0) {
        throw new DeviceProtocolError('field "maxBytes" must be a non-negative integer');
      }
      return;
    }
    case "writeFile":
      str(a, "path");
      str(a, "dataB64");
      return;
    case "stat":
      str(a, "path");
      return;
    case "killTagged":
      strArray(a, "tags");
      return;
    case "killAll":
      return;
    case "create":
      parseLimits(a.limits);
      return;
    case "stop": {
      const r = str(a, "reason");
      if (r !== "revoked" && r !== "deleted") {
        throw new DeviceProtocolError(`unknown stop reason "${r}"`);
      }
      return;
    }
    case "list": {
      absolutePath(a.path, 'field "path"');
      const limit = posInt(a, "limit");
      if (limit > MAX_DEVICE_LIST_ENTRIES) {
        throw new DeviceProtocolError(`field "limit" must be at most ${MAX_DEVICE_LIST_ENTRIES}`);
      }
      return;
    }
    case "scan":
      absolutePath(a.base, 'field "base"');
      return;
  }
}

/** Result type per op. */
export interface DeviceOpResults {
  create: DeviceCreateResult;
  exec: DeviceExecResult;
  readFile: DeviceReadFileResult;
  writeFile: DeviceWriteFileResult;
  stat: DeviceStatResult;
  killTagged: null;
  killAll: null;
  stop: null;
  list: DeviceListResult;
  scan: DeviceScanResult;
}

/** Validates the `result` of a successful `res` for `op`; throws {@link DeviceProtocolError}. */
export function parseOpResult<Op extends DeviceOp>(op: Op, result: unknown): DeviceOpResults[Op];
export function parseOpResult(op: DeviceOp, result: unknown): DeviceOpResults[DeviceOp] {
  switch (op) {
    case "exec": {
      const r = obj(result, "exec result");
      const exitCode = r.exitCode;
      if (exitCode !== null && (typeof exitCode !== "number" || !Number.isFinite(exitCode))) {
        throw new DeviceProtocolError('field "exitCode" must be a number or null');
      }
      const out: ExecResult = {
        exitCode: exitCode as number | null,
        stdout: str(r, "stdout"),
        stderr: str(r, "stderr"),
        truncated: bool(r, "truncated"),
        timedOut: bool(r, "timedOut"),
      };
      // an optional report: a malformed one is dropped, never failing the command's result
      const network = parseNetworkReport(r.network);
      if (network) out.network = network;
      return out;
    }
    case "readFile": {
      if (result === null) return null;
      const r = obj(result, "readFile result");
      return { dataB64: str(r, "dataB64"), truncated: bool(r, "truncated") };
    }
    case "stat": {
      if (result === null) return null;
      const r = obj(result, "stat result");
      return { size: num(r, "size"), isDir: bool(r, "isDir") };
    }
    case "create":
      return { roots: parseRoots(obj(result, "create result").roots) };
    case "list":
      return parseListResult(result);
    case "scan":
      return parseScanResult(result);
    default:
      if (result !== null) throw new DeviceProtocolError(`${op} result must be null`);
      return null;
  }
}

// ---- Protocol 5: scope-bearing operations ----

/**
 * The operations the kernel asks a protocol 5 device to run: every user operation carries its
 * admitted scope; there is no broad kill (`killTagged` / `killAll`) and no deployment-side change
 * of the machine's policy: the owner changes it on the machine and the device reports the change
 * ({@link DevicePolicyChanged}).
 */
export type DeviceOperation =
  | Exclude<DeviceOp, "killTagged" | "killAll">
  | "prepareReadFile"
  | "prepareWriteFile"
  | "prepareStat"
  | "browseStat"
  | "browseList"
  | "browseScan"
  | "backgroundStart"
  | "backgroundStatus"
  | "backgroundTail"
  | "backgroundReadOutput"
  | "backgroundStop"
  | "revokeOperation"
  | "bindInstance";
/**
 * How far a connection's project paths reach: `machine` (any path the deny list leaves), `paths`
 * (the listed project paths) or `workspace` (the connection's working directory only).
 */
export type DeviceProjectReach = "machine" | "paths" | "workspace";
/** Why a device refused a project path: the `refusal` of a `project_refused` outcome. */
export type DeviceProjectRefusal = "other-connection" | "outside-reach" | "denied";
/** The sandbox network of a device: the open public internet or an allowlist. */
export type DeviceNetworkMode = "open" | "allowlist";
/**
 * The owner ceiling of protocol 4 (approval-only profiles design, "Settings model"): the device
 * sandbox for every profile. `outsideSandbox` is whether a call may be granted escalation outside
 * the sandbox; `network` and `allowedDomains` are the sandbox network.
 */
export interface DeviceOwnerCeiling {
  readonly version: 3;
  readonly sequence: number;
  readonly revision: string;
  readonly outsideSandbox: boolean;
  readonly network: DeviceNetworkMode;
  readonly allowedDomains: readonly string[];
  readonly projectReach: DeviceProjectReach;
}
/**
 * An event body (the envelope's `event`): the owner changed the machine's policy or owner ceiling
 * while connected. `policy` is absent when the summary was unreadable.
 */
export interface DevicePolicyChanged {
  type: "policy";
  policy?: DeviceLocalPolicySummary;
  ownerCeiling: DeviceOwnerCeiling;
}
/**
 * The hello body (the envelope's `hello` carries the program facts: protocol, program version,
 * os, arch, boot and run identities, frame capacity). `policy` and `ownerCeiling` are the
 * machine's own narrowing, read by the provider serving the device.
 */
export interface DeviceHello {
  mode: "os" | "docker";
  roots: SandboxRoots;
  sessionIsolation: boolean;
  /** Optional capabilities (unknown entries are dropped by the parser). */
  features?: DeviceFeature[];
  /** The device's local policy summary (dropped by the parser when unreadable). */
  policy?: DeviceLocalPolicySummary;
  /**
   * The owner's home directory, an absolute path (a local device; the base of an auto-mode
   * project's relative path). A malformed value is dropped by the parser.
   */
  home?: string;
  permissionSupport: SandboxPermissionSupport;
  ownerCeiling: DeviceOwnerCeiling;
  instanceGeneration: string | null;
  /** Absent until the program can attest actual installed runtime/helper/environment bytes. */
  runtimeIdentity?: DeviceRuntimeIdentity;
}
/** A verified installed runtime/helper/environment identity bound to one instance generation. */
export interface DeviceRuntimeIdentity {
  runtimeHash: string;
  helperHash: string;
  imageFingerprint: string;
  instanceGeneration: string;
}
/**
 * Private lifecycle request (permission runtime cutover B4): binds the kernel's committed instance
 * generation to the device after commit. It carries no path, policy or manifest.
 */
export interface BindInstanceRequest {
  instanceId: string;
  instanceGeneration: string;
  bindingId: string;
  expectedPreviousGeneration: string | null;
}
export interface BindInstanceResult {
  instanceId: string;
  instanceGeneration: string;
  bindingId: string;
  runtimeIdentity: DeviceRuntimeIdentity;
  permissionSupport: SandboxPermissionSupport;
  ownerCeiling: DeviceOwnerCeiling;
}
export interface BackgroundReadOutputRequest {
  offset: number;
  maxBytes: number;
}
export type BackgroundReadOutputResult =
  | { dataB64: string; offset: number; nextOffset: number; totalBytes: number }
  | { unavailable: "lost" | "expired" };

/** A request body (the envelope's `req`): one operation and its arguments. */
export interface DeviceRequestBody {
  op: DeviceOperation;
  args: Readonly<Record<string, unknown>>;
}
/** A request as the device serves it: its body with the envelope's `id` and `deadlineMs`. */
export interface KernelRequest extends DeviceRequestBody {
  type: "req";
  id: string;
  deadlineMs: number;
}
/** A response body (the envelope's `res`): the result, or the typed failure. */
export type DeviceResponseBody =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: {
        /**
         * The typed failure: `denied`, `unsupported`, `unknown` and `invalid` carry the SDK's
         * scope denial, unsupported permission, unknown outcome and scope validation errors.
         * `invalid` never proves the operation had no effect (a skewed device may have parsed
         * part of it): it must never join the not-run refusals (`isRefusal`, `failureKindOf`).
         */
        kind:
          | "gone"
          | "fs_gone"
          | "policy"
          | "error"
          | "denied"
          | "unsupported"
          | "unsettled"
          | "unknown"
          | "invalid"
          | "project_refused";
        message: string;
        /** Present on `project_refused` only: why the project path was refused. */
        refusal?: DeviceProjectRefusal;
      };
    };
/** A response as the device produces it: its body with the envelope's `id`. */
export type DeviceResponse = { type: "res"; id: string } & DeviceResponseBody;
/** The bodies of protocol 5, by the envelope frame that carries them. */
export interface DeviceBodies {
  hello: DeviceHello;
  req: DeviceRequestBody;
  res: DeviceResponseBody;
  event: DevicePolicyChanged;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DeviceProtocolError("Expected an object");
  return value as Record<string, unknown>;
};
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new DeviceProtocolError(`Unknown field ${key}`);
}
function string(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new DeviceProtocolError("Expected a bounded nonempty string");
  return value;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new DeviceProtocolError("Expected a bounded integer");
  return value;
}
function path(value: unknown): void {
  if (typeof value !== "string" || validateSandboxPathShape(value).length)
    throw new DeviceProtocolError("Expected an absolute filesystem path");
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
/**
 * A strict copy of a wire object for the protocol 4 shapes: a plain object of own data properties
 * only (no accessor is ever invoked, so a value cannot change between check and use), each key in
 * `allowed`. Nested values are copied by the caller's own checks.
 */
function strictRecord(value: unknown, allowed: readonly string[], what: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new DeviceProtocolError(`Invalid ${what}: expected an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new DeviceProtocolError(`Invalid ${what}: expected a plain object`);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key))
      throw new DeviceProtocolError(`Invalid ${what}: unknown field ${String(key)}`);
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d))
      throw new DeviceProtocolError(`Invalid ${what}: accessor fields are not allowed`);
    if (d.value !== undefined) out[key] = d.value;
  }
  return out;
}
function strictHosts(value: unknown, what: string): string[] {
  if (!Array.isArray(value))
    throw new DeviceProtocolError(`Invalid ${what}: expected at most 100 hosts`);
  // one read of the length: a proxy or a getter cannot grow the list between check and copy
  const length: number = value.length;
  if (length > 100) throw new DeviceProtocolError(`Invalid ${what}: expected at most 100 hosts`);
  const hosts: string[] = [];
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, i);
    const h: unknown = d && "value" in d ? d.value : undefined;
    if (typeof h !== "string" || validateAllowHost(h).length)
      throw new DeviceProtocolError(`Invalid ${what}: expected hostnames or *.domain patterns`);
    hosts.push(h);
  }
  return hosts;
}
function strictBoolean(o: Record<string, unknown>, key: string, what: string): boolean {
  const v = o[key];
  if (typeof v !== "boolean")
    throw new DeviceProtocolError(`Invalid ${what}: ${key} must be a boolean`);
  return v;
}

/**
 * Strictly parses a runtime permission report, version 2 (the protocol 4 `permissionSupport`, also
 * the shape a cloud provider reports), and returns a frozen copy; throws {@link DeviceProtocolError}.
 * Restricted support is all four claims or `null`; per-operation hosts need the allowlist; an
 * operation boundary without restricted support claims no sandbox network at all. An
 * instance boundary is the whole instance: it claims no restricted per-operation scope, no
 * outside-sandbox escalation and no per-operation hosts (a host joins the device's list instead).
 */
export function parseSandboxPermissionSupport(value: unknown): SandboxPermissionSupport {
  const what = "runtime permission report";
  const o = strictRecord(
    value,
    [
      "version",
      "boundary",
      "restricted",
      "network",
      "outsideSandbox",
      "background",
      "unavailableReason",
    ],
    what,
  );
  if (o.version !== 2) throw new DeviceProtocolError(`Invalid ${what}: expected version 2`);
  if (o.boundary !== "operation" && o.boundary !== "instance")
    throw new DeviceProtocolError(`Invalid ${what}: boundary must be operation or instance`);
  let restricted: SandboxPermissionSupport["restricted"] = null;
  if (o.restricted !== null) {
    const claims = ["filesystem", "network", "native", "concurrentScopes"] as const;
    const r = strictRecord(o.restricted, claims, `${what} restricted claims`);
    if (claims.some((k) => r[k] !== true))
      throw new DeviceProtocolError(`Invalid ${what}: restricted support needs all four claims`);
    restricted = { filesystem: true, network: true, native: true, concurrentScopes: true };
  }
  const n = strictRecord(
    o.network,
    ["openPublic", "allowlist", "perOperationHosts"],
    `${what} network`,
  );
  const network = {
    openPublic: strictBoolean(n, "openPublic", what),
    allowlist: strictBoolean(n, "allowlist", what),
    perOperationHosts: strictBoolean(n, "perOperationHosts", what),
  };
  if (
    o.boundary === "operation" &&
    restricted === null &&
    (network.openPublic || network.allowlist || network.perOperationHosts)
  )
    throw new DeviceProtocolError(
      `Invalid ${what}: without restricted support an operation boundary has no sandbox network`,
    );
  if (network.perOperationHosts && !network.allowlist)
    throw new DeviceProtocolError(`Invalid ${what}: per-operation hosts need the allowlist`);
  const outsideSandbox = strictBoolean(o, "outsideSandbox", what);
  const background = strictBoolean(o, "background", what);
  if (
    o.boundary === "instance" &&
    (restricted !== null || outsideSandbox || network.perOperationHosts)
  )
    throw new DeviceProtocolError(
      `Invalid ${what}: an instance boundary claims no restricted scope, outside escalation or per-operation hosts`,
    );
  if (o.unavailableReason !== undefined) string(o.unavailableReason, 4096);
  return freeze({
    version: 2,
    boundary: o.boundary,
    restricted,
    network,
    outsideSandbox,
    background,
    ...(o.unavailableReason !== undefined
      ? { unavailableReason: o.unavailableReason as string }
      : {}),
  });
}

/**
 * Strictly parses one authenticated owner-ceiling report of protocol 4 and returns a frozen copy;
 * throws {@link DeviceProtocolError}. Unknown fields (the protocol 3 `fullAccess` and
 * `restrictedAllowedDomains` among them) are refused.
 */
export function parseOwnerCeilingReport(value: unknown): DeviceOwnerCeiling {
  const what = "owner ceiling report";
  const o = strictRecord(
    value,
    [
      "version",
      "sequence",
      "revision",
      "outsideSandbox",
      "network",
      "allowedDomains",
      "projectReach",
    ],
    what,
  );
  if (o.version !== 3) throw new DeviceProtocolError(`Invalid ${what}: expected version 3`);
  if (o.network !== "open" && o.network !== "allowlist")
    throw new DeviceProtocolError(`Invalid ${what}: network must be open or allowlist`);
  if (o.projectReach !== "machine" && o.projectReach !== "paths" && o.projectReach !== "workspace")
    throw new DeviceProtocolError(
      `Invalid ${what}: project reach must be machine, paths or workspace`,
    );
  return freeze({
    version: 3,
    sequence: integer(o.sequence),
    revision: string(o.revision, 512),
    outsideSandbox: strictBoolean(o, "outsideSandbox", what),
    network: o.network,
    allowedDomains: strictHosts(o.allowedDomains, `${what} allowedDomains`),
    projectReach: o.projectReach,
  });
}

const GENERATION = /^[0-9]{1,16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function generation(value: unknown): string {
  if (typeof value !== "string" || !GENERATION.test(value))
    throw new DeviceProtocolError("Expected an instance generation");
  return value;
}
function bindRequest(a: Record<string, unknown>): BindInstanceRequest {
  string(a.instanceId);
  generation(a.instanceGeneration);
  if (typeof a.bindingId !== "string" || !UUID.test(a.bindingId))
    throw new DeviceProtocolError("Expected a binding id");
  if (a.expectedPreviousGeneration !== null) {
    generation(a.expectedPreviousGeneration);
    if (BigInt(a.expectedPreviousGeneration as string) >= BigInt(a.instanceGeneration as string))
      throw new DeviceProtocolError("Previous generation must precede the bound generation");
  }
  return a as unknown as BindInstanceRequest;
}
function identity(value: unknown): DeviceRuntimeIdentity {
  const o = object(value);
  keys(o, ["runtimeHash", "helperHash", "imageFingerprint", "instanceGeneration"]);
  for (const key of ["runtimeHash", "helperHash", "imageFingerprint"])
    if (typeof o[key] !== "string" || !/^[a-f0-9]{64}$/.test(o[key] as string))
      throw new DeviceProtocolError("Incomplete runtime identity");
  string(o.instanceGeneration);
  return o as unknown as DeviceRuntimeIdentity;
}
const natives = ["exec", "readFile", "writeFile", "stat", "list", "scan"];
/** The machine lifecycle operations, checked by the protocol 2 argument guards. */
const lifecycle = ["create", "stop"];
function requestBody(value: unknown): DeviceRequestBody {
  const o = object(value);
  keys(o, ["op", "args"]);
  const op = string(o.op),
    a = object(o.args);
  if (lifecycle.includes(op)) {
    validateArgs(op as DeviceOp, a);
    return freeze({ op: op as DeviceOperation, args: a });
  }
  if (op === "bindInstance") {
    keys(a, ["instanceId", "instanceGeneration", "bindingId", "expectedPreviousGeneration"]);
    bindRequest(a);
  } else if (op === "revokeOperation") {
    keys(a, ["ref"]);
    a.ref = parseSandboxOperationRef(a.ref);
  } else if (
    ["backgroundStatus", "backgroundTail", "backgroundReadOutput", "backgroundStop"].includes(op)
  ) {
    keys(a, [
      "ref",
      ...(op === "backgroundReadOutput" ? ["offset", "maxBytes"] : []),
      ...(op === "backgroundTail" ? ["maxBytes"] : op === "backgroundStop" ? ["graceMs"] : []),
    ]);
    a.ref = parseSandboxExecutionRef(a.ref);
    if (op === "backgroundTail" || op === "backgroundReadOutput") integer(a.maxBytes, 0, 65536);
    if (op === "backgroundReadOutput") integer(a.offset);
    if (op === "backgroundStop") integer(a.graceMs, 0, 60000);
  } else {
    const preparation = op.startsWith("prepare"),
      browsing = op.startsWith("browse"),
      background = op === "backgroundStart";
    const method = background ? "exec" : preparation ? op.slice(7) : browsing ? op.slice(6) : op;
    const native = method[0]?.toLowerCase() + method.slice(1);
    if (
      !natives.includes(native) ||
      (preparation && !["readFile", "writeFile", "stat"].includes(native)) ||
      (browsing && !["stat", "list", "scan"].includes(native))
    )
      throw new DeviceProtocolError("Unknown operation");
    a.scope = preparation
      ? parseSandboxPreparationScope(a.scope)
      : browsing
        ? parseSandboxBrowseScope(a.scope)
        : parseSandboxOperationScope(a.scope);
    const fields =
      native === "exec"
        ? ["command", "cwd", "env", "timeoutMs", "maxOutputBytes", "limits", "grants"]
        : native === "readFile"
          ? ["path", "maxBytes"]
          : native === "writeFile"
            ? ["path", "dataB64"]
            : native === "stat"
              ? ["path"]
              : native === "list"
                ? ["path", "limit"]
                : ["base"];
    keys(a, ["scope", ...fields, ...(background ? ["taskId", "outputPath", "retainUntilMs"] : [])]);
    if (native !== "exec") path(a[native === "scan" ? "base" : "path"]);
    const validated = { ...a };
    delete validated.scope;
    if (native === "exec") {
      const scope = parseSandboxOperationScope(a.scope);
      validated.tag = scope.tag;
      validated.actor = scope.actor;
      if (background) {
        string(a.taskId);
        path(a.outputPath);
        integer(a.retainUntilMs, scope.admitBeforeMs);
        delete validated.taskId;
        delete validated.outputPath;
        delete validated.retainUntilMs;
      }
    }
    // Reuse the legacy pure value guards on the native fields.
    validateArgs(native as DeviceOp, validated);
    if (native === "writeFile" && (typeof a.dataB64 !== "string" || !isBase64(a.dataB64)))
      throw new DeviceProtocolError("Invalid base64 payload");
  }
  return freeze({ op: op as DeviceOperation, args: a });
}
/**
 * Padded standard base64: whole quartets of `A-Z a-z 0-9 + /`, the last one possibly ending in
 * `=` or `==`. One linear pass: a regex with a repeated group exhausts the engine's backtracking
 * stack on payloads of a few megabytes.
 */
function isBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let i = 0; i < value.length - padding; i++) {
    const c = value.charCodeAt(i);
    if (
      !(
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 43 ||
        c === 47
      )
    )
      return false;
  }
  return true;
}
const RESPONSE_KINDS: readonly string[] = [
  "gone",
  "fs_gone",
  "policy",
  "error",
  "denied",
  "unsupported",
  "unsettled",
  "unknown",
  "invalid",
  "project_refused",
];
const PROJECT_REFUSALS: readonly string[] = ["other-connection", "outside-reach", "denied"];
function helloBody(value: unknown): DeviceHello {
  const o = object(value);
  keys(o, [
    "mode",
    "roots",
    "sessionIsolation",
    "features",
    "policy",
    "home",
    "permissionSupport",
    "ownerCeiling",
    "instanceGeneration",
    "runtimeIdentity",
  ]);
  const mode = o.mode;
  if (mode !== "os" && mode !== "docker") throw new DeviceProtocolError("Unsupported mode");
  if (typeof o.sessionIsolation !== "boolean")
    throw new DeviceProtocolError('field "sessionIsolation" must be a boolean');
  const permissionSupport = parseSandboxPermissionSupport(o.permissionSupport);
  if (
    o.instanceGeneration === null &&
    (o.runtimeIdentity !== undefined ||
      permissionSupport.restricted !== null ||
      permissionSupport.outsideSandbox ||
      permissionSupport.network.openPublic ||
      permissionSupport.network.allowlist ||
      permissionSupport.network.perOperationHosts ||
      permissionSupport.background ||
      !permissionSupport.unavailableReason)
  )
    throw new DeviceProtocolError("Unbound hello cannot advertise runtime capability");
  let runtimeIdentity: DeviceHello["runtimeIdentity"];
  if (o.runtimeIdentity !== undefined) {
    runtimeIdentity = identity(o.runtimeIdentity);
    if (runtimeIdentity.instanceGeneration !== string(o.instanceGeneration))
      throw new DeviceProtocolError("Runtime identity generation mismatch");
  }
  const optional = optionalHelloFields({ features: o.features, policy: o.policy, home: o.home });
  return freeze({
    mode,
    roots: parseRoots(o.roots),
    sessionIsolation: o.sessionIsolation,
    ...(optional.features && { features: optional.features }),
    ...(optional.policy && { policy: optional.policy }),
    ...(optional.home !== undefined && { home: optional.home }),
    permissionSupport,
    ownerCeiling: parseOwnerCeilingReport(o.ownerCeiling),
    instanceGeneration: o.instanceGeneration === null ? null : string(o.instanceGeneration),
    ...(runtimeIdentity && { runtimeIdentity }),
  });
}
function responseBody(value: unknown): DeviceResponseBody {
  const o = object(value);
  if (o.ok === true) {
    keys(o, ["ok", "result"]);
    return freeze({ ok: true, result: o.result });
  }
  if (o.ok !== false) throw new DeviceProtocolError('field "ok" must be a boolean');
  keys(o, ["ok", "error"]);
  const e = object(o.error);
  keys(e, e.kind === "project_refused" ? ["kind", "message", "refusal"] : ["kind", "message"]);
  if (!RESPONSE_KINDS.includes(String(e.kind)))
    throw new DeviceProtocolError("Unknown outcome kind");
  let refusal: DeviceProjectRefusal | undefined;
  if (e.kind === "project_refused") {
    if (!PROJECT_REFUSALS.includes(String(e.refusal)))
      throw new DeviceProtocolError("A project_refused outcome needs a known refusal");
    refusal = e.refusal as DeviceProjectRefusal;
  }
  return freeze({
    ok: false,
    error: {
      kind: e.kind as Extract<DeviceResponseBody, { ok: false }>["error"]["kind"],
      message: string(e.message, 8192),
      ...(refusal && { refusal }),
    },
  });
}
function eventBody(value: unknown): DevicePolicyChanged {
  const o = object(value);
  if (o.type !== "policy") throw new DeviceProtocolError("Unknown event type");
  keys(o, ["type", "policy", "ownerCeiling"]);
  return freeze({
    type: "policy",
    ...optionalPolicy(o.policy),
    ownerCeiling: parseOwnerCeilingReport(o.ownerCeiling),
  });
}

/**
 * Strictly parses one protocol 5 body, as carried by the dial-in envelope frame of type `kind`
 * (`hello`, `event` and `res` from the device, `req` from the kernel), and returns a frozen copy;
 * throws {@link DeviceProtocolError}. The envelope (its ids, deadline and size bound) is checked
 * before: `parseDialInMachineFrame` on the kernel, `parseDialInKernelFrame` on the machine.
 */
export function parseDeviceFrame<K extends keyof DeviceBodies>(
  body: unknown,
  kind: K,
): DeviceBodies[K];
export function parseDeviceFrame(
  body: unknown,
  kind: keyof DeviceBodies,
): DeviceBodies[keyof DeviceBodies] {
  // a JSON snapshot: plain data only (no accessor runs twice, no prototype), never aliasing the
  // caller's objects, which the parsed copy freezes
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(body));
  } catch {
    throw new DeviceProtocolError("Body is not JSON data");
  }
  switch (kind) {
    case "hello":
      return helloBody(copy);
    case "req":
      return requestBody(copy);
    case "res":
      return responseBody(copy);
    case "event":
      return eventBody(copy);
    default:
      throw new DeviceProtocolError(`Unknown body kind ${String(kind)}`);
  }
}
export function parseOperationResult(
  op: DeviceOperation,
  result: unknown,
  request?: BackgroundReadOutputRequest | BindInstanceRequest,
): unknown {
  if (op === "bindInstance") {
    if (!request || !("bindingId" in request))
      throw new DeviceProtocolError("Binding validation requires the exact request");
    const o = object(result);
    keys(o, [
      "instanceId",
      "instanceGeneration",
      "bindingId",
      "runtimeIdentity",
      "permissionSupport",
      "ownerCeiling",
    ]);
    const runtimeIdentity = identity(o.runtimeIdentity);
    if (
      o.instanceId !== request.instanceId ||
      o.instanceGeneration !== request.instanceGeneration ||
      o.bindingId !== request.bindingId ||
      runtimeIdentity.instanceGeneration !== request.instanceGeneration
    )
      throw new DeviceProtocolError("Binding answer belongs to another instance generation");
    return freeze({
      instanceId: request.instanceId,
      instanceGeneration: request.instanceGeneration,
      bindingId: request.bindingId,
      runtimeIdentity,
      permissionSupport: parseSandboxPermissionSupport(o.permissionSupport),
      ownerCeiling: parseOwnerCeilingReport(o.ownerCeiling),
    } satisfies BindInstanceResult);
  }
  if (op === "backgroundReadOutput") {
    if (!request || !("offset" in request))
      throw new DeviceProtocolError("Output validation requires the exact request bounds");
    const offset = integer(request.offset),
      maxBytes = integer(request.maxBytes, 0, 65536);
    const o = object(result);
    if ("unavailable" in o) {
      keys(o, ["unavailable"]);
      if (o.unavailable !== "lost" && o.unavailable !== "expired")
        throw new DeviceProtocolError("Invalid output outcome");
      return freeze(o) as BackgroundReadOutputResult;
    }
    keys(o, ["dataB64", "offset", "nextOffset", "totalBytes"]);
    const total = integer(o.totalBytes),
      next = integer(o.nextOffset);
    if (
      integer(o.offset) !== offset ||
      typeof o.dataB64 !== "string" ||
      o.dataB64.length > 87384 ||
      !isBase64(o.dataB64)
    )
      throw new DeviceProtocolError("Invalid output range or base64");
    const decoded = atob(o.dataB64);
    if (
      btoa(decoded) !== o.dataB64 ||
      decoded.length !== Math.min(maxBytes, Math.max(total - offset, 0)) ||
      !Number.isSafeInteger(offset + decoded.length) ||
      next !== offset + decoded.length
    )
      throw new DeviceProtocolError("Inconsistent output range; retry from the same offset");
    return freeze(o) as BackgroundReadOutputResult;
  }
  if (op === "backgroundStart") return parseSandboxExecutionRef(result);
  if (op === "backgroundStatus") {
    const o = object(result);
    keys(o, ["state", "exitCode", "timedOut"]);
    if (o.state === "running" || o.state === "lost") return freeze({ state: o.state });
    if (
      o.state !== "exited" ||
      (o.exitCode !== null && !Number.isInteger(o.exitCode)) ||
      typeof o.timedOut !== "boolean"
    )
      throw new DeviceProtocolError("Invalid execution status");
    return freeze(o);
  }
  if (op === "backgroundTail") {
    if (result && typeof result === "object" && "unavailable" in result) {
      const o = object(result);
      keys(o, ["unavailable"]);
      if (o.unavailable !== "lost" && o.unavailable !== "expired")
        throw new DeviceProtocolError("Invalid output outcome");
      return freeze(o);
    }
    return parseOpResult("readFile", result);
  }
  if (op === "backgroundStop") {
    const o = object(result);
    keys(o, ["outcome", "exitCode", "timedOut"]);
    if (!["already-exited", "stopped", "cancel-pending", "lost"].includes(String(o.outcome)))
      throw new DeviceProtocolError("Invalid stop outcome");
    if (
      o.outcome === "already-exited" &&
      ((o.exitCode !== null && !Number.isInteger(o.exitCode)) || typeof o.timedOut !== "boolean")
    )
      throw new DeviceProtocolError("Invalid stopped execution status");
    return freeze(o);
  }
  if (op === "revokeOperation") {
    if (result !== null) throw new DeviceProtocolError("Revoke result must be null");
    return null;
  }
  const raw = op.startsWith("prepare") ? op.slice(7) : op.startsWith("browse") ? op.slice(6) : op;
  const native = raw.charAt(0).toLowerCase() + raw.slice(1);
  if (!natives.includes(native) && !lifecycle.includes(native))
    throw new DeviceProtocolError(`Unknown operation ${op}`);
  return parseOpResult(native as DeviceOp, result);
}
