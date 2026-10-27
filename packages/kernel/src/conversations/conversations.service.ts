import { randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { type ExpressionBuilder, sql, type Transaction } from "kysely";
import { type AgentsService, visibleTo } from "../agents/agents.service.js";
import type { AgentDefinition, ModelRef } from "../agents/definition.js";
import type { KernelDatabase, KernelDb, TitleSource } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { ProviderRegistry } from "../runtime/providers.js";
import type { RenderedInvocation, SkillInvoker } from "../skills/invoke.js";
import type { AppendEvent, EventLog } from "./event-log.js";
import type { ConversationEvent, LogContentBlock } from "./events.js";
import {
  NO_SELECTION,
  planSelection,
  readSelection,
  type Selection,
  sameModel,
  sameSelection,
} from "./selection.js";

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
}

/** One agent's group in the sidebar list: the caller's newest conversations with that agent. */
export interface ConversationGroup {
  agent: { id: string; name: string };
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

/** 会话服务用到的运行控制：投递运行（RunQueue）与跨副本中止（RunAbort）。 */
export interface RunControl {
  /** 有未消费的消息且没有进行中的运行时投递一轮运行；返回 runId 或 null。 */
  ensureRun(conversationId: string): Promise<string | null>;
  /**
   * 运行是孤儿（会话锁空闲、任务已不存在，没有 worker 会收到中止广播）时直接把它写成 aborted，返回 true；
   * 否则返回 false。
   */
  abortIfOrphaned(conversationId: string, runId: string, byAccountId: string): Promise<boolean>;
  /**
   * 运行在等人处理（waiting）时直接中止：取消等待、写 `run_aborted`、删除 checkpoint，返回 true；
   * 运行已不是 waiting（例如刚被续跑）→ false。
   */
  abortWaiting(conversationId: string, runId: string, byAccountId: string): Promise<boolean>;
  /** 请求中止运行（广播到所有副本）。 */
  requestAbort(runId: string, byAccountId: string): Promise<void>;
}

/** 消息附件引用（连接器 + 资源 URI）。 */
export interface AttachmentRef {
  connectorId: string;
  uri: string;
}

/** 附件解析：以发送者的凭据读取资源，返回追加在消息后的文本块与元数据（见 tools/connector-content.ts）。 */
export type ResolveAttachments = (
  orgId: string,
  accountId: string,
  refs: AttachmentRef[],
) => Promise<ResolvedExtra>;

/** Resolved `@` resources: the blocks after the user text and their metadata. */
export interface ResolvedExtra {
  blocks: { type: "text"; text: string }[];
  /** 写进 user_message 的附件元数据：事件 payload 字段名仍为 `appId` / `appName`（C27）。 */
  attachments: { appId: string; appName: string; uri: string; name: string }[];
}

/**
 * 消息引用的上传附件（`files`）：在发消息的事务里校验并绑定到会话，返回写进 user_message 的媒体块
 * （`source: {kind: "ref"}`，见 AttachmentsService.bindForMessage）。
 */
export type BindFiles = (
  trx: Transaction<KernelDatabase>,
  orgId: string,
  conversationId: string,
  accountId: string,
  ids: readonly string[],
) => Promise<LogContentBlock[]>;

/**
 * 用户消息的幂等键：客户端的 `clientMessageId` 加前缀，与运行流水线自用的幂等键分开，
 * 避免客户端恰好选中内部键而命中别的事件。
 */
export const userMessageIdemKey = (clientMessageId: string): string => `msg:${clientMessageId}`;

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
  };
}

/** The longest conversation title (characters, after trimming). */
export const CONVERSATION_TITLE_MAX_CHARS = 120;

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
}

/**
 * A sub-agent's conversation is reached through its parent (sub-agents spec §6.1, review m6, the
 * same rule as its trajectory): the parent is a chat conversation of the same owner whose agent is
 * not deleted and still visible to the viewer. Any other kind passes. The child's own `agent_id`
 * (the dispatched agent for an org agent, §5.5) is checked on top by the callers.
 */
