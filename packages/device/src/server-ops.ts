import {
  type DeviceExecArgs,
  type DeviceKillTaggedArgs,
  type DeviceListArgs,
  type DeviceLocalPolicySummary,
  type DevicePolicyArgs,
  type DevicePolicyStatus,
  type DevicePolicyStatusArgs,
  type DeviceReadFileArgs,
  type DeviceRes,
  type DeviceScanArgs,
  type DeviceStatArgs,
  type DeviceWriteFileArgs,
  isPolicyOpId,
  type KernelReq,
  MAX_DEVICE_LIST_ENTRIES,
  type SandboxLimits,
  validateAllowHost,
  validateSandboxPathShape,
} from "@capybara-hq/plugin-sdk";
import type { CommandLogEntry } from "./command-log.js";
import { DeviceOpError, type ExecMode, type Executor } from "./exec/types.js";
import { effectiveMode, grantedHosts } from "./policy.js";
import type { PolicyOpRecord } from "./policy-ops.js";
import type { PolicyStore } from "./policy-store.js";
import { publicSuffixWildcard } from "./public-suffix.js";
import { DEFAULT_POLICY, type Policy } from "./state.js";

/** What this program has seen across requests (one per program run, kept over reconnects). */
export interface SeenState {
  /** The mode of the latest exec's limits (the kernel's ceiling), for the summary. */
  limits?: Pick<SandboxLimits, "mode">;
}

/** What a request may need beyond the executor. */
export interface OpContext {
  /**
   * The local policy this program serves (the one the executor reads). Without it the device
   * answers the `policy` op as unsupported (and does not announce `policyOp` in its hello).
   */
  policy?: PolicyStore;
  /** Updated by every exec; read by the policy op's summary. */
  seen?: SeenState;
}

/** The refusal of a `policy` op that tries to turn auto mode on from the deployment. */
export const MODE_ON_DEVICE_MESSAGE =
  "The device's mode can only be changed on the machine: run `capybara-device mode auto`.";

/** The local-log line for a finished request; `detail` is its audit line, `run` how an exec ran. */
export function logEntryFor(
  req: KernelReq,
  res: DeviceRes,
  now: Date,
  detail?: string,
  run?: ExecMode,
): CommandLogEntry {
  const exec = req.op === "exec" ? (req.args as DeviceExecArgs) : undefined;
  const exitCode =
    res.ok && req.op === "exec"
      ? ((res.result as { exitCode: number | null }).exitCode ?? null)
      : null;
  return {
    time: now.toISOString(),
    op: req.op,
    tag: exec ? exec.tag : null,
    actor: exec ? { accountId: exec.actor.accountId } : null,
    exitCode,
    ...(run !== undefined && { mode: run.mode }),
    ...(detail !== undefined && { detail }),
  };
}

/** What the summary describes besides the policy file. */
export interface SummaryFacts {
  mode: Executor["mode"];
  /** The latest exec's mode ceiling; undefined before the first exec. */
  limits?: Pick<SandboxLimits, "mode"> | undefined;
}

/**
 * The summary the kernel keeps of a local policy (hello, `policy` op result): the owner's mode and
 * the device's sandbox-mode allowlist. The mode is never cut by the latest exec's ceiling: the
 * kernel takes min(allowed, reported) itself, so an organization that later allows auto mode is
 * followed at once instead of at the next command (the exec path still applies its ceiling).
 */
export function policySummary(p: Policy, _facts: SummaryFacts): DeviceLocalPolicySummary {
  return {
    mode: p.mode,
    allowedDomains: [...p.allowedDomains],
  };
}

/** The summary facts of a request context. */
export function summaryFacts(executor: Executor, ctx: OpContext): SummaryFacts {
  return {
    mode: executor.mode,
    limits: ctx.seen?.limits,
  };
}

/** A refused `policy` op, with the local audit line that records the attempt. */
class PolicyRefused extends DeviceOpError {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super("policy", message);
  }
}

/** A deployment-supplied string fit for the local log: no control or format characters. */
function clean(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .slice(0, max);
}

