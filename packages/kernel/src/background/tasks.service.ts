import {
  DeviceProtocolError,
  isSandboxGoneError,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ConversationAccess } from "../conversations/access.js";
import { EventLog } from "../conversations/event-log.js";
import { conversationTree } from "../conversations/tree.js";
import { ConversationDevices } from "../devices/conversation-devices.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { rootConversationOf } from "../runtime/subagents/child.js";
import { retirementPending, SandboxService } from "../sandbox/sandbox.service.js";
import { UUID_RE } from "../ui/registry.js";
import { finishedEventKey } from "./finish.js";
import { TASK_ID_RE } from "./launch.js";
import {
  ManagedInstanceMismatchError,
  ManagedRefError,
  onManagedInstance,
  readerOf,
} from "./managed.js";
import {
  assembleOutputSuffix,
  ManagedOutputCapacityError,
  ManagedOutputUnavailableError,
} from "./managed-output.js";
import { BackgroundTaskStopper } from "./stop.js";
import {
  type BackgroundTaskRow,
  type BackgroundTaskStatus,
  BackgroundTaskStore,
  isManagedTask,
} from "./store.js";

/** The most bytes of output one read returns. */
export const OUTPUT_TAIL_MAX_BYTES = 65_536;

/** The time limit of reading an output (the exact reads and the wait for the sandbox's lease). */
const OUTPUT_READ_TIMEOUT_MS = 30_000;

/** A task as the API shows it. */
export interface BackgroundTaskView {
  id: string;
  /** The conversation the task was asked for. */
  conversationId: string;
  /** The child conversation of a sub-agent's task; null for the conversation's own task. */
  subagentId: string | null;
  description: string;
  command: string;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  lostReason: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** True while a stop has claimed the task and it is still running. */
  stopping: boolean;
}

/**
 * Why a task's output cannot be read live: `starting` (the start has not been acknowledged with
 * the task's exact ref yet), `not_started` (the launch failed: the task never ran, its
 * `lostReason` says why), `device_offline` (the local device's machine is not connected),
 * `suspended` (the instance is suspended; reading never resumes it), `rebuilt` (the instance the
 * task ran in is gone, and its files with it), `output_missing` (the instance runs but the output
 * is gone), `no_access` (the conversation's owner may no longer use the device), `unavailable`
 * (the device's provider is not loaded), `read_failed` (the exact read failed, or the task is a
 * finished legacy one, whose output is never read live).
 */
export type OutputUnavailableReason =
  | "starting"
  | "not_started"
  | "device_offline"
  | "suspended"
  | "rebuilt"
  | "output_missing"
  | "no_access"
  | "unavailable"
  | "read_failed";

/** Why the live read failed, and where the task ran: a `local` device or a `cloud` sandbox. */
export interface OutputUnavailable {
  reason: OutputUnavailableReason;
  environment: "local" | "cloud";
}

export interface BackgroundTaskOutput {
  text: string;
  /** True when `text` is only the end of the output (or, for `event`, the last lines). */
  truncated: boolean;
  /** `live`: read from the running sandbox; `event`: the last lines the finished event kept. */
  source: "live" | "event";
  /** With `event`: why the output was not read live. */
  unavailable?: OutputUnavailable;
}

/** What the live read found: the output, or why there is none. */
type LiveRead =
  | { kind: "ok"; value: Omit<BackgroundTaskOutput, "source"> }
  | { kind: "unavailable"; reason: OutputUnavailableReason };

const conversationNotFound = () => new ApiError("conversation.not_found", "Conversation not found");
const taskNotFound = () => new ApiError("background_task.not_found", "Background task not found");

/**
 * The HTTP side of background tasks (spec 2026-11-05-background-bash-design §5): the tasks of a
 * conversation and of its sub-agents, stopping one, reading its output. A task is reachable
 * through the conversation that owns it or through any conversation above it, and only by a
 * person who may see the conversation (`ConversationAccess`, the rule of `GET :id`, which is also
 * what `POST :id/abort` checks: the owner).
 */
@Injectable()
export class BackgroundTasks {
  constructor(
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
    @Inject(BackgroundTaskStore)
    private readonly store: Pick<BackgroundTaskStore, "listFor" | "get">,
    @Inject(BackgroundTaskStopper) private readonly stopper: Pick<BackgroundTaskStopper, "stop">,
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "availableFor" | "ifRunning">,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "findByIdem">,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(ConversationDevices)
    private readonly devices: Pick<ConversationDevices, "forTool">,
  ) {}

