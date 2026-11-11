import {
  type DeviceExecArgs,
  type DeviceKillTaggedArgs,
  type DeviceLocalPolicySummary,
  type DevicePolicyArgs,
  type DeviceReadFileArgs,
  type DeviceRes,
  type DeviceStatArgs,
  type DeviceWriteFileArgs,
  type KernelReq,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import type { CommandLogEntry } from "./command-log.js";
import { DeviceOpError, type Executor } from "./exec/types.js";
import { grantedHosts } from "./policy.js";
import type { PolicyStore } from "./policy-store.js";
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
  return {
    network: p.network,
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
 * Applies a `policy` op to the local policy: refuses widening (`add`, `network: "open"`) unless
 * `remoteGrants` is `owner`, as the file says under the lock; always applies narrowing; validates
 * every host; idempotent. Returns the result and the local audit line.
 */
function applyPolicyOp(
  store: PolicyStore,
  args: DevicePolicyArgs,
): { result: { policy: DeviceLocalPolicySummary }; detail: string } {
  const source = (args.source ?? {}) as Partial<DevicePolicyArgs["source"]>;
  const fromApproval = source.approvalId !== undefined;
  const add = [...new Set(opHosts(args.add, "add", fromApproval))];
  const remove = [...new Set(opHosts(args.remove, "remove", fromApproval))];
  if (args.network !== undefined && args.network !== "allowlist" && args.network !== "open") {
    throw new DeviceOpError("policy", `unknown network ${JSON.stringify(args.network)}`);
  }
  const both = add.find((h) => remove.includes(h));
  if (both !== undefined) {
    throw new DeviceOpError("policy", `${both} is both added and removed`);
  }
  const widens = add.length > 0 || args.network === "open";
  const parts: string[] = [];
  if (add.length > 0) parts.push(`add ${add.join(", ")}`);
  if (remove.length > 0) parts.push(`remove ${remove.join(", ")}`);
  if (args.network !== undefined) parts.push(`network ${args.network}`);
  const by =
    `by ${clean(source.accountName, 100)} (${clean(source.accountId, 100)}) ` +
    `via ${clean(source.via, 10)}`;
  const approval = fromApproval ? `, approval ${clean(source.approvalId, 100)}` : "";
  const what = parts.length > 0 ? parts.join("; ") : "unchanged";
  const next = store.update((p) => {
    // Judged against the file as it is now, inside the lock: a local `remoteGrants off` wins.
    if (widens && p.remoteGrants !== "owner") {
      throw new PolicyRefused(REMOTE_GRANTS_OFF_MESSAGE, `policy refused ${what} ${by}${approval}`);
    }
    const kept = p.allowedDomains.filter((d) => !remove.includes(d.toLowerCase()));
    const present = new Set(kept.map((d) => d.toLowerCase()));
    return {
      ...p,
      allowedDomains: [...kept, ...add.filter((h) => !present.has(h))],
      network: args.network ?? p.network,
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
      const { result, detail } = applyPolicyOp(ctx.policy, req.args as DevicePolicyArgs);
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