/** Lowercased hosts of a `policy` op field; throws a `policy` error naming the first bad one. */
function opHosts(list: unknown, key: "add" | "remove", fromApproval: boolean): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new DeviceOpError("policy", `${key} must be a list of hosts`);
  return list.map((raw) => {
    if (typeof raw !== "string")
      throw new DeviceOpError("policy", `${key} must be a list of hosts`);
    const host = raw.toLowerCase();
    // A device-page wildcard over a whole public suffix is close to an open network, unconfirmed.
    const tooBroad = key === "add" ? publicSuffixWildcard(host) : null;
    if (tooBroad !== null) throw new DeviceOpError("policy", tooBroad);
    const errors = validateAllowHost(host);
    if (errors.length > 0) {
      throw new DeviceOpError("policy", `${JSON.stringify(raw)}: ${errors.join("; ")}`);
    }
    // An approval grants the exact host it asked about; wildcards come only from the device page.
    if (key === "add" && fromApproval && host.startsWith("*.")) {
      throw new DeviceOpError(
        "policy",
        `${JSON.stringify(raw)}: an approval grants an exact host, not a wildcard`,
      );
    }
    return host;
  });
}

/**
 * Applies a `policy` op to the local policy (a trust boundary: the deployment is not the owner).
 *
 * - `mode`: only `"sandbox"` (narrowing) is ever applied; `"auto"` is refused, so the deployment
 *   can never turn auto mode on. Only `capybara-device mode auto` on the machine does.
 * - `add` / `remove` change the sandbox-mode allowlist; every host is validated (an approval adds
 *   an exact host, never a wildcard).
 *
 * The op is idempotent. Returns the result and the local audit line; a refusal carries its audit
 * line too ({@link PolicyRefused}).
 */
function applyPolicyOp(
  store: PolicyStore,
  args: DevicePolicyArgs,
  facts: SummaryFacts,
  written: () => void,
): { result: { policy: DeviceLocalPolicySummary }; detail: string } {
  const source = (args.source ?? {}) as Partial<DevicePolicyArgs["source"]>;
  const fromApproval = source.approvalId !== undefined;
  const add = [...new Set(opHosts(args.add, "add", fromApproval))];
  const remove = [...new Set(opHosts(args.remove, "remove", fromApproval))];
  // Read as unknown: the frame parser may have been bypassed, so nothing is assumed of the shape.
  const rawMode: unknown = (args as { mode?: unknown }).mode;
  const parts: string[] = [];
  if (add.length > 0) parts.push(`add ${add.join(", ")}`);
  if (remove.length > 0) parts.push(`remove ${remove.join(", ")}`);
  if (rawMode !== undefined) parts.push(`mode ${clean(String(rawMode), 40)}`);
  const by =
    `by ${clean(source.accountName, 100)} (${clean(source.accountId, 100)}) ` +
    `via ${clean(source.via, 10)}`;
  const approval = fromApproval ? `, approval ${clean(source.approvalId, 100)}` : "";
  const what = parts.length > 0 ? parts.join("; ") : "unchanged";
  const refused = `policy refused ${what} ${by}${approval}`;
  if (rawMode !== undefined && rawMode !== "sandbox") {
    // Turning auto mode on is decided on the machine only (spec §4.1).
    throw new PolicyRefused(MODE_ON_DEVICE_MESSAGE, refused);
  }
  const both = add.find((h) => remove.includes(h));
  if (both !== undefined) {
    throw new DeviceOpError("policy", `${both} is both added and removed`);
  }
  const change = (p: Policy): Policy => {
    const kept = p.allowedDomains.filter((d) => !remove.includes(d.toLowerCase()));
    const present = new Set(kept.map((d) => d.toLowerCase()));
    return {
      ...p,
      mode: rawMode === "sandbox" ? "sandbox" : p.mode,
      allowedDomains: [...kept, ...add.filter((h) => !present.has(h))],
    };
  };
  const next = store.update(change, { written });
  return {
    result: { policy: policySummary(next, facts) },
    detail: `policy ${what} ${by}${approval}`,
  };
}

