import {
  type DeviceExecArgs,
  type DeviceKillTaggedArgs,
  type DeviceLocalPolicySummary,
  type DevicePolicyArgs,
  type DeviceReadFileArgs,
  type DeviceRes,
  type DeviceStatArgs,
  type DeviceWriteFileArgs,
  isSandboxTier,
  type KernelReq,
  tierAtMost,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import type { CommandLogEntry } from "./command-log.js";
import { DeviceOpError, type Executor } from "./exec/types.js";
import { grantedHosts } from "./policy.js";
import type { PolicyStore } from "./policy-store.js";
import { publicSuffixWildcard } from "./public-suffix.js";
import type { Policy } from "./state.js";

/** What a request may need beyond the executor. */
export interface OpContext {
  /**
   * The local policy this program serves (the one the executor reads). Without it the device
   * answers the `policy` op as unsupported (and does not announce `policyOp` in its hello).
   */
  policy?: PolicyStore;
}

/** The refusal of a widening `policy` op under `remoteGrants: "off"`. */
export const REMOTE_GRANTS_OFF_MESSAGE =
  "This device does not accept network changes from the deployment; allow it locally: " +
  "capybara-device policy add allowedDomains <host>";

/**
 * The refusal of a widening `policy` op in Docker mode: the container has either no network or the
 * whole internet, so one allowed domain would open everything.
 */
export const DOCKER_WIDENING_MESSAGE =
  "This device runs commands in Docker mode, which cannot limit network access per domain; " +
  "switch the device to OS mode to allow single domains.";

/** The local-log line for a finished request; `detail` is its audit line, if any. */
export function logEntryFor(
  req: KernelReq,
  res: DeviceRes,
  now: Date,
  detail?: string,
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
    ...(detail !== undefined && { detail }),
  };
}

