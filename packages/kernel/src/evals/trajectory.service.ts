import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { isAgentVisibleTo } from "../agents/agent-lookup.js";
import { EventLog } from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import type { ConversationKind } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { SettingsService } from "../identity/settings.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { PricesService } from "../models/prices.js";
import { type OrgRole, roleAtLeast } from "../orgs/roles.js";
import { buildTrajectory, type TrajectoryRun } from "./trajectory.js";

/** 轨迹列表的一项（不含对话内容，列表不写审计）。 */
export interface TrajectoryListItem {
  conversationId: string;
  agentId: string;
  agentName: string;
  accountId: string;
  title: string | null;
  updatedAt: string;
  lastRun: { runId: string; status: string; startedAt: string | null } | null;
}

export interface TrajectoryDetail {
  conversation: {
    id: string;
    agentId: string;
    accountId: string;
    title: string | null;
    kind: ConversationKind;
    /**
     * A sub-agent's conversation (phase C, spec §15.4): the parent conversation and the `agent`
     * call that first dispatched it, for the link back. Visible exactly when the child is (the
     * child's access is its parent's).
     */
    parent?: { conversationId: string; runId: string; callId: string };
  };
  runs: TrajectoryRun[];
  /** 成本的币种（部署设置 `priceCurrency`）。 */
  currency: string;
  /**
   * 只在按运行分页（给了 `limit` / `before`）时出现：更早一页的游标（本页最早一次运行的 id，作为 `before`
   * 传回）；没有更早的运行时为 null。给 `runId` 时总是 null。不带窗口时没有这个字段（形状与以前一致）。
   */
  next?: string | null;
}

/** 轨迹详情的运行窗口：`runId` 只取一次运行；否则取 `before` 之前（不传为最新）的 `limit` 次运行。 */
export type RunWindow = { runId: string } | { before?: string; limit: number };

/** 运行的状态（`runs.status`），列表按最近一次运行的状态过滤用。 */
export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "aborted",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** 一次读事件的页大小。 */
const EVENT_PAGE = 1000;

const notFound = () => new ApiError("trajectory.not_found", "Trajectory not found");

/**
 * 轨迹查看器（D6、C1）：只给组织管理员（admin / owner）与 agent 负责人。负责人与角色每次实时读（R5）；
 * 无权查看与不存在一律 `trajectory.not_found`，不泄露对话是否存在。每次查看详情写审计 `trajectory.viewed`。
 * 企业管理员不因身份而能看（不是组织成员时 OrgGuard 已 404）。
 *
 * 列表按 `conversations.kind` 过滤，不传时只列 `chat`（评测回放的隐藏对话用 `kind: "eval"` 列出）。
 * 评测对话（`kind = 'eval'`）只给组织管理员（Ruling S1-c）：里面是管理员的候选指令，非管理员的 agent 负责人
 * 列不出、读详情 404。
 */