/** The answer to a `policy` op whose outcome is logged already: the change is not made again. */
function answerFromLog(
  req: KernelReq,
  known: PolicyOpRecord,
  store: PolicyStore,
  facts: SummaryFacts,
): DeviceRes {
  if (known.outcome === "applied") {
    return {
      type: "res",
      id: req.id,
      ok: true,
      result: { policy: policySummary(store.current(), facts) },
    };
  }
  return {
    type: "res",
    id: req.id,
    ok: false,
    error: { kind: known.kind ?? "policy", message: known.message ?? "refused" },
  };
}

/**
 * A `policy` op by its op id: logged `started` before anything is checked or written, then
 * `applied` (inside the policy lock, right after the write) or `refused` with the message. An op
 * id applied or refused before is answered from the log without applying it again. Throws like
 * {@link applyPolicyOp}.
 */
function servePolicyOp(
  req: KernelReq,
  store: PolicyStore,
  facts: SummaryFacts,
): { res: DeviceRes; detail?: string } {
  const opId: unknown = (req.args as { opId?: unknown }).opId;
  if (!isPolicyOpId(opId)) {
    throw new DeviceOpError("error", 'invalid request: field "opId" must be a valid op id');
  }
  const known = store.ops.claim(opId);
  if (known !== undefined) return { res: answerFromLog(req, known, store, facts) };
  try {
    const { result, detail } = applyPolicyOp(store, req.args as DevicePolicyArgs, facts, () => {
      try {
        store.ops.recordHeld({ opId, outcome: "applied" });
      } catch {
        // the change stands; the log keeps `started` and the deployment learns it from the hello
      }
    });
    return { res: { type: "res", id: req.id, ok: true, result }, detail };
  } catch (e) {
    // an op the log already says was applied stays applied (the log reports what the file holds)
    if (store.ops.get(opId)?.outcome !== "applied") {
      try {
        store.ops.record({
          opId,
          outcome: "refused",
          message: e instanceof Error ? e.message : String(e),
          kind: e instanceof DeviceOpError ? e.kind : "error",
        });
      } catch {
        // nothing was applied; the log keeps `started`
      }
    }
    throw e;
  }
}

/** The operations answered from the local policy file. */
type LocalPolicyOp = "policy" | "policyStatus";

/**
 * Whether `op` is answered from the local policy file: it lives in the state directory, so these
 * work while the device directory is gone, like the `policy` ops.
 */
function isLocalPolicyOp(op: KernelReq["op"]): op is LocalPolicyOp {
  return op === "policy" || op === "policyStatus";
}

/** The answer to an operation this program does not serve (no policy store, or no reader). */
function unsupported(req: KernelReq): DeviceRes {
  return {
    type: "res",
    id: req.id,
    ok: false,
    error: { kind: "error", message: "unsupported operation" },
  };
}

/** What the log says of an op id, with the summary now. Read-only. */
function policyStatus(store: PolicyStore, args: unknown, facts: SummaryFacts): DevicePolicyStatus {
  const opId: unknown = (args as Partial<DevicePolicyStatusArgs> | null)?.opId;
  if (!isPolicyOpId(opId)) {
    throw new DeviceOpError("error", 'invalid request: field "opId" must be a valid op id');
  }
  const known = store.ops.get(opId);
  return {
    outcome: known?.outcome ?? "unknown",
    policy: policySummary(store.current(), facts),
    ...(known?.outcome === "refused" && known.message !== undefined && { message: known.message }),
  };
}

/** A `list` / `scan` field that must be a clean absolute path, checked again here. */
function requestPath(v: unknown, key: string): string {
  const errors = typeof v === "string" ? validateSandboxPathShape(v) : ["path must be a string"];
  if (errors.length > 0) {
    throw new DeviceOpError("error", `invalid request: field "${key}": ${errors.join("; ")}`);
  }
  return v as string;
}

