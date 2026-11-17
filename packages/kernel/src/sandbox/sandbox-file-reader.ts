import { SandboxScopeDeniedError, ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConversationDevices } from "../devices/conversation-devices.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { currentExecutionClaim } from "../runtime/run-execution.js";
import { rootConversationOf } from "../runtime/subagents/child.js";
import {
  checkPath,
  checkPathShape,
  clip,
  mapSandboxError,
} from "../tools/builtins/sandbox/common.js";
import type { OperationInvocation } from "./operation-intents.js";
import {
  PERMISSION_CONTEXT_ACTIVATION,
  permissionContextActive,
} from "./permission-context-types.js";
import { SandboxService } from "./sandbox.service.js";

/** What {@link SandboxFileReader.read} reads. */
export interface SandboxFileReadInput {
  orgId: string;
  /** The conversation whose sandbox holds the file (a sub-agent: its root's device). */
  conversationId: string;
  /** The account the read is made for (the sandbox actor). */
  actorAccountId: string;
  /** An absolute path under the sandbox roots, chosen by the model: untrusted. */
  path: string;
  /** The largest file accepted, in bytes. */
  maxBytes: number;
  signal: AbortSignal;
  /**
   * The tool call the read serves (the `Platform` call): once the activation gate is on, the read
   * is a managed operation of that call under the run's current execution claim.
   */
  callId?: string;
}

/** How long one gate-on read may wait for admission (as a builtin tool call's operations). */
const READ_OPERATION_DEADLINE_MS = 30_000;

/**
 * Reads one file from a conversation's sandbox for the kernel (skill authoring spec: a package
 * the agent built is registered from its sandbox). The same stat -> readFile sequence as the
 * `Deliver` tool, with the same path checks, in the device of the conversation's tree (holder =
 * the root conversation); no attachment sync and no `device_paths` record.
 *
 * Once the activation gate is on, {@link read} never takes the raw use: it is a managed operation
 * of the serving tool call (`input.callId`) under the run's current execution claim, and without
 * them nothing is entered (permission activation W3-L).
 *
 * Throws `ApiError` 422 `sandbox.file_invalid_path` / `sandbox.file_not_found` /
 * `sandbox.file_is_directory` / `sandbox.file_too_large`; provider and device failures go through
 * `mapSandboxError` (an actionable `ToolError`).
 */
@Injectable()
export class SandboxFileReader {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(ConversationDevices) private readonly devices: Pick<ConversationDevices, "forTool">,
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "withSandbox"> &
      Partial<Pick<SandboxService, "withOperations">>,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    /** The paired activation gate: once on, every read is a managed operation. */
    @Optional() @Inject(PERMISSION_CONTEXT_ACTIVATION) private readonly activation?: boolean,
  ) {}

  async read(input: SandboxFileReadInput): Promise<Uint8Array> {
    if (!permissionContextActive(this.activation)) return this.readWith(input);
    // the run this read serves: its current execution claim and the tool call, else nothing runs
    const claim = currentExecutionClaim();
    if (!claim || input.callId === undefined || claim.conversationId !== input.conversationId) {
      invalidPathAsApiError(() => checkPathShape(input.path));
      throw mapSandboxError(
        new SandboxScopeDeniedError("The read has no current server execution claim"),
        this.log,
      );
    }
    return this.readWith(input, {
      claim,
      callId: input.callId,
      deadlineMs: Date.now() + READ_OPERATION_DEADLINE_MS,
    });
  }
  /** Dormant caller adapter; the invoking tool supplies its actual current server execution identity. */
  async readOperation(
    input: SandboxFileReadInput,
    invocation: Omit<OperationInvocation, "ordinal">,
  ): Promise<Uint8Array> {
    return this.readWith(input, invocation);
  }
  private async readWith(
    input: SandboxFileReadInput,
    invocation?: Omit<OperationInvocation, "ordinal">,
  ): Promise<Uint8Array> {
    const { orgId, path: given, maxBytes: max } = input;
    // the shape is checked before the sandbox is entered (nothing starts for a bad path)
    invalidPathAsApiError(() => checkPathShape(given));
    try {
      const root = await rootConversationOf(this.db.db, input.conversationId);
      const deviceId = await this.devices.forTool(orgId, root);
      const enter: SandboxService["withSandbox"] = invocation
        ? (ctx, fn, signal) => {
            if (!this.sandbox.withOperations)
              throw new SandboxScopeDeniedError("Operation admission is unavailable");
            return this.sandbox.withOperations(ctx, invocation, fn, signal);
          }
        : this.sandbox.withSandbox.bind(this.sandbox);
      return await enter(
        {
          orgId,
          deviceId,
          holderConversationId: invocation ? input.conversationId : root,
          actor: {
            accountId: input.actorAccountId,
            conversationId: input.conversationId,
            ...(invocation && { runId: invocation.claim.runId }),
          },
        },
        async (h, p, info, signal) => {
          const path = invalidPathAsApiError(() => checkPath(given, info.roots));
          const st = await p.stat(h, path, signal);
          if (st === null) throw notFound(path);
          if (st.isDir) throw isDirectory(path);
          if (st.size > max) throw tooLarge(path, st.size, max);
          const got = await p.readFile(h, path, { maxBytes: max, signal });
          if (got === null) throw notFound(path);
          // the file grew while it was read
          if (got.truncated) throw tooLarge(path, max + 1, max);
          return got.data;
        },
        input.signal,
      );
    } catch (e) {
      if (e instanceof ApiError && e.code.startsWith("sandbox.file_")) throw e;
      throw mapSandboxError(e, this.log);
    }
  }
}

/** Runs a path check of the sandbox tools, turning its `ToolError` into `sandbox.file_invalid_path`. */
function invalidPathAsApiError<T>(check: () => T): T {
  try {
    return check();
  } catch (e) {
    if (e instanceof ToolError) throw new ApiError("sandbox.file_invalid_path", e.message);
    throw e;
  }
}

const notFound = (path: string) =>
  new ApiError(
    "sandbox.file_not_found",
    `File not found in the sandbox: ${clip(path, 200)}. Check the path with Glob.`,
  );
const isDirectory = (path: string) =>
  new ApiError(
    "sandbox.file_is_directory",
    `${clip(path, 200)} is a directory; pass one file, e.g. archive the directory first with Bash (zip -r) and retry.`,
  );
const tooLarge = (path: string, size: number, max: number) =>
  new ApiError(
    "sandbox.file_too_large",
    `File ${clip(path, 200)} is ${size} bytes, over the limit of ${max} bytes; make it smaller and retry.`,
  );
