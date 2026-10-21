import { sql } from "kysely";
import type { EventLog } from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import type { SettingsService } from "../identity/settings.js";
import type { PricesService } from "../models/prices.js";
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
    kind: "chat" | "eval";
  };
  runs: TrajectoryRun[];
  /** 成本的币种（部署设置 `priceCurrency`）。 */
  currency: string;
}

/** 一次读事件的页大小。 */
const EVENT_PAGE = 1000;

const notFound = () => new ApiError("trajectory.not_found", "Trajectory not found");

/**
 * 轨迹查看器（D6、C1）：只给组织管理员（admin / owner）与 agent 负责人。负责人与角色每次实时读（R5）；
 * 无权查看与不存在一律 `trajectory.not_found`，不泄露对话是否存在。每次查看详情写审计 `trajectory.viewed`。
 * 企业管理员不因身份而能看（不是组织成员时 OrgGuard 已 404）。
 *
 * `conversations.kind` 由 T3 加入：在那之前所有对话都按 `chat` 处理，`kind: "eval"` 列出为空。
 */
export class TrajectoryService {
  constructor(
    private readonly db: KernelDb,
    private readonly eventLog: EventLog,
    private readonly prices: PricesService,
    private readonly settings: SettingsService,
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
   * 列出可查看的对话（admin 看全部，其余只看自己负责的 agent），按 (updated_at, id) 倒序。
   * `before` 是上一页的 `next`（对话 id）：从该对话当前的 (updated_at, id) 之后继续。
   */
  async list(
    orgId: string,
    accountId: string,
    q: { agentId?: string; kind?: "chat" | "eval"; before?: string; limit: number },
  ): Promise<{ items: TrajectoryListItem[]; next: string | null }> {
    const role = await this.role(orgId, accountId);
    if (!TrajectoryService.isMember(role)) return { items: [], next: null };
    // T3 加 conversations.kind 之前没有评测对话
    if (q.kind === "eval") return { items: [], next: null };
    const admin = roleAtLeast(role, "admin");
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
      .where("a.org_id", "=", orgId)
      .where("a.deleted_at", "is", null)
      .orderBy("c.updated_at", "desc")
      .orderBy("c.id", "desc")
      .limit(q.limit + 1);
    if (!admin) query = query.where("a.owner_account_id", "=", accountId);
    if (q.agentId !== undefined) query = query.where("c.agent_id", "=", q.agentId);
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

  /** 一个对话的轨迹；无权或不存在 → `trajectory.not_found`。成功时写审计 `trajectory.viewed`。 */
  async get(
    orgId: string,
    accountId: string,
    conversationId: string,
    actorTokenId?: string,
  ): Promise<TrajectoryDetail> {
    const conv = await this.db
      .selectFrom("conversations")
      .select(["id", "agent_id", "account_id", "title"])
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!conv || !(await this.canView(orgId, accountId, conv.agent_id))) throw notFound();
    const events: ConversationEvent[] = [];
    for (let after = 0; ; ) {
      const page = await this.eventLog.readAfter(conversationId, after, EVENT_PAGE);
      events.push(...page);
      const last = page.at(-1);
      if (page.length < EVENT_PAGE || last === undefined) break;
      after = last.seq;
    }
    const [table, settings] = await Promise.all([this.prices.table(), this.settings.get()]);
    await audit(this.db, {
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
        kind: "chat",
      },
      runs: buildTrajectory(events, table),
      currency: settings.priceCurrency,
    };
  }
}
