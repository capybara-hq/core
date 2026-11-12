/**
 * Device protocol v1: the WebSocket frames between the kernel and a `capybara-device` program
 * (a connected machine that serves as a device). Pure types and hand-written guards.
 */
import {
  type ExecResult,
  isSandboxTier,
  type NetworkBlockedHost,
  type NetworkBlockLayer,
  type SandboxActor,
  type SandboxLimits,
  type SandboxRoots,
  type SandboxTier,
  validateAllowHost,
  validateSandboxPathShape,
} from "./sandbox.js";

/** The protocol version carried in `X-Capybara-Device-Protocol` and the hello frame. */
export const DEVICE_PROTOCOL_VERSION = 1;

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
  | "policy";

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
];

/**
 * Optional capabilities a device announces in its hello. A kernel sends the `policy` op only to a
 * device with `policyOp`; `networkReport` means exec results may carry `network`; `tiers` means the
 * device applies `limits.tier` / `defaultTier` / `devHosts` (without it the device behaves as
 * `strict`).
 */
export type DeviceFeature = "networkReport" | "policyOp" | "tiers";
const DEVICE_FEATURES: readonly DeviceFeature[] = ["networkReport", "policyOp", "tiers"];

/**
 * Whether the device accepts widening its local policy from the kernel (the `policy` op's `add`
 * and a higher `tier`, run and task grants): `owner` (default, decided by the device owner in a
 * signed-in session) or `off` (only the machine's user widens it, with the CLI).
 */
export type DeviceRemoteGrants = "owner" | "off";

/** What the kernel knows of a device's local policy (from the hello or a `policy` op). */
export interface DeviceLocalPolicySummary {
  /** The tier the device owner chose; absent = follows the org's default. */
  tier?: SandboxTier;
  /** The tier the device ran its last command at (its choice cut to the org's ceiling). */
  effectiveTier: SandboxTier;
  /** `none` = the device runs commands without a sandbox (only with tier `open`, OS mode). */
  isolation: "sandbox" | "none";
  /** Whether sandboxed commands may bind and reach localhost on this machine. */
  localhost: "on" | "off-proxy-detected" | "off";
  /** Unix socket access: within the roots, every socket masked, or none. */
  unixSockets: "roots" | "all-masked" | "off";
  allowedDomains: string[];
  remoteGrants: DeviceRemoteGrants;
}

/** The most blocked hosts an exec result reports; the parser cuts longer lists. */
export const MAX_NETWORK_BLOCKED_HOSTS = 20;

/** The most hosts a `policy` op's `add` / `remove` or an exec's `grants` may carry. */
const MAX_POLICY_HOSTS = 100;

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

export type DeviceFrame = DeviceHello | DeviceRes | KernelReq | KernelCancel;

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
   * scheduled task's grants). A device applies them only when its `remoteGrants` is `owner` and
   * only within `limits`; a device without the feature ignores the field.
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
 * Edits the device's local policy. The device refuses widening (`add`, a higher `tier`) unless
 * its `remoteGrants` is `owner`; narrowing is always accepted. `isolation` may only turn the
 * sandbox back on: turning it off is decided on the machine.
 */
export interface DevicePolicyArgs {
  /** Hosts to add to `allowedDomains`. */
  add?: string[];
  /** Hosts to remove from `allowedDomains`. */
  remove?: string[];
  /** The device's tier; null = follow the org's default. */
  tier?: SandboxTier | null;
  /** Only `sandbox`: the kernel never turns the sandbox off. */
  isolation?: "sandbox";
  /** Who decided, for the device's local audit line. */
  source: { approvalId?: string; accountId: string; accountName: string; via: "web" | "im" };
}
/** The policy as the device wrote it. */
export interface DevicePolicyResult {
  policy: DeviceLocalPolicySummary;
}

/** A frame that is not valid protocol v1 (or came from the wrong side). */
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

function strArray(o: Record<string, unknown>, k: string): string[] {
  const v = o[k];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new DeviceProtocolError(`field "${k}" must be an array of strings`);
  }
  return v as string[];
}