/** A `list` / `scan` request's ceiling (`limits.mode`), checked again here. */
function requestCeiling(args: unknown): Pick<SandboxLimits, "mode"> {
  const mode = (args as { limits?: { mode?: unknown } } | null)?.limits?.mode;
  if (mode !== "auto" && mode !== "sandbox") {
    throw new DeviceOpError(
      "error",
      'invalid request: field "limits.mode" must be "auto" or "sandbox"',
    );
  }
  return { mode };
}

/**
 * A `list` or `scan` request (a trust boundary: the device decides what a web session sees of its
 * machine). Each is read in the mode it would run in now, `effectiveMode` of the owner's policy and
 * the ceiling the request carries, never one an earlier command saw nor the file writes'
 * window. Answered without the device directory: it reads the owner's machine, not that
 * directory. Throws like the executor (a path its mode cannot reach is a `policy` refusal).
 */
async function serveRead(
  executor: Executor,
  req: KernelReq,
  signal: AbortSignal,
  store: PolicyStore,
): Promise<{ result: unknown; detail: string }> {
  const args = req.args as Partial<DeviceListArgs & DeviceScanArgs> | null;
  const limits = requestCeiling(args);
  if (req.op === "list") {
    const path = requestPath(args?.path, "path");
    const limit = args?.limit;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_DEVICE_LIST_ENTRIES
    ) {
      throw new DeviceOpError(
        "error",
        `invalid request: field "limit" must be an integer from 1 to ${MAX_DEVICE_LIST_ENTRIES}`,
      );
    }
    const mode = effectiveMode(store.current(), limits);
    signal.throwIfAborted();
    const result = await (executor.list as NonNullable<Executor["list"]>)(
      mode,
      path,
      limit,
      signal,
    );
    return { result, detail: `list ${clean(path, 300)} in ${mode} mode` };
  }
  const base = requestPath(args?.base, "base");
  const mode = effectiveMode(store.current(), limits);
  signal.throwIfAborted();
  const result = await (executor.scan as NonNullable<Executor["scan"]>)(mode, base, signal);
  return { result, detail: `scan ${clean(base, 300)} in ${mode} mode` };
}

/** Each file read uses this request's ceiling, intersected with the machine's current choice. */
function readMode(args: unknown, store: PolicyStore | undefined) {
  const mode = (args as { limits?: { mode?: unknown } } | undefined)?.limits?.mode;
  if (mode !== "auto" && mode !== "sandbox")
    throw new DeviceOpError(
      "error",
      "invalid request: file reads require limits.mode auto or sandbox",
    );
  return store === undefined ? "sandbox" : effectiveMode(store.current(), { mode });
}

/** The audit line of an exec whose grants applied (sandbox mode only: auto mode ignores grants). */
function grantsDetail(
  executor: Executor,
  args: DeviceExecArgs,
  policy: Policy | undefined,
): string | undefined {
  if (executor.mode !== "os" || args.grants === undefined || policy === undefined) {
    return undefined;
  }
  if (effectiveMode(policy, args.limits) !== "sandbox") return undefined;
  const hosts = grantedHosts(args.limits, args.grants);
  if (hosts.length === 0) return undefined;
  const s = args.grants.source;
  return `grants ${clean(s.kind, 10)} ${clean(s.id, 100)} by ${clean(s.accountId, 100)}: ${hosts.join(", ")}`;
}

/**
 * Runs one request and returns the answer plus its local audit line and, for an exec, its mode
 * (for the local command log). A vanished device directory answers `fs_gone` for every operation
 * except `stop`, `policy`, `policyStatus`, `list` and `scan`. Never throws.
 */
