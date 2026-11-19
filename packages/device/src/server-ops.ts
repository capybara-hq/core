import {
  type BindInstanceRequest,
  type DeviceExecGrants,
  type DeviceLocalPolicySummary,
  type DeviceOwnerCeiling,
  type DevicePolicyStatusArgs,
  type DeviceRes,
  type DeviceResponse,
  isPolicyOpId,
  type KernelReq,
  type KernelRequest,
  type LegacyDevicePolicyArgs,
  type LegacyDevicePolicyStatus,
  POLICY_ADD_REFUSED,
  type SandboxHandle,
  type SandboxLimits,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import type { CommandLog, CommandLogEntry } from "./command-log.js";
import type { InstanceBinder } from "./exec/instance-binding.js";
import type { MacOperationBackend } from "./exec/mac-operation-backend.js";
import { DeviceOpError } from "./exec/types.js";
import { grantedHosts } from "./policy.js";
import type { PolicyOpRecord } from "./policy-ops.js";
import type { PolicyStore } from "./policy-store.js";
import type { Policy } from "./state.js";

/** The refusal of a `policy` op that tries to widen the owner's ceiling from the deployment. */
export const MODE_ON_DEVICE_MESSAGE =
  "The owner ceiling is widened on the machine only: run `capybara-device ceiling set`.";

/** The refusal of a protocol 3 `mode` in a `policy` op: protocol 4 narrows through `ownerCeiling`. */
export const MODE_REMOVED_MESSAGE =
  'A policy op carries no mode in device protocol 4: the deployment narrows through "ownerCeiling".';

/** What the summary describes besides the policy file. */
export interface SummaryFacts {
  mode: "os" | "docker";
}

/**
 * The summary the kernel keeps of a local policy (hello, `policy` op result): the device's sandbox
 * allowlist. The owner ceiling travels in the owner report.
 */
export function policySummary(p: Policy, _facts: SummaryFacts): DeviceLocalPolicySummary {
  return { allowedDomains: [...p.allowedDomains] };
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

/** Lowercased hosts of a `policy` op's `remove`; throws a `policy` error naming the first bad one. */
function opHosts(list: unknown): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new DeviceOpError("policy", "remove must be a list of hosts");
  return list.map((raw) => {
    if (typeof raw !== "string")
      throw new DeviceOpError("policy", "remove must be a list of hosts");
    const host = raw.toLowerCase();
    const errors = validateAllowHost(host);
    if (errors.length > 0) {
      throw new DeviceOpError("policy", `${JSON.stringify(raw)}: ${errors.join("; ")}`);
    }
    return host;
  });
}

/**
 * Applies a `policy` op to the local policy (a trust boundary: the deployment is not the owner).
 * Protocol 4: the deployment only narrows; widening happens only on the machine.
 *
 * - `add` is refused ({@link POLICY_ADD_REFUSED}) and writes nothing: the owner adds hosts on the
 *   machine (`capybara-device policy add allowedDomains`).
 * - `mode` (protocol 3) is refused: `ownerCeiling` names each narrowing.
 * - `ownerCeiling`: a narrowing only ({@link ownerCeilingNarrowing}); anything else is refused.
 * - `remove` removes hosts from the sandbox allowlist; every host is validated.
 *
 * The op is idempotent. Returns the result and the local audit line; a refusal carries its audit
 * line too ({@link PolicyRefused}).
 */
function applyPolicyOp(
  store: PolicyStore,
  args: LegacyDevicePolicyArgs,
  facts: SummaryFacts,
  written: () => void,
): { result: { policy: DeviceLocalPolicySummary }; detail: string } {
  const source = (args.source ?? {}) as Partial<LegacyDevicePolicyArgs["source"]>;
  const fromApproval = source.approvalId !== undefined;
  const by =
    `by ${clean(source.accountName, 100)} (${clean(source.accountId, 100)}) ` +
    `via ${clean(source.via, 10)}`;
  const approval = fromApproval ? `, approval ${clean(source.approvalId, 100)}` : "";
  // Read as unknown: the frame parser may have been bypassed, so nothing is assumed of the shape.
  const rawAdd: unknown = (args as { add?: unknown }).add;
  const rawMode: unknown = (args as { mode?: unknown }).mode;
  if (rawAdd !== undefined) {
    // widening the allowlist from the deployment: refused before anything is read or written
    const asked = Array.isArray(rawAdd) ? rawAdd.map((h) => clean(h, 253)).join(", ") : "?";
    throw new PolicyRefused(
      POLICY_ADD_REFUSED,
      `policy refused add ${clean(asked, 200)} ${by}${approval}`,
    );
  }
  let remove: string[];
  try {
    remove = [...new Set(opHosts(args.remove))];
  } catch (e) {
    // an invalid host is a refused change too, audited with who asked for it
    const message = e instanceof Error ? e.message : String(e);
    throw new PolicyRefused(message, `policy refused (${clean(message, 200)}) ${by}${approval}`);
  }
  const parts: string[] = [];
  if (remove.length > 0) parts.push(`remove ${remove.join(", ")}`);
  if (rawMode !== undefined) parts.push(`mode ${clean(String(rawMode), 40)}`);
  const ceilingArg: unknown = (args as { ownerCeiling?: unknown }).ownerCeiling;
  if (ceilingArg !== undefined) parts.push(`ownerCeiling ${clean(JSON.stringify(ceilingArg), 80)}`);
  const what = parts.length > 0 ? parts.join("; ") : "unchanged";
  const refused = `policy refused ${what} ${by}${approval}`;
  if (rawMode !== undefined) {
    // protocol 3's mode: protocol 4 names each narrowing in `ownerCeiling`, never a mode
    throw new PolicyRefused(MODE_REMOVED_MESSAGE, refused);
  }
  const narrowing = ownerCeilingNarrowing((args as { ownerCeiling?: unknown }).ownerCeiling);
  if (narrowing === undefined)
    throw new PolicyRefused(
      "The owner ceiling is widened on the machine only (capybara-device ceiling set)",
      refused,
    );
  // removing a host from the sandbox allowlist is a narrowing as well
  for (const h of narrowing.removeAllowedDomains) if (!remove.includes(h)) remove.push(h);
  const change = (p: Policy): Policy => ({
    ...p,
    ownerCeiling: {
      outsideSandbox: p.ownerCeiling.outsideSandbox && !narrowing.outsideSandboxOff,
      network: narrowing.networkAllowlist ? "allowlist" : p.ownerCeiling.network,
      restrictedProjectReach: narrowing.workspaceReach
        ? "workspace"
        : p.ownerCeiling.restrictedProjectReach,
    },
    allowedDomains: p.allowedDomains.filter((d) => !remove.includes(d.toLowerCase())),
  });
  const next = store.update(change, { written });
  return {
    result: { policy: policySummary(next, facts) },
    detail: `policy ${what} ${by}${approval}`,
  };
}

/** An owner-ceiling narrowing as this program applies it: each field can only narrow. */
interface CeilingNarrowing {
  outsideSandboxOff: boolean;
  networkAllowlist: boolean;
  workspaceReach: boolean;
  removeAllowedDomains: string[];
}

/**
 * The owner-ceiling narrowing of a `policy` op (a trust boundary), read as unknown: the frame
 * parser may have been bypassed. It takes the fields of `DeviceOwnerCeilingNarrowing`
 * (`outsideSandbox: false`, `network: "allowlist"`, `removeAllowedDomains`,
 * `restrictedProjectReach: "workspace"`). Undefined for anything that could widen: another value,
 * another key (the protocol 3 `fullAccess` among them) or another shape.
 */
export function ownerCeilingNarrowing(raw: unknown): CeilingNarrowing | undefined {
  const none: CeilingNarrowing = {
    outsideSandboxOff: false,
    networkAllowlist: false,
    workspaceReach: false,
    removeAllowedDomains: [],
  };
  if (raw === undefined) return none;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const allowed = ["outsideSandbox", "network", "restrictedProjectReach", "removeAllowedDomains"];
  if (Object.keys(o).some((k) => !allowed.includes(k))) return undefined;
  if (o.outsideSandbox !== undefined && o.outsideSandbox !== false) return undefined;
  if (o.network !== undefined && o.network !== "allowlist") return undefined;
  if (o.restrictedProjectReach !== undefined && o.restrictedProjectReach !== "workspace")
    return undefined;
  let removeAllowedDomains: string[] = [];
  if (o.removeAllowedDomains !== undefined) {
    const list = o.removeAllowedDomains;
    if (!Array.isArray(list) || list.length > 100 || list.some((h) => typeof h !== "string"))
      return undefined;
    removeAllowedDomains = [...new Set((list as string[]).map((h) => h.toLowerCase()))];
  }
  return {
    outsideSandboxOff: o.outsideSandbox === false,
    networkAllowlist: o.network === "allowlist",
    workspaceReach: o.restrictedProjectReach === "workspace",
    removeAllowedDomains,
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
    const { result, detail } = applyPolicyOp(
      store,
      req.args as LegacyDevicePolicyArgs,
      facts,
      () => {
        try {
          store.ops.recordHeld({ opId, outcome: "applied" });
        } catch {
          // the change stands; the log keeps `started` and the deployment learns it from the hello
        }
      },
    );
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

/** What the log says of an op id, with the summary now. Read-only. */
function policyStatus(
  store: PolicyStore,
  args: unknown,
  facts: SummaryFacts,
): LegacyDevicePolicyStatus {
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

/** What the program needs to serve `policy` / `policyStatus` with owner reports (B2). */
export interface StagedOwnerPolicy {
  store: PolicyStore;
  /** The strict owner report now (`issueOwnerReport`), issued after the write. */
  report: () => DeviceOwnerCeiling;
  /** Reconciles live owners against the fresh strict ceiling (`reconcileOwnerCeiling`). */
  reconcile: (signal: AbortSignal) => Promise<void>;
  /** The owner's local command log: operations and policy changes are recorded there. */
  log?: CommandLog;
}

/** Appends one line to the local command log: best effort, never fails or delays an operation. */
function note(log: CommandLog | undefined, entry: Omit<CommandLogEntry, "time">): void {
  if (log === undefined) return;
  try {
    log.append({ time: new Date().toISOString(), ...entry });
  } catch {
    // the local log never fails an operation
  }
}

/** Who asked for a policy op, for its audit line (read as unknown: the frame may be invalid). */
function policyBy(args: unknown): string {
  const source = ((args as { source?: unknown } | null)?.source ?? {}) as Record<string, unknown>;
  const approval =
    source.approvalId !== undefined ? `, approval ${clean(source.approvalId, 100)}` : "";
  return (
    `by ${clean(source.accountName, 100)} (${clean(source.accountId, 100)}) ` +
    `via ${clean(source.via, 10)}${approval}`
  );
}

/** The audit line of a policy op that failed for a reason other than a refusal. */
function notePolicyFailure(log: CommandLog | undefined, req: KernelReq, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  notePolicy(log, req, `policy failed (${clean(message, 200)}) ${policyBy(req.args)}`);
}

/** The audit line of a policy change from the deployment, with the deciding account. */
function notePolicy(log: CommandLog | undefined, req: KernelReq, detail: string): void {
  const source = (req.args as { source?: { accountId?: unknown } } | null)?.source;
  const accountId = clean(source?.accountId, 100);
  note(log, {
    op: "policy",
    tag: null,
    actor: accountId === "" ? null : { accountId },
    exitCode: null,
    detail,
  });
}

/** The command-log line of an exec or a background start: isolation, actor, grants; no command. */
function operationEntry(
  op: string,
  args: Record<string, unknown>,
  scope: {
    profile: string;
    tag: string;
    actor: { accountId: string; conversationId: string };
    filesystem?: { kind: string };
    network?: { kind: string };
  },
  exitCode: number | null,
  failure?: string,
): Omit<CommandLogEntry, "time"> {
  // full reach under a restricted profile is only ever one approved escalated call
  const escalated =
    scope.profile !== "full-access" &&
    scope.filesystem?.kind === "device" &&
    scope.network?.kind === "environment";
  const full = scope.profile === "full-access" || escalated;
  const grants = args.grants as DeviceExecGrants | undefined;
  const limits = args.limits as Pick<SandboxLimits, "network"> | undefined;
  const hosts = grants && limits ? grantedHosts(limits, grants) : [];
  const detail =
    failure !== undefined
      ? `failed (${failure})`
      : hosts.length > 0 && grants
        ? `grants ${clean(grants.source.kind, 10)} ${clean(grants.source.id, 100)} by ` +
          `${clean(grants.source.accountId, 100)}: ${hosts.join(", ")}`
        : undefined;
  return {
    op,
    tag: clean(scope.tag, 200),
    actor: {
      accountId: clean(scope.actor.accountId, 100),
      conversationId: clean(scope.actor.conversationId, 100),
    },
    exitCode,
    isolation: full ? "full" : "restricted",
    ...(escalated && { grantSource: "call approval" as const }),
    ...(detail !== undefined && { detail }),
  };
}

/**
 * A `policy` / `policyStatus` op: the op log, idempotence and narrowing only, then, after a
 * successful write, live owners are reconciled at once and the answer carries the owner report
 * issued for the written revision. An applied status carries the current report. Exported for the
 * trust-boundary tests, which call it with a request the frame parser would refuse.
 */
export async function serveOwnerPolicyV3(
  owner: StagedOwnerPolicy,
  req: KernelReq,
  signal: AbortSignal,
): Promise<DeviceResponse> {
  const sdk = await import("@capybara-hq/plugin-sdk");
  const facts: SummaryFacts = { mode: "os" };
  try {
    if (req.op === "policyStatus") {
      const status = policyStatus(owner.store, req.args, facts);
      return {
        type: "res",
        id: req.id,
        ok: true,
        result: sdk.parseOperationResult("policyStatus", {
          ...status,
          ...(status.outcome === "applied" && { ownerCeiling: owner.report() }),
        }),
      };
    }
    const { res, detail } = servePolicyOp(req, owner.store, facts);
    if (detail !== undefined) notePolicy(owner.log, req, detail);
    if (!res.ok) return { type: "res", id: req.id, ok: false, error: res.error };
    // successful local policy writes reconcile live owners immediately (cutover 8.4)
    await owner.reconcile(signal);
    return {
      type: "res",
      id: req.id,
      ok: true,
      result: sdk.parseOperationResult("policy", {
        ...(res.result as object),
        ownerCeiling: owner.report(),
      }),
    };
  } catch (e) {
    // a refused or failed change is audited too, with who asked for it
    if (e instanceof PolicyRefused) notePolicy(owner.log, req, e.detail);
    else notePolicyFailure(owner.log, req, e);
    return {
      type: "res",
      id: req.id,
      ok: false,
      error: {
        kind: e instanceof DeviceOpError && e.kind === "policy" ? "policy" : "error",
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

/**
 * The device's one operation dispatch (protocol 4): every request is parsed strictly first, so an
 * operation the protocol does not define (the old `killTagged` / `killAll`, an unscoped read) is
 * refused before anything on the machine is reached.
 */
export async function serveOperationV3(
  backend: MacOperationBackend,
  handle: SandboxHandle,
  request: KernelRequest,
  signal: AbortSignal,
  binder?: Pick<InstanceBinder, "bind">,
  owner?: StagedOwnerPolicy,
): Promise<DeviceResponse> {
  const sdk = await import("@capybara-hq/plugin-sdk");
  try {
    const parsed = sdk.parseDeviceFrame(JSON.stringify(request), "kernel");
    if (parsed.type !== "req") throw new sdk.DeviceProtocolError("Expected an operation request");
    const a = parsed.args;
    signal.throwIfAborted();
    let result: unknown;
    if (parsed.op === "policy" || parsed.op === "policyStatus") {
      if (!owner)
        throw new sdk.SandboxPermissionUnsupportedError("This program cannot change its policy");
      return await serveOwnerPolicyV3(owner, parsed as unknown as KernelReq, signal);
    }
    if (parsed.op === "bindInstance") {
      // the private post-commit lifecycle binding (B4); never an implicit side effect of an operation
      if (!binder)
        throw new sdk.SandboxPermissionUnsupportedError(
          "This program cannot bind instances; update capybara-device",
        );
      const bind = a as unknown as BindInstanceRequest;
      return {
        type: "res",
        id: request.id,
        ok: true,
        result: sdk.parseOperationResult("bindInstance", await binder.bind(bind, signal), bind),
      };
    }
    if (parsed.op === "revokeOperation") {
      await backend.revokeOperation(handle, sdk.parseSandboxOperationRef(a.ref), signal);
      result = null;
    } else if (
      ["backgroundStatus", "backgroundTail", "backgroundReadOutput", "backgroundStop"].includes(
        parsed.op,
      )
    ) {
      const ref = sdk.parseSandboxExecutionRef(a.ref);
      result =
        parsed.op === "backgroundStatus"
          ? await backend.background.status(handle, ref, signal)
          : parsed.op === "backgroundReadOutput"
            ? await backend.background.readOutput(handle, ref, {
                offset: a.offset as number,
                maxBytes: a.maxBytes as number,
                signal,
              })
            : parsed.op === "backgroundTail"
              ? await backend.background.tail(handle, ref, {
                  maxBytes: a.maxBytes as number,
                  signal,
                })
              : await backend.background.stop(handle, ref, {
                  graceMs: a.graceMs as number,
                  signal,
                });
    } else {
      const prep = parsed.op.startsWith("prepare"),
        browse = parsed.op.startsWith("browse");
      if (parsed.op === "exec" || parsed.op === "backgroundStart") {
        const scope = sdk.parseSandboxOperationScope(a.scope);
        const limits = a.limits as SandboxLimits;
        // These fields came only from the authenticated kernel transport and its current grant lookup.
        const execution = backend.forExecution({
          operationId: scope.operationId,
          orgNetwork: limits.network,
          ...(a.grants === undefined ? {} : { grants: a.grants as DeviceExecGrants }),
        });
        const args = {
          command: a.command as string,
          timeoutMs: a.timeoutMs as number,
          maxOutputBytes: a.maxOutputBytes as number,
          signal,
          ...(a.cwd === undefined ? {} : { cwd: a.cwd as string }),
          ...(a.env === undefined ? {} : { env: a.env as Record<string, string> }),
        };
        try {
          result =
            parsed.op === "exec"
              ? await (await execution.operation(handle, scope, signal)).exec(args)
              : await execution.background.start(handle, scope, {
                  ...args,
                  taskId: a.taskId as string,
                  outputPath: a.outputPath as string,
                  retainUntilMs: a.retainUntilMs as number,
                });
        } catch (error) {
          note(owner?.log, operationEntry(parsed.op, a, scope, null, errorKind(sdk, error)));
          throw error;
        }
        const exitCode =
          parsed.op === "exec" ? ((result as { exitCode?: number | null }).exitCode ?? null) : null;
        note(owner?.log, operationEntry(parsed.op, a, scope, exitCode));
      } else {
        const operation = prep
          ? await backend.prepare(handle, sdk.parseSandboxPreparationScope(a.scope), signal)
          : browse
            ? await backend.browse(handle, sdk.parseSandboxBrowseScope(a.scope), signal)
            : await backend.operation(handle, sdk.parseSandboxOperationScope(a.scope), signal);
        const suffix = prep ? parsed.op.slice(7) : browse ? parsed.op.slice(6) : parsed.op;
        const method = suffix.charAt(0).toLowerCase() + suffix.slice(1);
        if (method === "stat") result = await operation.stat(a.path as string, signal);
        else if (method === "readFile" && "readFile" in operation)
          result = await operation.readFile(a.path as string, {
            maxBytes: a.maxBytes as number,
            signal,
          });
        else if (method === "writeFile" && "writeFile" in operation) {
          await operation.writeFile(
            a.path as string,
            new Uint8Array(Buffer.from(a.dataB64 as string, "base64")),
            signal,
          );
          result = null;
        } else if (method === "list" && "list" in operation && operation.list)
          result = await operation.list(a.path as string, { limit: a.limit as number, signal });
        else if (method === "scan" && "scan" in operation && operation.scan)
          result = await operation.scan(a.base as string, { signal });
        else
          throw new sdk.SandboxPermissionUnsupportedError(
            "Operation is unavailable on this capability",
          );
      }
    }
    if (
      result !== null &&
      typeof result === "object" &&
      "data" in result &&
      result.data instanceof Uint8Array
    )
      result = {
        dataB64: Buffer.from(result.data).toString("base64"),
        ...(parsed.op === "backgroundReadOutput"
          ? {
              offset: (result as unknown as { offset: number }).offset,
              nextOffset: (result as unknown as { nextOffset: number }).nextOffset,
              totalBytes: (result as unknown as { totalBytes: number }).totalBytes,
            }
          : { truncated: "truncated" in result && result.truncated }),
      };
    return {
      type: "res",
      id: request.id,
      ok: true,
      result: sdk.parseOperationResult(
        parsed.op,
        result,
        parsed.op === "backgroundReadOutput"
          ? { offset: a.offset as number, maxBytes: a.maxBytes as number }
          : undefined,
      ),
    };
  } catch (error) {
    // a policy op refused before the owner controls (the frame parser) is audited as well
    if ((request as { op?: unknown }).op === "policy")
      notePolicyFailure(owner?.log, request as unknown as KernelReq, error);
    const kind = errorKind(sdk, error);
    return {
      type: "res",
      id: request.id,
      ok: false,
      error: { kind, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** The protocol error kind of an operation's failure. */
function errorKind(
  sdk: typeof import("@capybara-hq/plugin-sdk"),
  error: unknown,
): "denied" | "unsupported" | "unknown" | "invalid" | "gone" | "fs_gone" | "error" {
  return sdk.isSandboxScopeDeniedError(error)
    ? "denied"
    : sdk.isSandboxScopeValidationError(error)
      ? "invalid"
      : sdk.isSandboxPermissionUnsupportedError(error)
        ? "unsupported"
        : sdk.isSandboxOperationOutcomeUnknownError(error)
          ? "unknown"
          : sdk.isSandboxGoneError(error)
            ? "gone"
            : sdk.isFileSystemGoneError(error)
              ? "fs_gone"
              : "error";
}
