import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { escapeLike } from "../conversations/conversations.service.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { AgentLookup, type AgentVisibility } from "./agent-lookup.js";
import type { AgentDefinition } from "./definition.js";
import type { AgentAvatar } from "./profile.js";

/** One row of the super admin's cross-org agent list (admin agents spec §3.2). */
export interface AdminAgentRow {
  id: string;
  orgId: string;
  orgName: string;
  /** The current version's name. */
  name: string;
  avatar: AgentAvatar;
  ownerAccountId: string;
  ownerName: string;
  needsReassignment: boolean;
  visibility: AgentVisibility;
  createdFrom: { templateId: string; name: string } | null;
  updatedAt: Date;
}

/**
 * The super admin's read-only agent detail (admin agents spec §3.3): the instructions in full,
 * quick actions by label only; never conversations, runs or credentials.
 */
export interface AdminAgentDetail extends AdminAgentRow {
  profile: { description: string | null; quickActions: { label: string }[] };
  memberIds: string[] | null;
  /** The current version's definition, instructions included. */
  definition: AgentDefinition;
  /** How many versions the agent has. */
  versions: number;
  createdAt: Date;
}

export interface AdminAgentListQuery {
  orgId?: string | undefined;
  /** Case-insensitive substring of the name; LIKE wildcards match literally. */
  q?: string | undefined;
  /** The last id of the previous page. */
  after?: string | undefined;
  limit: number;
}

const notFound = () => new ApiError("agent.not_found", "Agent not found");

/**
 * Cross-org agent reads for the super admin (admin agents spec §3.2, §3.3): every org's live
 * agents, private ones included. Agents of a deleted org and soft-deleted agents are never listed
 * and read as `agent.not_found`. The caller checks the super admin (`@SuperAdmin()`).
 */
@Injectable()
export class AdminAgents {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(AgentLookup) private readonly lookup: AgentLookup,
  ) {}

  /** Live agents of live orgs by id, `limit` per page; `next` is the last id when more follow. */
  async list(q: AdminAgentListQuery): Promise<{ agents: AdminAgentRow[]; next: string | null }> {
    let query = this.rows();
    if (q.orgId !== undefined) query = query.where("agents.org_id", "=", q.orgId);
    if (q.q !== undefined && q.q !== "") {
      query = query.where(
        sql<boolean>`agent_versions.definition->>'name' ILIKE ${`%${escapeLike(q.q)}%`} ESCAPE '\\'`,
      );
    }
    if (q.after !== undefined) query = query.where("agents.id", ">", q.after);
    const rows = await query
      .orderBy("agents.id")
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit).map(toRow);
    return { agents: page, next: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
  }

  /** One live agent of a live org; otherwise `agent.not_found`. */
  async get(agentId: string): Promise<AdminAgentDetail> {
    const row = await this.rows().where("agents.id", "=", agentId).executeTakeFirst();
    if (!row) throw notFound();
    const [view, versions] = await Promise.all([
      this.lookup.view(agentId),
      this.db
        .selectFrom("agent_versions")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("agent_id", "=", agentId)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      ...toRow(row),
      profile: {
        description: view.profile.description === "" ? null : view.profile.description,
        quickActions: view.profile.quickActions.map((a) => ({ label: a.title })),
      },
      memberIds: view.memberIds,
      definition: view.definition,
      versions: Number(versions.n),
      createdAt: view.createdAt,
    };
  }

  /** The list columns of live agents in live orgs. */
  private rows() {
    return this.db
      .selectFrom("agents")
      .innerJoin("orgs", "orgs.id", "agents.org_id")
      .innerJoin("accounts", "accounts.id", "agents.owner_account_id")
      .innerJoin("agent_versions", (j) =>
        j
          .onRef("agent_versions.agent_id", "=", "agents.id")
          .onRef("agent_versions.version", "=", "agents.current_version"),
      )
      .select([
        "agents.id",
        "agents.org_id",
        "orgs.name as org_name",
        sql<string>`agent_versions.definition->>'name'`.as("name"),
        "agents.profile_avatar",
        "agents.owner_account_id",
        "accounts.display_name as owner_name",
        "agents.needs_reassignment",
        "agents.visibility",
        "agents.created_from_template_id",
        "agents.created_from_template_name",
        "agents.updated_at",
      ])
      .where("agents.deleted_at", "is", null)
      .where("orgs.deleted_at", "is", null);
  }
}

function toRow(r: {
  id: string;
  org_id: string;
  org_name: string;
  name: string;
  profile_avatar: unknown;
  owner_account_id: string;
  owner_name: string;
  needs_reassignment: boolean;
  visibility: AgentVisibility;
  created_from_template_id: string | null;
  created_from_template_name: string | null;
  updated_at: Date;
}): AdminAgentRow {
  return {
    id: r.id,
    orgId: r.org_id,
    orgName: r.org_name,
    name: r.name,
    avatar: (r.profile_avatar ?? null) as AgentAvatar,
    ownerAccountId: r.owner_account_id,
    ownerName: r.owner_name,
    needsReassignment: r.needs_reassignment,
    visibility: r.visibility,
    createdFrom:
      r.created_from_template_id === null
        ? null
        : { templateId: r.created_from_template_id, name: r.created_from_template_name ?? "" },
    updatedAt: r.updated_at,
  };
}
