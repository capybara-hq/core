import { createHash } from "node:crypto";
import type { GitHostEntry } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { KernelConfig } from "../config/schema.js";
import { CacheService } from "../infra/cache/cache.service.js";
import { Cacheable } from "../infra/cache/cacheable.decorator.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import type { NetPolicy } from "../net/public-address.js";
import { safeFetch } from "../net/safe-fetch.js";
import { type ConnectorAuth, CredentialMissing, Credentials } from "../tools/credentials.js";

/**
 * Commit identity for git in sandboxes (sandbox git credentials spec §5.4, decision 8): the
 * person's GitHub display name and noreply address, read once through their connection.
 */

/** A commit identity (`GIT_AUTHOR_*` / `GIT_COMMITTER_*`). */
export interface GitIdentity {
  name: string;
  email: string;
}

/** What is cached per (org, connector, account, host): never a token. */
export interface GitHubUser {
  /** The GitHub display name, null when unset. */
  name: string | null;
  login: string;
  id: number;
}

/** How long a read GitHub user is cached (24 h). */
export const GIT_IDENTITY_TTL_SECONDS = 24 * 60 * 60;

/**
 * Test seam (`KernelAppOptions.overrides`): the API base of a git host in place of
 * {@link gitIdentityApiBase}, e.g. a loopback fake for `github.com`.
 */
export const GIT_IDENTITY_API_BASE = Symbol("GIT_IDENTITY_API_BASE");
export type GitIdentityApiBase = (host: string) => string | null;

const GHE_COM = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.ghe\.com$/;

/**
 * The REST API base of a git host: `github.com` → `https://api.github.com`, `<sub>.ghe.com` →
 * `https://api.<sub>.ghe.com`; any other host has no identity (null).
 */
export function gitIdentityApiBase(host: string): string | null {
  if (host === "github.com") return "https://api.github.com";
  const m = GHE_COM.exec(host);
  return m === null ? null : `https://api.${m[1]}.ghe.com`;
}

/**
 * The kernel's outbound rules for git hosts and their APIs: the deployment's egress proxy, its
 * private host exemptions (`marketplaces.allowPrivateHosts`) and loopback http only under
 * `tools.oauthAllowInsecureLoopback` (tests), as for OAuth URLs. Redirects are never followed.
 */
export function gitNetPolicy(config: KernelConfig): NetPolicy {
  return {
    allowInsecureLoopback: config.tools.oauthAllowInsecureLoopback,
    allowPrivateHosts: config.marketplaces.allowPrivateHosts,
    trustedOrigins: [],
    ...(config.net.httpsProxy !== undefined && {
      proxy: { url: config.net.httpsProxy, noProxy: config.net.noProxy },
    }),
  };
}

/** Bounds of a `GET /user` answer. */
const USER_MAX_BYTES = 256 * 1024;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;
const NAME_MAX = 200;

/** A display name safe for an environment variable: no control characters, bounded. */
function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = [...v]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      return c < 0x20 || c === 0x7f ? " " : ch;
    })
    .join("")
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return s === "" ? null : s;
}

/** The fields kept from a `GET /user` answer, or null when it does not look like a user. */
export function parseGitHubUser(body: unknown): GitHubUser | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { login?: unknown; id?: unknown; name?: unknown };
  if (typeof b.login !== "string" || !LOGIN_RE.test(b.login)) return null;
  if (typeof b.id !== "number" || !Number.isSafeInteger(b.id) || b.id <= 0) return null;
  return { name: cleanName(b.name), login: b.login, id: b.id };
}

