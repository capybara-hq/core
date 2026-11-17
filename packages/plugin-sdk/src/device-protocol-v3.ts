/** Development staging only. Task 8 replaces v2 and removes this module and its staged names together. */
import {
  type DeviceHello,
  type DeviceOp,
  DeviceProtocolError,
  type DeviceRes,
  type KernelCancel,
  parseDeviceFrame,
  parseOpResult,
} from "./device-protocol.js";
import { validateAllowHost, validateSandboxPathShape } from "./sandbox.js";
import {
  parseSandboxBrowseScope,
  parseSandboxExecutionRef,
  parseSandboxOperationRef,
  parseSandboxOperationScope,
  parseSandboxPreparationScope,
  type SandboxPermissionSupport,
} from "./sandbox-operation.js";
export const STAGED_DEVICE_PROTOCOL_VERSION = 3;
export type DeviceOperationV3 =
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
export interface DeviceOwnerCeilingV3 {
  readonly version: 2;
  readonly sequence: number;
  readonly restrictedProjectReach: "workspace" | "os-user";
  readonly revision: string;
  readonly fullAccess: boolean;
  readonly restrictedAllowedDomains: readonly string[];
}
export interface DeviceHelloV3 extends DeviceHello {
  protocol: 3;
  permissionSupport: SandboxPermissionSupport;
  ownerCeiling: DeviceOwnerCeilingV3;
  instanceGeneration: string | null;
  transport: { maxFrameBytes: number };
  /** Absent until the program can attest actual installed runtime/helper/environment bytes. */
  runtimeIdentity?: DeviceRuntimeIdentityV3;
}
/** A verified installed runtime/helper/environment identity bound to one instance generation. */
export interface DeviceRuntimeIdentityV3 {
  runtimeHash: string;
  helperHash: string;
  imageFingerprint: string;
  instanceGeneration: string;
}
/**
 * Private lifecycle request (permission runtime cutover B4): binds the kernel's committed instance
 * generation to the device after commit. It carries no path, policy or manifest.
 */
export interface BindInstanceRequestV3 {
  instanceId: string;
  instanceGeneration: string;
  bindingId: string;
  expectedPreviousGeneration: string | null;
}
export interface BindInstanceResultV3 {
  instanceId: string;
  instanceGeneration: string;
  bindingId: string;
  runtimeIdentity: DeviceRuntimeIdentityV3;
  permissionSupport: SandboxPermissionSupport;
  ownerCeiling: DeviceOwnerCeilingV3;
}
export interface KernelReadyV3 {
  type: "ready";
  connectionId: string;
  maxFrameBytes: number;
}
export interface BackgroundReadOutputRequestV3 {
  offset: number;
  maxBytes: number;
}
export type BackgroundReadOutputResultV3 =
  | { dataB64: string; offset: number; nextOffset: number; totalBytes: number }
  | { unavailable: "lost" | "expired" };

