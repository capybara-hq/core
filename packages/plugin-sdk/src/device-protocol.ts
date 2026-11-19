/**
 * The device protocol: the WebSocket frames between the kernel and a `capybara-device` program
 * (a connected machine that serves as a device). Pure types and hand-written guards.
 *
 * Protocol 4 (the scope-bearing operations, `parseDeviceFrame`) is defined in the second half of
 * this file. Protocol 2's frames keep a `Legacy` prefix where a newer name replaced them
 * (`LegacyDeviceHello`, `parseLegacyDeviceFrame`, ...); protocol 4 reuses their value guards, and
 * they go with the legacy device surface.
 */
import {
  type ExecResult,
  isDeviceProjectName,
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
} from "./sandbox.js";
import {
  parseSandboxBrowseScope,
  parseSandboxExecutionRef,
  parseSandboxOperationRef,
  parseSandboxOperationScope,
  parseSandboxPreparationScope,
  type SandboxPermissionSupport,
} from "./sandbox-operation.js";

/** The protocol version carried in `X-Capybara-Device-Protocol` and the hello frame. */
export const DEVICE_PROTOCOL_VERSION = 4;

/**
 * Protocol 3's version, which a deployment speaking {@link DEVICE_PROTOCOL_VERSION} refuses (426
 * on the header, a protocol close on the hello): its owner report and runtime support describe the
 * removed Full access ceiling, so a protocol 3 program must be updated.
 */
export const LEGACY_DEVICE_PROTOCOL_VERSION = 3;

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
  | "policy"
  | "policyStatus"
  | "list"
  | "scan";

const DEVICE_OPS: readonly DeviceOp[] = [
  "create",
  "exec",
  "readFile",
  "writeFile",
  "stat",
  "killTagged",
  "killAll",
  "stop",
  "policy",
  "policyStatus",
  "list",
  "scan",
];

/**
 * Optional capabilities a device announces in its hello. `policyOp`: the device takes the `policy`
 * op; `policyOpId`: it also logs each `policy` op's outcome by its `opId`, answers `policyStatus`
 * and reports recent outcomes in its hello (`recentOps`); `networkReport` means exec results may
 * carry `network`; `projects` means the device serves `list` and
 * `scan` (the kernel keeps a device's projects itself and asks the device only what it can read).
 * The kernel gates each op on its feature, as it gates `policy` on `policyOp` / `policyOpId`: it
 * never sends `list` or `scan` to a device that did not announce `projects`.
 */
export type DeviceFeature = "networkReport" | "policyOp" | "policyOpId" | "projects";
const DEVICE_FEATURES: readonly DeviceFeature[] = [
  "networkReport",
  "policyOp",
  "policyOpId",
  "projects",
];

/** The most entries a `list` op may ask for and its result may carry. */
export const MAX_DEVICE_LIST_ENTRIES = 1000;

/**
 * What a device knows of its local policy and reports (in the hello or a `policy` op). The owner
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

/** The most hosts a `policy` op's `remove` or an exec's `grants` may carry. */
const MAX_POLICY_HOSTS = 100;

/**
 * Why a `policy` op naming hosts to `add` is refused: the deployment may only narrow a local
 * device's sandbox; its owner widens it on the machine.
 */
export const POLICY_ADD_REFUSED =
  "The deployment may not add hosts to a device's sandbox allowlist: widening happens only on the machine (capybara-device policy add allowedDomains <host>)";

/** The longest `opId` a `policy` / `policyStatus` op may carry. */
export const MAX_POLICY_OP_ID_LENGTH = 128;

/** The most entries a hello's `recentOps` carries; the parser keeps the newest. */
export const MAX_RECENT_POLICY_OPS = 100;

/**
 * What a device recorded of a `policy` op: `started` (written before the change, so an op the
 * device was stopped in the middle of stays `started`), then `applied` or `refused`.
 */
export type DevicePolicyOpOutcome = "applied" | "refused" | "started";

/** One entry of a hello's `recentOps`. */
export interface DevicePolicyOpReport {
  opId: string;
  outcome: DevicePolicyOpOutcome;
}