const parentReachable =
  (viewerAccountId: string) => (eb: ExpressionBuilder<KernelDatabase, "conversations">) =>
    eb.or([
      eb("conversations.kind", "<>", "subagent"),
      eb.exists(
        eb
          .selectFrom("conversations as p")
          .innerJoin("agents", "agents.id", "p.agent_id")
          .select(sql`1`.as("one"))
          .whereRef("p.id", "=", "conversations.parent_conversation_id")
          .whereRef("p.org_id", "=", "conversations.org_id")
          .where("p.account_id", "=", viewerAccountId)
          .where("p.kind", "=", "chat")
          .where("agents.deleted_at", "is", null)
          .where(visibleTo(viewerAccountId)),
      ),
    ]);

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
export class ConversationsService {
  constructor(
    private readonly db: KernelDb,
    private readonly eventLog: EventLog,
    private readonly agents: AgentsService,
    private readonly runs?: RunControl,
    private readonly log?: Pick<Logger, "warn">,
    private readonly resolveAttachments?: ResolveAttachments,
    private readonly bindFiles?: BindFiles,
    /** Resolves a switched-to model and its declared parameters (UI refresh B). */
    private readonly models?: Pick<ProviderRegistry, "resolve">,
    /** Renders a person's skill invocation (phase D); without it `skill` is refused. */
    private readonly invoker?: Pick<SkillInvoker, "prepare">,
  ) {}

  /**
   * 不阻塞地调用一次 `ensureRun`（打开 SSE、读事件时）：它幂等，并顺带清理孤儿运行，
   * 会话不会因为某次运行结束后的投递失败而永远停在「运行中」。失败只记日志。
   */
  kickRun(conversationId: string): void {
    if (!this.runs) return;
    this.runs
      .ensureRun(conversationId)
      .catch((err) =>
        this.log?.warn("ensureRun on conversation open failed", { conversationId, err }),
      );
  }

