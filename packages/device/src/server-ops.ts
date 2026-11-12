import {
  type DeviceExecArgs,
  type DeviceKillTaggedArgs,
  type DeviceLocalPolicySummary,
  type DevicePolicyArgs,
  type DevicePolicyStatus,
  type DevicePolicyStatusArgs,
  type DeviceReadFileArgs,
  type DeviceRes,
  type DeviceStatArgs,
  type DeviceWriteFileArgs,
  isPolicyOpId,
  isSandboxTier,
  type KernelReq,
  type SandboxTier,
  tierAtMost,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import type { CommandLogEntry } from "./command-log.js";
import { execIsolation } from "./exec/switch.js";
import { DeviceOpError, type ExecIsolation, type Executor } from "./exec/types.js";
import { grantedHosts, type TierLimits, tierFacts } from "./policy.js";
import type { PolicyOpRecord } from "./policy-ops.js";
import type { PolicyStore } from "./policy-store.js";
import { publicSuffixWildcard } from "./public-suffix.js";
import { DEFAULT_POLICY, type Policy } from "./state.js";

/** What this program has seen across requests (one per program run, kept over reconnects). */
export interface SeenState {
  /** The tier limits of the latest exec: the org's ceiling and default, for the summary. */
  limits?: TierLimits;
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
  /** The platform the summary describes (default: this process's). */
  platform?: NodeJS.Platform;
}

/** The refusal of a `policy` op adding hosts under `remoteGrants: "off"`. */
export const REMOTE_GRANTS_OFF_MESSAGE =
  "This device does not accept network changes from the deployment; allow it locally: " +
  "capybara-device policy add allowedDomains <host>";

/** The refusal of a `policy` op raising the tier under `remoteGrants: "off"`. */
export const REMOTE_TIER_OFF_MESSAGE =
  "This device does not accept a higher tier from the deployment; raise it locally: " +
  "capybara-device policy set tier <tier>";

/**
 * The refusal of a `policy` op that tries to turn the sandbox off: whatever `remoteGrants` says,
 * only the person on the machine does that (spec §5.4).
 */
export const ISOLATION_REMOTE_MESSAGE =
  "This device turns its sandbox off only on the machine itself (capybara-device policy set " +
  'isolation none); the deployment may only set isolation to "sandbox".';

/**
 * The refusal of a widening `policy` op in Docker mode: the container has either no network or the
 * whole internet, so one allowed domain would open everything.
 */
export const DOCKER_WIDENING_MESSAGE =
  "This device runs commands in Docker mode, which cannot limit network access per domain; " +
  "switch the device to OS mode to allow single domains.";

/** The local-log line for a finished request; `detail` is its audit line, `run` how an exec ran. */
export function logEntryFor(
  req: KernelReq,
  res: DeviceRes,
  now: Date,
  detail?: string,
  run?: Pick<ExecIsolation, "tier" | "isolation">,
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
    ...(run !== undefined && { tier: run.tier, isolation: run.isolation }),
    ...(detail !== undefined && { detail }),
  };
}

/** What the summary describes besides the policy file. */
export interface SummaryFacts {
  mode: Executor["mode"];
  /** The latest exec's tier limits; undefined before the first exec. */
  limits?: TierLimits | undefined;
  /** The localhost proxy guard found a local forwarding proxy (OS mode). */
  proxyDetected?: boolean;
  platform?: NodeJS.Platform;
}

/**
 * The summary the kernel keeps of a local policy (hello, `policy` op result): the owner's tier,
 * what it gives on this machine with the latest ceiling seen ({@link tierFacts}), and the
 * isolation. Docker mode always reports `sandbox` (it ignores `isolation`).
 */
export function policySummary(p: Policy, facts: SummaryFacts): DeviceLocalPolicySummary {
  const tf = tierFacts(p, facts.limits, {
    mode: facts.mode,
    proxyDetected: facts.proxyDetected ?? false,
    ...(facts.platform !== undefined && { platform: facts.platform }),
  });
  return {
    ...(p.tier !== undefined && { tier: p.tier }),
    effectiveTier: tf.effectiveTier,
    isolation: facts.mode === "docker" ? "sandbox" : p.isolation,
    localhost: tf.localhost,
    unixSockets: tf.unixSockets,
    allowedDomains: [...p.allowedDomains],
    remoteGrants: p.remoteGrants,
  };
}