  /**
   * The conversation and every sub-agent conversation below it (grandchildren too: their tasks run
   * in the root's sandbox, agent map spec §6); `conversation.not_found` when not visible.
   */
  private async scope(orgId: string, conversationId: string, accountId: string): Promise<string[]> {
    if (
      !UUID_RE.test(conversationId) ||
      !(await this.access.isAccessible(orgId, conversationId, accountId))
    ) {
      throw conversationNotFound();
    }
    // the conversation is the org's (isAccessible), and so is every sub-agent conversation below it
    return (await conversationTree(this.db.db, conversationId)).map((c) => c.id);
  }

  private view(task: BackgroundTaskRow, conversationId: string): BackgroundTaskView {
    return {
      id: task.id,
      conversationId,
      subagentId: task.conversationId === conversationId ? null : task.conversationId,
      description: task.description,
      command: task.command,
      status: task.status,
      exitCode: task.exitCode,
      lostReason: task.lostReason,
      startedAt: task.startedAt.toISOString(),
      finishedAt: task.finishedAt === null ? null : task.finishedAt.toISOString(),
      // a managed task's owed cancellation is a stop in progress too
      stopping:
        task.status === "running" &&
        (task.stoppingAt !== null || task.launchState === "cancel-pending"),
    };
  }

  private async owned(
    orgId: string,
    conversationId: string,
    accountId: string,
    taskId: string,
  ): Promise<BackgroundTaskRow> {
    const ids = await this.scope(orgId, conversationId, accountId);
    if (!TASK_ID_RE.test(taskId)) throw taskNotFound();
    const task = await this.store.get(taskId);
    if (!task || task.orgId !== orgId || !ids.includes(task.conversationId)) throw taskNotFound();
    return task;
  }

  /** The tasks of the conversation and its sub-agents, newest first. */
  async list(
    orgId: string,
    conversationId: string,
    accountId: string,
  ): Promise<BackgroundTaskView[]> {
    const ids = await this.scope(orgId, conversationId, accountId);
    return (await this.store.listFor(ids)).map((t) => this.view(t, conversationId));
  }