@Injectable()
export class TrajectoryService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(PricesService) private readonly prices: PricesService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /** 调用者当前在组织里的角色；不是成员或组织已删除 → null。 */
  private async role(orgId: string, accountId: string): Promise<OrgRole | null> {
    const m = await this.db
      .selectFrom("memberships")
      .innerJoin("orgs", "orgs.id", "memberships.org_id")
      .select("memberships.role")
      .where("memberships.org_id", "=", orgId)
      .where("memberships.account_id", "=", accountId)
      .where("orgs.deleted_at", "is", null)
      .executeTakeFirst();
    return m?.role ?? null;
  }

  /** 至少是 member（guest 不能看轨迹）。 */
  private static isMember(role: OrgRole | null): role is OrgRole {
    return role !== null && roleAtLeast(role, "member");
  }

  /** 组织 admin / owner，或该 agent 当前的负责人（且至少是 member）。agent 已删除或不在本组织 → false。 */
  async canView(orgId: string, accountId: string, agentId: string): Promise<boolean> {
    const role = await this.role(orgId, accountId);
    if (!TrajectoryService.isMember(role)) return false;
    const agent = await this.db
      .selectFrom("agents")
      .select("owner_account_id")
      .where("id", "=", agentId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!agent) return false;
    return roleAtLeast(role, "admin") || agent.owner_account_id === accountId;
  }

  /**
   * 列出可查看的对话（admin 看全部，其余只看自己负责的 agent），按 (updated_at, id) 倒序；`kind` 缺省为 `chat`。
   * `before` 是上一页的 `next`（对话 id）：从该对话当前的 (updated_at, id) 之后继续。
   */
  async list(
    orgId: string,
    accountId: string,
    q: {
      agentId?: string;
      kind?: "chat" | "eval";
      /** 只列最近一次运行是该状态的对话（没有运行的对话不列）。 */
      status?: RunStatus;
      before?: string;
      limit: number;
    },
  ): Promise<{ items: TrajectoryListItem[]; next: string | null }> {
    const role = await this.role(orgId, accountId);
    if (!TrajectoryService.isMember(role)) return { items: [], next: null };
    const admin = roleAtLeast(role, "admin");
    // 评测对话只给组织管理员（Ruling S1-c）
    if (q.kind === "eval" && !admin) return { items: [], next: null };
    let query = this.db
      .selectFrom("conversations as c")
      .innerJoin("agents as a", "a.id", "c.agent_id")
      .innerJoin("agent_versions as v", (j) =>
        j.onRef("v.agent_id", "=", "a.id").onRef("v.version", "=", "a.current_version"),
      )
      .select([
        "c.id",
        "c.agent_id",
        "c.account_id",
        "c.title",
        "c.updated_at",
        sql<string | null>`v.definition ->> 'name'`.as("agent_name"),
      ])
      .where("c.org_id", "=", orgId)
      .where("c.kind", "=", q.kind ?? "chat")
      .where("a.org_id", "=", orgId)
      .where("a.deleted_at", "is", null)
      .orderBy("c.updated_at", "desc")
      .orderBy("c.id", "desc")
      .limit(q.limit + 1);
    if (!admin) query = query.where("a.owner_account_id", "=", accountId);
    if (q.agentId !== undefined) query = query.where("c.agent_id", "=", q.agentId);
    if (q.status !== undefined) {
      const status = q.status;
      // 与下面取 lastRun 的排序一致：最近一次运行 = created_at、id 最大的一条
      query = query.where(
        (eb) =>
          sql<boolean>`(
            SELECT r.status FROM capybara.runs r WHERE r.conversation_id = ${eb.ref("c.id")}
            ORDER BY r.created_at DESC, r.id DESC LIMIT 1
          ) = ${status}`,
      );
    }
    if (q.before !== undefined) {
      const before = q.before;
      query = query.where(
        (eb) =>
          sql<boolean>`(${eb.ref("c.updated_at")}, ${eb.ref("c.id")}) < (
            SELECT x.updated_at, x.id FROM capybara.conversations x
            WHERE x.id = ${before} AND x.org_id = ${orgId}
          )`,
      );
    }
    const rows = await query.execute();
    const page = rows.slice(0, q.limit);
    const ids = page.map((r) => r.id);
    const lastRuns =
      ids.length === 0
        ? []
        : await this.db
            .selectFrom("runs")
            .select(["id", "conversation_id", "status", "started_at"])
            .distinctOn("conversation_id")
            .where("conversation_id", "in", ids)
            .orderBy("conversation_id")
            .orderBy("created_at", "desc")
            .orderBy("id", "desc")
            .execute();
    const byConv = new Map(lastRuns.map((r) => [r.conversation_id, r]));
    const items = page.map((r): TrajectoryListItem => {
      const run = byConv.get(r.id);
      return {
        conversationId: r.id,
        agentId: r.agent_id,
        agentName: r.agent_name ?? "",
        accountId: r.account_id,
        title: r.title,
        updatedAt: r.updated_at.toISOString(),
        lastRun:
          run === undefined
            ? null
            : {
                runId: run.id,
                status: run.status,
                startedAt: run.started_at === null ? null : run.started_at.toISOString(),
              },
      };
    });
    const next = rows.length > q.limit ? (page.at(-1)?.id ?? null) : null;
    return { items, next };
  }

  /**
   * 一个对话的轨迹；无权或不存在 → `trajectory.not_found`。成功时（含窗口为空）写审计 `trajectory.viewed`。
   * 不给 `window` 时读全对话；给了只读窗口内（且已开始）的运行的事件，响应带 `next`。
   */
  async get(
    orgId: string,
    accountId: string,
    conversationId: string,
    actorTokenId?: string,
    window?: RunWindow,
  ): Promise<TrajectoryDetail> {
    const conv = await this.db
      .selectFrom("conversations")
      .select(["id", "agent_id", "account_id", "title", "kind", "parent_conversation_id"])
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    // A sub-agent's trajectory is part of its parent conversation's: authorized by the parent
    // conversation's agent, never by the dispatched agent (an org agent's owner must not read a
    // child drawn from someone else's conversation; batch 9 review I1)
    const authAgentId =
      conv?.kind === "subagent"
        ? await this.parentAgentId(orgId, conv.parent_conversation_id)
        : conv?.agent_id;
    if (!conv || authAgentId === null || authAgentId === undefined) throw notFound();
    if (!(await this.canView(orgId, accountId, authAgentId))) throw notFound();
    // an org agent child also needs that agent to be visible to a non-admin viewer, as on the
    // conversation read path (batch 9 ruling; final review m3)
    if (conv.kind === "subagent" && conv.agent_id !== authAgentId) {
      const role = await this.role(orgId, accountId);
      if (
        (role === null || !roleAtLeast(role, "admin")) &&
        !(await isAgentVisibleTo(this.db.db, conv.agent_id, accountId))
      ) {
        throw notFound();
      }
    }
    // 评测对话只给组织管理员（Ruling S1-c）：负责人也 404
    if (conv.kind === "eval") {
      const role = await this.role(orgId, accountId);
      if (role === null || !roleAtLeast(role, "admin")) throw notFound();
    }
    const events: ConversationEvent[] = [];
    let next: string | null | undefined;
    if (window === undefined) {
      for (let after = 0; ; ) {
        const page = await this.eventLog.readAfter(conversationId, after, EVENT_PAGE);
        events.push(...page);
        const last = page.at(-1);
        if (page.length < EVENT_PAGE || last === undefined) break;
        after = last.seq;
      }
    } else {
      const picked = await this.windowRuns(conversationId, window);
      next = picked.next;
      // 运行的事件都在它的 trigger_seq 之后：从窗口里最小的 trigger_seq 开始读，不扫更早的历史
      let after = Math.min(...picked.runs.map((r) => r.triggerSeq));
      const ids = picked.runs.map((r) => r.id);
      while (ids.length > 0) {
        const page = await this.eventLog.readRunsAfter(conversationId, ids, after, EVENT_PAGE);
        events.push(...page);
        const last = page.at(-1);
        if (page.length < EVENT_PAGE || last === undefined) break;
        after = last.seq;
      }
    }
    const [table, settings, parent] = await Promise.all([
      this.prices.table(),
      this.settings.get(),
      conv.kind === "subagent" ? this.firstDispatch(conv.id) : undefined,
    ]);
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "trajectory.viewed",
      target: conversationId,
      detail: { agentId: conv.agent_id },
    });
    return {
      conversation: {
        id: conv.id,
        agentId: conv.agent_id,
        accountId: conv.account_id,
        title: conv.title,
        kind: conv.kind,
        ...(parent !== undefined && { parent }),
      },
      runs: buildTrajectory(events, table),
      currency: settings.priceCurrency,
      ...(next !== undefined && { next }),
    };
  }

  /** The parent call that first dispatched a sub-agent conversation. */
  private async firstDispatch(
    childId: string,
  ): Promise<{ conversationId: string; runId: string; callId: string } | undefined> {
    const row = await this.db
      .selectFrom("subagent_dispatches")
      .select(["parent_conversation_id", "parent_run_id", "parent_call_id"])
      .where("child_conversation_id", "=", childId)
      .orderBy("created_at")
      .orderBy("resumed")
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          conversationId: row.parent_conversation_id,
          runId: row.parent_run_id,
          callId: row.parent_call_id,
        };
  }

  /** The agent of a sub-agent conversation's parent conversation, or null. */
  private async parentAgentId(orgId: string, parentId: string | null): Promise<string | null> {
    if (parentId === null) return null;
    const p = await this.db
      .selectFrom("conversations")
      .select("agent_id")
      .where("id", "=", parentId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    return p?.agent_id ?? null;
  }

  /**
   * 窗口内已开始（`started_at` 非空，与轨迹只列有 `run_started` 的运行一致）的运行，按 (created_at, id) 倒序取
   * `limit` 次；`before` 是上一页的 `next`（运行 id）。`next`：还有更早的运行时为本页最早一次的 id。
   * `runId` / `before` 不是本对话里已开始的运行 → `trajectory.not_found`（调用方在写审计之前调用）。
   */
  private async windowRuns(
    conversationId: string,
    window: RunWindow,
  ): Promise<{ runs: { id: string; triggerSeq: number }[]; next: string | null }> {
    let query = this.db
      .selectFrom("runs as r")
      .select(["r.id", "r.trigger_seq"])
      .where("r.conversation_id", "=", conversationId)
      .where("r.started_at", "is not", null)
      .orderBy("r.created_at", "desc")
      .orderBy("r.id", "desc");
    if ("runId" in window) {
      query = query.where("r.id", "=", window.runId).limit(1);
    } else {
      query = query.limit(window.limit + 1);
      if (window.before !== undefined) {
        const before = window.before;
        // 游标必须是本对话里已开始的一次运行，否则 404（不写审计）
        const cursor = await this.db
          .selectFrom("runs")
          .select("id")
          .where("id", "=", before)
          .where("conversation_id", "=", conversationId)
          .where("started_at", "is not", null)
          .executeTakeFirst();
        if (!cursor) throw notFound();
        query = query.where(
          (eb) =>
            sql<boolean>`(${eb.ref("r.created_at")}, ${eb.ref("r.id")}) < (
              SELECT x.created_at, x.id FROM capybara.runs x
              WHERE x.id = ${before} AND x.conversation_id = ${conversationId}
            )`,
        );
      }
    }
    const rows = await query.execute();
    // 指定的运行不在本对话里（或还没开始）：404（不写审计）
    if ("runId" in window && rows.length === 0) throw notFound();
    const limit = "runId" in window ? 1 : window.limit;
    const page = rows.slice(0, limit);
    return {
      runs: page.map((r) => ({ id: r.id, triggerSeq: Number(r.trigger_seq) })),
      next: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