export async function serveOp(
  executor: Executor,
  req: KernelReq,
  signal: AbortSignal,
  ctx: OpContext = {},
): Promise<{ res: DeviceRes; detail?: string; run?: ExecMode }> {
  const ok = (result: unknown): DeviceRes => ({ type: "res", id: req.id, ok: true, result });
  try {
    if (req.op === "stop") return { res: ok(null) };
    // The policy lives in the state directory, not the device directory.
    if (isLocalPolicyOp(req.op)) {
      if (ctx.policy === undefined) return { res: unsupported(req) };
      const facts = summaryFacts(executor, ctx);
      if (req.op === "policyStatus") return { res: ok(policyStatus(ctx.policy, req.args, facts)) };
      return servePolicyOp(req, ctx.policy, facts);
    }
    // They read the owner's machine in the request's own mode, not the device directory, so they
    // work while that directory is gone. Served only with a policy store (the mode needs the
    // owner's choice) and by an executor that can read in a given mode.
    if (req.op === "list" || req.op === "scan") {
      const can = req.op === "list" ? executor.list : executor.scan;
      if (ctx.policy === undefined || can === undefined) return { res: unsupported(req) };
      try {
        const { result, detail } = await serveRead(executor, req, signal, ctx.policy);
        return { res: ok(result), detail };
      } catch (e) {
        const { res } = errorAnswer(req, e);
        const message = res.ok ? "" : clean(res.error.message, 300);
        return { res, detail: `${req.op} refused: ${message}` };
      }
    }
    if ((await executor.ensureRoot()) === "gone") {
      return {
        res: {
          type: "res",
          id: req.id,
          ok: false,
          error: {
            kind: "fs_gone",
            message:
              "The device directory on this machine existed and is gone. It is not recreated automatically.",
          },
        },
      };
    }
    // The kernel may have cancelled while ensureRoot ran: never start the work then.
    signal.throwIfAborted();
    switch (req.op) {
      case "create":
        return { res: ok({ roots: executor.roots }) };
      case "exec": {
        const args = req.args as DeviceExecArgs;
        if (ctx.seen !== undefined) ctx.seen.limits = { mode: args.limits.mode };
        // One decision per command, on one read of the policy: the executor runs it and the
        // local log records it. Grants are judged on the same read.
        const policy = ctx.policy?.current();
        const run: ExecMode = {
          mode: effectiveMode(policy ?? DEFAULT_POLICY, args.limits),
        };
        // These limits are the latest decision file writes follow.
        executor.noteLimits?.(args.limits);
        const detail = grantsDetail(executor, args, policy);
        try {
          const result =
            policy !== undefined && executor.execDecided !== undefined
              ? await executor.execDecided(args, signal, run, policy)
              : await executor.exec(args, signal);
          const res = ok(result);
          return detail === undefined ? { res, run } : { res, detail, run };
        } catch (e) {
          return { ...errorAnswer(req, e), run };
        }
      }
      case "readFile": {
        const a = req.args as DeviceReadFileArgs;
        const mode = readMode(req.args, ctx.policy);
        const r = await executor.readFile(a.path, a.maxBytes, mode);
        return {
          res: ok(
            r === null
              ? null
              : { dataB64: Buffer.from(r.data).toString("base64"), truncated: r.truncated },
          ),
        };
      }
      case "writeFile": {
        const a = req.args as DeviceWriteFileArgs;
        await executor.writeFile(a.path, Buffer.from(a.dataB64, "base64"));
        return { res: ok(null) };
      }
      case "stat": {
        const a = req.args as DeviceStatArgs;
        return { res: ok(await executor.stat(a.path, readMode(req.args, ctx.policy))) };
      }
      case "killTagged":
        await executor.killTagged((req.args as DeviceKillTaggedArgs).tags);
        return { res: ok(null) };
      case "killAll":
        await executor.killAll();
        return { res: ok(null) };
    }
  } catch (e) {
    return errorAnswer(req, e);
  }
}

/** The error answer of a failed request, with a refused policy op's audit line. */
function errorAnswer(req: KernelReq, e: unknown): { res: DeviceRes; detail?: string } {
  const kind = e instanceof DeviceOpError ? e.kind : "error";
  const res: DeviceRes = {
    type: "res",
    id: req.id,
    ok: false,
    error: { kind, message: e instanceof Error ? e.message : String(e) },
  };
  return e instanceof PolicyRefused ? { res, detail: e.detail } : { res };
}

/** {@link serveOp} without the audit line. */
export async function runOp(
  executor: Executor,
  req: KernelReq,
  signal: AbortSignal,
  ctx: OpContext = {},
): Promise<DeviceRes> {
  return (await serveOp(executor, req, signal, ctx)).res;
}