  /**
   * A person's stop. Returns the row after the stop: `running` with `stopping` true when another
   * stop already claimed the task (or the task is a reservation still launching, which its launch
   * then kills); a stop that fails throws. Writes the `background_task.stopped` audit event.
   */
  async stop(
    orgId: string,
    conversationId: string,
    accountId: string,
    taskId: string,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<BackgroundTaskView> {
    const task = await this.owned(orgId, conversationId, accountId, taskId);
    // the stopper refuses a running legacy task's stop with the retirement refusal while its
    // instance runs (it is never signalled)
    const after = await this.stopper.stop(task, "person");
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "background_task.stopped",
      target: task.id,
      detail: {
        taskId: task.id,
        conversationId: task.conversationId,
        status: after.status,
        ...auditDetail,
      },
    });
    return this.view(after, conversationId);
  }

  /**
   * Whether the task's device may still be used by its conversation's owner (the access
   * re-check every sandbox tool call makes); when it may not, the live read is skipped.
   */
  private async deviceUsable(orgId: string, taskConversationId: string): Promise<boolean> {
    try {
      await this.devices.forTool(orgId, await rootConversationOf(this.db.db, taskConversationId));
      return true;
    } catch (e) {
      if (e instanceof ApiError) return false;
      throw e;
    }
  }

  /**
   * The end of the task's output, at most `tail` bytes. Read live when the task's device
   * instance runs (never resuming a suspended one); a finished task that cannot be read live
   * answers with the last lines its finished event kept and why (`unavailable`). Anything else is
   * `background_task.output_unavailable` (409) with `details: [{ reason, environment }]`.
   */
  async output(
    orgId: string,
    conversationId: string,
    accountId: string,
    taskId: string,
    tail: number,
  ): Promise<BackgroundTaskOutput> {
    const task = await this.owned(orgId, conversationId, accountId, taskId);
    const read = await this.readLive(orgId, task, tail);
    if (read.kind === "ok") return { ...read.value, source: "live" };
    const unavailable: OutputUnavailable = {
      reason: read.reason,
      environment: await this.environmentOf(task.deviceId),
    };
    if (task.status !== "running") {
      const ev = await this.eventLog.findByIdem(task.conversationId, finishedEventKey(task.id));
      if (ev?.type === "background_task_finished") {
        return { text: ev.payload.lastLines, truncated: true, source: "event", unavailable };
      }
    }
    throw new ApiError(
      "background_task.output_unavailable",
      `The task's output cannot be read now (${unavailable.reason})`,
      [unavailable],
    );
  }

  /** Whether the task ran on a local device (its machine) or in a cloud sandbox. */
  private async environmentOf(deviceId: string | null): Promise<"local" | "cloud"> {
    if (deviceId === null) return "cloud";
    const row = await this.db.db
      .selectFrom("devices")
      .select("source")
      .where("id", "=", deviceId)
      .executeTakeFirst();
    return row?.source === "local" ? "local" : "cloud";
  }

  /** Reads the output from the task's running instance, or says why it cannot. */
  private async readLive(orgId: string, task: BackgroundTaskRow, tail: number): Promise<LiveRead> {
    if (isManagedTask(task)) return this.readManaged(orgId, task, tail);
    // a legacy task's output is never read by an exec: a running one is the retirement gate's
    // (its actionable refusal), a finished one answers with its finish summary
    if (task.status === "running") throw retirementPending();
    return {
      kind: "unavailable",
      reason: task.sandboxCreatedAt === null ? "not_started" : "read_failed",
    };
  }

  /**
   * A managed task's live suffix (permission runtime cutover phase 8.3): by its exact ref on its
   * exact instance only (never resumed, no exec, no path), the metadata total N first, then every
   * byte of the last `tail` bytes before N through bounded reads; N stays the end however the
   * output grows meanwhile. The task's ref is loaded from its authorized row, never supplied.
   */
  private async readManaged(
    orgId: string,
    task: BackgroundTaskRow,
    tail: number,
  ): Promise<LiveRead> {
    if (task.executionRef === null || task.deviceId === null) {
      return {
        kind: "unavailable",
        reason: task.status === "running" ? "starting" : "not_started",
      };
    }
    if (!(await this.sandbox.availableFor(task.deviceId))) {
      return { kind: "unavailable", reason: "unavailable" };
    }
    if (!(await this.deviceUsable(orgId, task.conversationId))) {
      return { kind: "unavailable", reason: "no_access" };
    }
    try {
      const r = await onManagedInstance(
        this.sandbox.ifRunning.bind(this.sandbox),
        task,
        async (bg, h, ref, signal) => {
          try {
            return await assembleOutputSuffix(readerOf(bg, h, ref, signal), tail, signal);
          } catch (e) {
            if (e instanceof ManagedOutputUnavailableError) return null;
            throw e;
          }
        },
        AbortSignal.timeout(OUTPUT_READ_TIMEOUT_MS),
      );
      if (r.kind === "other_instance") return { kind: "unavailable", reason: "rebuilt" };
      if (r.kind === "not_running") {
        return { kind: "unavailable", reason: r.status === "suspended" ? "suspended" : "rebuilt" };
      }
      if (r.value === null) return { kind: "unavailable", reason: "output_missing" };
      return { kind: "ok", value: { text: r.value.text, truncated: r.value.truncated } };
    } catch (e) {
      if (isSandboxGoneError(e)) return { kind: "unavailable", reason: "rebuilt" };
      if (e instanceof ApiError && e.code.startsWith("device.")) {
        return {
          kind: "unavailable",
          reason: e.code === "device.offline" ? "device_offline" : "no_access",
        };
      }
      // a provider's typed refusal is no access; the kernel's own instance check, a missing
      // background capability, a protocol or transport failure, a bad ref, capacity or a timeout
      // is a failed read: never a 500, and a finished task still gets its finish summary
      if (isSandboxScopeDeniedError(e)) return { kind: "unavailable", reason: "no_access" };
      if (
        e instanceof ManagedRefError ||
        e instanceof ManagedInstanceMismatchError ||
        e instanceof ManagedOutputCapacityError ||
        isSandboxPermissionUnsupportedError(e) ||
        e instanceof DeviceProtocolError ||
        e instanceof ToolError ||
        (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"))
      ) {
        return { kind: "unavailable", reason: "read_failed" };
      }
      throw e;
    }
  }
}