/** The summary the kernel keeps of a local policy (hello, `policy` op result). */
export function policySummary(p: Policy): DeviceLocalPolicySummary {
  // Until tiers are applied per command (and localhost / Unix sockets offered), the device runs
  // tier `open` as the old open network and every other tier as `strict`.
  return {
    ...(p.tier !== undefined && { tier: p.tier }),
    effectiveTier: p.tier === "open" ? "open" : "strict",
    isolation: p.isolation,
    localhost: "off",
    unixSockets: "off",
    allowedDomains: [...p.allowedDomains],
    remoteGrants: p.remoteGrants,
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
 * Applies a `policy` op to the local policy: refuses widening (`add`, a higher `tier`) in
 * Docker mode and unless `remoteGrants` is `owner`, as the file says under the lock; always applies narrowing; validates
 * every host; idempotent. Returns the result and the local audit line.
 */
function applyPolicyOp(
  store: PolicyStore,
  args: DevicePolicyArgs,
  mode: Executor["mode"],
): { result: { policy: DeviceLocalPolicySummary }; detail: string } {
  const source = (args.source ?? {}) as Partial<DevicePolicyArgs["source"]>;
  const fromApproval = source.approvalId !== undefined;
  const add = [...new Set(opHosts(args.add, "add", fromApproval))];
  const remove = [...new Set(opHosts(args.remove, "remove", fromApproval))];
  if (args.tier !== undefined && args.tier !== null && !isSandboxTier(args.tier)) {
    throw new DeviceOpError("policy", `unknown tier ${JSON.stringify(args.tier)}`);
  }
  if (args.isolation !== undefined && args.isolation !== "sandbox") {
    // Turning the sandbox off is decided on the machine only.
    throw new DeviceOpError("policy", `isolation may only be set to "sandbox" from the deployment`);
  }
  const both = add.find((h) => remove.includes(h));
  if (both !== undefined) {
    throw new DeviceOpError("policy", `${both} is both added and removed`);
  }
  // A tier above the file's, or following the org's default, may widen (the org's default is not
  // known here): judged against the file under the lock below.
  const widensTier = (p: Policy): boolean => {
    const next = args.tier;
    if (next === undefined || next === "strict") return false;
    if (next === null) return p.tier !== undefined;
    return p.tier === undefined || !tierAtMost(next, p.tier);
  };
  const widens = add.length > 0 || args.tier === "open";
  const parts: string[] = [];
  if (add.length > 0) parts.push(`add ${add.join(", ")}`);
  if (remove.length > 0) parts.push(`remove ${remove.join(", ")}`);
  if (args.tier !== undefined) parts.push(`tier ${args.tier ?? "org default"}`);
  if (args.isolation !== undefined) parts.push(`isolation ${args.isolation}`);
  const by =
    `by ${clean(source.accountName, 100)} (${clean(source.accountId, 100)}) ` +
    `via ${clean(source.via, 10)}`;
  const approval = fromApproval ? `, approval ${clean(source.approvalId, 100)}` : "";
  const what = parts.length > 0 ? parts.join("; ") : "unchanged";
  const refused = `policy refused ${what} ${by}${approval}`;
  if (widens && mode === "docker") throw new PolicyRefused(DOCKER_WIDENING_MESSAGE, refused);
  const next = store.update((p) => {
    // Judged against the file as it is now, inside the lock: a local `remoteGrants off` wins.
    if ((widens || widensTier(p)) && p.remoteGrants !== "owner") {
      throw new PolicyRefused(REMOTE_GRANTS_OFF_MESSAGE, refused);
    }
    const kept = p.allowedDomains.filter((d) => !remove.includes(d.toLowerCase()));
    const present = new Set(kept.map((d) => d.toLowerCase()));
    const { tier: _old, ...rest } = p;
    const tier = args.tier === undefined ? p.tier : (args.tier ?? undefined);
    return {
      ...rest,
      ...(tier !== undefined && { tier }),
      ...(args.isolation !== undefined && { isolation: args.isolation }),
      allowedDomains: [...kept, ...add.filter((h) => !present.has(h))],
    };
  });
  return {
    result: { policy: policySummary(next) },
    detail: `policy ${what} ${by}${approval}`,
  };
}

/** The audit line of an exec whose grants applied (OS mode only: Docker mode ignores grants). */
function grantsDetail(
  executor: Executor,
  args: DeviceExecArgs,
  ctx: OpContext,
): string | undefined {
  if (executor.mode !== "os" || args.grants === undefined || ctx.policy === undefined) {
    return undefined;
  }
  const hosts = grantedHosts(ctx.policy.current(), args.limits, args.grants);
  if (hosts.length === 0) return undefined;
  const s = args.grants.source;
  return `grants ${clean(s.kind, 10)} ${clean(s.id, 100)} by ${clean(s.accountId, 100)}: ${hosts.join(", ")}`;
}

/**
 * Runs one request and returns the answer plus its local audit line. A vanished device
 * directory answers `fs_gone` for every operation except `stop` and `policy`. Never throws.
 */
export async function serveOp(
  executor: Executor,
  req: KernelReq,
  signal: AbortSignal,
  ctx: OpContext = {},
): Promise<{ res: DeviceRes; detail?: string }> {
  const ok = (result: unknown): DeviceRes => ({ type: "res", id: req.id, ok: true, result });
  try {
    if (req.op === "stop") return { res: ok(null) };
    // The policy lives in the state directory, not the device directory.
    if (req.op === "policy") {
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
      const { result, detail } = applyPolicyOp(
        ctx.policy,
        req.args as DevicePolicyArgs,
        executor.mode,
      );
      return { res: ok(result), detail };
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
        // Judged just before the executor reads the same policy for the command's list.
        const detail = grantsDetail(executor, args, ctx);
        const res = ok(await executor.exec(args, signal));
        return detail === undefined ? { res } : { res, detail };
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
    const kind = e instanceof DeviceOpError ? e.kind : "error";
    const res: DeviceRes = {
      type: "res",
      id: req.id,
      ok: false,
      error: { kind, message: e instanceof Error ? e.message : String(e) },
    };
    return e instanceof PolicyRefused ? { res, detail: e.detail } : { res };
  }
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