  /** 新建会话；agent 对该账号不可用 → `agent.not_found`。 */
  async create(orgId: string, accountId: string, agentId: string): Promise<ConversationView> {
    await this.agents.get(orgId, agentId, accountId);
    const row = await this.db
      .insertInto("conversations")
      .values({ id: randomUUID(), org_id: orgId, agent_id: agentId, account_id: accountId })
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
   */
  async createWithMessage(
    orgId: string,
    accountId: string,
    agentId: string,
    input: UserMessageInput & { clientMessageId: string },
  ): Promise<{ conversation: ConversationView; event: ConversationEvent; created: boolean }> {
    const agent = await this.agents.get(orgId, agentId, accountId);
    const prior = await this.findCreated(orgId, accountId, agentId, input.clientMessageId);
    if (prior) return prior;
    this.checkFilesSupported(input);
    const next = await this.planSwitch(agent.definition, NO_SELECTION, input);
    const extra = await this.resolveExtra(orgId, accountId, input);
    const invoked = await this.prepareSkill(orgId, agentId, undefined, agent.definition, input);
    const id = randomUUID();
    const written = await this.db.transaction().execute(async (t) => {
      const row = await t
        .insertInto("conversations")
        .values({
          id,
          org_id: orgId,
          agent_id: agentId,
          account_id: accountId,
          create_request_id: input.clientMessageId,
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
      const blocks = await this.bindIn(t, orgId, id, accountId, input.files ?? []);
      return this.writeMessage(t, id, accountId, input, next, extra, blocks, invoked);
    });
    if (!written) {
      const raced = await this.findCreated(orgId, accountId, agentId, input.clientMessageId);
      if (!raced) throw new ApiError("conflict", "The conversation is being created; retry");
      return raced;
    }
    await this.eventLog.notify(id, written.seq);
    await this.runs?.ensureRun(id);
    return { conversation: await this.rowView(id), event: written, created: true };
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
  ): Promise<{ conversation: ConversationView; event: ConversationEvent; created: false } | null> {
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
    await this.runs?.ensureRun(row.id);
    return { conversation: toView(row), event, created: false };
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

  /**
   * 轻量的可见性判定（一条查询，不加载 agent 视图），供长连接（SSE）建立时与定期复核用：
   * 会话属于该组织且归 viewer 所有、viewer 账号仍为 active、agent 未删除且对 viewer 仍可见
   * （`visibleTo` 已含「组织未删除、viewer 仍是成员」）。
   */
  async isAccessible(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom("conversations")
      .select("conversations.id")
      .where("conversations.id", "=", conversationId)
      .where("conversations.org_id", "=", orgId)
      .where("conversations.account_id", "=", viewerAccountId)
      .where("conversations.kind", "in", ["chat", "subagent"])
      .where(parentReachable(viewerAccountId))
      .where((eb) =>
        eb.and([
          eb.exists(
            eb
              .selectFrom("accounts")
              .select(sql`1`.as("one"))
              .where("accounts.id", "=", viewerAccountId)
              .where("accounts.status", "=", "active"),
          ),
          eb.exists(
            eb
              .selectFrom("agents")
              .select(sql`1`.as("one"))
              .whereRef("agents.id", "=", "conversations.agent_id")
              .where("agents.deleted_at", "is", null)
              .where(visibleTo(viewerAccountId)),
          ),
        ]),
      )
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * 我的会话，最近更新的在前；只含 agent 仍可用的会话。`after` 为上一页最后一个会话的 id，
   * 从它当前的 (updated_at, id) 之后继续；游标会话已不存在时返回空页。
   */
  async listMine(
    orgId: string,
    accountId: string,
    opts: { after?: string; limit: number; agentId?: string },
  ): Promise<ConversationView[]> {
    let q = this.db
      .selectFrom("conversations")
      .select(COLUMNS)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      // 评测回放的隐藏对话（kind = 'eval'）不在「我的对话」里
      .where("kind", "=", "chat")
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
    opts: { perGroup: number; limit: number; after?: string },
  ): Promise<{ groups: ConversationGroup[]; next: string | null }> {
    const visibleAgents = this.db
      .selectFrom("agents")
      .select("agents.id")
      .where("agents.org_id", "=", orgId)
      .where("agents.deleted_at", "is", null)
      .where(visibleTo(accountId));
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
      subagent_type: string | null;
    }>`
      WITH g AS (
        SELECT c.agent_id, max(c.updated_at) AS latest_at
        FROM capybara.conversations c
        WHERE c.org_id = ${orgId} AND c.account_id = ${accountId} AND c.kind = 'chat'
          AND c.agent_id IN ${visibleAgents}
        GROUP BY c.agent_id
      ), page AS (
        SELECT g.agent_id, g.latest_at FROM g
        ${cursor}
        ORDER BY g.latest_at DESC, g.agent_id DESC
        LIMIT ${opts.limit + 1}
      )
      SELECT page.agent_id, page.latest_at, v.definition ->> 'name' AS agent_name,
        cs.id, cs.org_id, cs.account_id, cs.title, cs.title_source, cs.selection, cs.last_seq,
        cs.created_at, cs.updated_at, cs.parent_conversation_id, cs.subagent_type
      FROM page
      JOIN capybara.agents a ON a.id = page.agent_id
      JOIN capybara.agent_versions v ON v.agent_id = a.id AND v.version = a.current_version
      CROSS JOIN LATERAL (
        SELECT c.id, c.org_id, c.account_id, c.title, c.title_source, c.selection, c.last_seq,
          c.created_at, c.updated_at, c.parent_conversation_id, c.subagent_type
        FROM capybara.conversations c
        WHERE c.org_id = ${orgId} AND c.account_id = ${accountId} AND c.kind = 'chat'
          AND c.agent_id = page.agent_id
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ${opts.perGroup + 1}
      ) cs
      ORDER BY page.latest_at DESC, page.agent_id DESC, cs.updated_at DESC, cs.id DESC
    `.execute(this.db);
    const groups: ConversationGroup[] = [];
    let current: ConversationGroup | undefined;
    for (const r of rows) {
      if (current?.agent.id !== r.agent_id) {
        current = {
          agent: { id: r.agent_id, name: r.agent_name ?? "" },
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
    return { groups: page, next };
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
    `.execute(this.db);
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
   * A conversation's token usage: its own `usage` events (compaction included) plus those of its
   * sub-agents (sub-agents spec §8.3), whose logs keep their own. Owner only, as {@link get}.
   */
  async usage(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
  ): Promise<UsageTotals> {
    if (!(await this.isAccessible(orgId, conversationId, viewerAccountId))) throw notFound();
    const { rows } = await sql<UsageRow>`${usageSums(
      sql`e.conversation_id IN (
        SELECT ${conversationId}::text
        UNION ALL
        SELECT c.id FROM capybara.conversations c
        WHERE c.parent_conversation_id = ${conversationId} AND c.kind = 'subagent'
      )`,
    )}`.execute(this.db);
    const row = rows[0];
    return row
      ? toUsage(row)
      : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }

  /**
   * The conversation whose sandbox `conversationId` works in: a sub-agent's is its parent's
   * (sub-agents spec §10.1), any other its own. Call only after an access check.
   */
  async sandboxConversationOf(orgId: string, conversationId: string): Promise<string> {
    const row = await this.db
      .selectFrom("conversations")
      .select("parent_conversation_id")
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    return row?.parent_conversation_id ?? conversationId;
  }

  /** 读事件（先做 `get` 的可见性判定）；顺带不阻塞地 {@link kickRun}。 */
  async listEvents(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
    afterSeq: number,
    limit: number,
  ): Promise<ConversationEvent[]> {
    await this.get(orgId, conversationId, viewerAccountId);
    this.kickRun(conversationId);
    return this.eventLog.readAfter(conversationId, afterSeq, limit);
  }

  /**
   * 追加一条用户消息；带 `clientMessageId` 时重复提交返回同一事件。写入后调用 `ensureRun`：
   * 没有进行中的运行时投递一轮；运行中则由当前运行在步骤间隙吸收，或在它结束时再次 `ensureRun`。
   * 投递失败时抛错（消息已写入；客户端带同一 `clientMessageId` 重试会再次触发投递）。
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
    this.checkFilesSupported(input);
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
        await this.runs?.ensureRun(conversationId);
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
        : await this.planSwitch(agent, conv.selection, input);
    const extra = await this.resolveExtra(orgId, accountId, input);
    const invoked =
      agent === undefined
        ? undefined
        : await this.prepareSkill(orgId, conv.agentId, conversationId, agent, input);
    let event: ConversationEvent | undefined;
    if (files.length > 0 || next !== null) {
      event = await this.db.transaction().execute(async (t) => {
        const blocks = await this.bindIn(t, orgId, conversationId, accountId, files);
        return this.writeMessage(t, conversationId, accountId, input, next, extra, blocks, invoked);
      });
      await this.eventLog.notify(conversationId, event.seq);
      if (next !== null) await this.eventLog.publishChanged(conversationId, "selection");
    } else {
      [event] = await this.eventLog.append(conversationId, [
        this.userMessage(accountId, input, extra, [], invoked),
      ]);
    }
    await this.runs?.ensureRun(conversationId);
    return event as ConversationEvent;
  }

  /**
   * The selection a message switches to, or null when it changes nothing. A model equal to the
   * agent's means "back to the agent's model" (null); a model change without `effort` resets the
   * effort. The target model must resolve (`agent.model_unavailable`) and declare the effort
   * (`validation_failed`). Resolving is the agent editor's check: providers are deployment-scoped
   * and serve chat models only. If per-org provider enablement is added, this check and the run
   * worker's `fallBackIfUnavailable` must follow it.
   */
  private async planSwitch(
    agent: AgentDefinition,
    current: Selection,
    input: Pick<UserMessageInput, "model" | "effort">,
  ): Promise<Selection | null> {
    const next = planSelection(agent.model, current, input);
    if (next === null) return null;
    const { model, effort } = next;
    if (!this.models) {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "model", message: "Model switching is not supported" },
      ]);
    }
    const { info } = await this.models.resolve(model ?? agent.model);
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
    await this.planSwitch(agent.definition, conv.selection, pick);
  }

  /**
   * Writes the message (preceded by its `model_switched` when it switches) inside `t` and updates
   * `conversations.selection`; returns the `user_message` event. The caller notifies after commit.
   */
  private async writeMessage(
    t: Transaction<KernelDatabase>,
    conversationId: string,
    accountId: string,
    input: UserMessageInput,
    next: Selection | null,
    extra: ResolvedExtra,
    blocks: LogContentBlock[],
    invoked: RenderedInvocation | undefined,
  ): Promise<ConversationEvent> {
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
    events.push(this.userMessage(accountId, input, extra, blocks, invoked));
    const written = await this.eventLog.append(conversationId, events, t);
    if (next !== null) {
      // the cache follows the log (a retried message's switch may be an old, deduped event that a
      // later switch already replaced), read under the row lock append took
      await t
        .updateTable("conversations")
        .set({ selection: JSON.stringify(await readSelection(t, conversationId)) })
        .where("id", "=", conversationId)
        .execute();
    }
    return written.at(-1) as ConversationEvent;
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
    if (!this.invoker) {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "skill", message: "Skill invocation is not supported" },
      ]);
    }
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

  /** `files` need the attachments service (shared with the queue). */
  checkFilesSupported(input: Pick<UserMessageInput, "files">): void {
    if ((input.files?.length ?? 0) > 0 && !this.bindFiles) {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "files", message: "Files are not supported" },
      ]);
    }
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
    if (!this.resolveAttachments) {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "attachments", message: "Attachments are not supported" },
      ]);
    }
    return this.resolveAttachments(orgId, accountId, refs);
  }

  /** Binds uploaded files inside the message's (or queue item's) transaction; none → no blocks. */
  async bindIn(
    t: Transaction<KernelDatabase>,
    orgId: string,
    conversationId: string,
    accountId: string,
    files: readonly string[],
  ): Promise<LogContentBlock[]> {
    if (files.length === 0 || !this.bindFiles) return [];
    return this.bindFiles(t, orgId, conversationId, accountId, files);
  }

  private userMessage(
    accountId: string,
    input: UserMessageInput,
    extra: ResolvedExtra,
    fileBlocks: LogContentBlock[],
    invoked?: RenderedInvocation,
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
        ...(input.clientMessageId !== undefined && { clientMessageId: input.clientMessageId }),
        ...(input.retryOf !== undefined && { retryOf: input.retryOf }),
        ...(invoked !== undefined && { skill: invoked.skill }),
      },
    };
  }

  /**
   * 中止会话当前的运行（queued / running / waiting）：返回 runId；没有 → `run.not_active`。
   * 等人处理的运行没有 worker：直接取消等待并写终态。其余经 Redis 广播，运行所在的任意副本都会收到；
   * 运行已是孤儿（没有任何 worker 在执行）时直接写终态。
   */
  async abort(orgId: string, conversationId: string, accountId: string): Promise<string> {
    await this.get(orgId, conversationId, accountId);
    const run = await this.db
      .selectFrom("runs")
      .select(["id", "status"])
      .where("conversation_id", "=", conversationId)
      .where("status", "in", ["queued", "running", "waiting"])
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    if (!run || !this.runs) throw new ApiError("run.not_active", "No active run to abort");
    // 等待中：直接结束；没成功（刚被续跑、已回到 queued）则按下面的常规路径中止。
    if (
      run.status === "waiting" &&
      (await this.runs.abortWaiting(conversationId, run.id, accountId))
    ) {
      this.kickRun(conversationId);
      return run.id;
    }
    // 孤儿运行没有 worker 在听中止广播：直接写成 aborted，之后再看有没有等待中的消息要起新一轮。
    if (await this.runs.abortIfOrphaned(conversationId, run.id, accountId)) {
      this.kickRun(conversationId);
      return run.id;
    }
    await this.runs.requestAbort(run.id, accountId);
    return run.id;
  }
}