/** The summary facts of a request context. */
export function summaryFacts(executor: Executor, ctx: OpContext): SummaryFacts {
  return {
    mode: executor.mode,
    limits: ctx.seen?.limits,
    proxyDetected: executor.proxyGuard?.().detected ?? false,
    ...(ctx.platform !== undefined && { platform: ctx.platform }),
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
 * - `isolation`: only `"sandbox"` (narrowing) is ever applied; anything else is refused whatever
 *   `remoteGrants` says, so the deployment can never turn the sandbox off.
 * - Widening (`add`; a `tier` above the file's; `tier: null` when the file has strict or dev,
 *   since the org's default is not known here) applies only under `remoteGrants: "owner"`, read from the
 *   file under the lock. Docker mode refuses `add` (its container cannot limit single domains).
 * - Narrowing always applies. Any tier change turns an unsandboxed device's sandbox back on (it
 *   runs unsandboxed only on the owner's own local tier `open`).
 *
 * Every host is validated; the op is idempotent. Returns the result and the local audit line; a
 * refusal carries its audit line too ({@link PolicyRefused}).
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
  const rawTier: unknown = (args as { tier?: unknown }).tier;
  const rawIsolation: unknown = (args as { isolation?: unknown }).isolation;
  const parts: string[] = [];
  if (add.length > 0) parts.push(`add ${add.join(", ")}`);
  if (remove.length > 0) parts.push(`remove ${remove.join(", ")}`);
  if (rawTier !== undefined) {
    parts.push(`tier ${rawTier === null ? "org default" : clean(String(rawTier), 40)}`);
  }
  if (rawIsolation !== undefined) parts.push(`isolation ${clean(String(rawIsolation), 40)}`);
  const by =
    `by ${clean(source.accountName, 100)} (${clean(source.accountId, 100)}) ` +
    `via ${clean(source.via, 10)}`;
  const approval = fromApproval ? `, approval ${clean(source.approvalId, 100)}` : "";
  const what = parts.length > 0 ? parts.join("; ") : "unchanged";
  const refused = `policy refused ${what} ${by}${approval}`;
  if (rawIsolation !== undefined && rawIsolation !== "sandbox") {
    // Turning the sandbox off is decided on the machine only.
    throw new PolicyRefused(ISOLATION_REMOTE_MESSAGE, refused);
  }
  if (rawTier !== undefined && rawTier !== null && !isSandboxTier(rawTier)) {
    throw new PolicyRefused(`unknown tier ${clean(String(rawTier), 40)}`, refused);
  }
  const nextTier = rawTier as SandboxTier | null | undefined;
  const both = add.find((h) => remove.includes(h));
  if (both !== undefined) {
    throw new DeviceOpError("policy", `${both} is both added and removed`);
  }
  if (add.length > 0 && facts.mode === "docker") {
    throw new PolicyRefused(DOCKER_WIDENING_MESSAGE, refused);
  }
  // Docker mode takes a tier change under remoteGrants owner: raising it to dev does not open the
  // container's network bridge (the dev hosts do not count there), only open does (spec §5.2).
  // A tier above the file's, or following the org's default (not known here) when the file has
  // a tier, may widen.
  const widensTier = (p: Policy): boolean => {
    if (nextTier === undefined || nextTier === "strict") return false;
    // The org's default is at most its ceiling, which is at most open: following it from open
    // never widens. From strict or dev it may.
    if (nextTier === null) return p.tier !== undefined && p.tier !== "open";
    return p.tier === undefined || !tierAtMost(nextTier, p.tier);
  };
  let sandboxBackOn = false;
  const change = (p: Policy): Policy => {
    // Judged against the file as it is now, inside the lock: a local `remoteGrants off` wins.
    if (p.remoteGrants !== "owner") {
      if (add.length > 0) throw new PolicyRefused(REMOTE_GRANTS_OFF_MESSAGE, refused);
      if (widensTier(p)) throw new PolicyRefused(REMOTE_TIER_OFF_MESSAGE, refused);
    }
    const kept = p.allowedDomains.filter((d) => !remove.includes(d.toLowerCase()));
    const present = new Set(kept.map((d) => d.toLowerCase()));
    const { tier: _old, ...rest } = p;
    const tier = nextTier === undefined ? p.tier : (nextTier ?? undefined);
    let isolation = rawIsolation === "sandbox" ? "sandbox" : p.isolation;
    // A device runs unsandboxed only on the owner's local tier `open`: any tier change from the
    // deployment turns the sandbox back on, so the deployment is never the last step that makes
    // (or keeps) a device unsandboxed.
    if (isolation === "none" && nextTier !== undefined && tier !== p.tier) {
      isolation = "sandbox";
      sandboxBackOn = true;
    }
    return {
      ...rest,
      ...(tier !== undefined && { tier }),
      isolation,
      allowedDomains: [...kept, ...add.filter((h) => !present.has(h))],
    };
  };
  const next = store.update(change, { written });
  const also = sandboxBackOn ? "; isolation sandbox (tier changed by the deployment)" : "";
  return {
    result: { policy: policySummary(next, facts) },
    detail: `policy ${what}${also} ${by}${approval}`,
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
    throw e;
  }
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

/** The audit line of an exec whose grants applied (OS mode only: Docker mode ignores grants). */
function grantsDetail(
  executor: Executor,
  args: DeviceExecArgs,
  policy: Policy | undefined,
): string | undefined {
  if (executor.mode !== "os" || args.grants === undefined || policy === undefined) {
    return undefined;
  }
  const hosts = grantedHosts(policy, args.limits, args.grants);
  if (hosts.length === 0) return undefined;
  const s = args.grants.source;
  return `grants ${clean(s.kind, 10)} ${clean(s.id, 100)} by ${clean(s.accountId, 100)}: ${hosts.join(", ")}`;
}

/**
 * Runs one request and returns the answer plus its local audit line and, for an exec, its tier
 * and isolation (for the local command log). A vanished device
 * directory answers `fs_gone` for every operation except `stop`, `policy` and `policyStatus`.
 * Never throws.
 */
export async function serveOp(
  executor: Executor,
  req: KernelReq,
  signal: AbortSignal,
  ctx: OpContext = {},
): Promise<{ res: DeviceRes; detail?: string; run?: ExecIsolation }> {
  const ok = (result: unknown): DeviceRes => ({ type: "res", id: req.id, ok: true, result });
  try {
    if (req.op === "stop") return { res: ok(null) };
    // The policy lives in the state directory, not the device directory.
    if (req.op === "policy" || req.op === "policyStatus") {
      if (ctx.policy === undefined) {
        return {
          res: {
            type: "res",
            id: req.id,
            ok: false,
            error: { kind: "error", message: "unsupported operation" },
          },
        };
      }
      const facts = summaryFacts(executor, ctx);
      if (req.op === "policyStatus") return { res: ok(policyStatus(ctx.policy, req.args, facts)) };
      return servePolicyOp(req, ctx.policy, facts);
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
        if (ctx.seen !== undefined) {
          ctx.seen.limits = {
            tier: args.limits.tier,
            ...(args.limits.defaultTier !== undefined && { defaultTier: args.limits.defaultTier }),
          };
        }
        // One decision per command, on one read of the policy: the executor runs it and the
        // local log records it. Grants are judged on the same read.
        const policy = ctx.policy?.current();
        const run = execIsolation(policy ?? DEFAULT_POLICY, args.limits, executor.mode);
        // Refused or not, these limits are the latest decision file operations follow.
        executor.noteLimits?.(args.limits);
        if (run.refusal !== undefined) {
          return { ...errorAnswer(req, new DeviceOpError("policy", run.refusal)), run };
        }
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
        const r = await executor.readFile(a.path, a.maxBytes);
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
      case "stat":
        return { res: ok(await executor.stat((req.args as DeviceStatArgs).path)) };
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
