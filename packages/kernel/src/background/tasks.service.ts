import { isSandboxGoneError, rootsOf } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ConversationAccess } from "../conversations/access.js";
import { EventLog } from "../conversations/event-log.js";
import { conversationTree } from "../conversations/tree.js";
import { ConversationDevices } from "../devices/conversation-devices.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { rootConversationOf } from "../runtime/subagents/child.js";
import { SandboxService } from "../sandbox/sandbox.service.js";
import { UUID_RE } from "../ui/registry.js";
import { finishedEventKey } from "./finish.js";
import { TASK_ID_RE, TASKS_DIR } from "./launch.js";
import { actingAs } from "./session.js";
import { BackgroundTaskStopper } from "./stop.js";
import { type BackgroundTaskRow, type BackgroundTaskStatus, BackgroundTaskStore } from "./store.js";

/** The most bytes of output one read returns. */
export const OUTPUT_TAIL_MAX_BYTES = 65_536;

/** The time limit of reading an output (the exec and the wait for the sandbox's lease). */
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
 * Why a task's output cannot be read live: `starting` (the launch has not recorded the task's
 * session yet), `not_started` (the launch failed: the task never ran, its `lostReason` says why),
 * `device_offline` (the local device's machine is not connected), `suspended` (the instance is
 * suspended; reading never resumes it), `rebuilt` (the instance the task ran in is gone, and its
 * files with it), `output_missing` (the instance runs but the output file is gone), `no_access`
 * (the conversation's owner may no longer use the device), `unavailable` (the device's provider
 * is not loaded), `read_failed` (the read command failed).
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
      stopping: task.status === "running" && task.stoppingAt !== null,
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
    const read = await this.readLive(orgId, accountId, task, tail);
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
  private async readLive(
    orgId: string,
    accountId: string,
    task: BackgroundTaskRow,
    tail: number,
  ): Promise<LiveRead> {
    if (task.sid === null || task.sandboxCreatedAt === null || task.deviceId === null) {
      // a reservation the launch has not finished, or a launch that failed
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
    const createdAt = task.sandboxCreatedAt;
    // the person reading it acts in the task's conversation
    const actor = { accountId, conversationId: task.conversationId };
    try {
      const r = await this.sandbox.ifRunning(
        task.deviceId,
        { createdAt },
        async (p, h, signal) => {
          const res = await actingAs(p, actor).exec(h, {
            command: tailScript(task.id, tail),
            cwd: rootsOf(h).workspace,
            timeoutMs: OUTPUT_READ_TIMEOUT_MS,
            maxOutputBytes: 2 * OUTPUT_TAIL_MAX_BYTES + 4096,
            signal,
          });
          return res.exitCode === 0 ? parseTail(res.stdout, tail) : null;
        },
        AbortSignal.timeout(OUTPUT_READ_TIMEOUT_MS),
      );
      if (r.kind === "other_instance") return { kind: "unavailable", reason: "rebuilt" };
      if (r.kind === "not_running") {
        // a suspended instance keeps its files; any other state means they went with it
        return { kind: "unavailable", reason: r.status === "suspended" ? "suspended" : "rebuilt" };
      }
      if (r.value === null) return { kind: "unavailable", reason: "read_failed" };
      if (r.value === "missing") return { kind: "unavailable", reason: "output_missing" };
      return { kind: "ok", value: r.value };
    } catch (e) {
      if (isSandboxGoneError(e)) return { kind: "unavailable", reason: "rebuilt" };
      // a local device's machine: offline, or no longer the owner's (revoked, deleted)
      if (e instanceof ApiError && e.code.startsWith("device.")) {
        return {
          kind: "unavailable",
          reason: e.code === "device.offline" ? "device_offline" : "no_access",
        };
      }
      throw e;
    }
  }
}

/**
 * Prints `size <bytes>` and `out <base64 of the last `tail` bytes>`, or `missing` when the output
 * file is not there. Relative to the workspace root; POSIX tools only (`wc -c`, `tail -c`,
 * `base64`, `tr`), so it reads the same on Linux and macOS.
 */
export function tailScript(id: string, tail: number): string {
  if (!TASK_ID_RE.test(id)) throw new Error(`invalid background task id: ${id}`);
  const f = `${TASKS_DIR}/${id}.out`;
  return [
    `if [ ! -f ${f} ]; then echo missing; exit 0; fi`,
    `s=$({ wc -c < ${f}; } 2>/dev/null | tr -d ' '); echo "size \${s:-0}"`,
    `printf 'out '; { tail -c ${Math.floor(tail)} ${f} 2>/dev/null | base64 | tr -d '\\n'; }; echo`,
  ].join("\n");
}

/**
 * Decodes {@link tailScript}'s output (`missing`: no output file; null: unreadable); a cut that
 * splits a UTF-8 character drops its tail bytes.
 */
export function parseTail(
  stdout: string,
  tail: number,
): Omit<BackgroundTaskOutput, "source"> | "missing" | null {
  if (/^missing$/m.test(stdout)) return "missing";
  const size = /^size ([0-9]+)$/m.exec(stdout);
  const out = /^out (\S*)$/m.exec(stdout);
  if (!size || !out) return null;
  let bytes = Buffer.from(out[1] as string, "base64");
  const truncated = Number(size[1]) > tail;
  if (truncated) {
    let i = 0;
    while (i < bytes.length && i < 3 && ((bytes[i] as number) & 0xc0) === 0x80) i++;
    bytes = bytes.subarray(i);
  }
  return { text: bytes.toString("utf8"), truncated };
}
