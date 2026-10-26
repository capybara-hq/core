import { randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import { type AgentsService, visibleTo } from "../agents/agents.service.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { EventLog } from "./event-log.js";
import type { ConversationEvent, LogContentBlock } from "./events.js";

/** 对外的会话视图。 */
export interface ConversationView {
  id: string;
  orgId: string;
  agentId: string;
  accountId: string;
  title: string | null;
  /** 已写入的最大事件 seq。 */
  lastSeq: number;
  createdAt: Date;
  updatedAt: Date;
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
) => Promise<{
  blocks: { type: "text"; text: string }[];
  /** 写进 user_message 的附件元数据：事件 payload 字段名仍为 `appId` / `appName`（C27）。 */
  attachments: { appId: string; appName: string; uri: string; name: string }[];
}>;

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
  "last_seq",
  "created_at",
  "updated_at",
] as const;

function toView(r: {
  id: string;
  org_id: string;
  agent_id: string;
  account_id: string;
  title: string | null;
  last_seq: string;
  created_at: Date;
  updated_at: Date;
}): ConversationView {
  return {
    id: r.id,
    orgId: r.org_id,
    agentId: r.agent_id,
    accountId: r.account_id,
    title: r.title,
    lastSeq: Number(r.last_seq),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

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

  /** 读会话：非所有者、或 agent 已对所有者不可用 → `conversation.not_found`。 */
  async get(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
  ): Promise<ConversationView> {
    const row = await this.db
      .selectFrom("conversations")
      .select(COLUMNS)
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .where("account_id", "=", viewerAccountId)
      // 评测回放的隐藏对话（kind = 'eval'）不经会话接口访问（只读轨迹查看器可见）
      .where("kind", "=", "chat")
      .executeTakeFirst();
    if (!row) throw notFound();
    try {
      await this.agents.get(orgId, row.agent_id, viewerAccountId);
    } catch (e) {
      if (e instanceof ApiError && e.code === "agent.not_found") throw notFound();
      throw e;
    }
    return toView(row);
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
      .where("conversations.kind", "=", "chat")
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
      last_seq: string;
      created_at: Date;
      updated_at: Date;
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
        cs.id, cs.org_id, cs.account_id, cs.title, cs.last_seq, cs.created_at, cs.updated_at
      FROM page
      JOIN capybara.agents a ON a.id = page.agent_id
      JOIN capybara.agent_versions v ON v.agent_id = a.id AND v.version = a.current_version
      CROSS JOIN LATERAL (
        SELECT c.id, c.org_id, c.account_id, c.title, c.last_seq, c.created_at, c.updated_at
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
    input: {
      text: string;
      clientMessageId?: string;
      attachments?: AttachmentRef[];
      files?: string[];
    },
  ): Promise<ConversationEvent> {
    await this.get(orgId, conversationId, accountId);
    const refs = input.attachments ?? [];
    const files = input.files ?? [];
    if (files.length > 0 && !this.bindFiles) {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "files", message: "Files are not supported" },
      ]);
    }
    let extra: Awaited<ReturnType<ResolveAttachments>> = { blocks: [], attachments: [] };
    // 重复提交：直接返回已写入的事件（不再读取资源、不再校验附件）
    if ((refs.length > 0 || files.length > 0) && input.clientMessageId !== undefined) {
      const existing = await this.eventLog.findByIdem(
        conversationId,
        userMessageIdemKey(input.clientMessageId),
      );
      if (existing) {
        await this.runs?.ensureRun(conversationId);
        return existing;
      }
    }
    if (refs.length > 0) {
      if (!this.resolveAttachments) {
        throw new ApiError("validation_failed", "Request validation failed", [
          { path: "attachments", message: "Attachments are not supported" },
        ]);
      }
      extra = await this.resolveAttachments(orgId, accountId, refs);
    }
    const message = (fileBlocks: LogContentBlock[]) => ({
      type: "user_message" as const,
      ...(input.clientMessageId !== undefined && {
        idemKey: userMessageIdemKey(input.clientMessageId),
      }),
      payload: {
        // 只发附件时（text 为空）不写空文本块（供应商不接受空文本）；带 `@` 资源时 text 一定非空（content[0]）
        content: [
          ...(input.text === "" ? [] : [{ type: "text" as const, text: input.text }]),
          ...extra.blocks,
          ...fileBlocks,
        ],
        ...(extra.attachments.length > 0 && { attachments: extra.attachments }),
        authorAccountId: accountId,
        ...(input.clientMessageId !== undefined && { clientMessageId: input.clientMessageId }),
      },
    });
    let event: ConversationEvent | undefined;
    if (files.length > 0 && this.bindFiles) {
      const bind = this.bindFiles;
      [event] = await this.db.transaction().execute(async (t) => {
        const blocks = await bind(t, orgId, conversationId, accountId, files);
        return this.eventLog.append(conversationId, [message(blocks)], t);
      });
      if (event) await this.eventLog.notify(conversationId, event.seq);
    } else {
      [event] = await this.eventLog.append(conversationId, [message([])]);
    }
    await this.runs?.ensureRun(conversationId);
    return event as ConversationEvent;
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
