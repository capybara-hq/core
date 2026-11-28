import { randomUUID } from "node:crypto";
import type { ConversationSource, TriggerSubject } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { AgentLookup, visibleTo } from "../agents/agent-lookup.js";
import { avatarView } from "../agents/avatar-view.js";
import type { AgentDefinition, ModelRef } from "../agents/definition.js";
import type { AgentAvatar, AgentAvatarView } from "../agents/profile.js";
import type { AutomationEventMarker, ScheduleMarker } from "../automations/types.js";
import { unbindConversation } from "../channels/threads.js";
import type { ConversationSubject, TitleSource } from "../db/kernel-schema.js";
import { oweConversationDeletedNotice } from "../device-access/conversation-notices.js";
import {
  ConversationDevices,
  type NewConversationDevice,
} from "../devices/conversation-devices.js";
import { DeviceProjectFilesService } from "../devices/device-project-files.service.js";
import { DeviceProjectsService } from "../devices/device-projects.service.js";
import { projectFilePath } from "../devices/project-paths.js";
import { clipped } from "../devices/project-rules.js";
import { ApiError } from "../errors.js";
import { LibraryFilesService } from "../files/library-files.service.js";
import { loadPeople, type PersonRef } from "../identity/account-avatar.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import {
  TransactionHost,
  withTransactionFencePrelude,
} from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { projectSkillOf } from "../runtime/context/project-root.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { RunControl as RunControlService } from "../runtime/run-control.js";
import { RunDeletion } from "../runtime/run-deletion.js";
import { rootConversationOf } from "../runtime/subagents/child.js";
import { PermissionCeilingWrites } from "../sandbox/permission-ceiling-writes.js";
import { permissionScopeHash } from "../sandbox/permission-facts.js";
import { revokeSharesIn } from "../shares/revoke.js";
import { type RenderedInvocation, SkillInvoker } from "../skills/invoke.js";
import { type ApprovalRecord, ApprovalsService } from "../tools/approvals.service.js";
import {
  attachmentMeta,
  ConnectorContent,
  type ReadResource,
  resourceBlockText,
} from "../tools/connector-content.js";
import { MentionableConnectorsService } from "../tools/mentionable-connectors.js";
import { type QuestionRecord, QuestionsService } from "../tools/questions.service.js";
import { READ_RESOURCE } from "../tools/resources.js";
import { ConversationAccess, parentReachable } from "./access.js";
import { type AgentTreeNode, readAgentTree } from "./agent-tree.js";
import { conversationRefText, REF_TURN_MESSAGES, refMessageText } from "./conversation-ref.js";
import { type AppendEvent, EventLog } from "./event-log.js";
import { peopleOfEvents } from "./event-people.js";
import { type ConversationEvent, type LogContentBlock, refFileId } from "./events.js";
import { userMessageIdemKey } from "./idem-keys.js";
import {
  connectorMentionText,
  fileLine,
  foldLabel,
  type InlineEntry,
  MENTION_LOAD_MAX_TOOLS,
  type MessageToken,
  numberLabels,
  placeholder,
  renderInline,
  tokenEntityKey,
} from "./inline-tokens.js";
import {
  type ImSenderContext,
  type MessageContext,
  readMessageContext,
} from "./message-context.js";
import type { PermissionSelection } from "./permission-profiles.schemas.js";
import { PermissionProfilesService } from "./permission-profiles.service.js";
import {
  NO_SELECTION,
  planSelection,
  readSelection,
  type Selection,
  sameSelection,
} from "./selection.js";
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
  /** The automation that created it (a `new`-mode task's run); null otherwise (spec §4). */
  automationId: string | null;
  /**
   * The event subject it serves (a `subject`-mode automation's conversation, collaboration spec
   * §4.5): the emitting extension and the subject; null for any other conversation.
   */
  subject: ConversationSubject | null;
  /**
   * The device project it is bound to (project root spec §4.3: chosen at creation, never
   * changed), as resolved then: its name and absolute path on the device; null in free mode (a
   * sub-agent's is null too: it works in its root conversation's).
   */
  project: { name: string; path: string } | null;
  /**
   * The latest `project_root` snapshot of its log (project root spec §4.7), however far back:
   * `loaded` with whether the project's `AGENTS.md` was found, or the reason the project is
   * `unavailable`; null when no run start has recorded one (a free conversation, a bound one before
   * its first run). Single-conversation responses compute it; the list queries carry null.
   */
  projectState: ProjectState | null;
  /**
   * What the latest run is doing: `running` (queued or running), `waiting` (an approval or a
   * question), else null. Only the list queries compute it; other responses carry null.
   */
  activity: "running" | "waiting" | null;
}

/** The state a conversation's latest `project_root` event records ({@link ConversationView}). */
export type ProjectState =
  | { loaded: true; agentsMd: boolean }
  | { unavailable: "gone" | "outside_mode" | "unreadable" | "unsupported" | "removed" };

/**
 * SQL for the {@link ProjectState} of the conversation row aliased/named `ref` (a correlated
 * subquery on the latest `project_root` event, served by `conversation_events_project_root_idx`).
 */
function projectStateSql(ref: string) {
  const id = sql.ref(`${ref}.id`);
  return sql<ProjectState | null>`(
    SELECT CASE
      WHEN pe.payload ? 'unavailable'
        THEN jsonb_build_object('unavailable', pe.payload->'unavailable'->>'reason')
      ELSE jsonb_build_object('loaded', true, 'agentsMd', pe.payload ? 'agentsMd') END
    FROM capybara.conversation_events pe
    WHERE pe.conversation_id = ${id} AND pe.type = 'project_root'
    ORDER BY pe.seq DESC LIMIT 1
  )`;
}

/** The columns of a single-conversation response: {@link COLUMNS} and its project state. */
const viewColumns = () =>
  [...COLUMNS, projectStateSql("conversations").as("project_state")] as const;

/** Escapes `\`, `%` and `_` so user text is matched literally by `LIKE … ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * SQL for the activity of the conversation row aliased/named `ref` (a correlated subquery).
 * A run waiting on its sub-agents (status waiting with `wait_expires_at`, set only for a
 * `subagents` wait) is still working, so it reports `running`; only a wait for a person
 * (approval, input) reports `waiting`. An idle compact run is not activity (idle compaction spec
 * §6: quiet): the latest other run decides.
 */
function activitySql(ref: string) {
  const id = sql.ref(`${ref}.id`);
  return sql<"running" | "waiting" | null>`(
    SELECT CASE
      WHEN lr.status IN ('queued', 'running') THEN 'running'
      WHEN lr.status = 'waiting' AND lr.wait_expires_at IS NOT NULL THEN 'running'
      WHEN lr.status = 'waiting' THEN 'waiting' END
    FROM capybara.runs lr
    WHERE lr.conversation_id = ${id} AND lr.compact_origin IS DISTINCT FROM 'idle'
    ORDER BY lr.created_at DESC, lr.id DESC LIMIT 1
  )`;
}

/**
 * An agent as the conversation lists carry it: its name and the avatar half of its profile, in the
 * agents API's shape (the web draws it without reading the agents list).
 */
export interface ConversationAgent {
  id: string;
  name: string;
  profile: { avatar: AgentAvatarView; updatedAt: string };
}

/** A {@link ConversationAgent} from an agent row and its current definition's name. */
function toConversationAgent(r: {
  id: string;
  name: string | null;
  profile_avatar: unknown;
  profile_updated_at: Date;
}): ConversationAgent {
  return {
    id: r.id,
    name: r.name ?? "",
    profile: {
      avatar: avatarView(r.profile_avatar as AgentAvatar),
      updatedAt: r.profile_updated_at.toISOString(),
    },
  };
}

/** One row of {@link ConversationsService.listMine}: the conversation and its agent. */
export interface ConversationListRow extends ConversationView {
  /** Null only when the agent stopped being visible between the page read and the agent read. */
  agent: ConversationAgent | null;
}