export interface KernelRequestV3 {
  type: "req";
  id: string;
  op: DeviceOperationV3;
  args: Readonly<Record<string, unknown>>;
  deadlineMs: number;
}
export type DeviceResponseV3 =
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
export type DeviceFrameV3 =
  | DeviceHelloV3
  | KernelReadyV3
  | KernelRequestV3
  | KernelCancel
  | DeviceResponseV3
  | { type: "policy"; policy?: unknown };
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
function support(value: unknown): SandboxPermissionSupport {
  const o = object(value);
  keys(o, ["version", "restricted", "fullAccess", "background", "unavailableReason"]);
  if (o.version !== 1 || typeof o.fullAccess !== "boolean" || typeof o.background !== "boolean")
    throw new DeviceProtocolError("Invalid runtime permission report");
  if (o.restricted !== null) {
    const r = object(o.restricted);
    keys(r, ["filesystem", "network", "native", "concurrentScopes"]);
    for (const k of ["filesystem", "network", "native", "concurrentScopes"])
      if (r[k] !== true) throw new DeviceProtocolError("Incomplete restricted runtime report");
  }
  if (o.unavailableReason !== undefined) string(o.unavailableReason, 4096);
  return o as unknown as SandboxPermissionSupport;
}
function owner(value: unknown): DeviceOwnerCeilingV3 {
  const o = object(value);
  keys(o, [
    "version",
    "sequence",
    "revision",
    "fullAccess",
    "restrictedProjectReach",
    "restrictedAllowedDomains",
  ]);
  integer(o.sequence);
  if (o.version !== 2 || !["workspace", "os-user"].includes(String(o.restrictedProjectReach)))
    throw new DeviceProtocolError("Invalid owner ceiling report version or project reach");
  string(o.revision, 512);
  if (
    typeof o.fullAccess !== "boolean" ||
    !Array.isArray(o.restrictedAllowedDomains) ||
    o.restrictedAllowedDomains.length > 100 ||
    o.restrictedAllowedDomains.some((h) => typeof h !== "string" || validateAllowHost(h).length)
  )
    throw new DeviceProtocolError("Invalid owner ceiling");
  return o as unknown as DeviceOwnerCeilingV3;
}
const GENERATION = /^[0-9]{1,16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function generation(value: unknown): string {
  if (typeof value !== "string" || !GENERATION.test(value))
    throw new DeviceProtocolError("Expected an instance generation");
  return value;
}
function bindRequest(a: Record<string, unknown>): BindInstanceRequestV3 {
  string(a.instanceId);
  generation(a.instanceGeneration);
  if (typeof a.bindingId !== "string" || !UUID.test(a.bindingId))
    throw new DeviceProtocolError("Expected a binding id");
  if (a.expectedPreviousGeneration !== null) {
    generation(a.expectedPreviousGeneration);
    if (BigInt(a.expectedPreviousGeneration as string) >= BigInt(a.instanceGeneration as string))
      throw new DeviceProtocolError("Previous generation must precede the bound generation");
  }
  return a as unknown as BindInstanceRequestV3;
}
function identity(value: unknown): DeviceRuntimeIdentityV3 {
  const o = object(value);
  keys(o, ["runtimeHash", "helperHash", "imageFingerprint", "instanceGeneration"]);
  for (const key of ["runtimeHash", "helperHash", "imageFingerprint"])
    if (typeof o[key] !== "string" || !/^[a-f0-9]{64}$/.test(o[key] as string))
      throw new DeviceProtocolError("Incomplete runtime identity");
  string(o.instanceGeneration);
  return o as unknown as DeviceRuntimeIdentityV3;
}
const natives = ["exec", "readFile", "writeFile", "stat", "list", "scan"];
const legacy = ["create", "stop", "policy", "policyStatus"];
function request(o: Record<string, unknown>): KernelRequestV3 {
  keys(o, ["type", "id", "op", "args", "deadlineMs"]);
  const id = string(o.id),
    op = string(o.op),
    a = object(o.args),
    deadlineMs = integer(o.deadlineMs, 1);
  if (legacy.includes(op)) {
    const parsed = parseDeviceFrame(JSON.stringify(o), "kernel");
    if (parsed.type !== "req") throw new DeviceProtocolError("Expected request");
    return freeze({ ...parsed, op: op as DeviceOperationV3, args: object(parsed.args) });
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
    } else if (native !== "writeFile") validated.limits = { mode: "sandbox" };
    // Reuse v2's pure value guards; inserted mode is never returned or used as authority.
    parseDeviceFrame(
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
  return freeze({ type: "req", id, op: op as DeviceOperationV3, args: a, deadlineMs });
}
/** Strict scope-bearing frames; active parseDeviceFrame still speaks v2. */
export function parseDeviceFrameV3(
  raw: string,
  from: "device" | "kernel",
  maxFrameBytes?: number,
): DeviceFrameV3 {
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
    if (from !== "device" || o.protocol !== 3)
      throw new DeviceProtocolError("Expected protocol 3 hello");
    const transport = object(o.transport);
    keys(transport, ["maxFrameBytes"]);
    const maxFrameBytes = integer(transport.maxFrameBytes, 1024);
    const permissionSupport = support(o.permissionSupport);
    if (
      o.instanceGeneration === null &&
      (o.runtimeIdentity !== undefined ||
        permissionSupport.restricted !== null ||
        permissionSupport.fullAccess ||
        permissionSupport.background ||
        !permissionSupport.unavailableReason)
    )
      throw new DeviceProtocolError("Unbound hello cannot advertise runtime capability");
    const base = parseDeviceFrame(raw, from);
    if (base.type !== "hello") throw new DeviceProtocolError("Expected hello");
    let runtimeIdentity: DeviceHelloV3["runtimeIdentity"];
    if (o.runtimeIdentity !== undefined) {
      runtimeIdentity = identity(o.runtimeIdentity);
      if (runtimeIdentity.instanceGeneration !== string(o.instanceGeneration))
        throw new DeviceProtocolError("Runtime identity generation mismatch");
    }
    return freeze({
      ...base,
      protocol: 3,
      permissionSupport,
      transport: { maxFrameBytes },
      ownerCeiling: owner(o.ownerCeiling),
      instanceGeneration: o.instanceGeneration === null ? null : string(o.instanceGeneration),
      ...(runtimeIdentity && { runtimeIdentity }),
    });
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
        kind: e.kind as Extract<DeviceResponseV3, { ok: false }>["error"]["kind"],
        message: string(e.message, 8192),
      },
    });
  }
  const base = parseDeviceFrame(raw, from);
  if (base.type === "hello" || base.type === "req")
    throw new DeviceProtocolError("Expected staged frame");
  return freeze(base);
}
export function parseOperationResultV3(
  op: DeviceOperationV3,
  result: unknown,
  request?: BackgroundReadOutputRequestV3 | BindInstanceRequestV3,
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
      permissionSupport: support(o.permissionSupport),
      ownerCeiling: owner(o.ownerCeiling),
    } satisfies BindInstanceResultV3);
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
      return freeze(o) as BackgroundReadOutputResultV3;
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
    return freeze(o) as BackgroundReadOutputResultV3;
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
  return parseOpResult((raw.charAt(0).toLowerCase() + raw.slice(1)) as DeviceOp, result);
}
