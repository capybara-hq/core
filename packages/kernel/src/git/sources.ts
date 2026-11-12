import type { GitHostEntry } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { isAnonymousGuest } from "../orgs/members.service.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import { type ConnectorAuth, Credentials, isOAuth } from "../tools/credentials.js";

/**
 * Git sources (sandbox git credentials spec §6): which connector's credential the git gateway
 * presents to a git host for one actor. Everything is read live per call (no process memory).
 */

/** The source of one git host for one actor. */
export interface GitSourceFor {
  /** The git host (from the connector's `git_hosts`), e.g. `github.com`. */
  host: string;
  connectorId: string;
  /** The basic username the host expects with a token password (GitHub: `x-access-token`). */
  username: string;
  /** An org connector an admin turned on for git: pushes are the bot's, not the person's. */
  bot: boolean;
}

/** An org connector declaring one host, before the org-wide choice. */
interface Candidate extends GitSourceFor {
  auth: ConnectorAuth;
  oauthCode: boolean;
  createdAt: Date;
}

/**
 * The org-wide default among a host's candidates (no pick): personal-ownership connectors before
 * `use_for_git` bots, then the authorization-code one, then the oldest, then the lowest id.
 */
function byDefault(a: Candidate, b: Candidate): number {
  return (
    Number(a.bot) - Number(b.bot) ||
    Number(b.oauthCode) - Number(a.oauthCode) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.connectorId.localeCompare(b.connectorId)
  );
}

/** Auth types whose credential can be presented as a basic password (not `none` / `headers`). */
const gitCapable = (
  auth: ConnectorAuth,
): auth is Exclude<ConnectorAuth, { type: "none" } | { type: "headers" }> =>
  auth.type === "bearer" || auth.type === "api_key" || auth.type === "basic" || isOAuth(auth);

@Injectable()
export class GitSources {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(Credentials) private readonly credentials: Pick<Credentials, "status">,
    /** Read per call: `tools.git.enabled` is hot. */
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
  ) {}

  /**
   * The git sources of `accountId` in `orgId`, one per host (spec §6.2):
   *
   * - nothing while the gateway is off (`tools.git.enabled`, the org's `gitGateway.enabled`), for
   *   an account that is not an active member of the live org, or for an anonymous channel guest;
   * - one connector per host for the whole org ("never mixed"): the org's
   *   `gitGateway.hostSources[host]` pick; without one, among the org's live, active connectors
   *   declaring the host (personal-ownership ones, and org-credential ones only with
   *   `use_for_git`): a personal one before a bot (a bot is the default only when no personal
   *   connector declares the host), the authorization-code (`oauth_code`) one first, else the
   *   oldest;
   * - the account gets that connector only when it can use it: its own credential for a
   *   personal one (never another account's), the org credential for a bot (`bot: true`);
   *   otherwise no source for the host, never another connector.
   */
  async sourcesFor(orgId: string, accountId: string): Promise<GitSourceFor[]> {
    if (!this.config.get().tools.git.enabled) return [];
    const db = this.db.db;
    const member = await db
      .selectFrom("memberships as m")
      .innerJoin("accounts as a", "a.id", "m.account_id")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select("m.account_id")
      .where("m.org_id", "=", orgId)
      .where("m.account_id", "=", accountId)
      .where("a.status", "=", "active")
      .where("o.deleted_at", "is", null)
      .executeTakeFirst();
    if (member === undefined) return [];
    // anonymous channel guests never get a credential (spec §6.2)
    if (await isAnonymousGuest(db, accountId)) return [];
    const settings = await readOrgSettings(db, orgId);
    if (settings.gitGateway?.enabled === false) return [];

    const rows = await db
      .selectFrom("connectors")
      .select(["id", "auth", "git_hosts", "use_for_git", "created_at"])
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .where("status", "=", "active")
      .where("git_hosts", "is not", null)
      .execute();
    const byHost = new Map<string, Candidate[]>();
    for (const r of rows) {
      const auth = r.auth as unknown as ConnectorAuth;
      if (!gitCapable(auth)) continue;
      const bot = auth.ownership === "org";
      if (bot && !r.use_for_git) continue;
      for (const h of (r.git_hosts ?? []) as GitHostEntry[]) {
        const list = byHost.get(h.host) ?? [];
        list.push({
          host: h.host,
          connectorId: r.id,
          username: h.username,
          bot,
          auth,
          oauthCode: auth.type === "oauth_code",
          createdAt: new Date(r.created_at),
        });
        byHost.set(h.host, list);
      }
    }

    const picks = settings.gitGateway?.hostSources ?? {};
    const out: GitSourceFor[] = [];
    for (const [host, list] of [...byHost].sort(([a], [b]) => a.localeCompare(b))) {
      const chosen = Object.hasOwn(picks, host)
        ? list.find((c) => c.connectorId === picks[host])
        : [...list].sort(byDefault)[0];
      if (chosen === undefined) continue;
      // personal: this account's own credential; bot: the org's (status never decrypts)
      const usable = await this.credentials.status(
        orgId,
        chosen.connectorId,
        chosen.auth,
        accountId,
      );
      if (usable !== "connected") continue;
      out.push({
        host,
        connectorId: chosen.connectorId,
        username: chosen.username,
        bot: chosen.bot,
      });
    }
    return out;
  }
}