function parseLimits(v: unknown): SandboxLimits {
  const o = obj(v, 'field "limits"');
  const egress = str(o, "egress");
  if (egress !== "none" && egress !== "allowlist" && egress !== "open") {
    throw new DeviceProtocolError(`unknown egress "${egress}"`);
  }
  const devHosts = strArray(o, "devHosts");
  for (const h of devHosts) {
    const problems = validateAllowHost(h);
    if (problems.length > 0) {
      throw new DeviceProtocolError(`invalid dev host "${h}": ${problems.join("; ")}`);
    }
  }
  const out: SandboxLimits = {
    cpu: num(o, "cpu"),
    memoryMb: num(o, "memoryMb"),
    diskMb: num(o, "diskMb"),
    egress,
    allowHosts: strArray(o, "allowHosts"),
    tier: parseTier(o, "tier"),
    devHosts,
  };
  if (o.defaultTier !== undefined) out.defaultTier = parseTier(o, "defaultTier");
  if (o.allowUnsandboxed !== undefined) out.allowUnsandboxed = bool(o, "allowUnsandboxed");
  return out;
}

function parseTier(o: Record<string, unknown>, k: string): SandboxTier {
  const v = str(o, k);
  if (!isSandboxTier(v)) throw new DeviceProtocolError(`unknown tier "${v}"`);
  return v;
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

function parsePolicySummary(v: unknown): DeviceLocalPolicySummary {
  const o = obj(v, 'field "policy"');
  const remoteGrants = str(o, "remoteGrants");
  if (remoteGrants !== "owner" && remoteGrants !== "off") {
    throw new DeviceProtocolError(`unknown remoteGrants "${remoteGrants}"`);
  }
  const out: DeviceLocalPolicySummary = {
    effectiveTier: parseTier(o, "effectiveTier"),
    isolation: oneOf(o, "isolation", ["sandbox", "none"] as const),
    localhost: oneOf(o, "localhost", ["on", "off-proxy-detected", "off"] as const),
    unixSockets: oneOf(o, "unixSockets", ["roots", "all-masked", "off"] as const),
    allowedDomains: strArray(o, "allowedDomains"),
    remoteGrants,
  };
  if (o.tier !== undefined) out.tier = parseTier(o, "tier");
  return out;
}

/** Optional hello fields: malformed values are ignored so old and new peers interoperate. */
function optionalHelloFields(o: Record<string, unknown>): Pick<DeviceHello, "features" | "policy"> {
  const out: Pick<DeviceHello, "features" | "policy"> = {};
  if (Array.isArray(o.features)) {
    out.features = DEVICE_FEATURES.filter((f) => (o.features as unknown[]).includes(f));
  }
  if (o.policy !== undefined) {
    try {
      out.policy = parsePolicySummary(o.policy);
    } catch {
      // an unreadable summary is the same as none: the kernel learns the policy later
    }
  }
  return out;
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
      if (a.add !== undefined) hostArray(a, "add");
      if (a.remove !== undefined) hostArray(a, "remove");
      if (a.tier !== undefined && a.tier !== null) parseTier(a, "tier");
      if (a.isolation !== undefined && a.isolation !== "sandbox") {
        throw new DeviceProtocolError('field "isolation" may only be "sandbox"');
      }
      const src = obj(a.source, 'field "source"');
      nonEmptyStr(src, "accountId");
      str(src, "accountName");
      const via = str(src, "via");
      if (via !== "web" && via !== "im") throw new DeviceProtocolError(`unknown via "${via}"`);
      if (src.approvalId !== undefined) str(src, "approvalId");
      return;
    }
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
    default:
      if (result !== null) throw new DeviceProtocolError(`${op} result must be null`);
      return null;
  }
}

/**
 * Parses one WebSocket text frame. `from` is the sender: a device may send `hello` and `res`, the
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
      if (from !== "device") throw new DeviceProtocolError(`"${type}" must come from the device`);
      return type === "hello" ? parseHello(o) : parseRes(o);
    case "req":
    case "cancel":
      if (from !== "kernel") throw new DeviceProtocolError(`"${type}" must come from the kernel`);
      return type === "req" ? parseReq(o) : { type: "cancel", id: nonEmptyStr(o, "id") };
    default:
      throw new DeviceProtocolError(`unknown frame type "${String(type)}"`);
  }
}