/** One agent's group in the sidebar list: the caller's newest conversations with that agent. */
export interface ConversationGroup {
  agent: ConversationAgent;
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
  /** The pending questions that are watched waits (`InputRequired.watch`): a subset of the above. */
  watchedQuestionIds: string[];
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
   * A manual compaction run (context compaction spec §4.7): the compact run already queued/running,
   * or a new one; `conversation.busy` while an ordinary run is active.
   */
  startCompaction(conversationId: string, accountId: string): Promise<string>;
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

/**
 * Resolved `@` resources and referenced project files: the blocks after the user text (the
 * resources' bodies, then one text block per project file) and their metadata. A message with
 * `tokens` (composer inline tokens spec §3) also gets its rendered text, where its placeholders
 * stand, its connector mentions and its file tokens.
 */
export interface ResolvedExtra {
  blocks: { type: "text"; text: string }[];
  /**
   * The text with each token marker replaced by its placeholder (a skill invocation's trimmed
   * arguments); absent: the message has no tokens and its text is used as typed.
   */
  text?: string;
  /** Where each placeholder stands in {@link text} (`payload.inline`, display only). */
  inline?: InlineEntry[];
  /** The connectors the message names (`payload.connectorMentions`), in block order. */
  connectorMentions?: ConnectorMention[];
  /** The library files the message's file tokens name, in text order, before the uploads. */
  fileTokenIds?: string[];
  /** The label of each file (file tokens and uploads), numbered across them (spec §3.2). */
  fileLabels?: Map<string, string>;
  /** The resources' metadata in the user_message (payload fields `appId` / `appName`, C27). */
  attachments: { appId: string; appName: string; uri: string; name: string }[];
  /** The referenced project files (normalized paths), in block order; absent: none. */
  projectFiles?: { path: string }[];
  /** The project root the project file blocks name (set with `projectFiles`). */
  projectRoot?: string;
  /**
   * The referenced conversations (@ conversations spec §2), in block order after the project
   * files' blocks; absent: none.
   */
  conversationRefs?: ConversationRefMeta[];
}

/** One connector a message names, as `payload.connectorMentions` records it (spec §3.5). */
export interface ConnectorMention {
  connectorId: string;
  slug: string;
  name: string;
  /** The agent's offered tools of it at send time. */
  toolCount: number;
  /**
   * Its offered tool keys when it offers at most 20 (else empty), loaded from this message on when
   * a step runs with tool search (inert without it).
   */
  loadedTools: string[];
}

/** Where the agent's tools are resolved for a message that names connectors or resources. */
export interface MessageAgentContext {
  agent: AgentDefinition;
  source: ConversationSource;
  /** The conversation the step's sandbox tools follow; absent for a conversation being created. */
  sandboxConversationId?: string | undefined;
}

/** One referenced conversation as `payload.conversationRefs` names it. */
export interface ConversationRefMeta {
  id: string;
  /** The title at send time; null: untitled. */
  title: string | null;
  /** `summary`: built from its latest compaction summary; `excerpt`: from its last messages. */
  source: "summary" | "excerpt";
  /** The highest seq read from it. */
  upToSeq: number;
}

export { MAX_PROJECT_FILES } from "../devices/device-project-files.service.js";

/** Where a message's project files are checked: the conversation's device and bound project. */
export interface ProjectFilesTarget {
  /** The conversation being written in (a reference to it is refused); absent: a new one. */
  conversationId?: string | undefined;
  deviceId: string | null;
  project: { name: string; path: string } | null | undefined;
  /** Stops the check on the device (the request's signal: the client hung up). */
  signal?: AbortSignal | undefined;
}

/**
 * The model-visible text of one referenced project file (composer menus §5): English, logged in
 * the `user_message`, so replay rebuilds it from the log as it is.
 */
export const projectFileText = (path: string, root: string): string =>
  `Referenced project file: ${path} (in the project root ${root}; read it with Read when needed).`;

/** The files a message attaches, in block order: its file tokens' files, then its uploads. */
const messageFiles = (
  input: Pick<UserMessageInput, "files">,
  extra: Pick<ResolvedExtra, "fileTokenIds">,
): string[] => {
  const tokens = extra.fileTokenIds ?? [];
  return [...tokens, ...uploadsBeside(input.files ?? [], tokens)];
};

/** A message's uploads without the files its file tokens already name (attached once). */
const uploadsBeside = (uploads: readonly string[], fileTokenIds: readonly string[]): string[] => {
  const named = new Set(fileTokenIds);
  return uploads.filter((id) => !named.has(id));
};

/**
 * The files' blocks with a `[file: <label>]` text block before each media block (composer inline
 * tokens spec §3.3), so the model reads which file each one is (an image is sent bare). A file
 * with no given label is labelled by its name, numbered after the given labels.
 */
export function withFileLines(
  blocks: readonly LogContentBlock[],
  labels?: ReadonlyMap<string, string>,
): LogContentBlock[] {
  const given = labels ?? new Map<string, string>();
  const numbered = numberLabels([
    ...[...given].map(([id, label]) => ({ key: id, label })),
    ...blocks.flatMap((b) =>
      (b.type === "image" || b.type === "document" || b.type === "file") && b.source.kind === "ref"
        ? [{ key: refFileId(b.source), label: foldLabel(b.name ?? "") }]
        : [],
    ),
  ]);
  return blocks.flatMap((b) =>
    (b.type === "image" || b.type === "document" || b.type === "file") && b.source.kind === "ref"
      ? [
          {
            type: "text" as const,
            text: fileLine(
              given.get(refFileId(b.source)) ?? numbered.get(refFileId(b.source)) ?? "",
            ),
          },
          b,
        ]
      : [b],
  );
}

/**
 * A referenced conversation that cannot be referenced (422, `details: [{ id, reason? }]`): one
 * code and one message for every case, so another person's conversation reads as a missing one.
 */
const conversationRefUnavailable = (details: { id: string; reason?: "empty" }[]): ApiError =>
  new ApiError(
    "conversation.reference_unavailable",
    details.every((d) => d.reason === "empty")
      ? "A referenced conversation has no messages yet; remove it and send again"
      : "A referenced conversation is not available; remove it and send again",
    details,
  );

/** A message's project file that cannot be referenced (422, `details: [{ path }]` or `reason`). */
const projectFileUnavailable = (message: string, details: unknown[]): ApiError =>
  new ApiError("conversation.project_file_unavailable", message, details);

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
  "automation_id",
  "subject",
  "project_name",
  "project_path",
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
  automation_id: string | null;
  subject: ConversationSubject | null;
  project_name: string | null;
  project_path: string | null;
  activity?: "running" | "waiting" | null;
  project_state?: ProjectState | null;
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
    automationId: r.automation_id,
    subject:
      r.subject === null
        ? null
        : {
            source: r.subject.source,
            kind: r.subject.kind,
            id: r.subject.id,
            title: r.subject.title,
          },
    project:
      r.project_name !== null && r.project_path !== null
        ? { name: r.project_name, path: r.project_path }
        : null,
    projectState: r.project_state ?? null,
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
  /**
   * Inline tokens (composer inline tokens spec §3.1), one U+FFFC in `text` each, in order:
   * connectors, connector resources, library files, project files and conversations.
   */
  tokens?: MessageToken[];
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
 * Message options only kernel callers pass (an automation's fire, scheduled tasks spec §6), never
 * an HTTP body: the schedule marker or the event marker (collaboration spec §4.6) the
 * `user_message` carries, and a zone that beats every other source of the message's `timeZone`
 * (`readMessageContext`).
 */
export interface InternalMessageOptions {
  initialPermission?: PermissionSelection;
  /** The request's signal: the project file check on the device stops when the client hangs up. */
  signal?: AbortSignal;
  createRequestHash?: string;
  schedule?: ScheduleMarker;
  automationEvent?: AutomationEventMarker;
  timeZoneOverride?: string;
}

/** Options of a conversation created by a kernel caller (never an HTTP body). */
export interface NewConversationOptions {
  /**
   * Where it comes from (memory plugin spec §6.2), fixed at creation. Required: a channel or group
   * conversation that fell back to `web` would be offered what only the web and DMs may see.
   */
  source: ConversationSource;
  /**
   * The event subject a `subject`-mode automation's conversation serves (collaboration spec §4.5):
   * `subject` of the subject's trigger events and the emitting extension (`source`), fixed at
   * creation (`conversations.subject`).
   */
  subject?: TriggerSubject & { source: string };
}

/** `conversations.subject` as stored: the four fields, never the subject's link. */
function storedSubject(s: (TriggerSubject & { source: string }) | undefined): string | null {
  return s === undefined
    ? null
    : JSON.stringify({ source: s.source, kind: s.kind, id: s.id, title: s.title });
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
    @Inject(PermissionProfilesService)
    private readonly permissions: Pick<PermissionProfilesService, "initialize" | "lockInitial">,
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
    private readonly content: Pick<ConnectorContent, "readResources">,
    /** Attaches the sender's library files to the conversation in the message's transaction. */
    @Inject(LibraryFilesService)
    private readonly libraryFiles: Pick<
      LibraryFilesService,
      "attachForMessage" | "labelsFor" | "checkMessageFileCount"
    >,
    /** Renders a person's skill invocation (phase D). */
    @Inject(SkillInvoker) private readonly invoker: Pick<SkillInvoker, "prepare">,
    /** Stops a deleted conversation's background tasks. */
    @Inject(RunDeletion)
    private readonly deletion: Pick<RunDeletion, "stopTree">,
    /** The device a new conversation is bound to (environments spec §4.1 item 1). */
    @Inject(ConversationDevices)
    private readonly devices: Pick<ConversationDevices, "forNew">,
    /** The project of that device a new conversation is bound to (project root design §4.3). */
    @Inject(DeviceProjectsService)
    private readonly projects: Pick<DeviceProjectsService, "resolveForBinding">,
    /** Checks a message's referenced project files on the device (composer menus §5). */
    @Inject(DeviceProjectFilesService)
    private readonly projectFiles: Pick<DeviceProjectFilesService, "statAll">,
    /** A starter's message skips the run's pending questions (reply-while-question spec §8.1). */
    @Inject(QuestionsService)
    private readonly questions: Pick<QuestionsService, "skipPendingIn">,
    /** ... and its pending network asks (network ask-to-allow spec §6.7). */
    @Inject(ApprovalsService)
    private readonly approvals: Pick<ApprovalsService, "skipNetworkIn">,
    @Inject(KernelEvents) private readonly events: Pick<KernelEvents, "emit">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
    /** Owes the snapshot deletions of the shares a deletion revokes (file sharing spec §9). */
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    /** The agent's tools for a message naming connectors or resources (inline tokens §3.4). */
    @Inject(MentionableConnectorsService)
    private readonly mentions: Pick<MentionableConnectorsService, "resolveForMessage">,
  ) {}

  /**
   * Creates an empty conversation bound to its device (`pick`, see
   * {@link ConversationDevices.forNew}); an agent the account cannot use →
   * `agent.not_found`, a device it may not use → `device.not_found` /
   * `device.unavailable`, and nothing is created. `pick.project` binds it to one of that device's
   * projects ({@link bindingFor}), refused as that says. `opts.source` records where the
   * conversation comes from.
   */
  @Transactional()
  async create(
    orgId: string,
    accountId: string,
    agentId: string,
    pick: NewConversationDevice = {},
    opts: NewConversationOptions,
  ): Promise<ConversationView> {
    await this.agents.get(orgId, agentId, accountId);
    const deviceId = await this.devices.forNew(orgId, accountId, pick);
    const project = await this.bindingFor(orgId, accountId, deviceId, pick.project);
    const row = await this.db
      .insertInto("conversations")
      .values({
        id: randomUUID(),
        org_id: orgId,
        agent_id: agentId,
        account_id: accountId,
        device_id: deviceId,
        project_name: project?.name ?? null,
        project_path: project?.path ?? null,
        source: opts.source,
        subject: storedSubject(opts.subject),
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
   * `internal`: the conversation's source and, for kernel callers only, an automation's marker,
   * which also sets `conversations.automation_id`, and its zone override. `pick.project` binds
   * the conversation to one of its device's projects inside the write ({@link bindingFor}); a
   * retry answers with the conversation the first send created, its binding unchanged.
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
    const requestHash = internal.initialPermission
      ? permissionScopeHash({ agentId, input, pick, permission: internal.initialPermission })
      : undefined;
    if (requestHash) internal = { ...internal, createRequestHash: requestHash };
    const agent = await this.agents.get(orgId, agentId, accountId);
    const prior = await this.findCreated(
      orgId,
      accountId,
      agentId,
      input.clientMessageId,
      requestHash,
    );
    if (prior) return prior;
    const deviceId = await this.devices.forNew(orgId, accountId, pick);
    const next = await this.planSwitch(orgId, agent.definition, NO_SELECTION, input);
    // the project its files are checked in, or its project skill is rendered from, read before the
    // write (the binding inside it decides)
    const project =
      input.tokens?.some((t) => t.type === "projectFile") === true ||
      (input.skill !== undefined && projectSkillOf(input.skill.name) !== undefined)
        ? await this.bindingFor(orgId, accountId, deviceId, pick.project)
        : undefined;
    const extra = await this.resolveExtra(
      orgId,
      accountId,
      input,
      { deviceId, project, signal: internal.signal },
      // no sandbox conversation yet: the row is written after the resolution (its id with it), so
      // the device-bound builtins are listed as for a conversation without one; a connector's
      // tools never depend on it, only the tool search threshold's count may
      { agent: agent.definition, source: internal.source },
    );
    const invoked = await this.prepareSkill(
      orgId,
      accountId,
      agentId,
      { conversationId: undefined, deviceId, ...(project !== undefined && { project }) },
      agent.definition,
      { ...(input.skill !== undefined && { skill: input.skill }), text: extra.text ?? input.text },
    );
    const id = randomUUID();
    let all: ConversationEvent[] | undefined;
    try {
      all = await this.createIn(
        { id, orgId, accountId, agentId, deviceId, project: pick.project },
        input,
        next,
        extra,
        invoked,
        internal,
      );
    } catch (e) {
      // a concurrent first send with this id created the conversation while this one resolved its
      // binding: a refusal here (the project just went away) answers with what the first created
      if (!(e instanceof ApiError)) throw e;
      const raced = await this.findCreated(
        orgId,
        accountId,
        agentId,
        input.clientMessageId,
        requestHash,
      );
      if (!raced) throw e;
      return raced;
    }
    const written = all?.at(-1);
    if (!all || !written) {
      const raced = await this.findCreated(
        orgId,
        accountId,
        agentId,
        input.clientMessageId,
        requestHash,
      );
      if (!raced) throw new ApiError("conflict", "The conversation is being created; retry");
      return raced;
    }
    await this.eventLog.notify(id, written.seq);
    await this.startRun(id);
    return {
      conversation: await this.rowView(orgId, id),
      event: written,
      events: all,
      created: true,
    };
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
      /** The project name to bind ({@link bindingFor}); undefined: free mode. */
      project: string | undefined;
    },
    input: UserMessageInput & { clientMessageId: string },
    next: Selection | null,
    extra: ResolvedExtra,
    invoked: RenderedInvocation | undefined,
    internal: InternalMessageOptions & NewConversationOptions,
  ): Promise<ConversationEvent[] | undefined> {
    const { id, orgId, accountId } = conv;
    if (internal.initialPermission) await this.permissions.lockInitial(orgId, id, conv.deviceId);
    const project = await this.bindingFor(orgId, accountId, conv.deviceId, conv.project);
    // the project changed since its files were checked: the blocks would name another root
    if (extra.projectRoot !== undefined && extra.projectRoot !== project?.path) {
      throw new ApiError("conflict", "The project changed while the message was sent; retry");
    }
    const row = await this.db
      .insertInto("conversations")
      .values({
        id,
        org_id: orgId,
        agent_id: conv.agentId,
        account_id: accountId,
        device_id: conv.deviceId,
        project_name: project?.name ?? null,
        project_path: project?.path ?? null,
        create_request_id: input.clientMessageId,
        create_request_hash: internal.createRequestHash ?? null,
        automation_id: internal.schedule?.taskId ?? internal.automationEvent?.automationId ?? null,
        source: internal.source,
        subject: storedSubject(internal.subject),
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
    const initialEvents = internal.initialPermission
      ? await this.permissions.initialize(
          orgId,
          id,
          accountId,
          conv.deviceId,
          project?.path ?? null,
          project?.name ?? null,
          internal.initialPermission,
        )
      : [];
    const blocks = await this.bindIn(
      orgId,
      id,
      accountId,
      messageFiles(input, extra),
      extra.fileLabels,
    );
    // a new conversation has no run yet, so nothing to skip
    const written = await this.writeMessage(
      orgId,
      id,
      accountId,
      input,
      next,
      extra,
      blocks,
      invoked,
      internal,
    );
    return [...initialEvents, ...written.events];
  }

  /**
   * The project a new conversation binds to (project root design §4.3): `name` resolved against
   * the chosen device's projects by `DeviceProjectsService.resolveForBinding`, which reads only and
   * checks the owner and the device's current mode (refused with `device.not_found`,
   * `device.projects_unsupported`, `device.project_not_found` or `device.project_outside_mode`).
   * Called inside the transaction that writes the conversation. A conversation without a device
   * (no default device provider on in the org, an anonymous IM sender) cannot have one. Undefined
   * name: free mode.
   */
  private async bindingFor(
    orgId: string,
    accountId: string,
    deviceId: string | null,
    name: string | undefined,
  ): Promise<{ name: string; path: string } | undefined> {
    if (name === undefined) return undefined;
    if (deviceId === null) {
      throw new ApiError(
        "device.projects_unsupported",
        "This conversation has no device, so it cannot be bound to a project; choose one of your devices, or start it without a project",
      );
    }
    return this.projects.resolveForBinding(orgId, deviceId, accountId, name);
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
    requestHash?: string,
  ): Promise<{
    conversation: ConversationView;
    event: ConversationEvent;
    events: ConversationEvent[];
    created: false;
  } | null> {
    const row = await this.db
      .selectFrom("conversations")
      .select(viewColumns())
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .select("create_request_hash")
      .where("create_request_id", "=", clientMessageId)
      .where("kind", "=", "chat")
      .executeTakeFirst();
    if (!row) return null;
    if (
      row.agent_id !== agentId ||
      (requestHash !== undefined && row.create_request_hash !== requestHash)
    ) {
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

  private async rowView(orgId: string, id: string): Promise<ConversationView> {
    return toView(
      await this.db
        .selectFrom("conversations")
        .select(viewColumns())
        .where("id", "=", id)
        .where("org_id", "=", orgId)
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
      .where("org_id", "=", orgId)
      .returning(viewColumns())
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
      .where("org_id", "=", orgId)
      .returning(viewColumns())
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
    // Close entrances before the direct stop. The outbox owes the same claim-revoking cleanup.
    // The root authority lock is the transaction's ordered prelude: inside a run's fence (a
    // Platform call) it follows the org row and precedes the conversation rows
    const subject = await this.deletionSubject(orgId, conversationId);
    await withTransactionFencePrelude(
      () => this.ceilings.lock(subject, "root"),
      () => this.markDeleted(orgId, conversationId, accountId, subject),
    );
    await this.deletion.stopTree(conversationId, accountId);
    await this.eventLog.publishChanged(conversationId, "deleted");
  }

  /** The authority subject a deletion locks: the tree's root and its device, read without locks. */
  private async deletionSubject(
    orgId: string,
    conversationId: string,
  ): Promise<{ orgId: string; rootConversationId: string; deviceId?: string }> {
    const binding = await this.db
      .selectFrom("conversations")
      .select(["device_id", "parent_conversation_id"])
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!binding) throw notFound();
    // Root deletion closes the whole tree; a child is fenced through its actual root's authority.
    let rootId = conversationId,
      parent = binding.parent_conversation_id;
    for (let depth = 0; parent && depth < 16; depth++) {
      const ancestor = await this.db
        .selectFrom("conversations")
        .select(["id", "parent_conversation_id"])
        .where("id", "=", parent)
        .where("org_id", "=", orgId)
        .executeTakeFirstOrThrow();
      rootId = ancestor.id;
      parent = ancestor.parent_conversation_id;
    }
    if (parent) throw notFound();
    const root = await this.db
      .selectFrom("conversations")
      .select("device_id")
      .where("id", "=", rootId)
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow();
    return {
      orgId,
      rootConversationId: rootId,
      ...(root.device_id ? { deviceId: root.device_id } : {}),
    };
  }

  // the publish happens after the commit, in the caller; the tree stop after it is owed here
  // (transactional outbox spec §6), so a process that dies before it still stops the tree
  @Transactional()
  private async markDeleted(
    orgId: string,
    conversationId: string,
    accountId: string,
    locked: { orgId: string; rootConversationId: string; deviceId?: string },
  ): Promise<void> {
    // the prelude locked `locked`; a root or device that changed since is not covered by it
    const subject = await this.deletionSubject(orgId, conversationId);
    if (
      subject.rootConversationId !== locked.rootConversationId ||
      subject.deviceId !== locked.deviceId
    )
      throw new ApiError("conflict", "The conversation's device changed; retry the deletion");
    await this.ceilings.lock(subject, "root");
    await this.ceilings.publishLocked(
      subject,
      "root",
      (_scope, intent) =>
        conversationId === subject.rootConversationId || intent.conversation_id === conversationId,
    );
    const row = await this.db
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound();
    await this.db
      .updateTable("conversations")
      .set({ deleted_at: sql<Date>`now()` })
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .execute();
    await this.runs.oweStopDeletedTree(conversationId, accountId, orgId);
    // Queued messages must not start a run on a deleted conversation
    await this.db
      .deleteFrom("conversation_queue")
      .where("conversation_id", "=", conversationId)
      .execute();
    await unbindConversation(this.db.db, conversationId);
    // its shares stop with it and their snapshots are owed for deletion (file sharing spec §9);
    // a share being created waits on the row lock above (`FOR SHARE`) and then finds it deleted
    await revokeSharesIn(this.db.db, { conversationId }, "conversation_deleted");
    // the device's services (the browser's tabs) forget the conversation: the notice is owed here
    // and delivered by the worker, an offline device's once it is back (close tabs on delete §4)
    if (subject.deviceId)
      await oweConversationDeletedNotice(this.db.db, this.outbox, {
        orgId,
        deviceId: subject.deviceId,
        conversationId,
      });
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
      .select([...viewColumns(), "kind"])
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
   * My conversations, most recently updated first; only those whose agent is in this org, not
   * deleted and visible to me. `after` is the previous page's last conversation id, continued after
   * its current (updated_at, id); a cursor that no longer exists gives an empty page. Each row
   * carries its agent (one batch read for the page). With `total`, also counts every conversation
   * matching the same filters (the cursor aside) in the same statement.
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
      total?: boolean;
    },
  ): Promise<{ conversations: ConversationListRow[]; total?: number }> {
    let q = this.db
      .selectFrom("conversations")
      .select(COLUMNS)
      .select(activitySql("conversations").as("activity"))
      // The total of every match, computed before LIMIT in this same statement. It costs
      // O(matches) (the window reads every matching row instead of stopping at the page), which
      // is why only the first page asks for it.
      .$if(opts.total === true, (qb) => qb.select(sql<string>`count(*) OVER ()`.as("total_count")))
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
            .where("agents.org_id", "=", orgId)
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
    const rows = await q.execute();
    const agents = await this.listAgents(orgId, accountId, [
      ...new Set(rows.map((r) => r.agent_id)),
    ]);
    const conversations = rows.map((r) => ({
      ...toView(r),
      agent: agents.get(r.agent_id) ?? null,
    }));
    if (opts.total !== true) return { conversations };
    return { conversations, total: Number(rows[0]?.total_count ?? 0) };
  }

  /**
   * The agents of `ids` that are in this org, not deleted and visible to the viewer, by id, in one
   * statement (the same visibility as the agents read path).
   */
  private async listAgents(
    orgId: string,
    viewerAccountId: string,
    ids: string[],
  ): Promise<Map<string, ConversationAgent>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("agents")
      .innerJoin("agent_versions as v", (j) =>
        j.onRef("v.agent_id", "=", "agents.id").onRef("v.version", "=", "agents.current_version"),
      )
      .select([
        "agents.id",
        "agents.profile_avatar",
        "agents.profile_updated_at",
        sql<string | null>`v.definition ->> 'name'`.as("name"),
      ])
      .where("agents.id", "in", ids)
      .where("agents.org_id", "=", orgId)
      .where("agents.deleted_at", "is", null)
      .where(visibleTo(viewerAccountId))
      .execute();
    return new Map(rows.map((r) => [r.id, toConversationAgent(r)]));
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
      automation_id: string | null;
      subject: ConversationSubject | null;
      subagent_type: string | null;
      archived_at: Date | null;
      device_id: string | null;
      project_name: string | null;
      project_path: string | null;
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
        cs.archived_at, cs.device_id, cs.automation_id, cs.subject, cs.project_name, cs.project_path,
        cs.activity
      FROM page
      JOIN capybara.agents a ON a.id = page.agent_id
      JOIN capybara.agent_versions v ON v.agent_id = a.id AND v.version = a.current_version
      CROSS JOIN LATERAL (
        SELECT c.id, c.org_id, c.account_id, c.title, c.title_source, c.selection, c.last_seq,
          c.created_at, c.updated_at, c.parent_conversation_id, c.subagent_type,
          c.archived_at, c.device_id, c.automation_id, c.subject, c.project_name, c.project_path,
          ${activitySql("c")} AS activity
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
          agent: toConversationAgent({
            id: r.agent_id,
            name: r.agent_name,
            profile_avatar: r.profile_avatar,
            profile_updated_at: r.profile_updated_at,
          }),
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
            WHERE c2.id = ${opts.after} AND c2.org_id = ${orgId}
              AND c2.parent_conversation_id = ${conversationId}
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
      watched_question_ids: string[];
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
          ORDER BY q.created_at, q.id) AS question_ids,
        ARRAY(SELECT q.id FROM capybara.questions q
          WHERE q.conversation_id = c.id AND q.status = 'pending' AND q.expires_at > now()
            AND (q.spec->>'watch')::boolean IS TRUE
          ORDER BY q.created_at, q.id) AS watched_question_ids
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
        watchedQuestionIds: r.watched_question_ids,
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

  /** The `people` sidecar of an events response: every account the events name (read time). */
  eventPeople(events: readonly ConversationEvent[]): Promise<Record<string, PersonRef>> {
    return peopleOfEvents(this.db.db, events);
  }

  /** The person behind an account id; null when the account is gone. */
  async person(accountId: string): Promise<PersonRef | null> {
    return (await loadPeople(this.db.db, [accountId])).get(accountId) ?? null;
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
   * Appends a user message; a repeated send with the same `clientMessageId` returns the same
   * event. After the write it calls `ensureRun`: with no run in progress it enqueues one; during
   * a run the current run takes the message in between steps, or `ensureRun` runs again when it
   * ends. A failed `ensureRun` is logged, not thrown: the message's transaction owes the ensure-run
   * backstop, which starts the run once the queue is reachable (transactional outbox spec §6).
   *
   * `tokens` (composer inline tokens spec §3): resolved as the sender before the write
   * ({@link resolveExtra}): each marker becomes its placeholder in `content[0]`, the referenced
   * blocks (resources, project files, conversations, connector mentions) follow it, and
   * `payload.inline` / `connectorMentions` record them. Any refusal writes nothing; a repeated send
   * with the same `clientMessageId` returns the written event without resolving again.
   *
   * `files` (uploaded attachment ids): checked and bound to this conversation in the transaction
   * that writes the event (see {@link BindFiles}) and appended last as image / document reference
   * blocks, each after its `[file: <name>]` line; any unavailable file writes nothing. The log
   * holds only references, never bytes. With empty `text` (files only: the HTTP layer ensures
   * `files` and no tokens then) no text block of the person's is written.
   */
  async postUserMessage(
    orgId: string,
    conversationId: string,
    accountId: string,
    input: UserMessageInput,
    /** The request's signal: the project file check on the device stops when the client hangs up. */
    signal?: AbortSignal,
  ): Promise<ConversationEvent> {
    const conv = await this.writable(orgId, conversationId, accountId);
    // A retry returns the written event before resolving today's model or resources.
    if (input.clientMessageId !== undefined) {
      const existing = await this.eventLog.findByIdem(
        conversationId,
        userMessageIdemKey(input.clientMessageId),
      );
      if (existing) {
        await this.startRun(conversationId);
        return existing;
      }
    }
    const namesConnectors =
      input.tokens?.some((t) => t.type === "connector" || t.type === "resource") === true;
    const needsAgent =
      input.model !== undefined ||
      input.effort !== undefined ||
      input.skill !== undefined ||
      namesConnectors;
    const agent = needsAgent
      ? (await this.agents.get(orgId, conv.agentId, accountId)).definition
      : undefined;
    const extra = await this.resolveExtra(
      orgId,
      accountId,
      input,
      { ...conv, conversationId, signal },
      agent !== undefined && namesConnectors
        ? {
            agent,
            source: await this.sourceOf(orgId, conversationId),
            sandboxConversationId: conversationId,
          }
        : undefined,
    );
    const invoked =
      agent === undefined
        ? undefined
        : await this.prepareSkill(
            orgId,
            accountId,
            conv.agentId,
            { conversationId, deviceId: conv.deviceId },
            agent,
            {
              ...(input.skill !== undefined && { skill: input.skill }),
              text: extra.text ?? input.text,
            },
          );
    // one transaction: the sender, time zone and language are read with the message's write
    // (run context spec §3.2)
    let current = conv.selection;
    let posted: { event: ConversationEvent; skipped: ReplySkips; toSeq: number } | undefined;
    let next: Selection | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      next = agent === undefined ? null : await this.planSwitch(orgId, agent, current, input);
      const result = await this.postIn(
        orgId,
        conversationId,
        accountId,
        input,
        next,
        extra,
        invoked,
        input.model !== undefined || input.effort !== undefined ? current : undefined,
      );
      if ("selection" in result) {
        current = result.selection;
        continue;
      }
      posted = result;
      break;
    }
    if (posted === undefined) {
      throw new ApiError("conflict", "The conversation selection changed; send the message again");
    }
    const { event, skipped, toSeq } = posted;
    await this.eventLog.notify(conversationId, toSeq);
    await this.announceSkipped(skipped);
    if (next !== null) await this.eventLog.publishChanged(conversationId, "selection");
    // The message is written: it brings an archived conversation back into the default lists
    if (conv.archivedAt !== null) {
      await this.db
        .updateTable("conversations")
        .set({ archived_at: null })
        .where("id", "=", conversationId)
        .where("org_id", "=", orgId)
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
    expectedSelection: Selection | undefined,
  ): Promise<
    { event: ConversationEvent; skipped: ReplySkips; toSeq: number } | { selection: Selection }
  > {
    // Serialize the partial pick with the append. Provider resolution runs outside this
    // transaction; if another send changed the selection, revalidate its model before retrying.
    const row = await this.db
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound();
    if (expectedSelection !== undefined) {
      const selection = await readSelection(this.db.db, conversationId);
      if (!sameSelection(expectedSelection, selection)) return { selection };
    }

    const blocks = await this.bindIn(
      orgId,
      conversationId,
      accountId,
      messageFiles(input, extra),
      extra.fileLabels,
    );
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
    events.push(this.userMessage(accountId, input, extra, blocks, invoked, context, internal));
    const { events: written, fresh } = await this.eventLog.appendInReport(conversationId, events);
    const message = written.at(-1) as ConversationEvent;
    // the run this message starts is owed with it: the direct ensureRun after the commit may never
    // happen (the process died) or fail (transactional outbox spec §6)
    if (fresh.at(-1) === true) await this.runs.oweEnsureRun(conversationId, message.seq, orgId);
    // the files this message attached were first referred to by it (a queued message's files keep
    // a null `first_seq`: they were attached when queued, before the message had a seq)
    const fileIds = blocks.flatMap((b) =>
      (b.type === "image" || b.type === "document" || b.type === "file") && b.source.kind === "ref"
        ? [refFileId(b.source)]
        : [],
    );
    if (fileIds.length > 0) {
      await this.db.db
        .updateTable("conversation_files")
        .set({ first_seq: message.seq })
        .where("org_id", "=", orgId)
        .where("conversation_id", "=", conversationId)
        .where("file_id", "in", fileIds)
        .where("first_seq", "is", null)
        .execute();
    }
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
        .where("org_id", "=", orgId)
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
    accountId: string,
    agentId: string,
    /**
     * The conversation (absent before it is created), its device (its skills root) and, before it
     * is created, the project it is created bound to.
     */
    where: {
      conversationId: string | undefined;
      deviceId: string | null;
      project?: { name: string; path: string };
    },
    agent: AgentDefinition,
    input: Pick<UserMessageInput, "skill" | "text">,
  ): Promise<RenderedInvocation | undefined> {
    if (input.skill === undefined) return undefined;
    const { conversationId, deviceId, project } = where;
    return this.invoker.prepare({
      orgId,
      agentId,
      accountId,
      ...(conversationId !== undefined && { conversationId }),
      ...(project !== undefined && { project }),
      deviceId,
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
    return this.prepareSkill(
      orgId,
      accountId,
      conv.agentId,
      { conversationId: conv.id, deviceId: conv.deviceId },
      agent.definition,
      input,
    );
  }

  /** Resolves what a message's tokens reference before it is written ({@link resolveTokens}). */
  async resolveExtra(
    orgId: string,
    accountId: string,
    input: Pick<UserMessageInput, "text" | "tokens" | "files" | "skill">,
    target?: ProjectFilesTarget,
    /** Where the agent's tools are resolved; required when the tokens name connectors or resources. */
    agentContext?: MessageAgentContext,
  ): Promise<ResolvedExtra> {
    if (input.tokens !== undefined) {
      return this.resolveTokens(orgId, accountId, input, input.tokens, target, agentContext);
    }
    return { blocks: [], attachments: [] };
  }

  /**
   * {@link resolveExtra} for a message with tokens (composer inline tokens spec §3), as the sender,
   * outside any transaction; any refusal writes nothing. Each entity is resolved once however
   * often its token repeats: project file paths are normalized first (a path leaving the project →
   * `device.path_outside_project` before anything is read), then the connectors named and the
   * resources' connectors against the agent's tools in one resolution
   * ({@link MentionableConnectorsService.resolveForMessage}: `conversation.connector_unavailable`),
   * the project files and the referenced conversations as without tokens, the resources last
   * ({@link ConnectorContent.readResources}; one whose `read_resource` the agent is not offered →
   * `connector.resources_disabled`), and the files' names. Labels are numbered per kind in text
   * order (file tokens before uploads); each marker becomes its placeholder in the text (the trimmed
   * arguments of a skill invocation, where `inline` then points). Blocks, in order: resources,
   * project files, conversations, connector mentions; the files' blocks follow in the write.
   */
  private async resolveTokens(
    orgId: string,
    accountId: string,
    input: Pick<UserMessageInput, "text" | "files" | "skill">,
    tokens: readonly MessageToken[],
    target: ProjectFilesTarget | undefined,
    agentContext: MessageAgentContext | undefined,
  ): Promise<ResolvedExtra> {
    // keyed first: a project file path leaving the project is refused before anything is read
    const keyed = tokens.map((t) => ({ t, key: tokenEntityKey(t) }));
    const distinct = <K extends MessageToken["type"]>(kind: K) => {
      const seen = new Set<string>();
      return keyed.flatMap(({ t, key }) => {
        if (t.type !== kind || seen.has(key)) return [];
        seen.add(key);
        return [t as Extract<MessageToken, { type: K }>];
      });
    };
    const named = distinct("connector").map((t) => t.connectorId);
    const resourceRefs = distinct("resource").map(({ connectorId, uri }) => ({ connectorId, uri }));
    const paths = [...new Set(distinct("projectFile").map((t) => projectFilePath(t.path)))];
    const conversationIds = distinct("conversation").map((t) => t.id);
    const fileTokenIds = distinct("file").map((t) => t.id);
    // a file both named by a token and uploaded is attached once, as the token
    const uploads = uploadsBeside(input.files ?? [], fileTokenIds);
    // the per-message file cap, before anything remote is read (attaching checks it again)
    this.libraryFiles.checkMessageFileCount(fileTokenIds.length + uploads.length);

    // the agent's tools first (the database only), then the checks as without tokens, the
    // resources (remote reads) last
    let resolved:
      | Awaited<ReturnType<MentionableConnectorsService["resolveForMessage"]>>
      | undefined;
    if (named.length > 0 || resourceRefs.length > 0) {
      if (agentContext === undefined) {
        throw new Error("resolveTokens: connector or resource tokens need the agent's context");
      }
      resolved = await this.mentions.resolveForMessage(
        orgId,
        agentContext.agent,
        {
          source: agentContext.source,
          sandboxConversationId: agentContext.sandboxConversationId,
        },
        named,
      );
    }
    const toolSearch = resolved?.toolSearch === true;
    const mentioned = resolved?.connectors ?? [];
    const files = await this.checkProjectFiles(
      orgId,
      accountId,
      paths.map((path) => ({ path })),
      target,
    );
    const conversations = await this.readConversationRefs(
      orgId,
      accountId,
      conversationIds.map((id) => ({ id })),
      target?.conversationId,
    );
    const read: ReadResource[] =
      resolved === undefined || resourceRefs.length === 0
        ? []
        : await this.content.readResources(
            orgId,
            accountId,
            resourceRefs,
            new Set(
              resolved.tools.flatMap((t) =>
                t.source.kind === "connector" &&
                t.source.resources === true &&
                t.source.name === READ_RESOURCE
                  ? [t.source.connectorId]
                  : [],
              ),
            ),
          );
    const fileNames = await this.libraryFiles.labelsFor(orgId, accountId, [
      ...fileTokenIds,
      ...uploads,
    ]);

    // labels, numbered per kind in text order
    const connectorName = new Map<string, string>([
      ...mentioned.map((c) => [c.id, c.name] as const),
      ...read.map((r) => [r.connectorId, r.connectorName] as const),
    ]);
    const connectorLabels = numberLabels(
      keyed.flatMap(({ t }) =>
        t.type === "connector" || t.type === "resource"
          ? [
              {
                key: t.connectorId,
                label: foldLabel(connectorName.get(t.connectorId) ?? t.connectorId),
              },
            ]
          : [],
      ),
    );
    const resourceName = new Map(read.map((r) => [`resource:${r.connectorId}:${r.uri}`, r.name]));
    const conversationTitle = new Map(
      conversations.map((c) => [`conversation:${c.meta.id}`, c.meta.title]),
    );
    const labelOfKey = (t: MessageToken, key: string): string => {
      switch (t.type) {
        case "connector":
          return foldLabel(connectorName.get(t.connectorId) ?? t.connectorId);
        case "resource":
          return foldLabel(resourceName.get(key) ?? t.uri);
        case "file":
          return foldLabel(fileNames.get(t.id) ?? t.id);
        case "projectFile":
          return foldLabel(key.slice("projectFile:".length));
        case "conversation":
          return foldLabel(conversationTitle.get(key) ?? "") || "Untitled conversation";
      }
    };
    // numbered per kind (each kind has its own placeholder), file tokens before uploads
    const kindLabels = new Map<string, string>();
    for (const kind of ["resource", "file", "projectFile", "conversation"] as const) {
      const items = [
        ...keyed
          .filter(({ t }) => t.type === kind)
          .map(({ t, key }) => ({ key, label: labelOfKey(t, key) })),
        ...(kind === "file"
          ? uploads.map((id) => ({ key: `file:${id}`, label: foldLabel(fileNames.get(id) ?? id) }))
          : []),
      ];
      for (const [k, v] of numberLabels(items)) kindLabels.set(k, v);
    }
    const labelOf = (t: MessageToken): string =>
      t.type === "connector"
        ? (connectorLabels.get(t.connectorId) ?? t.connectorId)
        : (kindLabels.get(tokenEntityKey(t)) ?? "");
    const connectorLabelOf = (id: string): string => connectorLabels.get(id) ?? id;
    const rendered = renderInline(
      input.skill === undefined ? input.text : input.text.trim(),
      // `inline` names a project file by its normalized path
      tokens.map((t) => (t.type === "projectFile" ? { ...t, path: projectFilePath(t.path) } : t)),
      labelOf,
      connectorLabelOf,
    );

    const connectorMentions: ConnectorMention[] = mentioned.map((c) => {
      const keys = c.tools.map((t) => t.key);
      return {
        connectorId: c.id,
        slug: c.slug,
        name: c.name,
        toolCount: keys.length,
        // recorded whatever the send-time tool search state: request building reads the loaded
        // keys only under tool search, so they are inert when a step has it off
        loadedTools: keys.length <= MENTION_LOAD_MAX_TOOLS ? keys : [],
      };
    });
    const blocks = [
      ...read.map((r) =>
        resourceBlockText(
          r,
          placeholder(
            "resource",
            kindLabels.get(`resource:${r.connectorId}:${r.uri}`) ?? r.name,
            connectorLabelOf(r.connectorId),
          ),
        ),
      ),
      ...(files?.paths ?? []).map(
        (path) =>
          `${placeholder("projectFile", kindLabels.get(`projectFile:${path}`) ?? path)} ${projectFileText(path, files?.root ?? "")}`,
      ),
      ...conversations.map(
        (c) =>
          `${placeholder("conversation", kindLabels.get(`conversation:${c.meta.id}`) ?? "")}\n${c.text}`,
      ),
      ...mentioned.map((c) =>
        connectorMentionText({
          label: connectorLabelOf(c.id),
          name: foldLabel(c.name),
          slug: c.slug,
          toolCount: c.tools.length,
          toolSearch,
        }),
      ),
    ].map((text) => ({ type: "text" as const, text }));
    const fileLabels = new Map(
      [...fileTokenIds, ...uploads].map((id) => [id, kindLabels.get(`file:${id}`) ?? id]),
    );
    return {
      blocks,
      text: rendered.text,
      inline: rendered.inline,
      connectorMentions,
      fileTokenIds,
      fileLabels,
      attachments: read.map(attachmentMeta),
      ...(files !== undefined && {
        projectFiles: files.paths.map((path) => ({ path })),
        projectRoot: files.root,
      }),
      ...(conversations.length > 0 && { conversationRefs: conversations.map((c) => c.meta) }),
    };
  }

  /** The conversation's source (where it comes from: web, IM, an automation). */
  private async sourceOf(orgId: string, conversationId: string): Promise<ConversationSource> {
    const row = await this.db
      .selectFrom("conversations")
      .select("source")
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow();
    return row.source as ConversationSource;
  }

  /**
   * {@link resolveExtra}'s referenced conversations (@ conversations spec §1), read as the sender
   * outside any transaction, once each in the body's order. Each must be the sender's own chat in
   * this org, not deleted, its agent still visible ({@link readable} plus `kind = 'chat'`); any
   * other → `conversation.reference_unavailable` (`details: [{ id }]`, the same for every case);
   * one with no `user_message` yet → the same code with `reason: "empty"`; the conversation
   * being written in → `conversation.reference_self`.
   */
  private async readConversationRefs(
    orgId: string,
    accountId: string,
    refs: readonly { id: string }[],
    selfId: string | undefined,
  ): Promise<{ text: string; meta: ConversationRefMeta }[]> {
    if (refs.length === 0) return [];
    const ids = [...new Set(refs.map((r) => r.id))];
    if (selfId !== undefined && ids.includes(selfId)) {
      throw new ApiError(
        "conversation.reference_self",
        "A message cannot reference the conversation it is written in; remove that reference",
        [{ id: selfId }],
      );
    }
    const refused: { id: string; reason?: "empty" }[] = [];
    const read: { text: string; meta: ConversationRefMeta }[] = [];
    for (const id of ids) {
      const one = await this.readConversationRef(orgId, accountId, id);
      if (one === "unavailable") refused.push({ id });
      else if (one === "empty") refused.push({ id, reason: "empty" });
      else read.push(one);
    }
    // the unavailable ones first: a client reads the first detail's reason for its copy
    if (refused.length > 0) {
      throw conversationRefUnavailable([
        ...refused.filter((r) => r.reason === undefined),
        ...refused.filter((r) => r.reason !== undefined),
      ]);
    }
    return read;
  }

  /** One referenced conversation's block and metadata, or why it cannot be referenced. */
  private async readConversationRef(
    orgId: string,
    accountId: string,
    id: string,
  ): Promise<{ text: string; meta: ConversationRefMeta } | "unavailable" | "empty"> {
    const row = await this.db
      .selectFrom("conversations")
      .select(["id", "title", "agent_id", "updated_at"])
      .select(activitySql("conversations").as("activity"))
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("deleted_at", "is", null)
      // a sub-agent's or an eval replay conversation is never referenced
      .where("kind", "=", "chat")
      .executeTakeFirst();
    if (!row) return "unavailable";
    let agentName: string;
    try {
      agentName = (await this.agents.get(orgId, row.agent_id, accountId)).definition.name;
    } catch (e) {
      if (e instanceof ApiError && e.code === "agent.not_found") return "unavailable";
      throw e;
    }
    // the latest summary (conversation_events_compaction_summary_idx), then the newest messages
    // after what it covers
    const summary = await this.db
      .selectFrom("conversation_events")
      .select(["seq", sql<unknown>`payload`.as("payload")])
      .where("conversation_id", "=", id)
      .where("type", "=", "compaction_summary")
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    const summaryPayload = summary?.payload as { coversUpToSeq: number; text: string } | undefined;
    const rows = await this.db
      .selectFrom("conversation_events")
      .select(["seq", "type", sql<unknown>`payload`.as("payload")])
      .where("conversation_id", "=", id)
      .where("type", "in", ["user_message", "assistant_message"])
      // only messages with text count toward the cap (a run's tool-only steps carry none)
      .where(sql<boolean>`payload -> 'content' @> '[{"type":"text"}]'::jsonb`)
      .where("seq", ">", String(summaryPayload?.coversUpToSeq ?? 0))
      .orderBy("seq", "desc")
      .limit(REF_TURN_MESSAGES)
      .execute();
    // nothing to quote: no summary and no message of the person yet (a long run's text replies may
    // fill the newest rows, and a files-only message has no text, so the log is asked when they
    // hold none)
    if (summary === undefined && !rows.some((r) => r.type === "user_message")) {
      const anyUser = await this.db
        .selectFrom("conversation_events")
        .select("seq")
        .where("conversation_id", "=", id)
        .where("type", "=", "user_message")
        .limit(1)
        .executeTakeFirst();
      if (anyUser === undefined) return "empty";
    }
    const messages = rows
      .slice()
      .reverse()
      .map((r) => ({
        role: r.type === "user_message" ? ("user" as const) : ("assistant" as const),
        text: refMessageText(r.type, r.payload),
      }))
      .filter((m) => m.text !== "");
    const upToSeq = Math.max(Number(rows[0]?.seq ?? 0), Number(summary?.seq ?? 0));
    return {
      text: conversationRefText({
        id,
        title: row.title,
        agentName,
        lastActiveAt: row.updated_at,
        running: row.activity === "running",
        summary: summaryPayload?.text ?? null,
        messages,
      }),
      meta: {
        id,
        title: row.title,
        source: summary === undefined ? "excerpt" : "summary",
        upToSeq,
      },
    };
  }

  /** {@link resolveExtra}'s project file check: the normalized paths and the root, or none. */
  private async checkProjectFiles(
    orgId: string,
    accountId: string,
    refs: readonly { path: string }[],
    target: ProjectFilesTarget | undefined,
  ): Promise<{ paths: string[]; root: string } | undefined> {
    if (refs.length === 0) return undefined;
    const project = target?.project;
    if (!project || target?.deviceId == null) {
      throw projectFileUnavailable(
        "This conversation has no device project, so it cannot reference project files; start it in a project",
        [{ reason: "no_project" }],
      );
    }
    // normalized first (a path leaving the project is refused before the device is asked), once each
    const paths = [...new Set(refs.map((r) => projectFilePath(r.path)))];
    const { missing } = await this.projectFiles.statAll(
      { orgId, accountId, deviceId: target.deviceId },
      project.path,
      paths,
      target.signal,
    );
    if (missing.length > 0) {
      throw projectFileUnavailable(
        `${clipped(missing[0] as string)} is not a file in the project ${project.name}; pick it again`,
        // the whole normalized path, so the composer can mark the token it came from
        missing.map((path) => ({ path })),
      );
    }
    return { paths, root: project.path };
  }

  /**
   * Attaches the sender's library files inside the message's (or queue item's) transaction
   * (`LibraryFilesService.attachForMessage`: drafts become ready, the conversation refers to each);
   * none → no blocks. The files join the conversation's files, so open pages read the list again
   * after the commit (`changed: files`, a hint).
   */
  @Transactional({ propagation: "mandatory" })
  async bindIn(
    orgId: string,
    conversationId: string,
    accountId: string,
    files: readonly string[],
    /** Each file's label (composer inline tokens spec §3.2); a file not in it: its name. */
    labels?: ReadonlyMap<string, string>,
  ): Promise<LogContentBlock[]> {
    if (files.length === 0) return [];
    const blocks = await this.libraryFiles.attachForMessage(
      orgId,
      conversationId,
      accountId,
      files,
    );
    afterCommit(() => this.eventLog.publishChanged(conversationId, "files"));
    return withFileLines(blocks, labels);
  }

  private userMessage(
    accountId: string,
    input: UserMessageInput,
    extra: ResolvedExtra,
    fileBlocks: LogContentBlock[],
    invoked: RenderedInvocation | undefined,
    context: MessageContext,
    markers: Pick<InternalMessageOptions, "schedule" | "automationEvent"> = {},
  ): AppendEvent {
    const { schedule, automationEvent } = markers;
    // a skill invocation's rendered text replaces the typed arguments as content[0]; tokens
    // put their placeholders into the text
    const text = invoked?.text ?? extra.text ?? input.text;
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
        ...(extra.projectFiles !== undefined &&
          extra.projectFiles.length > 0 && { projectFiles: extra.projectFiles }),
        ...(extra.conversationRefs !== undefined &&
          extra.conversationRefs.length > 0 && { conversationRefs: extra.conversationRefs }),
        ...(extra.connectorMentions !== undefined &&
          extra.connectorMentions.length > 0 && { connectorMentions: extra.connectorMentions }),
        ...(extra.inline !== undefined && extra.inline.length > 0 && { inline: extra.inline }),
        authorAccountId: accountId,
        ...context,
        ...(input.clientMessageId !== undefined && { clientMessageId: input.clientMessageId }),
        ...(input.retryOf !== undefined && { retryOf: input.retryOf }),
        ...(invoked !== undefined && { skill: invoked.skill }),
        ...(schedule !== undefined && { schedule }),
        ...(automationEvent !== undefined && { automationEvent }),
      },
    };
  }

  /**
   * Aborts the conversation's current run (queued / running / waiting): returns its runId; none →
   * `run.not_active`. A run waiting for a person has no worker: its wait is cancelled and its end
   * written here. Any other is broadcast through Redis, reaching whichever replica runs it; an
   * orphaned run (no worker executing it) gets its end written directly.
   *
   * A root conversation's stop stops everything below it too (agent map spec §6, changed in
   * acceptance 2026-11-13: after a person stops, the conversation stays stopped). In order:
   * 1. `tree_stopped_at` is set on the root under its row lock: by the stopped run's terminal
   *    transaction (a waiting, queued or orphaned run), before the stop is asked for (a run a
   *    worker holds, which is active until then), or on its own (nothing of the root ran). From
   *    then on no sub-agent delivery wakes the root (`wakeDecisionIn`) and no
   *    sub-agent of the tree starts a run by a wake or a parent's message (`RunQueue.childWakeIn`),
   *    until the root next starts a run (a person's message, the queue, a background Bash task's
   *    finish), which clears it. A child that finishes just before or after the stop, `completed`
   *    or `aborted`, thus never wakes the root; its delivery stays in the log and reaches the
   *    model with the next run;
   * 2. (with 1) the root's own active run stops as before ({@link abortRootRun});
   * 3. every active sub-agent run of the tree stops (`RunControl.stopTree`, as the agent map's stop
   *    and the deletion do), with the background tasks of every sub-agent. A sub-agent the root's
   *    run dispatched after that read is stopped when the root run ends
   *    (`Waits.stopDescendantsOfStopped`).
   * The root's own background Bash tasks keep running: they are the conversation's tasks, stopped
   * with `TaskStop` or the task list. `run.not_active` when neither the root nor its tree had an
   * active run (the stop still holds the tree's wakes); else the root's run id (its latest when only
   * sub-agents ran).
   *
   * A sub-agent's conversation (its owner, from the agent map) stops that sub-agent with every
   * descendant (`RunControl.stopTree`); `run.not_active` when nothing in that subtree runs, else
   * the sub-agent's latest run id. Its `aborted` finish never wakes its parent.
   */
  async abort(orgId: string, conversationId: string, accountId: string): Promise<string> {
    const conv = await this.get(orgId, conversationId, accountId);
    const latest = () =>
      this.db
        .selectFrom("runs")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .orderBy("created_at", "desc")
        .executeTakeFirst();
    if (conv.parentConversationId !== null) {
      const last = await latest();
      const n = await this.runs.stopTree(conversationId, accountId);
      if (n === 0 || !last) throw new ApiError("run.not_active", "No active run to abort");
      return last.id;
    }
    const stopped = await this.abortRootRun(conversationId, accountId);
    // nothing of the root's ran: the hold is the stop's own write
    if (stopped === null) await this.holdTree(conversationId);
    const n = await this.runs.stopTree(conversationId, accountId, { includeSelf: false });
    if (stopped !== null) return stopped;
    const last = await latest();
    if (n === 0 || !last) throw new ApiError("run.not_active", "No active run to abort");
    return last.id;
  }

  /**
   * Manual compaction (context compaction spec §4.7): starts a compact run for the caller's own
   * chat conversation, or returns the compact run already queued/running. Eval conversations and
   * other people's are `conversation.not_found`; a sub-agent's is `conversation.read_only`; while
   * an ordinary run is active the run start is `conversation.busy`.
   */
  async compact(orgId: string, conversationId: string, accountId: string): Promise<string> {
    await this.writable(orgId, conversationId, accountId);
    return this.runs.startCompaction(conversationId, accountId);
  }

  /**
   * Marks a person's stop of the root's tree (`tree_stopped_at`, see {@link abort}); committed
   * before any stop, so every wake decided after it (under the root's row lock) sees it.
   */
  // org-filter: conversationId was checked by get(orgId, ...) in abort, the only entry point
  @Transactional()
  private async holdTree(conversationId: string): Promise<void> {
    await this.db
      .updateTable("conversations")
      .set({ tree_stopped_at: sql<Date>`now()` })
      .where("id", "=", conversationId)
      .execute();
  }

  /**
   * Stops a root conversation's own active run (queued / running / waiting) and returns its id;
   * null when none is active. Its sub-agents are the caller's. The tree's hold
   * (`tree_stopped_at`) is written by the stopped run's terminal transaction (`RunFinish.finishIn`
   * for a run a person stopped), in the lock order every stop and decision takes (conversation,
   * decided row, run); a run a worker holds is marked before its stop is asked for as well.
   */
  private async abortRootRun(conversationId: string, accountId: string): Promise<string | null> {
    const run = await this.db
      .selectFrom("runs")
      .select(["id", "status"])
      .where("conversation_id", "=", conversationId)
      .where("status", "in", ["queued", "running", "waiting"])
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    if (!run) return null;
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
    // a run a worker holds ends later: the hold is written now, before the stop is asked for,
    // while the run is still active (no wake can start the root before it), and again by its
    // terminal transaction
    await this.holdTree(conversationId);
    await runs.requestAbort(run.id, accountId);
    // the suspend handshake (`WaitsService.suspend`): a run that became `waiting` after the read
    // above may have checked the marker before it was set and ended its job, so nobody hears the
    // broadcast; check `waiting` again after setting the marker and end it as a waiting run
    const now = await this.db
      .selectFrom("runs")
      .select("status")
      .where("id", "=", run.id)
      .executeTakeFirst();
    if (now?.status === "waiting" && (await runs.abortWaiting(conversationId, run.id, accountId))) {
      await runs.ensureRunAfterCommit(conversationId);
    }
    return run.id;
  }
}
