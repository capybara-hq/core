import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import type { OrgRole } from "../orgs/roles.js";
import { type OrgSettings, readOrgSettings } from "../orgs/settings.service.js";
import { rootConversationOf } from "../runtime/subagents/child.js";

/** What {@link availability} decides on, read live for each call (spec §6.1). */
export interface ActorFacts {
  /** The actor's role in the org; null: not a member any more. */
  role: OrgRole | null;
  isSuperAdmin: boolean;
  /** A person who can see and answer a confirmation is behind this run. */
  personPresent: boolean;
  /** The agent's visibility is `private` and its owner is the actor. */
  agentPrivateToActor: boolean;
  /** The org setting `platformTool`. */
  setting: OrgSettings["platformTool"];
}

/**
 * Reads the facts about the actor of a `Platform` call: the run's trigger account (spec §6.1),
 * re-read on every call, as the HTTP guards would.
 *
 * A person is present when all of these hold:
 * - there is a run, it belongs to the conversation and its trigger account is the actor;
 * - the root conversation of the tree (a sub-agent's is followed up through its parents) is a
 *   `chat` (an `eval` conversation replays, nobody watches it);
 * - the actor is an active member of the org, and not the org's anonymous guest account (a channel
 *   message from an unlinked user under the `anonymous` policy runs as that account).
 *
 * Service tokens cannot start runs (posting a message requires a user principal), so no run is
 * token-started; a wake run (`budget_run_id` set) runs as the person whose run it continues and
 * counts as present. No new run column is needed to tell the origins apart.
 */
@Injectable()
export class PlatformActor {
  constructor(@Inject(KernelDb) private readonly db: KernelDb) {}

  async facts(ctx: {
    orgId: string;
    accountId: string;
    agentId: string;
    conversationId: string;
    runId?: string | null;
  }): Promise<ActorFacts> {
    const [account, settings, agent, anonymous] = await Promise.all([
      this.db
        .selectFrom("accounts")
        .leftJoin("memberships", (j) =>
          j
            .onRef("memberships.account_id", "=", "accounts.id")
            .on("memberships.org_id", "=", ctx.orgId),
        )
        .select(["accounts.is_super_admin", "accounts.status", "memberships.role"])
        .where("accounts.id", "=", ctx.accountId)
        .executeTakeFirst(),
      readOrgSettings(this.db.db, ctx.orgId),
      this.db
        .selectFrom("agents")
        .select(["owner_account_id", "visibility"])
        .where("id", "=", ctx.agentId)
        .where("org_id", "=", ctx.orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst(),
      this.db
        .selectFrom("org_anonymous_accounts")
        .select("account_id")
        .where("org_id", "=", ctx.orgId)
        .where("account_id", "=", ctx.accountId)
        .executeTakeFirst(),
    ]);
    const role = account?.role ?? null;
    const activeMember = role !== null && account?.status === "active";
    return {
      role,
      isSuperAdmin: account?.is_super_admin === true && account.status === "active",
      personPresent: activeMember && anonymous === undefined && (await this.personRun(ctx)),
      agentPrivateToActor:
        agent?.visibility === "private" && agent.owner_account_id === ctx.accountId,
      setting: settings.platformTool,
    };
  }

  /** The run is the actor's, in this conversation, and its tree's root is a `chat`. */
  private async personRun(ctx: {
    orgId: string;
    accountId: string;
    conversationId: string;
    runId?: string | null;
  }): Promise<boolean> {
    if (ctx.runId == null) return false;
    const run = await this.db
      .selectFrom("runs")
      .select("trigger_account_id")
      .where("id", "=", ctx.runId)
      .where("conversation_id", "=", ctx.conversationId)
      .executeTakeFirst();
    if (run?.trigger_account_id !== ctx.accountId) return false;
    const rootId = await rootConversationOf(this.db.db, ctx.conversationId);
    const root = await this.db
      .selectFrom("conversations")
      .select("kind")
      .where("id", "=", rootId)
      .where("org_id", "=", ctx.orgId)
      .executeTakeFirst();
    return root?.kind === "chat";
  }
}
