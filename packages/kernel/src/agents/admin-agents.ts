import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { escapeLike } from "../conversations/conversations.service.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import {
  agentSkills,
  builtinSkillIds,
  builtinSkillPlugins,
  linkedCopyIds,
  skillIdsOf,
  usableSkillVersions,
} from "../skills/usable.js";
import { AgentLookup, type AgentVisibility } from "./agent-lookup.js";
import {
  type AgentDefinition,
  type DisabledSkillRef,
  type DisabledToolRef,
  skillDisabled,
} from "./definition.js";
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
  createdFrom: { templateId: string; name: string | null } | null;
  /**
   * How many of the skills on in the org it turns off (skills default-on spec §11): a builtin
   * plugin's skill and an org skill it shared never count, as it always has them.
   */
  skillsOff: number;
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
  /**
   * The skills it has now by name (skills default-on spec §3): every skill on in the org that its
   * `disabledSkills` does not turn off, the org skills it shared and its own skills
   * (`scope: "agent"`). Never a skill body.
   */
  skills: { id: string; name: string; scope: "org" | "agent" }[];
  /**
   * The org's live connectors it can use by name (tools default-on): every one but those whose
   * every tool it turns off. Never auth, credentials or a member's state.
   */
  connectors: AdminAgentConnector[];
}

export interface AdminAgentConnector {
  id: string;
  name: string;
  slug: string;
  status: "active" | "disabled";
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
    const kept = rows.slice(0, q.limit);
    const off = await this.skillsOff(kept);
    const page = kept.map((r) => toRow(r, off.get(r.id) ?? 0));
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
    const [skills, off, connectors] = await Promise.all([
      agentSkills(this.db.db, {
        orgId: row.org_id,
        agentId,
        disabledSkills: view.definition.disabledSkills ?? [],
      }),
      this.skillsOff([row]),
      this.connectorsOf(row.org_id, view.definition.disabledTools),
    ]);
    return {
      ...toRow(row, off.get(agentId) ?? 0),
      skills: skills
        .map((s) => ({ id: s.id, name: s.name, scope: s.scope }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      connectors,
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

  /**
   * How many of the org's skills each agent turns off, by agent id (agents turning none off are
   * left out): the org's usable skills are resolved once per org, then matched against each
   * agent's `disabledSkills` by the rule of `agentSkills` (a builtin plugin's skill and an org
   * skill the agent shared are never off).
   */
  private async skillsOff(
    rows: readonly { id: string; org_id: string; disabled_skills: unknown }[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const byOrg = new Map<string, { id: string; disabled: DisabledSkillRef[] }[]>();
    for (const r of rows) {
      const disabled = Array.isArray(r.disabled_skills)
        ? (r.disabled_skills as DisabledSkillRef[])
        : [];
      if (disabled.length === 0) continue;
      byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), { id: r.id, disabled }]);
    }
    if (byOrg.size === 0) return out;
    const db = this.db.db;
    const builtinPlugins = await builtinSkillPlugins(db);
    const agentIds = [...byOrg.values()].flat().map((a) => a.id);
    const sharedRows = await db
      .selectFrom("skills")
      .select(["id", "origin_agent_id"])
      .where("scope", "=", "org")
      .where("deleted_at", "is", null)
      .where("origin_agent_id", "in", agentIds)
      .execute();
    const shared = new Map<string, Set<string>>();
    for (const r of sharedRows) {
      const a = r.origin_agent_id as string;
      shared.set(a, (shared.get(a) ?? new Set()).add(r.id));
    }
    for (const [orgId, agents] of byOrg) {
      const usable = await usableSkillVersions(db, orgId);
      const linked = await linkedCopyIds(
        db,
        orgId,
        usable.flatMap((r) => (r.origin === "platform" ? [r.id] : [])),
      );
      const builtinIds = new Set(await builtinSkillIds(db, orgId));
      const candidates = usable.flatMap((r) => {
        const ids = skillIdsOf(r, linked);
        const fixed =
          (r.plugin !== null && builtinPlugins.has(r.plugin) && r.origin === "platform") ||
          ids.some((id) => builtinIds.has(id));
        return fixed ? [] : [{ plugin: r.plugin, name: r.name, ids }];
      });
      for (const a of agents) {
        const mine = shared.get(a.id) ?? new Set<string>();
        const n = candidates.filter(
          (c) => !c.ids.some((id) => mine.has(id)) && skillDisabled(a.disabled, c),
        ).length;
        out.set(a.id, n);
      }
    }
    return out;
  }

  /**
   * The org's live connectors by name, minus those the agent turns off as a whole: `tools: "all"`,
   * or a list naming every tool the connector has (a connector without tools stays listed).
   */
  private async connectorsOf(
    orgId: string,
    disabled: readonly DisabledToolRef[] | undefined,
  ): Promise<AdminAgentConnector[]> {
    const rows = await this.db
      .selectFrom("connectors as c")
      .select(["c.id", "c.name", "c.slug", "c.status"])
      .select(
        sql<string[]>`coalesce((SELECT array_agg(t.name) FROM capybara.connector_tools t
          WHERE t.connector_id = c.id), '{}')`.as("tools"),
      )
      .where("c.org_id", "=", orgId)
      .where("c.deleted_at", "is", null)
      .orderBy("c.name")
      .orderBy("c.id")
      .execute();
    const offByConnector = new Map<string, "all" | Set<string>>();
    for (const r of disabled ?? []) {
      if (r.kind !== "connector") continue;
      const prev = offByConnector.get(r.connectorId);
      if (prev === "all" || r.tools === "all") offByConnector.set(r.connectorId, "all");
      else offByConnector.set(r.connectorId, new Set([...(prev ?? []), ...r.tools]));
    }
    const allOff = (id: string, tools: readonly string[]): boolean => {
      const off = offByConnector.get(id);
      if (off === undefined) return false;
      if (off === "all") return true;
      return tools.length > 0 && tools.every((t) => off.has(t));
    };
    return rows
      .filter((r) => !allOff(r.id, r.tools))
      .map((r) => ({ id: r.id, name: r.name, slug: r.slug, status: r.status }));
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
        sql<unknown>`agent_versions.definition->'disabledSkills'`.as("disabled_skills"),
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

function toRow(
  r: {
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
  },
  skillsOff: number,
): AdminAgentRow {
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
        : { templateId: r.created_from_template_id, name: r.created_from_template_name ?? null },
    skillsOff,
    updatedAt: r.updated_at,
  };
}
