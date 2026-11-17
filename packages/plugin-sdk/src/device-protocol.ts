/**
 * Device protocol v2: the WebSocket frames between the kernel and a `capybara-device` program
 * (a connected machine that serves as a device). Pure types and hand-written guards.
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

/** The protocol version carried in `X-Capybara-Device-Protocol` and the hello frame. */
export const DEVICE_PROTOCOL_VERSION = 2;

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
 * carry `network`; `mode` means the device applies `limits.mode` / `limits.network` (without it
 * the device behaves as an allowlisted sandbox); `projects` means the device serves `list` and
 * `scan` (the kernel keeps a device's projects itself and asks the device only what it can read).
 * The kernel gates each op on its feature, as it gates `policy` on `policyOp` / `policyOpId`: it
 * never sends `list` or `scan` to a device that did not announce `projects`.
 */
export type DeviceFeature = "networkReport" | "policyOp" | "policyOpId" | "mode" | "projects";
const DEVICE_FEATURES: readonly DeviceFeature[] = [
  "networkReport",
  "policyOp",
  "policyOpId",
  "mode",
  "projects",
];

/** The most entries a `list` op may ask for and its result may carry. */
export const MAX_DEVICE_LIST_ENTRIES = 1000;

/** What a device knows of its local policy and reports (in the hello or a `policy` op). */
export interface DeviceLocalPolicySummary {
  /** `auto` = no OS sandbox (the owner's machine); `sandbox` = the OS sandbox. */
  mode: "auto" | "sandbox";
  /** The device's sandbox-mode allowlist; meaningful in sandbox mode only. */
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

/**
 * The kernel's current ceiling on a request that reads the device's file system outside a command
 * (`readFile`, `stat`, `list`, `scan`): the device answers in the mode it would run this request in, the owner's
 * choice cut to `mode`, never by a ceiling it saw on an earlier command.
 */
export type DeviceRequestCeiling = Pick<SandboxLimits, "mode">;

/**
 * The first line of the kernel's background task launch command (`Bash` `run_in_background`), a
 * shell comment. A device kills what a foreground exec leaves running once the exec ends; an exec
 * whose command starts with this line detaches a task on purpose, and its processes are left alone.
 */
export const BACKGROUND_LAUNCH_LINE = "# capybara: background task launch";

/** Whether an exec's command is a background task launch ({@link BACKGROUND_LAUNCH_LINE}). */
export function isBackgroundLaunch(command: string): boolean {
  return command === BACKGROUND_LAUNCH_LINE || command.startsWith(`${BACKGROUND_LAUNCH_LINE}\n`);
}

/** The most blocked hosts an exec result reports; the parser cuts longer lists. */
export const MAX_NETWORK_BLOCKED_HOSTS = 20;

/** The most hosts a `policy` op's `add` / `remove` or an exec's `grants` may carry. */
const MAX_POLICY_HOSTS = 100;

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
export interface DeviceHello {
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

/** Whether `v` is a well-formed {@link DeviceHello.bootId}. */
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
export interface DevicePolicyChanged {
  type: "policy";
  policy?: DeviceLocalPolicySummary;
}

export type DeviceFrame = DeviceHello | DeviceRes | DevicePolicyChanged | KernelReq | KernelCancel;

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
   * Hosts the kernel allows for this command beyond the local policy (a run's 「这次允许」 or a
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
  limits: DeviceRequestCeiling;
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
  limits: DeviceRequestCeiling;
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
 * Edits the device's local policy. The kernel may only narrow: `mode` may turn the sandbox back on
 * (`"sandbox"`), never off (turning auto mode on is decided on the machine), and `add` extends the
 * sandbox-mode allowlist only. Narrowing is always accepted.
 */
export interface DevicePolicyArgs {
  /**
   * The kernel's id of this change (non-empty, no `:`, at most {@link MAX_POLICY_OP_ID_LENGTH}
   * characters): the device logs the op's outcome under it, for `policyStatus` and the hello's
   * `recentOps`.
   */
  opId: string;
  /** Hosts to add to `allowedDomains`. */
  add?: string[];
  /** Hosts to remove from `allowedDomains`. */
  remove?: string[];
  /** Only `"sandbox"`: the kernel may narrow, never turn auto mode on. */
  mode?: "sandbox";
  /** Who decided, for the device's local audit line. */
  source: { approvalId?: string; accountId: string; accountName: string; via: "web" | "im" };
}
/** The policy as the device wrote it. */
export interface DevicePolicyResult {
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
export interface DevicePolicyStatus {
  outcome: DevicePolicyOpOutcome | "unknown";
  policy?: DeviceLocalPolicySummary;
  message?: string;
}
/**
 * Lists one directory (absolute `path`, {@link validateSandboxPathShape}): at most `limit` entries
 * (at most {@link MAX_DEVICE_LIST_ENTRIES}), read in the mode `limits` gives. See
 * `SandboxProvider.list` for the semantics.
 */
export interface DeviceListArgs {
  path: string;
  limit: number;
  limits: DeviceRequestCeiling;
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
 * read in the mode `limits` gives. A `base` that does not exist answers `[]`; a `base` that is a
 * file, unreadable, or outside the request's mode is an error. See `SandboxProvider.scan` for the
 * traversal.
 */
export interface DeviceScanArgs {
  base: string;
  limits: DeviceRequestCeiling;
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
    mode: oneOf(o, "mode", ["auto", "sandbox"] as const),
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

/** A request's ceiling (`limits` of `list` / `scan`): only its mode. */
function parseCeiling(v: unknown): DeviceRequestCeiling {
  return { mode: oneOf(obj(v, 'field "limits"'), "mode", ["auto", "sandbox"] as const) };
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
  return {
    mode: oneOf(o, "mode", ["auto", "sandbox"] as const),
    allowedDomains: strArray(o, "allowedDomains"),
  };
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
): Pick<DeviceHello, "features" | "policy" | "recentOps" | "home" | "bootId"> {
  const out: Pick<DeviceHello, "features" | "policy" | "recentOps" | "home" | "bootId"> = {};
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

function parseHello(o: Record<string, unknown>): DeviceHello {
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
      parseCeiling(a.limits);
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
      parseCeiling(a.limits);
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
      if (a.add !== undefined) hostArray(a, "add");
      if (a.remove !== undefined) hostArray(a, "remove");
      if (a.mode !== undefined && a.mode !== "sandbox") {
        throw new DeviceProtocolError('field "mode" may only be "sandbox"');
      }
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
      parseCeiling(a.limits);
      return;
    }
    case "scan":
      absolutePath(a.base, 'field "base"');
      parseCeiling(a.limits);
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
  policy: DevicePolicyResult;
  policyStatus: DevicePolicyStatus;
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
      const out: DevicePolicyStatus = {
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
export function parseDeviceFrame(raw: string, from: "device" | "kernel"): DeviceFrame {
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
