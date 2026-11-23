import { posix } from "node:path";
import {
  DEFAULT_SANDBOX_ROOTS,
  type SandboxHandle,
  type SandboxPreparation,
  type SandboxPreparationScope,
  type SandboxRoots,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import type { ExecutionClaim } from "../../src/runtime/run-execution.js";
import { attachmentsDir } from "../../src/sandbox/attachments-path.js";
import type { ManagedDeviceContextPort } from "../../src/sandbox/managed-device-context.js";
import type {
  HeldDeviceContextEvidence,
  PermissionContextSubject,
} from "../../src/sandbox/permission-context-types.js";
import type {
  HeldProvider,
  OperationSessionInvocation,
  SandboxService,
  SandboxStaging,
  SandboxUseInfo,
} from "../../src/sandbox/sandbox.service.js";
import type { SandboxUseContext } from "../../src/sandbox/use-context.js";

/**
 * Unit stubs for the managed device route of the builtin tools (`inSandboxOperations` in
 * `src/tools/builtins/sandbox/common.ts`), the only route production takes: a stub
 * `withOperations` that keeps the real service's order (`SandboxService.runAs`: the held info with
 * its context evidence when the invocation asks for it, then `invocation.beforeUser` with the
 * kernel staging, then the user callback), a recording managed device context writer, and a call
 * context carrying the server execution claim of its run.
 */

/** One entry of the stub's device: what the tool asked for. */
export interface ManagedEntry {
  use: SandboxUseContext;
  invocation: OperationSessionInvocation;
}

/** One trusted preparation the kernel staged through `beforeUser` (`staging.prepare`). */
export interface StagedPreparation {
  purpose: SandboxPreparationScope["purpose"];
  roots: readonly string[];
}

export interface ManagedSandboxOptions {
  /** The held instance's roots (default {@link DEFAULT_SANDBOX_ROOTS}). */
  roots?: SandboxRoots;
  /** The held handle (default `{ id: "h", roots }`). */
  handle?: SandboxHandle;
  /**
   * The base working root the held evidence names (what `OperationAuthority.workingRootFor`
   * answers in production; default the instance's workspace).
   */
  workingRoot?: string | ((use: SandboxUseContext) => string);
  /** The use info's lifecycle flags (default: an ordinary use). */
  info?: Partial<Pick<SandboxUseInfo, "fresh" | "restarted" | "filesReset">>;
  /**
   * The root conversation of the holder (default the holder itself): the attachments base of a
   * trusted preparation, as `SandboxService.prepareFor` derives it.
   */
  rootConversationId?: string;
  /** Runs on entry before the evidence is read (advance a clock, throw an entry failure). */
  onEnter?: (use: SandboxUseContext) => void | Promise<void>;
}

/**
 * A device whose provider calls go to `p` (its methods take the handle first, as `HeldProvider`
 * does).
 */
export function managedSandbox(p: unknown, o: ManagedSandboxOptions = {}) {
  const roots = o.roots ?? DEFAULT_SANDBOX_ROOTS;
  const handle: SandboxHandle = o.handle ?? { id: "h", roots };
  const entries: ManagedEntry[] = [];
  const staged: StagedPreparation[] = [];
  const held = p as HeldProvider;
  const withOperations: SandboxService["withOperations"] = async (use, invocation, fn, signal) => {
    entries.push({ use, invocation });
    await o.onEnter?.(use);
    const workingRoot =
      typeof o.workingRoot === "function" ? o.workingRoot(use) : (o.workingRoot ?? roots.workspace);
    const contextEvidence: HeldDeviceContextEvidence = {
      deviceId: use.deviceId,
      provider: "@managed-tool-stub",
      instanceId: handle.id,
      instanceGeneration: "1",
      revision: "r1",
      roots,
      workingRoot,
    };
    const info: SandboxUseInfo = {
      fresh: o.info?.fresh ?? false,
      restarted: o.info?.restarted ?? false,
      ...(o.info?.filesReset && { filesReset: true as const }),
      roots,
      ...(invocation.contextEvidence && { contextEvidence }),
    };
    const staging: SandboxStaging = {
      prepare: async (purpose, stageRoots, stage) => {
        // the purpose directory check of SandboxService.prepareFor
        const base =
          purpose === "skills"
            ? roots.skills
            : attachmentsDir(roots, o.rootConversationId ?? use.holderConversationId);
        if (
          stageRoots.length === 0 ||
          stageRoots.some(
            (r) => posix.normalize(r) !== r || (r !== base && !r.startsWith(`${base}/`)),
          )
        )
          throw new SandboxScopeDeniedError(
            "Preparation roots must stay inside the trusted purpose directory",
          );
        staged.push({ purpose, roots: [...stageRoots] });
        const prep: SandboxPreparation = {
          readFile: (path, opts) => held.readFile(handle, path, opts),
          writeFile: (path, data, sig) => held.writeFile(handle, path, data, sig),
          stat: (path, sig) => held.stat(handle, path, sig),
        };
        return stage(prep, signal);
      },
    };
    if (invocation.beforeUser) await invocation.beforeUser(staging, info, signal);
    return fn(handle, held, info, signal);
  };
  const sandbox = { withOperations } satisfies Pick<SandboxService, "withOperations">;
  return { sandbox, entries, staged };
}

/**
 * The real service's `withOperations` (its leases, admission and provider calls) for a
 * service-level test whose device records no installed environment: the use never asks the
 * service for held evidence, and stub evidence of the held instance (its roots, the workspace as
 * the working root) is added to the info `beforeUser` and the callback get, as an installed
 * binding would give it.
 */
export function withStubEvidence(s: Pick<SandboxService, "withOperations">) {
  const withOperations: SandboxService["withOperations"] = (use, invocation, fn, signal) => {
    const add = (info: SandboxUseInfo): SandboxUseInfo => ({
      ...info,
      contextEvidence: {
        deviceId: use.deviceId,
        provider: "@managed-tool-stub",
        instanceId: "h",
        instanceGeneration: "1",
        revision: "r1",
        roots: info.roots,
        workingRoot: info.roots.workspace,
      },
    });
    const { contextEvidence: _asked, beforeUser, ...rest } = invocation;
    return s.withOperations(
      use,
      {
        ...rest,
        ...(beforeUser && {
          beforeUser: (staging, info, sig) => beforeUser(staging, add(info), sig),
        }),
      },
      (h, p, info, sig) => fn(h, p, add(info), sig),
      signal,
    );
  };
  return { withOperations };
}

/** A managed device context writer that records what it was asked to write. */
export function recordingDeviceContext(): ManagedDeviceContextPort & {
  recorded: { input: PermissionContextSubject; held: Readonly<HeldDeviceContextEvidence> }[];
} {
  const recorded: {
    input: PermissionContextSubject;
    held: Readonly<HeldDeviceContextEvidence>;
  }[] = [];
  return {
    recorded,
    record: async (input, held) => {
      recorded.push({ input, held });
    },
  };
}

/** The `SandboxToolDeps` field of the managed route: the managed writer. */
export function managedRoute(writer = recordingDeviceContext()) {
  return { managedDeviceContext: writer };
}

/** `ctx` with its run's server execution claim (the managed route refuses a call without one). */
export function managedCall<C extends { orgId: string; conversationId: string }>(
  ctx: C,
  runId = "run",
): C & { runId: string; executionClaim: ExecutionClaim } {
  return {
    ...ctx,
    runId,
    executionClaim: {
      runId,
      conversationId: ctx.conversationId,
      orgId: ctx.orgId,
      rootId: ctx.conversationId,
      executionId: "execution-1",
    },
  };
}
