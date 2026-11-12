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

/** A connector usable for one host, before the pick. */
interface Candidate extends GitSourceFor {
  oauthCode: boolean;
  createdAt: Date;
}

/** Auth types whose credential can be presented as a basic password (not `none` / `headers`). */
const gitCapable = (auth: ConnectorAuth): boolean =>
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
   * - a personal connector (live, active, with `git_hosts`) where this account has its own
   *   credential; never another account's;
   * - an org-credential connector only with `use_for_git` and its org credential present
   *   (`bot: true`);
   * - one per host: with the org's `gitGateway.hostSources[host]` pick only that connector, and
   *   nothing for an account that cannot use it (the pick is org-wide, never a fallback to
   *   another connector or a bot); without a pick the authorization-code (`oauth_code`) one,
   *   else the oldest (then the lowest id).
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
      const hosts = (r.git_hosts ?? []) as GitHostEntry[];
      if (hosts.length === 0 || !gitCapable(auth) || auth.type === "none") continue;
      const bot = auth.ownership === "org";
      if (bot && !r.use_for_git) continue;
      // personal: this account's own credential; org: the org's (status never decrypts)
      if ((await this.credentials.status(orgId, r.id, auth, accountId)) !== "connected") continue;
      for (const h of hosts) {
        const list = byHost.get(h.host) ?? [];
        list.push({
          host: h.host,
          connectorId: r.id,
          username: h.username,
          bot,
          oauthCode: auth.type === "oauth_code",
          createdAt: new Date(r.created_at),
        });
        byHost.set(h.host, list);
      }
    }

    const picks = settings.gitGateway?.hostSources ?? {};
    const out: GitSourceFor[] = [];
    for (const [host, list] of [...byHost].sort(([a], [b]) => a.localeCompare(b))) {
      // the org's pick is org-wide ("never mixed", spec §6.2): only that connector serves the
      // host, and an account that cannot use it gets no source there (never another connector)
      const chosen = Object.hasOwn(picks, host)
        ? list.find((c) => c.connectorId === picks[host])
        : [...list].sort(
            (a, b) =>
              Number(b.oauthCode) - Number(a.oauthCode) ||
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.connectorId.localeCompare(b.connectorId),
          )[0];
      if (chosen === undefined) continue;
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
