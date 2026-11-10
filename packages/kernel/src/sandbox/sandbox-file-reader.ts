import { ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ConversationDevices } from "../devices/conversation-devices.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { rootConversationOf } from "../runtime/subagents/child.js";
import {
  checkPath,
  checkPathShape,
  clip,
  mapSandboxError,
} from "../tools/builtins/sandbox/common.js";
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
}

/**
 * Reads one file from a conversation's sandbox for the kernel (skill authoring spec: a package
 * the agent built is registered from its sandbox). The same stat -> readFile sequence as the
 * `Deliver` tool, with the same path checks, in the device of the conversation's tree (holder =
 * the root conversation); no attachment sync and no `device_paths` record.
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
    @Inject(SandboxService) private readonly sandbox: Pick<SandboxService, "withSandbox">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  async read(input: SandboxFileReadInput): Promise<Uint8Array> {
    const { orgId, path: given, maxBytes: max } = input;
    // the shape is checked before the sandbox is entered (nothing starts for a bad path)
    invalidPathAsApiError(() => checkPathShape(given));
    try {
      const root = await rootConversationOf(this.db.db, input.conversationId);
      const deviceId = await this.devices.forTool(orgId, root);
      return await this.sandbox.withSandbox(
        {
          orgId,
          deviceId,
          holderConversationId: root,
          actor: { accountId: input.actorAccountId, conversationId: input.conversationId },
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
