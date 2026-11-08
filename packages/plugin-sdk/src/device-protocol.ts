/**
 * Device protocol v1: the WebSocket frames between the kernel and a `capybara-device` program
 * (a connected machine that serves as an environment). Pure types and hand-written guards.
 */
import type { ExecResult, SandboxActor, SandboxLimits, SandboxRoots } from "./sandbox.js";

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
    if (!p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p)) {
      throw new DeviceProtocolError(`root "${k}" must be an absolute path`);
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
    protocol: num(o, "protocol"),
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
  return {
    type: "req",
    id: nonEmptyStr(o, "id"),
    op: op as DeviceOp,
    args: o.args,
    deadlineMs: num(o, "deadlineMs"),
  };
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
