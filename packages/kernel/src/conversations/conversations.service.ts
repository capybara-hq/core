import { randomUUID } from "node:crypto";
import type { ConversationSource } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { AgentLookup, visibleTo } from "../agents/agent-lookup.js";
import type { AgentDefinition, ModelRef } from "../agents/definition.js";
import type { AgentAvatar } from "../agents/profile.js";
import { BackgroundTaskStopper } from "../background/stop.js";
import { unbindConversation } from "../channels/threads.js";
import type { TitleSource } from "../db/kernel-schema.js";
import {
  ConversationDevices,
  type NewConversationDevice,
} from "../devices/conversation-devices.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { RunControl as RunControlService } from "../runtime/run-control.js";
import { rootConversationOf } from "../runtime/subagents/child.js";
import type { ScheduleMarker } from "../schedules/types.js";
import { type RenderedInvocation, SkillInvoker } from "../skills/invoke.js";
import { type ApprovalRecord, ApprovalsService } from "../tools/approvals.service.js";
import { ConnectorContent } from "../tools/connector-content.js";
import { type QuestionRecord, QuestionsService } from "../tools/questions.service.js";
import { ConversationAccess, parentReachable } from "./access.js";
import { type AgentTreeNode, readAgentTree } from "./agent-tree.js";
import { AttachmentsService } from "./attachments.service.js";
import { type AppendEvent, EventLog } from "./event-log.js";
import type { ConversationEvent, LogContentBlock } from "./events.js";
import { userMessageIdemKey } from "./idem-keys.js";
import {
  type ImSenderContext,
  type MessageContext,
  readMessageContext,
} from "./message-context.js";
import { NO_SELECTION, planSelection, readSelection, type Selection } from "./selection.js";
import { conversationTree } from "./tree.js";

/** 对外的会话视图。 */
export interface ConversationView {
  id: string;
  orgId: string;
  agentId: string;
  accountId: string;
  title: string | null;
  /** Who wrote `title`: the title job, a rename, or nobody yet (UI refresh B). */
  titleSource: TitleSource | null;
  /** The model / effort the person switched to (UI refresh B); nulls = the agent's own. */
  selection: Selection;
  /** 已写入的最大事件 seq。 */
  lastSeq: number;
  createdAt: Date;
  updatedAt: Date;
  /** A sub-agent's parent conversation; null for any other conversation (sub-agents spec §14.3). */
  parentConversationId: string | null;
  /** A sub-agent's type as resolved at its first dispatch; null for any other conversation. */
  subagentType: string | null;
  /** When the owner archived it; null = not archived (hidden from the default lists). */
  archivedAt: Date | null;
  /**
   * The device it works in (environments spec §4.1 item 1); null while unbound (no sandbox
   * provider when it was created, an anonymous IM sender's, or created before devices). A
   * sub-agent's is null: it works in its root conversation's.
   */
  deviceId: string | null;
  /** The scheduled task that created it (a `new`-mode task's run); null otherwise (spec §4). */
  scheduledTaskId: string | null;
  /**
   * What the latest run is doing: `running` (queued or running), `waiting` (an approval or a
   * question), else null. Only the list queries compute it; other responses carry null.
   */
  activity: "running" | "waiting" | null;
}

/** Escapes `\`, `%` and `_` so user text is matched literally by `LIKE … ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * SQL for the activity of the conversation row aliased/named `ref` (a correlated subquery).
 * A run waiting on its sub-agents (status waiting with `wait_expires_at`, set only for a
 * `subagents` wait) is still working, so it reports `running`; only a wait for a person
 * (approval, input) reports `waiting`.
 */
function activitySql(ref: string) {
  const id = sql.ref(`${ref}.id`);
  return sql<"running" | "waiting" | null>`(
    SELECT CASE
      WHEN lr.status IN ('queued', 'running') THEN 'running'
      WHEN lr.status = 'waiting' AND lr.wait_expires_at IS NOT NULL THEN 'running'
      WHEN lr.status = 'waiting' THEN 'waiting' END
    FROM capybara.runs lr WHERE lr.conversation_id = ${id}
    ORDER BY lr.created_at DESC, lr.id DESC LIMIT 1
  )`;
}

/** One agent's group in the sidebar list: the caller's newest conversations with that agent. */
export interface ConversationGroup {
  /**
   * The agent's name and the avatar half of its profile, in the agents API's shape (the sidebar
   * draws the group title from it without reading the agents list).
   */
  agent: { id: string; name: string; profile: { avatar: AgentAvatar; updatedAt: string } };
  /** max(updated_at) of the group's conversations. */
  latestAt: Date;
  /** At most `perGroup`, updated_at DESC, id DESC. */
  conversations: ConversationView[];
  /** The group has more than `perGroup` conversations. */
  more: boolean;
}

/** Token usage, the four fields of a `usage` event. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * One sub-agent of a conversation (sub-agents spec §14.3). `status`, `toolCalls`, `startedAt` and
 * `finishedAt` describe its latest run (the newest dispatch, a follow-up included); `description` is
 * that dispatch's; `usage` sums all of its runs; the pending ids are its open approvals and
 * questions.
 */
export interface SubagentView {
  /** The child conversation's id. */
  id: string;
  agentType: string;
  description: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "aborted";
  toolCalls: number;
  startedAt: string;
  finishedAt: string | null;
  usage: UsageTotals;
  pendingApprovalIds: string[];
  pendingQuestionIds: string[];
}

const notFound = () => new ApiError("conversation.not_found", "Conversation not found");

/**
 * What a message skipped (reply-while-question spec §8.1, network ask-to-allow spec §6.7): its
 * author's pending questions and network asks, and the highest seq the network skips wrote per
 * conversation (a sub-agent's ask is in its own conversation).
 */
export interface ReplySkips {
  questions: QuestionRecord[];
  network: ApprovalRecord[];
  seqs: ReadonlyMap<string, number>;
}

export const NO_REPLY_SKIPS: ReplySkips = { questions: [], network: [], seqs: new Map() };

/** 会话服务用到的运行控制：投递运行（RunQueue）与跨副本中止（RunAbort）。 */
export interface RunControl {
  /**
   * The direct `ensureRun` after a commit that owes the ensure-run backstop: a failure is logged,
   * never thrown (transactional outbox spec §6).
   */
  ensureRunAfterCommit(conversationId: string): Promise<void>;
  /**
   * Owes the ensure-run backstop in the caller's transaction (transactional outbox spec §6): `seq`
   * is the event it wrote (or the conversation's newest), `orgId` the conversation's.
   */
  oweEnsureRun(conversationId: string, seq: number | string, orgId: string): Promise<boolean>;
  /** After a root's queue was unpaused: the wakes it held for its tree (agent map spec §5.3). */
  wakeHeldTree(rootId: string): Promise<void>;
  /**
   * In the transaction that may release a root's hold: owes the ensure-run backstop of each
   * sub-agent {@link wakeHeldTree} wakes after the commit (transactional outbox spec §6).
   */
  oweHeldTreeIn(rootId: string): Promise<void>;
  /**
   * In a decision's transaction, after its decided rows: resumes the waiting run when it waits on
   * nothing else (lock order: conversations, decided rows, runs).
   */
  resumeIn(runId: string, waitId: string): Promise<unknown>;
  /** In a root's delete transaction: owes the stop of its sub-agent tree (`stop-tree`). */
  oweStopDeletedTree(
    conversationId: string,
    byAccountId: string | null,
    orgId: string,
  ): Promise<boolean>;
  /**
   * 运行是孤儿（会话锁空闲、任务已不存在，没有 worker 会收到中止广播）时直接把它写成 aborted，返回 true；
   * 否则返回 false。
   */
  abortIfOrphaned(conversationId: string, runId: string, byAccountId: string): Promise<boolean>;
  /** Ends a run still `queued` in PG before a worker started it (`RunQueue.abortQueued`): true. */
  abortQueued(conversationId: string, runId: string, byAccountId: string): Promise<boolean>;
  /**
   * 运行在等人处理（waiting）时直接中止：取消等待、写 `run_aborted`、删除 checkpoint，返回 true；
   * 运行已不是 waiting（例如刚被续跑）→ false。
   */
  abortWaiting(conversationId: string, runId: string, byAccountId: string): Promise<boolean>;
  /** 请求中止运行（广播到所有副本）。 */
  requestAbort(runId: string, byAccountId: string): Promise<void>;
  /**
   * Stops a sub-agent with its descendants (with `includeSelf: false` only the sub-agent
   * conversations below); the number of runs asked to stop (agent map spec §6).
   */
  stopTree(
    conversationId: string,
    byAccountId: string,
    opts?: { includeSelf?: boolean },
  ): Promise<number>;
}

