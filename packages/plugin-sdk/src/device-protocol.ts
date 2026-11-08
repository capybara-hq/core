/**
 * Device protocol v1: the WebSocket frames between the kernel and a `capybara-device` program
 * (a connected machine that serves as an environment). Pure types and hand-written guards.
 */
import {
  type ExecResult,
  type SandboxActor,
  type SandboxLimits,
  type SandboxRoots,
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
  | "stop";

const DEVICE_OPS: readonly DeviceOp[] = [
  "create",
  "exec",
  "readFile",
  "writeFile",
  "stat",
  "killTagged",
  "killAll",
  "stop",
];

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
  return {
    cpu: num(o, "cpu"),
    memoryMb: num(o, "memoryMb"),
    diskMb: num(o, "diskMb"),
    egress,
    allowHosts: strArray(o, "allowHosts"),
  };
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
      parseLimits(a.limits);
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
      return {
        exitCode: exitCode as number | null,
        stdout: str(r, "stdout"),
        stderr: str(r, "stderr"),
        truncated: bool(r, "truncated"),
        timedOut: bool(r, "timedOut"),
      };
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