/** First frame from the device after the WebSocket opens. */
export interface LegacyDeviceHello {
  type: "hello";
  protocol: number;
  programVersion: string;
  os: "darwin" | "linux";
  arch: string;
  mode: "os" | "docker";
  roots: SandboxRoots;
  sessionIsolation: boolean;
  /** Optional capabilities (absent on older devices; unknown entries are dropped by the parser). */
  features?: DeviceFeature[];
  /** The device's local policy at connect time (absent on older devices). */
  policy?: DeviceLocalPolicySummary;
  /**
   * The outcomes of the latest `policy` ops by op id, oldest first, at most
   * {@link MAX_RECENT_POLICY_OPS} (devices with `policyOpId`; malformed entries are dropped by
   * the parser).
   */
  recentOps?: DevicePolicyOpReport[];
  /**
   * The owner's home directory, an absolute path (a local device; the base of an auto-mode
   * project's relative path). A malformed value is dropped by the parser.
   */
  home?: string;
  /**
   * The identity of the host's current OS boot (Linux `/proc/sys/kernel/random/boot_id`; macOS
   * `kern.bootsessionuuid`): a value that differs from an earlier one of the
   * same machine proves the host restarted since, so no process of that earlier boot can exist.
   * A malformed value is dropped by the parser.
   */
  bootId?: string;
}

/** A hello's `bootId`: 1 to 128 characters of letters, digits, `.`, `_`, `:` and `-`. */
export const DEVICE_BOOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Whether `v` is a well-formed {@link LegacyDeviceHello.bootId}. */
export function isDeviceBootId(v: unknown): v is string {
  return typeof v === "string" && DEVICE_BOOT_ID_RE.test(v);
}

/** Error kinds a device reports for a failed request. */
export type DeviceErrorKind = "gone" | "fs_gone" | "policy" | "error";

/** The device's answer to a {@link KernelReq}. */
export type DeviceRes =
  | { type: "res"; id: string; ok: true; result: unknown }
  | { type: "res"; id: string; ok: false; error: { kind: DeviceErrorKind; message: string } };

/** A request from the kernel. */
export interface KernelReq {
  type: "req";
  id: string;
  op: DeviceOp;
  args: unknown;
  deadlineMs: number;
}

/** The kernel gives up on a request (abort or deadline). */
export interface KernelCancel {
  type: "cancel";
  id: string;
}

/**
 * The device's local policy changed while connected (its file was edited on the machine, the owner
 * switched mode): the summary as it is now, sent only when it differs from the last one sent on
 * this connection. `policy` is absent when the frame's summary was unreadable; the kernel then
 * learns the policy later, as for the hello.
 */
export interface LegacyDevicePolicyChanged {
  type: "policy";
  policy?: DeviceLocalPolicySummary;
}

export type LegacyDeviceFrame =
  | LegacyDeviceHello
  | DeviceRes
  | LegacyDevicePolicyChanged
  | KernelReq
  | KernelCancel;

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
 * Edits the device's local policy. The kernel may only narrow: it removes hosts from the sandbox
 * allowlist and narrows the owner ceiling ({@link DevicePolicyArgs}). Widening happens only on the
 * machine (`capybara-device policy add`, `capybara-device ceiling set`): the frame parser refuses
 * an `add` and the protocol 3 `mode`.
 */
export interface LegacyDevicePolicyArgs {
  /**
   * The kernel's id of this change (non-empty, no `:`, at most {@link MAX_POLICY_OP_ID_LENGTH}
   * characters): the device logs the op's outcome under it, for `policyStatus` and the hello's
   * `recentOps`.
   */
  opId: string;
  /** Hosts to remove from `allowedDomains`. */
  remove?: string[];
  /** Who decided, for the device's local audit line. */
  source: { approvalId?: string; accountId: string; accountName: string; via: "web" | "im" };
}
/** The policy as the device wrote it. */
export interface LegacyDevicePolicyResult {
  policy: DeviceLocalPolicySummary;
}
/** Asks what became of the `policy` op with this id. Read-only on the device. */
export interface DevicePolicyStatusArgs {
  opId: string;
}
/**
 * What the device logged of a `policy` op: its {@link DevicePolicyOpOutcome}, or `unknown` when
 * the id is not in its log (never received, or dropped from the log since). `policy` is the
 * device's summary now; `message` the refusal's.
 */
