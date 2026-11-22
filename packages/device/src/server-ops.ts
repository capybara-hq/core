import type { SandboxExecutionRef, SandboxHandle, SandboxLimits } from "@capybara-hq/plugin-sdk";
import type {
  BindInstanceRequest,
  DeviceExecGrants,
  DeviceLocalPolicySummary,
  DeviceOwnerCeiling,
  DeviceResponse,
  KernelRequest,
} from "@capybara-hq/plugin-sdk/device-protocol";
import type { RunningOperations } from "./activity.js";
import type { CommandLog, CommandLogEntry } from "./command-log.js";
import type { InstanceBinder } from "./exec/instance-binding.js";
import type { MacOperationBackend } from "./exec/mac-operation-backend.js";
import { DeviceProjectRefusedError } from "./exec/types.js";
import { grantedHosts } from "./policy.js";
import type { PolicyStore } from "./policy-store.js";
import type { Policy } from "./state.js";

/** What the summary describes besides the policy file. */
export interface SummaryFacts {
  mode: "os" | "docker";
  /**
   * This connection's project directories another connection on the machine also uses, limited to
   * those the owner listed in this connection's `projectPaths`.
   */
  sharedProjectRoots: readonly string[];
}

/**
 * The summary of the local policy a hello and an owner change event carry: the device's sandbox
 * allowlist and the owner-listed project directories it shares with another connection on the
 * machine (never which one). The owner ceiling travels in the owner report.
 */
export function policySummary(p: Policy, facts: SummaryFacts): DeviceLocalPolicySummary {
  return {
    allowedDomains: [...p.allowedDomains],
    sharedProjectRoots: [...facts.sharedProjectRoots],
  };
}

/** A deployment-supplied string fit for the local log: no control or format characters. */
function clean(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .slice(0, max);
}

/**
 * The owner's local controls a session serves with: the policy store, the strict owner report
 * (the hello and the owner change event carry it), the reconciliation of live owners after the
 * owner changed the ceiling, the command log and the running operations.
 */
export interface StagedOwnerPolicy {
  store: PolicyStore;
  /** The strict owner report now (`issueOwnerReport`). */
  report: () => DeviceOwnerCeiling;
  /** Reconciles live owners against the fresh strict ceiling (`reconcileOwnerCeiling`). */
  reconcile: (signal: AbortSignal) => Promise<void>;
  /** The owner's local command log: the operations are recorded there. */
  log?: CommandLog;
  /** The operations executing now, for the control socket's `running` op (never their command). */
  running?: RunningOperations;
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
 * The device's one operation dispatch (protocol 5): every request body is parsed strictly first,
 * so an operation the protocol does not define (the old `killTagged` / `killAll` and `policy` /
 * `policyStatus`, an unscoped read) is refused before anything on the machine is reached.
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
  const proto = await import("@capybara-hq/plugin-sdk/device-protocol");
  try {
    // the body again, strictly: a caller that bypassed the session's parse reaches nothing
    const parsed = proto.parseDeviceFrame({ op: request.op, args: request.args }, "req");
    const a = parsed.args;
    signal.throwIfAborted();
    let result: unknown;
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
        result: proto.parseOperationResult("bindInstance", await binder.bind(bind, signal), bind),
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
        // listed as running from here until its worker is gone (an exec: its answer; a background
        // task: the backend reports its end, completion or kill); never the command
        const entry = operationEntry(parsed.op, a, scope, null);
        const running = owner?.running;
        running?.begin(
          {
            tag: entry.tag ?? "",
            conversationId: entry.actor?.conversationId || null,
            accountId: entry.actor?.accountId || null,
            isolation: entry.isolation ?? "restricted",
            startedAt: new Date().toISOString(),
          },
          scope.operationId,
        );
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
          running?.endOperation(scope.operationId);
          note(owner?.log, operationEntry(parsed.op, a, scope, null, errorKind(sdk, error)));
          throw error;
        }
        if (parsed.op === "exec") running?.endOperation(scope.operationId);
        else if (running) await keepIfStillRunning(running, backend, handle, result, scope, signal);
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
      result: proto.parseOperationResult(
        parsed.op,
        result,
        parsed.op === "backgroundReadOutput"
          ? { offset: a.offset as number, maxBytes: a.maxBytes as number }
          : undefined,
      ),
    };
  } catch (error) {
    const kind = errorKind(sdk, error);
    return {
      type: "res",
      id: request.id,
      ok: false,
      error: {
        kind,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof DeviceProjectRefusedError && { refusal: error.refusal }),
      },
    };
  }
}

/**
 * A started background task stays in the running operations only while it runs: one that already
 * ended (a fast task, or a retried start of a finished one, whose worker end was reported before
 * or never) leaves now. A status that cannot be read leaves it too: a list that misses a task is
 * safer than one that keeps the machine busy for good.
 */
async function keepIfStillRunning(
  running: RunningOperations,
  backend: MacOperationBackend,
  handle: SandboxHandle,
  ref: unknown,
  scope: { operationId: string },
  signal: AbortSignal,
): Promise<void> {
  try {
    const status = await backend.background.status(handle, ref as SandboxExecutionRef, signal);
    if (status.state === "running") return;
  } catch {
    // unreadable: not kept
  }
  running.endOperation(scope.operationId);
}

/** The protocol error kind of an operation's failure. */
function errorKind(
  sdk: typeof import("@capybara-hq/plugin-sdk"),
  error: unknown,
):
  | "project_refused"
  | "denied"
  | "unsupported"
  | "unsettled"
  | "unknown"
  | "invalid"
  | "gone"
  | "fs_gone"
  | "error" {
  if (error instanceof DeviceProjectRefusedError) return "project_refused";
  return sdk.isSandboxScopeDeniedError(error)
    ? "denied"
    : sdk.isSandboxScopeValidationError(error)
      ? "invalid"
      : sdk.isSandboxWorkUnsettledError(error)
        ? "unsettled"
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
