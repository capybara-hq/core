import { Inject, Injectable, Module } from "@nestjs/common";
import { type ExpressionBuilder, sql } from "kysely";
import type { KernelDatabase, KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { type AgentDefinition, normalizeStoredDefinition } from "./definition.js";

export const AGENT_VISIBILITIES = ["private", "org", "members"] as const;
export type AgentVisibility = (typeof AGENT_VISIBILITIES)[number];

/** 对外的 agent 视图：当前版本的定义 + 元数据；`memberIds` 只在 visibility='members' 时为数组。 */
export interface AgentView {
  id: string;
  orgId: string;
  ownerAccountId: string;
  visibility: AgentVisibility;
  currentVersion: number;
  definition: AgentDefinition;
  memberIds: string[] | null;
  /** 负责人离职后被转给组织所有者、等待管理员重新指派。 */
  needsReassignment: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const notFound = () => new ApiError("agent.not_found", "Agent not found");

/**
 * 可见性判定（`canUse`）的 SQL 条件：agent 未删除、所属组织未删除，且
 * - viewer 为账号：仍是该组织成员（含访客），并且是负责人 / visibility='org' / 在 agent_members 名单中；
 * - viewer 为 null（该组织的服务令牌）：只认 visibility='org'。
 */
export function visibleTo(viewerAccountId: string | null) {
  return (eb: ExpressionBuilder<KernelDatabase, "agents">) => {
    const orgLive = eb.exists(
      eb
        .selectFrom("orgs")
        .select(sql`1`.as("one"))
        .whereRef("orgs.id", "=", "agents.org_id")
        .where("orgs.deleted_at", "is", null),
    );
    if (viewerAccountId === null) {
      return eb.and([orgLive, eb("agents.visibility", "=", "org")]);
    }
    return eb.and([
      orgLive,
      eb.exists(
        eb
          .selectFrom("memberships")
          .select(sql`1`.as("one"))
          .whereRef("memberships.org_id", "=", "agents.org_id")
          .where("memberships.account_id", "=", viewerAccountId),
      ),
      eb.or([
        eb("agents.owner_account_id", "=", viewerAccountId),
        eb("agents.visibility", "=", "org"),
        eb.and([
          eb("agents.visibility", "=", "members"),
          eb.exists(
            eb
              .selectFrom("agent_members")
              .select(sql`1`.as("one"))
              .whereRef("agent_members.agent_id", "=", "agents.id")
              .where("agent_members.account_id", "=", viewerAccountId),
          ),
        ]),
      ]),
    ]);
  };
}

/**
 * Whether the live agent `agentId` is visible to `accountId` under the normal visibility rule
 * ({@link visibleTo}: owner, `visibility = 'org'`, or listed in `agent_members`, while a member of
 * the live org). Deleted agents are never visible.
 */
export async function isAgentVisibleTo(
  db: KernelSchemaDb,
  agentId: string,
  accountId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("agents")
    .select("id")
    .where("id", "=", agentId)
    .where("deleted_at", "is", null)
    .where(visibleTo(accountId))
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Reads agents for a viewer (the visibility rule {@link visibleTo}): the part of `AgentsService`
 * the conversations, the skill invoker and the attachments read, with no dependency on the
 * services that write agents (it breaks the agents ↔ skills module cycle, spec §3 (a)). Reads go
 * through `KernelDb`, so inside a transaction they see its writes.
 */
@Injectable()
export class AgentLookup {
  constructor(@Inject(KernelDb) private readonly db: KernelDb) {}

  /** 取对 viewer 可见的 agent；`viewerAccountId = null` 表示该组织的服务令牌。不可见 → `agent.not_found`。 */
  async get(orgId: string, agentId: string, viewerAccountId: string | null): Promise<AgentView> {
    const row = await this.db
      .selectFrom("agents")
      .select("id")
      .where("id", "=", agentId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .where(visibleTo(viewerAccountId))
      .executeTakeFirst();
    if (!row) throw notFound();
    return this.view(agentId);
  }

  /** 组织内对 viewer 可见的全部 agent（按创建时间）。 */
  async listVisible(orgId: string, viewerAccountId: string | null): Promise<AgentView[]> {
    const rows = await this.db
      .selectFrom("agents")
      .select("id")
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .where(visibleTo(viewerAccountId))
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return this.views(rows.map((r) => r.id));
  }

  /** One agent's view (no visibility check: the caller did it); missing → `agent.not_found`. */
  async view(agentId: string): Promise<AgentView> {
    const views = await this.views([agentId]);
    const v = views[0];
    if (!v) throw notFound();
    return v;
  }

  /** 按给定 id 顺序组装视图（调用方已完成可见性判定）。 */
  async views(ids: string[]): Promise<AgentView[]> {
    if (ids.length === 0) return [];
    const db = this.db;
    const rows = await db
      .selectFrom("agents")
      .innerJoin("agent_versions", (j) =>
        j
          .onRef("agent_versions.agent_id", "=", "agents.id")
          .onRef("agent_versions.version", "=", "agents.current_version"),
      )
      .select([
        "agents.id",
        "agents.org_id",
        "agents.owner_account_id",
        "agents.visibility",
        "agents.current_version",
        "agents.needs_reassignment",
        "agents.created_at",
        "agents.updated_at",
        "agent_versions.definition",
      ])
      .where("agents.id", "in", ids)
      .execute();
    const memberRows = await db
      .selectFrom("agent_members")
      .select(["agent_id", "account_id"])
      .where("agent_id", "in", ids)
      .orderBy("account_id")
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      if (!r) return [];
      return [
        {
          id: r.id,
          orgId: r.org_id,
          ownerAccountId: r.owner_account_id,
          visibility: r.visibility,
          currentVersion: r.current_version,
          definition: normalizeStoredDefinition(r.definition),
          memberIds:
            r.visibility === "members"
              ? memberRows.filter((m) => m.agent_id === id).map((m) => m.account_id)
              : null,
          needsReassignment: r.needs_reassignment,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        },
      ];
    });
  }
}

/** The one {@link AgentLookup} (database only). */
@Module({ providers: [AgentLookup], exports: [AgentLookup] })
export class AgentLookupModule {}