export interface LegacyDevicePolicyStatus {
  outcome: DevicePolicyOpOutcome | "unknown";
  policy?: DeviceLocalPolicySummary;
  message?: string;
}
/**
 * Lists one directory (absolute `path`, {@link validateSandboxPathShape}): at most `limit` entries
 * (at most {@link MAX_DEVICE_LIST_ENTRIES}), read within the operation's scope. See
 * `SandboxProvider.list` for the semantics.
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
 * file, unreadable, or outside the request's scope is an error. See `SandboxProvider.scan` for the
 * traversal.
 */
export interface DeviceScanArgs {
  base: string;
}
/**
 * `base` itself and the directories at most {@link MAX_DEVICE_SCAN_DEPTH} levels below it that
 * hold a `.git` entry or an `AGENTS.md` file, sorted by `path` in code-unit order and cut to the
 * first {@link MAX_DEVICE_SCAN_RESULTS}. Never file contents. See `SandboxProvider.scan`.
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

/** The exec `limits`: resources and the outer network (no mode: protocol 4 removed it). */
function parseLimits(v: unknown): SandboxLimits {
  const o = obj(v, 'field "limits"');
  const network = obj(o.network, 'field "network"');
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

/**
 * Whether `v` is a valid policy op id: non-empty, no `:`, at most
 * {@link MAX_POLICY_OP_ID_LENGTH} characters.
 */
export function isPolicyOpId(v: unknown): v is string {
  return (
    typeof v === "string" && v !== "" && v.length <= MAX_POLICY_OP_ID_LENGTH && !v.includes(":")
  );
}

function opId(o: Record<string, unknown>): string {
  const v = o.opId;
  if (!isPolicyOpId(v)) {
    throw new DeviceProtocolError(
      `field "opId" must be a non-empty string without ":" of at most ${MAX_POLICY_OP_ID_LENGTH} characters`,
    );
  }
  return v;
}

const OP_OUTCOMES: readonly DevicePolicyOpOutcome[] = ["applied", "refused", "started"];

/**
 * The valid entries of a hello's `recentOps`, one per op id (the last listed), the newest
 * {@link MAX_RECENT_POLICY_OPS}.
 */
function parseRecentOps(v: unknown[]): DevicePolicyOpReport[] {
  // one entry per op id: the last one listed (the newest outcome), where it is listed
  const byId = new Map<string, DevicePolicyOpReport>();
  for (const e of v) {
    if (!isRecord(e) || !isPolicyOpId(e.opId)) continue;
    if (!OP_OUTCOMES.includes(e.outcome as DevicePolicyOpOutcome)) continue;
    byId.delete(e.opId);
    byId.set(e.opId, { opId: e.opId, outcome: e.outcome as DevicePolicyOpOutcome });
  }
  return [...byId.values()].slice(-MAX_RECENT_POLICY_OPS);
}

/** Optional hello fields: malformed values are ignored so old and new peers interoperate. */
function optionalHelloFields(
  o: Record<string, unknown>,
): Pick<LegacyDeviceHello, "features" | "policy" | "recentOps" | "home" | "bootId"> {
  const out: Pick<LegacyDeviceHello, "features" | "policy" | "recentOps" | "home" | "bootId"> = {};
  if (Array.isArray(o.features)) {
    out.features = DEVICE_FEATURES.filter((f) => (o.features as unknown[]).includes(f));
  }
  if (Array.isArray(o.recentOps)) out.recentOps = parseRecentOps(o.recentOps);
  if (typeof o.home === "string" && validateSandboxPathShape(o.home).length === 0) {
    out.home = o.home;
  }
  if (isDeviceBootId(o.bootId)) out.bootId = o.bootId;
  return { ...out, ...optionalPolicy(o.policy) };
}

/** A summary field that is dropped when absent or unreadable. */
function optionalPolicy(v: unknown): Pick<LegacyDeviceHello, "policy"> {
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

function parseHello(o: Record<string, unknown>): LegacyDeviceHello {
  const os = str(o, "os");
  if (os !== "darwin" && os !== "linux") throw new DeviceProtocolError(`unsupported os "${os}"`);
  const mode = str(o, "mode");
  if (mode !== "os" && mode !== "docker") {
    throw new DeviceProtocolError(`unsupported mode "${mode}"`);
  }
  if (typeof o.sessionIsolation !== "boolean") {
    throw new DeviceProtocolError('field "sessionIsolation" must be a boolean');
  }
  return {
    type: "hello",
    protocol: posInt(o, "protocol"),
    programVersion: str(o, "programVersion"),
    os,
    arch: str(o, "arch"),
    mode,
    roots: parseRoots(o.roots),
    sessionIsolation: o.sessionIsolation,
    ...optionalHelloFields(o),
  };
}

function parseRes(o: Record<string, unknown>): DeviceRes {
  const id = nonEmptyStr(o, "id");
  if (o.ok === true) return { type: "res", id, ok: true, result: o.result };
  if (o.ok !== false) throw new DeviceProtocolError('field "ok" must be a boolean');
  const e = o.error;
  if (!isRecord(e)) throw new DeviceProtocolError('field "error" must be an object');
  const kind = str(e, "kind");
  if (kind !== "gone" && kind !== "fs_gone" && kind !== "policy" && kind !== "error") {
    throw new DeviceProtocolError(`unknown error kind "${kind}"`);
  }
  return { type: "res", id, ok: false, error: { kind, message: str(e, "message") } };
}

function parseReq(o: Record<string, unknown>): KernelReq {
  const op = str(o, "op");
  if (!DEVICE_OPS.includes(op as DeviceOp)) throw new DeviceProtocolError(`unknown op "${op}"`);
  const args = obj(o.args, 'field "args"');
  validateArgs(op as DeviceOp, args);
  return {
    type: "req",
    id: nonEmptyStr(o, "id"),
    op: op as DeviceOp,
    args,
    deadlineMs: posInt(o, "deadlineMs"),
  };
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
    case "policy": {
      opId(a);
      if (a.add !== undefined) throw new DeviceProtocolError(POLICY_ADD_REFUSED);
      if (a.mode !== undefined)
        throw new DeviceProtocolError(
          'field "mode" is not part of device protocol 4; narrow with "ownerCeiling" instead',
        );
      if (a.remove !== undefined) hostArray(a, "remove");
      const src = obj(a.source, 'field "source"');
      nonEmptyStr(src, "accountId");
      str(src, "accountName");
      const via = str(src, "via");
      if (via !== "web" && via !== "im") throw new DeviceProtocolError(`unknown via "${via}"`);
      if (src.approvalId !== undefined) str(src, "approvalId");
      return;
    }
    case "policyStatus":
      opId(a);
      return;
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
  policy: LegacyDevicePolicyResult;
  policyStatus: LegacyDevicePolicyStatus;
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
    case "policy":
      return { policy: parsePolicySummary(obj(result, "policy result").policy) };
    case "policyStatus": {
      const r = obj(result, "policyStatus result");
      const out: LegacyDevicePolicyStatus = {
        outcome: oneOf(r, "outcome", [...OP_OUTCOMES, "unknown"] as const),
      };
      if (r.policy !== undefined) out.policy = parsePolicySummary(r.policy);
      if (r.message !== undefined) out.message = str(r, "message");
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

/**
 * Parses one WebSocket text frame. `from` is the sender: a device may send `hello`, `res` and
 * `policy`, the
 * kernel `req` and `cancel`. Throws {@link DeviceProtocolError} on bad JSON, an unknown `type`,
 * missing fields or a frame of the wrong direction.
 */
export function parseLegacyDeviceFrame(raw: string, from: "device" | "kernel"): LegacyDeviceFrame {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new DeviceProtocolError("frame is not valid JSON");
  }
  if (!isRecord(o)) throw new DeviceProtocolError("frame must be a JSON object");
  const type = o.type;
  switch (type) {
    case "hello":
    case "res":
    case "policy":
      if (from !== "device") throw new DeviceProtocolError(`"${type}" must come from the device`);
      if (type === "policy") return { type, ...optionalPolicy(o.policy) };
      return type === "hello" ? parseHello(o) : parseRes(o);
    case "req":
    case "cancel":
      if (from !== "kernel") throw new DeviceProtocolError(`"${type}" must come from the kernel`);
      return type === "req" ? parseReq(o) : { type: "cancel", id: nonEmptyStr(o, "id") };
    default:
      throw new DeviceProtocolError(`unknown frame type "${String(type)}"`);
  }
}

// ---- Protocol 4: scope-bearing operations ----

/**
 * The operations the kernel asks a protocol 4 device to run: every user operation carries its
 * admitted scope; there is no broad kill (`killTagged` / `killAll`).
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
  readonly restrictedProjectReach: "workspace" | "os-user";
}
/**
 * The narrowing of protocol 4: the kernel may switch the network to `allowlist`, remove hosts, turn
 * `outsideSandbox` off or narrow the project reach. Never a widening: widening is decided on the
 * machine by its owner (`capybara-device ceiling set`), never over the wire.
 */
export interface DeviceOwnerCeilingNarrowing {
  readonly outsideSandbox?: false;
  readonly network?: "allowlist";
  /** Hosts to remove from `allowedDomains`; a host not on the list is ignored. */
  readonly removeAllowedDomains?: readonly string[];
  readonly restrictedProjectReach?: "workspace";
}
/** A staged `policy` op: the protocol 2 change plus an optional owner-ceiling narrowing. */
export interface DevicePolicyArgs extends LegacyDevicePolicyArgs {
  ownerCeiling?: DeviceOwnerCeilingNarrowing;
}
/** A staged `policy` answer: the policy as written and the owner report issued for it. */
export interface DevicePolicyResult {
  policy: DeviceLocalPolicySummary;
  ownerCeiling: DeviceOwnerCeiling;
}
/** A staged `policyStatus` answer: an `applied` outcome carries the current owner report. */
export interface DevicePolicyStatus extends LegacyDevicePolicyStatus {
  ownerCeiling?: DeviceOwnerCeiling;
}
/** The device pushed a policy change: the owner report for the newly observed revision. */
export interface DevicePolicyChanged {
  type: "policy";
  policy?: DeviceLocalPolicySummary;
  ownerCeiling: DeviceOwnerCeiling;
}
export interface DeviceHello extends LegacyDeviceHello {
  protocol: 4;
  permissionSupport: SandboxPermissionSupport;
  ownerCeiling: DeviceOwnerCeiling;
  instanceGeneration: string | null;
  transport: { maxFrameBytes: number };
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
export interface KernelReady {
  type: "ready";
  connectionId: string;
  maxFrameBytes: number;
}
export interface BackgroundReadOutputRequest {
  offset: number;
  maxBytes: number;
}
export type BackgroundReadOutputResult =
  | { dataB64: string; offset: number; nextOffset: number; totalBytes: number }
  | { unavailable: "lost" | "expired" };

export interface KernelRequest {
  type: "req";
  id: string;
  op: DeviceOperation;
  args: Readonly<Record<string, unknown>>;
  deadlineMs: number;
}
export type DeviceResponse =
  | Exclude<DeviceRes, { ok: false }>
  | {
      type: "res";
      id: string;
      ok: false;
      error: {
        kind: "gone" | "fs_gone" | "policy" | "error" | "denied" | "unsupported" | "unknown";
        message: string;
      };
    };
export type DeviceFrame =
  | DeviceHello
  | KernelReady
  | KernelRequest
  | KernelCancel
  | DeviceResponse
  | DevicePolicyChanged;
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
      "restrictedProjectReach",
    ],
    what,
  );
  if (o.version !== 3) throw new DeviceProtocolError(`Invalid ${what}: expected version 3`);
  if (o.network !== "open" && o.network !== "allowlist")
    throw new DeviceProtocolError(`Invalid ${what}: network must be open or allowlist`);
  if (o.restrictedProjectReach !== "workspace" && o.restrictedProjectReach !== "os-user")
    throw new DeviceProtocolError(`Invalid ${what}: project reach must be workspace or os-user`);
  return freeze({
    version: 3,
    sequence: integer(o.sequence),
    revision: string(o.revision, 512),
    outsideSandbox: strictBoolean(o, "outsideSandbox", what),
    network: o.network,
    allowedDomains: strictHosts(o.allowedDomains, `${what} allowedDomains`),
    restrictedProjectReach: o.restrictedProjectReach,
  });
}

/**
 * Strictly parses an owner-ceiling narrowing of protocol 4 and returns a frozen copy; throws
 * {@link DeviceProtocolError}. Every field can only narrow: `outsideSandbox` only to `false`,
 * `network` only to `allowlist`, the project reach only to `workspace`, and hosts only removed.
 * There is no way to name a host to add or a list to replace.
 */
export function parseOwnerCeilingNarrowing(value: unknown): DeviceOwnerCeilingNarrowing {
  const what = "owner ceiling narrowing";
  const o = strictRecord(
    value,
    ["outsideSandbox", "network", "removeAllowedDomains", "restrictedProjectReach"],
    what,
  );
  if (
    (Object.hasOwn(o, "outsideSandbox") && o.outsideSandbox !== false) ||
    (Object.hasOwn(o, "network") && o.network !== "allowlist") ||
    (Object.hasOwn(o, "restrictedProjectReach") && o.restrictedProjectReach !== "workspace")
  )
    throw new DeviceProtocolError("The deployment may only narrow the owner ceiling");
  return freeze({
    ...(Object.hasOwn(o, "outsideSandbox") ? { outsideSandbox: false as const } : {}),
    ...(Object.hasOwn(o, "network") ? { network: "allowlist" as const } : {}),
    ...(Object.hasOwn(o, "removeAllowedDomains")
      ? {
          removeAllowedDomains: strictHosts(o.removeAllowedDomains, `${what} removeAllowedDomains`),
        }
      : {}),
    ...(Object.hasOwn(o, "restrictedProjectReach")
      ? { restrictedProjectReach: "workspace" as const }
      : {}),
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
const legacy = ["create", "stop", "policy", "policyStatus"];
function request(o: Record<string, unknown>): KernelRequest {
  keys(o, ["type", "id", "op", "args", "deadlineMs"]);
  const id = string(o.id),
    op = string(o.op),
    a = object(o.args),
    deadlineMs = integer(o.deadlineMs, 1);
  if (legacy.includes(op)) {
    if (op === "policy" && a.ownerCeiling !== undefined)
      a.ownerCeiling = parseOwnerCeilingNarrowing(a.ownerCeiling);
    const parsed = parseLegacyDeviceFrame(JSON.stringify(o), "kernel");
    if (parsed.type !== "req") throw new DeviceProtocolError("Expected request");
    return freeze({ ...parsed, op: op as DeviceOperation, args: object(parsed.args) });
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
    parseLegacyDeviceFrame(
      JSON.stringify({ type: "req", id, op: native, args: validated, deadlineMs }),
      "kernel",
    );
    if (
      native === "writeFile" &&
      (typeof a.dataB64 !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.dataB64))
    )
      throw new DeviceProtocolError("Invalid base64 payload");
  }
  return freeze({ type: "req", id, op: op as DeviceOperation, args: a, deadlineMs });
}
/** Strictly parses one protocol 4 frame; throws {@link DeviceProtocolError}. */
export function parseDeviceFrame(
  raw: string,
  from: "device" | "kernel",
  maxFrameBytes?: number,
): DeviceFrame {
  if (
    maxFrameBytes !== undefined &&
    new TextEncoder().encode(raw).byteLength > integer(maxFrameBytes, 1)
  )
    throw new DeviceProtocolError(
      "Frame exceeds negotiated capacity; check device and deployment frame limits",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeviceProtocolError("Frame is not valid JSON");
  }
  const o = object(parsed);
  if (o.type === "ready") {
    if (from !== "kernel") throw new DeviceProtocolError("Ready must come from kernel");
    keys(o, ["type", "connectionId", "maxFrameBytes"]);
    return freeze({
      type: "ready",
      connectionId: string(o.connectionId),
      maxFrameBytes: integer(o.maxFrameBytes, 1024),
    });
  }
  if (o.type === "req") {
    if (from !== "kernel") throw new DeviceProtocolError("Request must come from kernel");
    return request(o);
  }
  if (o.type === "hello") {
    if (from !== "device" || o.protocol !== DEVICE_PROTOCOL_VERSION)
      throw new DeviceProtocolError(`Expected protocol ${DEVICE_PROTOCOL_VERSION} hello`);
    const transport = object(o.transport);
    keys(transport, ["maxFrameBytes"]);
    const maxFrameBytes = integer(transport.maxFrameBytes, 1024);
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
    const base = parseLegacyDeviceFrame(raw, from);
    if (base.type !== "hello") throw new DeviceProtocolError("Expected hello");
    let runtimeIdentity: DeviceHello["runtimeIdentity"];
    if (o.runtimeIdentity !== undefined) {
      runtimeIdentity = identity(o.runtimeIdentity);
      if (runtimeIdentity.instanceGeneration !== string(o.instanceGeneration))
        throw new DeviceProtocolError("Runtime identity generation mismatch");
    }
    return freeze({
      ...base,
      protocol: DEVICE_PROTOCOL_VERSION,
      permissionSupport,
      transport: { maxFrameBytes },
      ownerCeiling: parseOwnerCeilingReport(o.ownerCeiling),
      instanceGeneration: o.instanceGeneration === null ? null : string(o.instanceGeneration),
      ...(runtimeIdentity && { runtimeIdentity }),
    });
  }
  if (o.type === "policy") {
    if (from !== "device") throw new DeviceProtocolError("Policy must come from device");
    keys(o, ["type", "policy", "ownerCeiling"]);
    const base = parseLegacyDeviceFrame(JSON.stringify({ type: "policy", policy: o.policy }), from);
    if (base.type !== "policy") throw new DeviceProtocolError("Expected policy");
    return freeze({ ...base, ownerCeiling: parseOwnerCeilingReport(o.ownerCeiling) });
  }
  if (o.type === "res" && o.ok === false) {
    if (from !== "device") throw new DeviceProtocolError("Response must come from device");
    keys(o, ["type", "id", "ok", "error"]);
    const e = object(o.error);
    keys(e, ["kind", "message"]);
    if (
      !["gone", "fs_gone", "policy", "error", "denied", "unsupported", "unknown"].includes(
        String(e.kind),
      )
    )
      throw new DeviceProtocolError("Unknown outcome kind");
    return freeze({
      type: "res",
      id: string(o.id),
      ok: false,
      error: {
        kind: e.kind as Extract<DeviceResponse, { ok: false }>["error"]["kind"],
        message: string(e.message, 8192),
      },
    });
  }
  const base = parseLegacyDeviceFrame(raw, from);
  if (base.type === "hello" || base.type === "req" || base.type === "policy")
    throw new DeviceProtocolError("Expected staged frame");
  return freeze(base);
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
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(o.dataB64)
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
  if (op === "policy") {
    const o = object(result);
    keys(o, ["policy", "ownerCeiling"]);
    return freeze({
      ...parseOpResult("policy", { policy: o.policy }),
      ownerCeiling: parseOwnerCeilingReport(o.ownerCeiling),
    } satisfies DevicePolicyResult);
  }
  if (op === "policyStatus") {
    const o = object(result);
    keys(o, ["outcome", "policy", "message", "ownerCeiling"]);
    const { ownerCeiling, ...rest } = o;
    const status: DevicePolicyStatus = parseOpResult("policyStatus", rest);
    if (status.outcome === "applied" && ownerCeiling === undefined)
      throw new DeviceProtocolError("An applied policy status carries the owner report");
    if (ownerCeiling !== undefined) status.ownerCeiling = parseOwnerCeilingReport(ownerCeiling);
    return freeze(status);
  }
  if (op === "revokeOperation") {
    if (result !== null) throw new DeviceProtocolError("Revoke result must be null");
    return null;
  }
  const raw = op.startsWith("prepare") ? op.slice(7) : op.startsWith("browse") ? op.slice(6) : op;
  return parseOpResult((raw.charAt(0).toLowerCase() + raw.slice(1)) as DeviceOp, result);
}
