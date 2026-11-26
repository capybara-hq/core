import type { Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { EventLog } from "../conversations/event-log.js";
import { DeviceAccess } from "../devices/access.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { SandboxService } from "../sandbox/sandbox.service.js";
import {
  checkFilePathShape,
  checkToolPath,
  looksBinary,
} from "../tools/builtins/sandbox/common.js";
import {
  type FileState,
  fileStateOf,
  lastFileState,
  normalizeSandboxPath,
} from "../tools/builtins/sandbox/file-state.js";
import { TOOL_VIEW_DIFF_MAX_BYTES, TOOL_VIEW_DIFF_MAX_TEXT_BYTES } from "../tools/view.js";
import { currentExecutionClaim, type ExecutionClaim } from "./run-execution.js";
import type { WriteBase, WriteBaseReader } from "./write-base.js";

/** What the run's device read needs to know about the run (the step runs under its claim). */
export interface WriteBaseRunFacts {
  /** The device the conversation tree is bound to (the root conversation's; never binds one). */
  deviceId: string;
  /** The run's trigger account, the owner of the conversation and its device. */
  accountId: string;
}

/** The dependencies of {@link readWriteBase} (the service's, faked in unit tests). */
export interface WriteBaseReadDeps {
  /** The current execution claim of the step (`currentExecutionClaim`). */
  claim(): Readonly<ExecutionClaim> | undefined;
  /** The run's device and actor, or null when the run may not read one now (never binds). */
  runFacts(claim: Readonly<ExecutionClaim>): Promise<WriteBaseRunFacts | null>;
  eventLog: Pick<EventLog, "latestFileState">;
  sandbox: Pick<SandboxService, "withKernelRead">;
  log: Pick<Logger, "warn">;
}

/**
 * Reads the base of a streaming `Write` of `rawPath` in `conversationId`, or null (§4.1):
 * 1. The path as `Write` takes it (`checkFilePathShape`, `checkToolPath`, normalized). A relative
 *    path gets none here: it resolves against the working root only inside a tool's use.
 * 2. The step's current execution claim, for this conversation. The log's latest recorded state
 *    of the path (`lastFileState`): none, or one above `TOOL_VIEW_DIFF_MAX_TEXT_BYTES`, gives none.
 * 3. A `write_base` kernel read (`withKernelRead`: the run `running`, `stat` / `readFile` of exactly
 *    the path, never making, waking or resuming an instance, no path lease), at most
 *    `TOOL_VIEW_DIFF_MAX_TEXT_BYTES` read (below `TOOL_VIEW_DIFF_MAX_BYTES`). A path in the skills
 *    directory (read-only to `Write`), a directory, a missing file, a cut read, a NUL byte, a size
 *    or sha256 other than the recorded state's: none. The state check is the guard that the base
 *    shows nothing the conversation had not already read unchanged (symlink targets included).
 * Every failure (a refused admission, `KernelReadInstanceNotRunning`, a read error, an abort) is
 * logged and gives none.
 */
export async function readWriteBase(
  deps: WriteBaseReadDeps,
  input: { conversationId: string; path: string; signal: AbortSignal },
): Promise<WriteBase | null> {
  const { conversationId, signal } = input;
  try {
    if (!input.path.startsWith("/")) return null;
    checkFilePathShape(input.path);
    const path = normalizeSandboxPath(checkToolPath(input.path, "file_path"));
    if (path === "/") return null;
    const claim = deps.claim();
    if (!claim || claim.conversationId !== conversationId) return null;
    const seen: FileState | null = await lastFileState(deps.eventLog, conversationId, path);
    if (seen === null || seen.size > TOOL_VIEW_DIFF_MAX_TEXT_BYTES) return null;
    signal.throwIfAborted();
    const facts = await deps.runFacts(claim);
    if (facts === null) return null;
    signal.throwIfAborted();
    const data = await deps.sandbox.withKernelRead(
      {
        orgId: claim.orgId,
        deviceId: facts.deviceId,
        holderConversationId: conversationId,
        // a display-only read tells the model nothing
        silent: true,
        actor: { accountId: facts.accountId, conversationId, runId: claim.runId },
      },
      { claim, purpose: "write_base", path },
      async (h, p, info, sig) => {
        const skills = info.roots.skills;
        if (path === skills || path.startsWith(`${skills}/`)) return null;
        const st = await p.stat(h, path, sig);
        if (st === null || st.isDir || st.size !== seen.size) return null;
        const got = await p.readFile(h, path, {
          maxBytes: Math.min(TOOL_VIEW_DIFF_MAX_TEXT_BYTES, TOOL_VIEW_DIFF_MAX_BYTES),
          signal: sig,
        });
        if (got === null || got.truncated) return null;
        return got.data;
      },
      signal,
    );
    if (data === null || signal.aborted) return null;
    if (data.byteLength > TOOL_VIEW_DIFF_MAX_TEXT_BYTES) return null;
    const now = fileStateOf(data, data.byteLength);
    if (now.size !== seen.size || now.sha256 !== seen.sha256) return null;
    if (looksBinary(data) || data.includes(0)) return null;
    // bytes that are not UTF-8 are binary here: no base
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(data), sha256: now.sha256 };
  } catch (err) {
    if (!signal.aborted) {
      deps.log.warn("write base not read; the row streams without it", {
        conversationId,
        err,
      });
    }
    return null;
  }
}

/**
 * The run worker's {@link WriteBaseReader} (streaming tool input spec §4.1): {@link readWriteBase}
 * over the event log, the sandbox's kernel read and the run's facts read from PG. The device is
 * the one the conversation tree is already bound to (never bound here), used only when the run's
 * trigger account owns the conversation, its root and the device, and the device's provider is
 * on in the org (`DeviceAccess.usable`), as a `Write` call would require.
 */
@Injectable()
export class WriteBaseService implements WriteBaseReader {
  private readonly deps: WriteBaseReadDeps;

  constructor(
    @Inject(KernelDb) db: KernelDb,
    @Inject(EventLog) eventLog: EventLog,
    @Inject(SandboxService) sandbox: SandboxService,
    @Inject(DeviceAccess) access: DeviceAccess,
    @Inject(KERNEL_LOGGER) log: KernelLogger,
  ) {
    this.deps = {
      claim: currentExecutionClaim,
      eventLog,
      sandbox,
      log,
      runFacts: async (claim) => {
        const run = await db.db
          .selectFrom("runs")
          .select("trigger_account_id")
          .where("id", "=", claim.runId)
          .where("conversation_id", "=", claim.conversationId)
          .executeTakeFirst();
        const convs = await db.db
          .selectFrom("conversations")
          .select(["id", "account_id", "device_id"])
          .where("org_id", "=", claim.orgId)
          .where("id", "in", [claim.conversationId, claim.rootId])
          .execute();
        const own = convs.find((c) => c.id === claim.conversationId);
        const root = convs.find((c) => c.id === claim.rootId);
        if (!run || !own || !root || root.device_id === null) return null;
        const accountId = run.trigger_account_id;
        // a run another account triggered never uses the owner's device
        if (own.account_id !== accountId || root.account_id !== accountId) return null;
        const device = await access.usable(claim.orgId, accountId, root.device_id);
        return { deviceId: device.id, accountId };
      },
    };
  }

  read(input: { conversationId: string; path: string; signal: AbortSignal }) {
    return readWriteBase(this.deps, input);
  }
}