/** 消息附件引用（连接器 + 资源 URI）。 */
export interface AttachmentRef {
  connectorId: string;
  uri: string;
}

/** Resolved `@` resources: the blocks after the user text and their metadata. */
export interface ResolvedExtra {
  blocks: { type: "text"; text: string }[];
  /** 写进 user_message 的附件元数据：事件 payload 字段名仍为 `appId` / `appName`（C27）。 */
  attachments: { appId: string; appName: string; uri: string; name: string }[];
}

export { userMessageIdemKey } from "./idem-keys.js";

const COLUMNS = [
  "id",
  "org_id",
  "agent_id",
  "account_id",
  "title",
  "title_source",
  "selection",
  "last_seq",
  "created_at",
  "updated_at",
  "parent_conversation_id",
  "subagent_type",
  "archived_at",
  "device_id",
  "scheduled_task_id",
] as const;

function toView(r: {
  id: string;
  org_id: string;
  agent_id: string;
  account_id: string;
  title: string | null;
  title_source: TitleSource | null;
  selection: unknown;
  last_seq: string;
  created_at: Date;
  updated_at: Date;
  parent_conversation_id: string | null;
  subagent_type: string | null;
  archived_at: Date | null;
  device_id: string | null;
  scheduled_task_id: string | null;
  activity?: "running" | "waiting" | null;
}): ConversationView {
  return {
    id: r.id,
    orgId: r.org_id,
    agentId: r.agent_id,
    accountId: r.account_id,
    title: r.title,
    titleSource: r.title_source,
    selection: (r.selection as Selection | null) ?? NO_SELECTION,
    lastSeq: Number(r.last_seq),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    parentConversationId: r.parent_conversation_id,
    subagentType: r.subagent_type,
    archivedAt: r.archived_at,
    deviceId: r.device_id,
    scheduledTaskId: r.scheduled_task_id,
    activity: r.activity ?? null,
  };
}

/** The longest conversation title (characters, after trimming). */
export const CONVERSATION_TITLE_MAX_CHARS = 120;

/**
 * How far back a `before` page of events reaches past its `limit` for the start of a turn (history
 * paging spec §2); a longer run starts mid-run.
 */
export const EVENTS_TURN_EXTEND = 2000;

/** A user message as posted (`POST …/messages`, or the first message of `POST /conversations`). */
export interface UserMessageInput {
  text: string;
  clientMessageId?: string;
  attachments?: AttachmentRef[];
  files?: string[];
  /** Switch the conversation's model from the next run (the agent's own model = back to it). */
  model?: ModelRef;
  /** Switch the effort (one of the model's declared `effort` values). */
  effort?: string;
  /** A retry after a failed run: the seq of the repeated message (display only). */
  retryOf?: number;
  /**
   * Invoke this skill of the agent (phase D, `/name args`): `text` is the arguments, and the
   * rendered skill replaces it as `content[0]`.
   */
  skill?: { name: string };
  /** The browser's IANA time zone and UI language (run context spec §3.4); IM sends none. */
  timeZone?: string;
  locale?: "zh" | "en";
  /** An anonymous IM guest's IM profile name (run context spec §7); other senders: none. */
  senderName?: string;
  /**
   * An IM message: the time zone and language the platform gave for the sender (channel@1
   * `sender.timeZone` / `sender.locale`, checked and normalized by the inbound); they win over the
   * account setting and the person's web language (run context spec §3.4).
   */
  im?: ImSenderContext;
}

/**
 * Message options only kernel callers pass (a scheduled task's fire, scheduled tasks spec §6), never
 * an HTTP body: the schedule marker the `user_message` carries and a zone that beats every other
 * source of the message's `timeZone` (`readMessageContext`).
 */
export interface InternalMessageOptions {
  schedule?: ScheduleMarker;
  timeZoneOverride?: string;
}

/** Options of a conversation created by a kernel caller (never an HTTP body). */
export interface NewConversationOptions {
  /**
   * Where it comes from (memory plugin spec §6.2), fixed at creation. Required: a channel or group
   * conversation that fell back to `web` would be offered what only the web and DMs may see.
   */
  source: ConversationSource;
}

interface UsageRow {
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
}

/** The sums of the `usage` events matching `where` (over `conversation_events e`), one row. */
const usageSums = (where: ReturnType<typeof sql>) => sql`
  SELECT
    coalesce(sum((e.payload->>'inputTokens')::bigint), 0) AS input_tokens,
    coalesce(sum((e.payload->>'outputTokens')::bigint), 0) AS output_tokens,
    coalesce(sum((e.payload->>'cacheReadTokens')::bigint), 0) AS cache_read_tokens,
    coalesce(sum((e.payload->>'cacheWriteTokens')::bigint), 0) AS cache_write_tokens
  FROM capybara.conversation_events e
  WHERE e.type = 'usage' AND ${where}
`;

const toUsage = (r: UsageRow): UsageTotals => ({
  inputTokens: Number(r.input_tokens),
  outputTokens: Number(r.output_tokens),
  cacheReadTokens: Number(r.cache_read_tokens),
  cacheWriteTokens: Number(r.cache_write_tokens),
});

/**
 * 会话：只有所有者可见；每次访问都实时复核 agent 对所有者仍可用（spec 3.6 R5），
 * 不可用时会话也按不存在处理（`conversation.not_found`）。
 */
