import {
  type AvatarValue,
  CONVERSATIONS_BY_SUBJECT_MAX,
  CtxReadError,
  PEOPLE_GET_MAX,
  PEOPLE_SEARCH_MAX,
  type PersonView,
  type SubjectConversation,
  type SubjectConversationState,
  type UsableAgent,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "kysely";
import { AgentLookup, AgentLookupModule } from "../agents/agent-lookup.js";
import type { AgentAvatarView } from "../agents/profile.js";
import { isExtensionEnabled } from "../extensions/enabled.js";
import { avatarColumns, personAvatarUrl } from "../identity/account-avatar.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { PLUGIN_READS_BACKEND } from "./token.js";

const SEARCH_DEFAULT = 20;

/** Escapes `%`, `_` and `\` so a name search matches the text literally. */
const likeLiteral = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The reads behind `ctx.agents`, `ctx.conversations` and `ctx.people` (collaboration spec; people
 * data: plugin full pages spec §8). Every call runs in the org scope the ctx set, requires the
 * calling extension to be enabled in the org (`org_disabled`), and returns metadata only: no
 * conversation content, no email.
 */
@Injectable()
export class PluginReadsService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(AgentLookup) private readonly agents: AgentLookup,
  ) {}

  private async requireEnabled(plugin: string, orgId: string): Promise<void> {
    if (!(await isExtensionEnabled(this.kdb.db, orgId, plugin)))
      throw new CtxReadError("org_disabled", `${plugin} is not enabled in org ${orgId}`);
  }

  /** The agents `accountId` may use in the org; `[]` unless it is an active member. */
  async usableBy(plugin: string, orgId: string, accountId: string): Promise<UsableAgent[]> {
    await this.requireEnabled(plugin, orgId);
    const member = await this.kdb.db
      .selectFrom("memberships")
      .innerJoin("accounts", "accounts.id", "memberships.account_id")
      .select("accounts.id")
      .where("memberships.org_id", "=", orgId)
      .where("memberships.account_id", "=", accountId)
      .where("accounts.status", "=", "active")
      .executeTakeFirst();
    if (member === undefined) return [];
    const views = await this.agents.listVisible(orgId, accountId);
    return views.map((v) => ({
      id: v.id,
      name: v.definition.name,
      avatar: agentAvatar(orgId, v),
    }));
  }

  /** The live conversations of the org whose subject is `plugin`'s `{ kind, id }`. */
  async bySubject(
    plugin: string,
    orgId: string,
    subject: { kind: string; id: string },
  ): Promise<SubjectConversation[]> {
    await this.requireEnabled(plugin, orgId);
    const db = this.kdb.db;
    const convs = await db
      .selectFrom("conversations")
      .select(["id", "account_id", "agent_id", "updated_at"])
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .where(sql<string>`subject->>'source'`, "=", plugin)
      .where(sql<string>`subject->>'kind'`, "=", subject.kind)
      .where(sql<string>`subject->>'id'`, "=", subject.id)
      .orderBy("updated_at", "desc")
      .orderBy("id")
      .limit(CONVERSATIONS_BY_SUBJECT_MAX)
      .execute();
    if (convs.length === 0) return [];
    const runs = await db
      .selectFrom("runs")
      .select(["conversation_id", "status", "waiting_since"])
      .distinctOn("conversation_id")
      .where(
        "conversation_id",
        "in",
        convs.map((c) => c.id),
      )
      .orderBy("conversation_id")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    const latest = new Map(runs.map((r) => [r.conversation_id, r]));
    return convs.map((c) => {
      const r = latest.get(c.id);
      let state: SubjectConversationState = "idle";
      if (r?.status === "waiting" || (r?.status === "running" && r.waiting_since !== null))
        state = "waiting";
      else if (r?.status === "queued" || r?.status === "running") state = "running";
      return {
        id: c.id,
        ownerAccountId: c.account_id,
        agentId: c.agent_id,
        state,
        lastActivityAt: c.updated_at.toISOString(),
      };
    });
  }

  /** The given accounts that are members of the org (others dropped). */
  async peopleGet(plugin: string, orgId: string, accountIds: string[]): Promise<PersonView[]> {
    if (!Array.isArray(accountIds) || accountIds.some((i) => typeof i !== "string"))
      throw new CtxReadError("invalid_args", "accountIds must be a list of strings");
    if (accountIds.length > PEOPLE_GET_MAX)
      throw new CtxReadError("invalid_args", `at most ${PEOPLE_GET_MAX} account ids per call`);
    await this.requireEnabled(plugin, orgId);
    const ids = [...new Set(accountIds)];
    if (ids.length === 0) return [];
    const rows = await this.kdb.db
      .selectFrom("memberships")
      .innerJoin("accounts", "accounts.id", "memberships.account_id")
      .select((eb) => [
        "accounts.id",
        "accounts.display_name",
        "accounts.status",
        ...avatarColumns(eb, "accounts", "account"),
      ])
      .where("memberships.org_id", "=", orgId)
      .where("memberships.account_id", "in", ids)
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      if (!r) return [];
      return [
        {
          id: r.id,
          name: r.display_name,
          avatar: avatarValue(personAvatarUrl(r, "account", r.id)),
          active: r.status === "active",
        },
      ];
    });
  }

  /** Active members whose display name contains `query`, by name. */
  async peopleSearch(
    plugin: string,
    orgId: string,
    query: string,
    limit: number | undefined,
  ): Promise<Pick<PersonView, "id" | "name" | "avatar">[]> {
    if (typeof query !== "string") throw new CtxReadError("invalid_args", "query must be a string");
    if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit)))
      throw new CtxReadError("invalid_args", "limit must be a number");
    await this.requireEnabled(plugin, orgId);
    const n = Math.min(Math.max(Math.floor(limit ?? SEARCH_DEFAULT), 1), PEOPLE_SEARCH_MAX);
    const q = query.trim();
    let sel = this.kdb.db
      .selectFrom("memberships")
      .innerJoin("accounts", "accounts.id", "memberships.account_id")
      .select((eb) => [
        "accounts.id",
        "accounts.display_name",
        ...avatarColumns(eb, "accounts", "account"),
      ])
      .where("memberships.org_id", "=", orgId)
      .where("accounts.status", "=", "active");
    if (q !== "")
      sel = sel.where(
        sql<boolean>`accounts.display_name ilike ${`%${likeLiteral(q)}%`} escape '\\'`,
      );
    const rows = await sel
      .orderBy("accounts.display_name")
      .orderBy("accounts.id")
      .limit(n)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.display_name,
      avatar: avatarValue(personAvatarUrl(r, "account", r.id)),
    }));
  }
}

const avatarValue = (src: string | null): AvatarValue =>
  src === null ? null : { kind: "image", src };

/**
 * An agent's avatar for a page, the same mapping as the web's `avatarValue`: a preset stays one, a
 * theme preset is its immutable asset URL, an upload or migrated external image goes through the
 * agent avatar route (`v` busts caches when the profile changes).
 */
function agentAvatar(
  orgId: string,
  v: { id: string; profile: { avatar: AgentAvatarView; updatedAt: string } },
): AvatarValue {
  const a = v.profile.avatar;
  if (a === null) return null;
  if (a.kind === "preset") return { kind: "preset", id: a.id };
  if (a.kind === "theme") return { kind: "image", src: a.url };
  return {
    kind: "image",
    src: `/api/v1/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(v.id)}/avatar?v=${encodeURIComponent(v.profile.updatedAt)}`,
  };
}

/** `PluginReadsService`, found by the extension host through {@link PLUGIN_READS_BACKEND}. */
@Module({
  imports: [AgentLookupModule],
  providers: [
    PluginReadsService,
    { provide: PLUGIN_READS_BACKEND, useExisting: PluginReadsService },
  ],
  exports: [PluginReadsService, PLUGIN_READS_BACKEND],
})
export class PluginReadsModule {}