@Injectable()
export class GitIdentities {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(Credentials)
    private readonly credentials: Pick<
      Credentials,
      "gitAuthorization" | "gitUnauthorized" | "checkRevision"
    >,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    /** Read by `@Cacheable`. */
    @Inject(CacheService) readonly cacheService: CacheService,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Optional() @Inject(GIT_IDENTITY_API_BASE) private readonly apiBase?: GitIdentityApiBase,
  ) {}

  /**
   * The commit identity of `accountId` through the connector's credential on `host`: the GitHub
   * `name` (else the login) and `<id>+<login>@users.noreply.<host>`. Null for a host without an
   * identity API (not github.com or `*.ghe.com`), a connector of another org or without that host,
   * a missing credential or an API failure (git then uses the sandbox's own config).
   *
   * Cached per (org, connector, subject, host, credential revision): the subject is the account
   * for a personal connector and `org` for an org-credential one (the bot's identity is the same
   * for every member, read once); the revision (`Credentials.checkRevision`, hashed) changes when
   * the credential is set, refreshed or cleared, so a reconnect reads the user again.
   */
  async gitIdentity(
    orgId: string,
    connectorId: string,
    accountId: string,
    host: string,
  ): Promise<GitIdentity | null> {
    const base = (this.apiBase ?? gitIdentityApiBase)(host);
    if (base === null) return null;
    const row = await this.db.db
      .selectFrom("connectors")
      .select(["auth", "git_hosts"])
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const entry = ((row?.git_hosts ?? []) as GitHostEntry[]).find((h) => h.host === host);
    if (row === undefined || entry === undefined) return null;
    const auth = row.auth as unknown as ConnectorAuth;
    const bot = auth.type !== "none" && auth.ownership === "org";
    const subject = bot ? "org" : accountId;
    const revision = createHash("sha256")
      .update(await this.credentials.checkRevision(orgId, connectorId, bot ? null : accountId))
      .digest("hex")
      .slice(0, 16);
    const user = await this.gitHubUser(orgId, connectorId, subject, host, revision, {
      base,
      auth,
      username: entry.username,
      accountId,
    });
    if (user === null) return null;
    return {
      name: user.name ?? user.login,
      email: `${user.id}+${user.login}@users.noreply.${host}`,
    };
  }

  /**
   * `GET /user` on the host's API with the connector's credential (one forced refresh after a
   * 401), cached 24 h under the first five arguments (see {@link gitIdentity}); failures are not
   * cached. The cached value holds no token; the log lines name the connector and the status,
   * never a header. Called by {@link gitIdentity} only.
   */
  @Cacheable({ key: "git-identity:#{0}:#{1}:#{2}:#{3}:#{4}", ttl: GIT_IDENTITY_TTL_SECONDS })
  async gitHubUser(
    orgId: string,
    connectorId: string,
    _subject: string,
    host: string,
    _revision: string,
    req: { base: string; auth: ConnectorAuth; username: string; accountId: string },
  ): Promise<GitHubUser | null> {
    const { base, auth, accountId, username } = req;
    const config = this.config.get();
    const get = async (authorization: string) =>
      safeFetch(
        `${base}/user`,
        {
          headers: {
            Authorization: authorization,
            Accept: "application/vnd.github+json",
            "User-Agent": "capybara-git-gateway",
          },
          signal: AbortSignal.timeout(Math.min(config.tools.timeoutMs, 30_000)),
        },
        gitNetPolicy(config),
        { maxBytes: USER_MAX_BYTES },
      );
    try {
      const authorization = await this.credentials.gitAuthorization(
        orgId,
        connectorId,
        auth,
        accountId,
        username,
      );
      let res = await get(authorization);
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        await this.credentials.gitUnauthorized(orgId, connectorId, auth, accountId, authorization);
        res = await get(
          await this.credentials.gitAuthorization(orgId, connectorId, auth, accountId, username),
        );
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        this.log.warn("git identity: the user lookup failed", {
          connectorId,
          host,
          status: res.status,
        });
        return null;
      }
      const user = parseGitHubUser(await res.json());
      if (user === null) {
        this.log.warn("git identity: the user lookup answered no user", { connectorId, host });
      }
      return user;
    } catch (e) {
      if (!(e instanceof CredentialMissing)) {
        this.log.warn("git identity: the user lookup failed", {
          connectorId,
          host,
          error: e instanceof Error ? e.name : "unknown",
        });
      }
      return null;
    }
  }
}