@Injectable()
export class ConversationsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(AgentLookup) private readonly agents: Pick<AgentLookup, "get">,
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
    /** Starts and stops the conversation's runs. */
    @Inject(RunControlService) private readonly runs: RunControl,
    /** Resolves a switched-to model and its declared parameters (UI refresh B). */
    @Inject(ProviderRegistry) private readonly providers: Pick<ProviderRegistry, "resolve">,
    /** Reads `@` resources with the sender's credentials. */
    @Inject(ConnectorContent)
    private readonly content: Pick<ConnectorContent, "resolveAttachments">,
    /** Binds uploaded files to the conversation in the message's transaction. */
    @Inject(AttachmentsService)
    private readonly attachments: Pick<AttachmentsService, "bindForMessage">,
    /** Renders a person's skill invocation (phase D). */
    @Inject(SkillInvoker) private readonly invoker: Pick<SkillInvoker, "prepare">,
    /** Stops a deleted conversation's background tasks. */
    @Inject(BackgroundTaskStopper)
    private readonly background: Pick<BackgroundTaskStopper, "stopForDeletedConversation">,
    /** The device a new conversation is bound to (environments spec §4.1 item 1). */
    @Inject(ConversationDevices)
    private readonly devices: Pick<ConversationDevices, "forNew">,
    /** A starter's message skips the run's pending questions (reply-while-question spec §8.1). */
    @Inject(QuestionsService)
    private readonly questions: Pick<QuestionsService, "skipPendingIn">,
    /** ... and its pending network asks (network ask-to-allow spec §6.7). */
    @Inject(ApprovalsService)
    private readonly approvals: Pick<ApprovalsService, "skipNetworkIn">,
    @Inject(KernelEvents) private readonly events: Pick<KernelEvents, "emit">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * Creates an empty conversation bound to its device (`pick`, see
   * {@link ConversationDevices.forNew}); an agent the account cannot use →
   * `agent.not_found`, a device it may not use → `device.not_found` /
   * `device.unavailable`, and nothing is created. `opts.source` records where the conversation
   * comes from.
   */
  async create(
    orgId: string,
    accountId: string,
    agentId: string,
    pick: NewConversationDevice = {},
    opts: NewConversationOptions,
  ): Promise<ConversationView> {
    await this.agents.get(orgId, agentId, accountId);
    const deviceId = await this.devices.forNew(orgId, accountId, pick);
    const row = await this.db
      .insertInto("conversations")
      .values({
        id: randomUUID(),
        org_id: orgId,
        agent_id: agentId,
        account_id: accountId,
        device_id: deviceId,
        source: opts.source,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return toView(row);
  }

  /**
   * Creates a conversation together with its first message (UI refresh B, create on first send):
   * the conversation row and the `user_message` are written in one transaction, keyed by the
   * message's `clientMessageId` (`create_request_id`), so a retried send returns the same
   * conversation and event with `created: false`. An agent the caller cannot use →
   * `agent.not_found` and nothing is written. Queues a run afterwards, like `postUserMessage`.
   * `events` are every event the create wrote, in seq order from seq 1 (a `model_switched` before
   * the message when the send switched), so a client can seed the new conversation's log whole.
   * `internal`: the conversation's source and, for kernel callers only, a scheduled task's marker,
   * which also sets `conversations.scheduled_task_id`, and its zone override.
   */
  async createWithMessage(
    orgId: string,
    accountId: string,
    agentId: string,
    input: UserMessageInput & { clientMessageId: string },
    pick: NewConversationDevice = {},
    internal: InternalMessageOptions & NewConversationOptions,
  ): Promise<{
    conversation: ConversationView;
    event: ConversationEvent;
    events: ConversationEvent[];
    created: boolean;
  }> {
    const agent = await this.agents.get(orgId, agentId, accountId);
    const prior = await this.findCreated(orgId, accountId, agentId, input.clientMessageId);
    if (prior) return prior;
    const deviceId = await this.devices.forNew(orgId, accountId, pick);
    const next = await this.planSwitch(orgId, agent.definition, NO_SELECTION, input);
    const extra = await this.resolveExtra(orgId, accountId, input);
    const invoked = await this.prepareSkill(orgId, agentId, undefined, agent.definition, input);
    const id = randomUUID();
    const all = await this.createIn(
      { id, orgId, accountId, agentId, deviceId },
      input,
      next,
      extra,
      invoked,
      internal,
    );
    const written = all?.at(-1);
    if (!all || !written) {
      const raced = await this.findCreated(orgId, accountId, agentId, input.clientMessageId);
      if (!raced) throw new ApiError("conflict", "The conversation is being created; retry");
      return raced;
    }
    await this.eventLog.notify(id, written.seq);
    await this.startRun(id);
    return { conversation: await this.rowView(id), event: written, events: all, created: true };
  }

  /** The conversation row and its first message (undefined: a concurrent retry committed first). */
  // its own transaction: the caller notifies and publishes after the commit
  @Transactional({ propagation: "requires_new" })
  private async createIn(
    conv: {
      id: string;
      orgId: string;
      accountId: string;
      agentId: string;
      deviceId: string | null;
    },
    input: UserMessageInput & { clientMessageId: string },
    next: Selection | null,
    extra: ResolvedExtra,
    invoked: RenderedInvocation | undefined,
    internal: InternalMessageOptions & NewConversationOptions,
  ): Promise<ConversationEvent[] | undefined> {
    const { id, orgId, accountId } = conv;
    const row = await this.db
      .insertInto("conversations")
      .values({
        id,
        org_id: orgId,
        agent_id: conv.agentId,
        account_id: accountId,
        device_id: conv.deviceId,
        create_request_id: input.clientMessageId,
        scheduled_task_id: internal.schedule?.taskId ?? null,
        source: internal.source,
      })
      .onConflict((oc) =>
        oc
          .columns(["org_id", "account_id", "create_request_id"])
          .where("create_request_id", "is not", null)
          .doNothing(),
      )
      .returning("id")
      .executeTakeFirst();
    // a concurrent retry committed first: answer with its conversation below
    if (!row) return undefined;
    const blocks = await this.bindIn(orgId, id, accountId, input.files ?? []);
    // a new conversation has no run yet, so nothing to skip
    return (
      await this.writeMessage(orgId, id, accountId, input, next, extra, blocks, invoked, internal)
    ).events;
  }

  /**
   * The conversation (and its first event) an earlier first send with this id created. The id used
   * for another agent's conversation → `conflict` (the caller only checked access to `agentId`, so
   * the other conversation is never returned).
   */
  private async findCreated(
    orgId: string,
    accountId: string,
    agentId: string,
    clientMessageId: string,
  ): Promise<{
    conversation: ConversationView;
    event: ConversationEvent;
    events: ConversationEvent[];
    created: false;
  } | null> {
    const row = await this.db
      .selectFrom("conversations")
      .select(COLUMNS)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("create_request_id", "=", clientMessageId)
      .where("kind", "=", "chat")
      .executeTakeFirst();
    if (!row) return null;
    if (row.agent_id !== agentId) {
      throw new ApiError(
        "conflict",
        "This clientMessageId was already used for another conversation",
      );
    }
    const event = await this.eventLog.findByIdem(row.id, userMessageIdemKey(clientMessageId));
    if (!event) return null;
    // what the first send wrote: the log from its start up to the message
    const events = (await this.eventLog.readAfter(row.id, 0, event.seq)).filter(
      (e) => e.seq <= event.seq,
    );
    await this.startRun(row.id);
    return { conversation: toView(row), event, events, created: false };
  }

  /**
   * The direct `ensureRun` after a message's commit ({@link RunControl.ensureRunAfterCommit}): a
   * failure never fails the request, since the message's transaction owes the ensure-run backstop.
   */
  private startRun(conversationId: string): Promise<void> {
    return this.runs.ensureRunAfterCommit(conversationId);
  }

  private async rowView(id: string): Promise<ConversationView> {
    return toView(
      await this.db
        .selectFrom("conversations")
        .select(COLUMNS)
        .where("id", "=", id)
        .executeTakeFirstOrThrow(),
    );
  }

  /**
   * Renames a conversation (owner only, as {@link get}): `title_source = 'manual'`, so the title
   * job never overwrites it. Publishes `changed: title`. `title` is already trimmed and checked.
   */
  async rename(
    orgId: string,
    conversationId: string,
    accountId: string,
    title: string,
  ): Promise<ConversationView> {
    await this.writable(orgId, conversationId, accountId);
    const row = await this.db
      .updateTable("conversations")
      .set({ title, title_source: "manual" })
      .where("id", "=", conversationId)
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    await this.eventLog.publishChanged(conversationId, "title");
    return toView(row);
  }

  /**
   * Archives or unarchives a conversation (owner only, as {@link rename}). An archived
   * conversation leaves the default lists but stays readable. Publishes `changed: archived`.
   */
  async setArchived(
    orgId: string,
    conversationId: string,
    accountId: string,
    archived: boolean,
  ): Promise<ConversationView> {
    await this.writable(orgId, conversationId, accountId);
    const row = await this.db
      .updateTable("conversations")
      .set({ archived_at: archived ? sql<Date>`now()` : null })
      .where("id", "=", conversationId)
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    await this.eventLog.publishChanged(conversationId, "archived");
    return toView(row);
  }

  /**
   * Soft-deletes a conversation (owner only; a sub-agent's conversation is `conversation.read_only`):
   * stops an active run, hides the conversation everywhere for its owner and drops its channel
   * bindings, stops every running background task in its sandbox (its sub-agents' too; outside
   * the delete's transaction, a task whose sandbox cannot be reached ends `lost` with
   * `kill_pending`), then every active run of its sub-agent tree (agent map spec §10). The tasks
   * are stopped after the conversation is marked deleted, so no finish
   * (the stops' own, or one the poller writes meanwhile) can wake a run on it: `ensureRun` refuses a
   * deleted conversation (the stops' finishes carry `stoppedBy: "deletion"` as well). The event
   * log, runs and trajectory stay (super admins still see them).
   */
  async remove(orgId: string, conversationId: string, accountId: string): Promise<void> {
    await this.writable(orgId, conversationId, accountId);
    try {
      await this.abort(orgId, conversationId, accountId);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "run.not_active")) throw e;
    }
    await this.markDeleted(orgId, conversationId, accountId);
    // after the mark, so no finish or delivery of the stops below can start a run on the deleted
    // root (`ensureRun` refuses it). The sandbox's tasks stop first, so the sub-agents' tasks end
    // as a deletion; the tree stop then only stops a task a sub-agent started in between
    // (`stoppedBy: "subagent_end"`, which never wakes either)
    await this.background.stopForDeletedConversation(conversationId);
    // the whole tree stops (agent map spec §10)
    await this.runs.stopTree(conversationId, accountId, { includeSelf: false });
    await this.eventLog.publishChanged(conversationId, "deleted");
  }

  // the publish happens after the commit, in the caller; the tree stop after it is owed here
  // (transactional outbox spec §6), so a process that dies before it still stops the tree
  @Transactional()
  private async markDeleted(
    orgId: string,
    conversationId: string,
    accountId: string,
  ): Promise<void> {
    await this.db
      .updateTable("conversations")
      .set({ deleted_at: sql<Date>`now()` })
      .where("id", "=", conversationId)
      .execute();
    await this.runs.oweStopDeletedTree(conversationId, accountId, orgId);
    // Queued messages must not start a run on a deleted conversation
    await this.db
      .deleteFrom("conversation_queue")
      .where("conversation_id", "=", conversationId)
      .execute();
    await unbindConversation(this.db.db, conversationId);
  }

  /** 读会话：非所有者、或 agent 已对所有者不可用 → `conversation.not_found`。 */
  async get(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
  ): Promise<ConversationView> {
    const { kind: _kind, ...row } = await this.readable(orgId, conversationId, viewerAccountId);
    return toView(row);
  }

  /**
   * {@link get} for a change made by a person (a message, rename, queue, model switch): a
   * sub-agent's conversation is read-only (sub-agents spec §6.1) → `conversation.read_only`.
   */
  async writable(
    orgId: string,
    conversationId: string,
    accountId: string,
  ): Promise<ConversationView> {
    const { kind, ...row } = await this.readable(orgId, conversationId, accountId);
    if (kind === "subagent") {
      throw new ApiError("conversation.read_only", "A sub-agent's conversation takes no messages");
    }
    return toView(row);
  }

  /** {@link get}'s row, with the conversation's kind. */
  private async readable(orgId: string, conversationId: string, viewerAccountId: string) {
    const row = await this.db
      .selectFrom("conversations")
      .select([...COLUMNS, "kind"])
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .where("account_id", "=", viewerAccountId)
      .where("deleted_at", "is", null)
      // Hidden eval replay conversations (kind 'eval') are not reachable here (only the trajectory
      // viewer shows them); a sub-agent's conversation is, for its owner (sub-agents spec §6.1)
      .where("kind", "in", ["chat", "subagent"])
      .where(parentReachable(viewerAccountId))
      .executeTakeFirst();
    if (!row) throw notFound();
    try {
      await this.agents.get(orgId, row.agent_id, viewerAccountId);
    } catch (e) {
      if (e instanceof ApiError && e.code === "agent.not_found") throw notFound();
      throw e;
    }
    return row;
  }

  /** The stream's visibility check ({@link ConversationAccess.isAccessible}). */
  isAccessible(orgId: string, conversationId: string, viewerAccountId: string): Promise<boolean> {
    return this.access.isAccessible(orgId, conversationId, viewerAccountId);
  }

  /**
   * 我的会话，最近更新的在前；只含 agent 仍可用的会话。`after` 为上一页最后一个会话的 id，
   * 从它当前的 (updated_at, id) 之后继续；游标会话已不存在时返回空页。
   */
  async listMine(
    orgId: string,
    accountId: string,
    opts: {
      after?: string;
      limit: number;
      agentId?: string;
      archived?: boolean;
      q?: string;
      state?: "running" | "waiting";
    },
  ): Promise<ConversationView[]> {
    let q = this.db
      .selectFrom("conversations")
      .select(COLUMNS)
      .select(activitySql("conversations").as("activity"))
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      // 评测回放的隐藏对话（kind = 'eval'）不在「我的对话」里
      .where("kind", "=", "chat")
      .where("deleted_at", "is", null)
      .where("archived_at", opts.archived === true ? "is not" : "is", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("agents")
            .select(sql`1`.as("one"))
            .whereRef("agents.id", "=", "conversations.agent_id")
            .where("agents.deleted_at", "is", null)
            .where(visibleTo(accountId)),
        ),
      )
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .limit(opts.limit);
    if (opts.agentId !== undefined) q = q.where("agent_id", "=", opts.agentId);
    if (opts.q !== undefined) {
      q = q.where(sql<boolean>`conversations.title ILIKE ${`%${escapeLike(opts.q)}%`} ESCAPE '\\'`);
    }
    if (opts.state !== undefined) {
      q = q.where(sql<boolean>`${activitySql("conversations")} = ${opts.state}`);
    }
    if (opts.after !== undefined) {
      const after = opts.after;
      q = q.where(
        (eb) =>
          sql<boolean>`(${eb.ref("updated_at")}, ${eb.ref("id")}) < (
            SELECT c.updated_at, c.id FROM capybara.conversations c
            WHERE c.id = ${after} AND c.org_id = ${orgId} AND c.account_id = ${accountId}
          )`,
      );
    }
    return (await q.execute()).map(toView);
  }

  /**
   * My chat conversations grouped by agent (the sidebar, UI refresh spec §5.9), in one statement.
   * Only agents that are not deleted and still visible to me (as {@link listMine}). Groups are
   * ordered by (latestAt DESC, agent id DESC); each holds up to `perGroup` conversations and says
   * whether it has more. `after` is the last group's agent id, re-evaluated against that group's
   * current latestAt; a cursor agent that is no longer listed gives an empty page.
   */
  async listGroups(
    orgId: string,
    accountId: string,
    opts: {
      perGroup: number;
      limit: number;
      after?: string;
      archived?: boolean;
      q?: string;
      state?: "running" | "waiting";
    },
  ): Promise<{ groups: ConversationGroup[]; next: string | null; archivedCount: number }> {
    const visibleAgents = this.db
      .selectFrom("agents")
      .select("agents.id")
      .where("agents.org_id", "=", orgId)
      .where("agents.deleted_at", "is", null)
      .where(visibleTo(accountId));
    const archivedFilter =
      opts.archived === true ? sql`c.archived_at IS NOT NULL` : sql`c.archived_at IS NULL`;
    const searchFilter =
      opts.q === undefined
        ? sql``
        : sql`AND c.title ILIKE ${`%${escapeLike(opts.q)}%`} ESCAPE '\\'`;
    const stateFilter =
      opts.state === undefined ? sql`` : sql`AND ${activitySql("c")} = ${opts.state}`;
    const cursor =
      opts.after === undefined
        ? sql``
        : sql`WHERE (g.latest_at, g.agent_id) < (
            SELECT g2.latest_at, g2.agent_id FROM g g2 WHERE g2.agent_id = ${opts.after}
          )`;
    const { rows } = await sql<{
      agent_id: string;
      latest_at: Date;
      agent_name: string | null;
      profile_avatar: AgentAvatar;
      profile_updated_at: Date;
      id: string;
      org_id: string;
      account_id: string;
      title: string | null;
      title_source: TitleSource | null;
      selection: unknown;
      last_seq: string;
      created_at: Date;
      updated_at: Date;
      parent_conversation_id: string | null;
      scheduled_task_id: string | null;
      subagent_type: string | null;
      archived_at: Date | null;
      device_id: string | null;
      activity: "running" | "waiting" | null;
    }>`
      WITH g AS (
        SELECT c.agent_id, max(c.updated_at) AS latest_at
        FROM capybara.conversations c
        WHERE c.org_id = ${orgId} AND c.account_id = ${accountId} AND c.kind = 'chat'
          AND c.deleted_at IS NULL AND ${archivedFilter} ${searchFilter} ${stateFilter}
          AND c.agent_id IN ${visibleAgents}
        GROUP BY c.agent_id
      ), page AS (
        SELECT g.agent_id, g.latest_at FROM g
        ${cursor}
        ORDER BY g.latest_at DESC, g.agent_id DESC
        LIMIT ${opts.limit + 1}
      )
      SELECT page.agent_id, page.latest_at, v.definition ->> 'name' AS agent_name,
        a.profile_avatar, a.profile_updated_at, cs.id, cs.org_id, cs.account_id, cs.title, cs.title_source, cs.selection, cs.last_seq,
        cs.created_at, cs.updated_at, cs.parent_conversation_id, cs.subagent_type,
        cs.archived_at, cs.device_id, cs.scheduled_task_id, cs.activity
      FROM page
      JOIN capybara.agents a ON a.id = page.agent_id
      JOIN capybara.agent_versions v ON v.agent_id = a.id AND v.version = a.current_version
      CROSS JOIN LATERAL (
        SELECT c.id, c.org_id, c.account_id, c.title, c.title_source, c.selection, c.last_seq,
          c.created_at, c.updated_at, c.parent_conversation_id, c.subagent_type,
          c.archived_at, c.device_id, c.scheduled_task_id, ${activitySql("c")} AS activity
        FROM capybara.conversations c
        WHERE c.org_id = ${orgId} AND c.account_id = ${accountId} AND c.kind = 'chat'
          AND c.deleted_at IS NULL AND ${archivedFilter} ${searchFilter} ${stateFilter}
          AND c.agent_id = page.agent_id
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ${opts.perGroup + 1}
      ) cs
      ORDER BY page.latest_at DESC, page.agent_id DESC, cs.updated_at DESC, cs.id DESC
    `.execute(this.db.db);
    const groups: ConversationGroup[] = [];
    let current: ConversationGroup | undefined;
    for (const r of rows) {
      if (current?.agent.id !== r.agent_id) {
        current = {
          agent: {
            id: r.agent_id,
            name: r.agent_name ?? "",
            profile: {
              avatar: r.profile_avatar,
              updatedAt: r.profile_updated_at.toISOString(),
            },
          },
          latestAt: r.latest_at,
          conversations: [],
          more: false,
        };
        groups.push(current);
      }
      if (current.conversations.length < opts.perGroup) {
        current.conversations.push(toView(r));
      } else current.more = true;
    }
    const page = groups.slice(0, opts.limit);
    const next = groups.length > opts.limit ? (page.at(-1)?.agent.id ?? null) : null;
    // The archived entry's count ignores `q` and `state`
    const counted = await sql<{ n: string }>`
      SELECT count(*) AS n FROM capybara.conversations c
      WHERE c.org_id = ${orgId} AND c.account_id = ${accountId} AND c.kind = 'chat'
        AND c.deleted_at IS NULL AND c.archived_at IS NOT NULL
        AND c.agent_id IN ${visibleAgents}
    `.execute(this.db.db);
    return { groups: page, next, archivedCount: Number(counted.rows[0]?.n ?? 0) };
  }

  /**
   * The sub-agents of a conversation, newest first (sub-agents spec §14.3); owner only, as
   * {@link isAccessible} (else `conversation.not_found`). `after` is the previous page's last id,
   * re-evaluated against its current position; a cursor that is not a sub-agent of this
   * conversation gives an empty page. A row is listed even when its child is not accessible to the
   * viewer (an org agent they can no longer see): its id is already in the parent's log, and opening
   * the child still goes through {@link isAccessible}.
   */
  async listSubagents(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
    opts: { after?: string; limit: number },
  ): Promise<{ subagents: SubagentView[]; next: string | null }> {
    if (!(await this.isAccessible(orgId, conversationId, viewerAccountId))) throw notFound();
    const cursor =
      opts.after === undefined
        ? sql``
        : sql`AND (c.created_at, c.id) < (
            SELECT c2.created_at, c2.id FROM capybara.conversations c2
            WHERE c2.id = ${opts.after} AND c2.parent_conversation_id = ${conversationId}
          )`;
    const { rows } = await sql<{
      id: string;
      subagent_type: string | null;
      title: string | null;
      description: string | null;
      status: SubagentView["status"];
      run_created_at: Date;
      started_at: Date | null;
      finished_at: Date | null;
      tool_calls: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      approval_ids: string[];
      question_ids: string[];
    }>`
      WITH page AS (
        -- the page of children first, so the per-child work below runs for this page only
        -- (batch 11 m3)
        SELECT c.id, c.created_at, c.subagent_type, c.title
        FROM capybara.conversations c
        WHERE c.org_id = ${orgId} AND c.parent_conversation_id = ${conversationId}
          AND c.kind = 'subagent'
          AND EXISTS (
            SELECT 1 FROM capybara.subagent_dispatches sd WHERE sd.child_conversation_id = c.id
          )
          ${cursor}
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ${opts.limit + 1}
      ),
      described AS (
        SELECT DISTINCT ON (e.payload->>'subagentId')
          e.payload->>'subagentId' AS id, e.payload->>'description' AS description
        FROM capybara.conversation_events e
        WHERE e.conversation_id = ${conversationId} AND e.type = 'subagent_dispatched'
          AND e.payload->>'subagentId' IN (SELECT id FROM page)
        ORDER BY e.payload->>'subagentId', e.seq DESC
      )
      SELECT c.id, c.subagent_type, c.title, d.description, r.status,
        r.created_at AS run_created_at, r.started_at, r.finished_at,
        (SELECT count(*) FROM capybara.conversation_events e
          WHERE e.conversation_id = c.id AND e.run_id = r.id AND e.type = 'tool_result'
        ) AS tool_calls,
        u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
        ARRAY(SELECT a.id FROM capybara.approvals a
          WHERE a.conversation_id = c.id AND a.status = 'pending' AND a.expires_at > now()
          ORDER BY a.created_at, a.id) AS approval_ids,
        ARRAY(SELECT q.id FROM capybara.questions q
          WHERE q.conversation_id = c.id AND q.status = 'pending' AND q.expires_at > now()
          ORDER BY q.created_at, q.id) AS question_ids
      FROM page c
      CROSS JOIN LATERAL (
        SELECT sd.child_run_id FROM capybara.subagent_dispatches sd
        WHERE sd.child_conversation_id = c.id
        ORDER BY sd.created_at DESC, sd.child_run_id DESC
        LIMIT 1
      ) latest
      JOIN capybara.runs r ON r.id = latest.child_run_id
      CROSS JOIN LATERAL (${usageSums(sql`e.conversation_id = c.id`)}) u
      LEFT JOIN described d ON d.id = c.id
      ORDER BY c.created_at DESC, c.id DESC
    `.execute(this.db.db);
    const subagents = rows.slice(0, opts.limit).map(
      (r): SubagentView => ({
        id: r.id,
        agentType: r.subagent_type ?? "",
        description: r.description ?? r.title ?? "",
        status: r.status,
        toolCalls: Number(r.tool_calls),
        startedAt: (r.started_at ?? r.run_created_at).toISOString(),
        finishedAt: r.finished_at?.toISOString() ?? null,
        usage: toUsage(r),
        pendingApprovalIds: r.approval_ids,
        pendingQuestionIds: r.question_ids,
      }),
    );
    const next = rows.length > opts.limit ? (subagents.at(-1)?.id ?? null) : null;
    return { subagents, next };
  }

  /**
   * The agent tree of a root conversation (agent map spec §8, §9.2): the root and every sub-agent
   * below it with status, model, time, tokens and tool calls. Owner only, as {@link isAccessible};
   * a sub-agent's id (not a root) is `conversation.not_found` too.
   */
  async agentTree(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
  ): Promise<{ root: AgentTreeNode }> {
    if (!(await this.isAccessible(orgId, conversationId, viewerAccountId))) throw notFound();
    const root = await readAgentTree(this.db.db, orgId, conversationId);
    if (!root) throw notFound();
    return { root };
  }

  /**
   * A conversation's token usage: its own `usage` events (compaction included) plus those of every
   * sub-agent below it, at any depth (sub-agents spec §8.3, agent map spec §6: every descendant
   * counts toward the root; `conversationTree`), whose logs keep their own. Owner only, as
   * {@link get}.
   */
  async usage(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
  ): Promise<UsageTotals> {
    if (!(await this.isAccessible(orgId, conversationId, viewerAccountId))) throw notFound();
    const ids = (await conversationTree(this.db.db, conversationId)).map((c) => c.id);
    const { rows } = await sql<UsageRow>`${usageSums(
      sql`e.conversation_id IN (${sql.join(ids.length > 0 ? ids : [conversationId])})`,
    )}`.execute(this.db.db);
    const row = rows[0];
    return row
      ? toUsage(row)
      : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }

  /**
   * The conversation whose sandbox `conversationId` works in: a sub-agent's is its root
   * conversation's at any depth (sub-agents spec §10.1, agent map spec §6), any other its own. Call
   * only after an access check.
   */
  async sandboxConversationOf(orgId: string, conversationId: string): Promise<string> {
    const row = await this.db
      .selectFrom("conversations")
      .select("parent_conversation_id")
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!row?.parent_conversation_id) return conversationId;
    return rootConversationOf(this.db.db, row.parent_conversation_id);
  }

  /**
   * 读事件（先做 `get` 的可见性判定）. A read never changes run state (transactional outbox spec
   * §6): a run nobody runs is the `run-orphan-check`'s to repair.
   */
  async listEvents(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
    afterSeq: number,
    limit: number,
  ): Promise<ConversationEvent[]> {
    await this.get(orgId, conversationId, viewerAccountId);
    return this.eventLog.readAfter(conversationId, afterSeq, limit);
  }

  /**
   * The turn-aligned page of events before `beforeSeq` (`null`: the log's last page), with how
   * many runs started before it ({@link EventLog.readTurnPageBefore}; history paging spec §2).
   * Visibility as {@link get}; a read only, as {@link listEvents}.
   */
  async listEventsBefore(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
    beforeSeq: number | null,
    limit: number,
  ): Promise<{ events: ConversationEvent[]; turnsBefore: number }> {
    await this.get(orgId, conversationId, viewerAccountId);
    return this.eventLog.readTurnPageBefore(conversationId, beforeSeq, limit, EVENTS_TURN_EXTEND);
  }

  /**
   * 追加一条用户消息；带 `clientMessageId` 时重复提交返回同一事件。写入后调用 `ensureRun`：
   * 没有进行中的运行时投递一轮；运行中则由当前运行在步骤间隙吸收，或在它结束时再次 `ensureRun`。
   * A failed `ensureRun` is logged, not thrown: the message's transaction owes the ensure-run
   * backstop, which starts the run once the queue is reachable (transactional outbox spec §6).
   *
   * `attachments`（`@` 资源引用）：内核以发送者的凭据读取资源（打码、限长），作为用户文本之后的额外文本块写入同一条
   * user_message，并在 `payload.attachments` 记录元数据（第 i 个附件对应 `content[i + 1]`）。读取失败整条不写。
   * 带 `clientMessageId` 的重复提交直接返回已写入的事件，不再读取。
   *
   * `files`（上传的附件 id）：在写事件的同一事务里校验并绑定到本会话（见 {@link BindFiles}），作为 image /
   * document 引用块追加在最后（`@` 资源块之后）；任一附件不可用则整条不写。日志里只有引用，没有字节。
   * `text` 为空时（只发附件，HTTP 层保证此时有 `files` 且没有 `@` 资源）不写文本块。
   */
  async postUserMessage(
    orgId: string,
    conversationId: string,
    accountId: string,
    input: UserMessageInput,
  ): Promise<ConversationEvent> {
    const conv = await this.writable(orgId, conversationId, accountId);
    const refs = input.attachments ?? [];
    const files = input.files ?? [];
    // A retry returns the written event (no resource read, no file check, no skill resolution)
    if (
      (refs.length > 0 || files.length > 0 || input.skill !== undefined) &&
      input.clientMessageId !== undefined
    ) {
      const existing = await this.eventLog.findByIdem(
        conversationId,
        userMessageIdemKey(input.clientMessageId),
      );
      if (existing) {
        await this.startRun(conversationId);
        return existing;
      }
    }
    const needsAgent =
      input.model !== undefined || input.effort !== undefined || input.skill !== undefined;
    const agent = needsAgent
      ? (await this.agents.get(orgId, conv.agentId, accountId)).definition
      : undefined;
    const next =
      agent === undefined || (input.model === undefined && input.effort === undefined)
        ? null
        : await this.planSwitch(orgId, agent, conv.selection, input);
    const extra = await this.resolveExtra(orgId, accountId, input);
    const invoked =
      agent === undefined
        ? undefined
        : await this.prepareSkill(orgId, conv.agentId, conversationId, agent, input);
    // one transaction: the sender, time zone and language are read with the message's write
    // (run context spec §3.2)
    const { event, skipped, toSeq } = await this.postIn(
      orgId,
      conversationId,
      accountId,
      input,
      next,
      extra,
      invoked,
    );
    await this.eventLog.notify(conversationId, toSeq);
    await this.announceSkipped(skipped);
    if (next !== null) await this.eventLog.publishChanged(conversationId, "selection");
    // The message is written: it brings an archived conversation back into the default lists
    if (conv.archivedAt !== null) {
      await this.db
        .updateTable("conversations")
        .set({ archived_at: null })
        .where("id", "=", conversationId)
        .execute();
      await this.eventLog.publishChanged(conversationId, "archived");
    }
    await this.startRun(conversationId);
    return event;
  }

  /**
   * Writes a message in one transaction: binds its files, reads its sender context and appends it
   * (after its `model_switched` when it switches).
   */
  // its own transaction: the caller notifies and publishes after the commit
  @Transactional({ propagation: "requires_new" })
  private async postIn(
    orgId: string,
    conversationId: string,
    accountId: string,
    input: UserMessageInput,
    next: Selection | null,
    extra: ResolvedExtra,
    invoked: RenderedInvocation | undefined,
  ): Promise<{ event: ConversationEvent; skipped: ReplySkips; toSeq: number }> {
    const blocks = await this.bindIn(orgId, conversationId, accountId, input.files ?? []);
    const written = await this.writeMessage(
      orgId,
      conversationId,
      accountId,
      input,
      next,
      extra,
      blocks,
      invoked,
    );
    const event = written.events.at(-1) as ConversationEvent;
    return {
      event,
      skipped: written.skipped,
      toSeq: Math.max(event.seq, written.skippedToSeq ?? 0),
    };
  }

  /**
   * The selection a message switches to, or null when it changes nothing. A model equal to the
   * agent's means "back to the agent's model" (null); a model change without `effort` resets the
   * effort. The target model must resolve (`agent.model_unavailable`) and declare the effort
   * (`validation_failed`). Resolving is the agent editor's check, for the org (its effective
   * provider config, spec B §5.5) and its disabled lists: a model the platform or the org disabled,
   * or a non-chat model, is refused (spec B §5.3), as the run worker's `fallBackIfUnavailable` falls
   * back from it.
   */
  private async planSwitch(
    orgId: string,
    agent: AgentDefinition,
    current: Selection,
    input: Pick<UserMessageInput, "model" | "effort">,
  ): Promise<Selection | null> {
    const next = planSelection(agent.model, current, input);
    if (next === null) return null;
    const { model, effort } = next;
    const { info } = await this.providers.resolve(orgId, model ?? agent.model);
    if (effort !== null) {
      const knob = info.parameters.find((p) => p.key === "effort");
      const values = (knob?.schema as { enum?: unknown[] } | undefined)?.enum ?? [];
      if (!values.includes(effort)) {
        throw new ApiError("validation_failed", "Request validation failed", [
          { path: "effort", message: `The model does not offer effort "${effort}"` },
        ]);
      }
    }
    return next;
  }

  /**
   * Checks a queued message's model / effort pick by the direct send's rules (final review I1): the
   * target model must resolve and declare the effort, against the selection in effect now. The
   * queue re-plans it against the selection in effect at dispatch.
   */
  async checkPick(
    orgId: string,
    conv: ConversationView,
    accountId: string,
    pick: Pick<UserMessageInput, "model" | "effort">,
  ): Promise<void> {
    if (pick.model === undefined && pick.effort === undefined) return;
    const agent = await this.agents.get(orgId, conv.agentId, accountId);
    await this.planSwitch(orgId, agent.definition, conv.selection, pick);
  }

  /**
   * Skips, in the caller's transaction (it wrote `accountId`'s message at `messageSeq` and holds the
   * conversation row lock), the pending questions that message closes (reply-while-question spec
   * §8.1) and the pending network asks of the author's runs, here and in the sub-agents'
   * conversations (network ask-to-allow spec §6.7). The queue's "send now" uses it as the direct
   * send does; announce after the commit with {@link announceSkipped}. `toSeq` is the highest seq
   * written in this conversation (null: none).
   *
   * Lock order: this (root) conversation (the caller's), its pending questions, the sub-agents'
   * conversations with a pending network ask (id order), the asks themselves (the root's and the
   * sub-agents'), and only then the run rows, as each skipped wait's run resumes in this
   * transaction. Every run row comes after every conversation and decided row (ruling R19); a
   * sub-agent's conversation comes after the root's questions, which only this path locks with a
   * sub-agent conversation after them.
   */
  @Transactional({ propagation: "mandatory" })
  async skipWaitsIn(
    conversationId: string,
    accountId: string,
    messageSeq: number,
  ): Promise<{ skipped: ReplySkips; toSeq: number | null }> {
    const q = await this.questions.skipPendingIn(conversationId, accountId, messageSeq);
    const n = await this.approvals.skipNetworkIn(conversationId, accountId);
    for (const w of [...q.records, ...n.records]) await this.runs.resumeIn(w.runId, w.id);
    const here = n.seqs.get(conversationId);
    const toSeq = q.toSeq === null && here === undefined ? null : Math.max(q.toSeq ?? 0, here ?? 0);
    return { skipped: { questions: q.records, network: n.records, seqs: n.seqs }, toSeq };
  }

  /**
   * After the commit: announces each skipped question (`question.answered`, outcome `skipped`) and
   * network ask (`approval.decided`, status `skipped`; a sub-agent's conversation is notified
   * first) as domain events with no kernel subscriber: the IM card updates are owed by the skips'
   * appends (transactional outbox spec §8.1); the run resumed in the message's transaction.
   */
  async announceSkipped(skipped: ReplySkips): Promise<void> {
    for (const q of skipped.questions) {
      await this.events.emit("question.answered", {
        id: q.id,
        orgId: q.orgId,
        conversationId: q.conversationId,
        runId: q.runId,
        outcome: "skipped",
      });
    }
    for (const [conversationId, seq] of skipped.seqs) {
      await this.eventLog.notify(conversationId, seq);
    }
    for (const a of skipped.network) {
      await this.events.emit("approval.decided", {
        id: a.id,
        orgId: a.orgId,
        conversationId: a.conversationId,
        runId: a.runId,
        status: "skipped",
      });
    }
  }

  /**
   * Writes the message (preceded by its `model_switched` when it switches) inside `t` and updates
   * `conversations.selection`; returns the events written, in seq order (the `user_message`
   * last). A message this call newly wrote (not a retry's deduped one) then skips the pending
   * questions its author may answer (reply-while-question spec §8.1): `skipped` and the highest
   * seq their events took. The caller notifies and emits `question.answered` after commit.
   */
  @Transactional({ propagation: "mandatory" })
  private async writeMessage(
    orgId: string,
    conversationId: string,
    accountId: string,
    input: UserMessageInput,
    next: Selection | null,
    extra: ResolvedExtra,
    blocks: LogContentBlock[],
    invoked: RenderedInvocation | undefined,
    internal: InternalMessageOptions = {},
  ): Promise<{
    events: ConversationEvent[];
    skipped: ReplySkips;
    skippedToSeq: number | null;
  }> {
    const events: AppendEvent[] = [];
    if (next !== null) {
      events.push({
        type: "model_switched",
        ...(input.clientMessageId !== undefined && {
          idemKey: `switch:${input.clientMessageId}`,
        }),
        payload: { ...next, byAccountId: accountId, reason: "user" },
      });
    }
    const context = await readMessageContext(this.db.db, {
      orgId,
      accountId,
      senderName: input.senderName,
      browser: { timeZone: input.timeZone, locale: input.locale },
      im: input.im,
      timeZoneOverride: internal.timeZoneOverride,
    });
    events.push(
      this.userMessage(accountId, input, extra, blocks, invoked, context, internal.schedule),
    );
    const { events: written, fresh } = await this.eventLog.appendInReport(conversationId, events);
    const message = written.at(-1) as ConversationEvent;
    // the run this message starts is owed with it: the direct ensureRun after the commit may never
    // happen (the process died) or fail (transactional outbox spec §6)
    if (fresh.at(-1) === true) await this.runs.oweEnsureRun(conversationId, message.seq, orgId);
    const skips =
      fresh.at(-1) === true
        ? await this.skipWaitsIn(conversationId, accountId, message.seq)
        : { skipped: NO_REPLY_SKIPS, toSeq: null };
    if (next !== null) {
      const t = this.db.db;
      // the cache follows the log (a retried message's switch may be an old, deduped event that a
      // later switch already replaced), read under the row lock append took
      await t
        .updateTable("conversations")
        .set({ selection: JSON.stringify(await readSelection(t, conversationId)) })
        .where("id", "=", conversationId)
        .execute();
    }
    return { events: written, skipped: skips.skipped, skippedToSeq: skips.toSeq };
  }

  /**
   * Renders the message's skill invocation (phase D), or undefined when it has none. Resolved
   * against the agent's current version and, for an existing conversation, its trial drafts.
   */
  private async prepareSkill(
    orgId: string,
    agentId: string,
    conversationId: string | undefined,
    agent: AgentDefinition,
    input: Pick<UserMessageInput, "skill" | "text">,
  ): Promise<RenderedInvocation | undefined> {
    if (input.skill === undefined) return undefined;
    return this.invoker.prepare({
      orgId,
      agentId,
      ...(conversationId !== undefined && { conversationId }),
      agent,
      name: input.skill.name,
      args: input.text,
    });
  }

  /**
   * Renders a queued message's skill invocation now (phase D Task 9), by the direct send's rules,
   * against the agent's current version and the conversation's trial drafts; undefined without
   * `skill`. The queue stores the result and sends it unchanged later.
   */
  async prepareQueuedSkill(
    orgId: string,
    conv: ConversationView,
    accountId: string,
    input: Pick<UserMessageInput, "skill" | "text">,
  ): Promise<RenderedInvocation | undefined> {
    if (input.skill === undefined) return undefined;
    const agent = await this.agents.get(orgId, conv.agentId, accountId);
    return this.prepareSkill(orgId, conv.agentId, conv.id, agent.definition, input);
  }

  /**
   * Reads the `@` resources with the sender's credentials (nothing when there are none). Shared
   * with the queue, which reads them when a message is queued (decision 15).
   */
  async resolveExtra(
    orgId: string,
    accountId: string,
    input: Pick<UserMessageInput, "attachments">,
  ): Promise<ResolvedExtra> {
    const refs = input.attachments ?? [];
    if (refs.length === 0) return { blocks: [], attachments: [] };
    return this.content.resolveAttachments(orgId, accountId, refs);
  }

  /** Binds uploaded files inside the message's (or queue item's) transaction; none → no blocks. */
  @Transactional({ propagation: "mandatory" })
  async bindIn(
    orgId: string,
    conversationId: string,
    accountId: string,
    files: readonly string[],
  ): Promise<LogContentBlock[]> {
    if (files.length === 0) return [];
    return this.attachments.bindForMessage(orgId, conversationId, accountId, files);
  }

  private userMessage(
    accountId: string,
    input: UserMessageInput,
    extra: ResolvedExtra,
    fileBlocks: LogContentBlock[],
    invoked: RenderedInvocation | undefined,
    context: MessageContext,
    schedule?: ScheduleMarker,
  ): AppendEvent {
    // a skill invocation's rendered text replaces the typed arguments as content[0]
    const text = invoked?.text ?? input.text;
    return {
      type: "user_message",
      ...(input.clientMessageId !== undefined && {
        idemKey: userMessageIdemKey(input.clientMessageId),
      }),
      payload: {
        // 只发附件时（text 为空）不写空文本块（供应商不接受空文本）；带 `@` 资源时 text 一定非空（content[0]）
        content: [
          ...(text === "" ? [] : [{ type: "text" as const, text }]),
          ...extra.blocks,
          ...fileBlocks,
        ],
        ...(extra.attachments.length > 0 && { attachments: extra.attachments }),
        authorAccountId: accountId,
        ...context,
        ...(input.clientMessageId !== undefined && { clientMessageId: input.clientMessageId }),
        ...(input.retryOf !== undefined && { retryOf: input.retryOf }),
        ...(invoked !== undefined && { skill: invoked.skill }),
        ...(schedule !== undefined && { schedule }),
      },
    };
  }

  /**
   * 中止会话当前的运行（queued / running / waiting）：返回 runId；没有 → `run.not_active`。
   * 等人处理的运行没有 worker：直接取消等待并写终态。其余经 Redis 广播，运行所在的任意副本都会收到；
   * 运行已是孤儿（没有任何 worker 在执行）时直接写终态。
   *
   * A root conversation's stop stops only its own run: its background sub-agents keep working
   * (agent map spec §6). A sub-agent's conversation (its owner, from the agent map) stops that
   * sub-agent with every descendant (`RunControl.stopTree`); `run.not_active` when nothing in that
   * subtree runs, else the sub-agent's latest run id.
   */
  async abort(orgId: string, conversationId: string, accountId: string): Promise<string> {
    const conv = await this.get(orgId, conversationId, accountId);
    if (conv.parentConversationId !== null) {
      const latest = await this.db
        .selectFrom("runs")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      const n = await this.runs.stopTree(conversationId, accountId);
      if (n === 0 || !latest) throw new ApiError("run.not_active", "No active run to abort");
      return latest.id;
    }
    const run = await this.db
      .selectFrom("runs")
      .select(["id", "status"])
      .where("conversation_id", "=", conversationId)
      .where("status", "in", ["queued", "running", "waiting"])
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    if (!run) throw new ApiError("run.not_active", "No active run to abort");
    const runs = this.runs;
    // 等待中：直接结束；没成功（刚被续跑、已回到 queued）则按下面的常规路径中止。
    // the stop's terminal transaction owed the ensure-run backstop; the direct call starts what
    // waited for the stopped run now
    if (run.status === "waiting" && (await runs.abortWaiting(conversationId, run.id, accountId))) {
      await runs.ensureRunAfterCommit(conversationId);
      return run.id;
    }
    // a queued run no worker has started yet is ended in PG (ruling R27), never left to the stop
    // marker's TTL: the marker first, so a worker that takes it meanwhile stops too
    if (run.status === "queued") {
      await runs.requestAbort(run.id, accountId);
      if (await runs.abortQueued(conversationId, run.id, accountId)) {
        await runs.ensureRunAfterCommit(conversationId);
      }
      return run.id;
    }
    // 孤儿运行没有 worker 在听中止广播：直接写成 aborted，之后再看有没有等待中的消息要起新一轮。
    if (await runs.abortIfOrphaned(conversationId, run.id, accountId)) {
      await runs.ensureRunAfterCommit(conversationId);
      return run.id;
    }
    await runs.requestAbort(run.id, accountId);
    return run.id;
  }
}
