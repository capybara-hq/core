import type { RouteCaller } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module, Optional } from "@nestjs/common";
import { getStorageToken, type ThrottlerStorage } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import { currentOrgRole, type Route } from "../ctx/create-ctx.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { EffectiveConfigs, NEEDS_CONFIG_REASON } from "../extensions/effective-config.js";
import { ExtensionStateModule } from "../extensions/state.module.js";
import { AccountsService } from "../identity/accounts.js";
import { ApiTokenService } from "../identity/api-tokens.js";
import { authenticatePersonalToken } from "../identity/auth.guard.js";
import { IdentityModule } from "../identity/identity.module.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { NAMED_THROTTLERS, throttlerKey } from "../infra/throttler/named-throttlers.js";
import { type OrgRole, roleAtLeast } from "../orgs/roles.js";
import type { RouteAccessResolver } from "./plugin-dispatch.js";

/** Optional provider: the public write limit instead of the `plugin-public-write` throttler's (tests). */
export const PLUGIN_PUBLIC_WRITE_LIMIT = Symbol("PLUGIN_PUBLIC_WRITE_LIMIT");

/** The named throttler of unsafe methods on `public` extension routes (per extension and client IP). */
const PUBLIC_WRITE = (() => {
  const t = NAMED_THROTTLERS.find((x) => x.name === "plugin-public-write");
  if (!t) throw new Error('named throttler "plugin-public-write" is missing');
  return t;
})();

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const BEARER_RE = /^Bearer\s+(\S+)$/i;

/**
 * The org role of a person for an extension `member` / `admin` route, in one query (the same as
 * an embed token's live check): the extension enabled in the org, the org not deleted, the account
 * active and a member. Undefined when any of that fails.
 */
export function orgRouteMember(
  db: KernelSchemaDb,
  plugin: string,
  orgId: string,
  accountId: string,
): Promise<OrgRole | undefined> {
  return currentOrgRole(db, plugin, orgId, accountId);
}

const authRequired = () => new ApiError("auth.required", "Authentication required");

/**
 * The kernel's access check for extension routes (spec 2026-11-15-extension-route-auth):
 * - `public`: anyone; POST / PUT / DELETE count against `plugin-public-write` per extension and
 *   client IP (Redis, fail-open like every plain per-route limit), over it 429 `rate_limited`
 *   with `retry-after`.
 * - `embed`: an embed token of this extension as `Authorization: Bearer` (not a `cap_` kernel
 *   token) or `?token=`, verified by the route's own `verifyEmbed` (signature, TTL, scope, live
 *   membership, slot role, extension enabled); missing or invalid -> 401 `auth.required`. An org
 *   token also needs a valid effective config (409 `extension.needs_config`).
 * - `member` / `admin`: a personal API token only (`authenticatePersonalToken`; a cookie is no
 *   credential); not a member, the extension off, or the org gone -> 404 `org.not_found`; a role
 *   below `member` / `admin` -> 403 `forbidden`; an invalid effective config -> 409.
 * Everything is read live (PG / Redis) per request; nothing is kept in the process.
 */
@Injectable()
export class PluginRouteAccess implements RouteAccessResolver {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ApiTokenService) private readonly tokens: ApiTokenService,
    @Inject(EffectiveConfigs) private readonly effective: Pick<EffectiveConfigs, "get">,
    @Inject(getStorageToken()) private readonly throttle: ThrottlerStorage,
    @Optional()
    @Inject(PLUGIN_PUBLIC_WRITE_LIMIT)
    private readonly publicWriteLimit: number = PUBLIC_WRITE.limit,
  ) {}

  async resolve(
    route: Route,
    req: FastifyRequest,
    reply: FastifyReply,
    params: Record<string, string>,
  ): Promise<RouteCaller> {
    switch (route.access) {
      case "public":
        await this.throttlePublicWrite(route, req, reply);
        return { access: "public" };
      case "embed":
        return this.embed(route, req);
      case "member":
      case "admin":
        return this.member(route, req, params);
    }
  }

  private async throttlePublicWrite(
    route: Route,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (SAFE_METHODS.has(req.method.toUpperCase())) return;
    const tracker = `${route.plugin}:${req.ip}`;
    const r = await this.throttle.increment(
      throttlerKey(PUBLIC_WRITE.name, tracker),
      PUBLIC_WRITE.ttl,
      this.publicWriteLimit,
      0,
      PUBLIC_WRITE.name,
    );
    if (!r.isBlocked) return;
    reply.header("retry-after", String(r.timeToBlockExpire));
    throw new ApiError(PUBLIC_WRITE.code ?? "rate_limited", PUBLIC_WRITE.message);
  }

  private async embed(route: Route, req: FastifyRequest): Promise<RouteCaller> {
    const token = embedToken(req);
    if (token === undefined) throw authRequired();
    const claims = await route.verifyEmbed(token);
    if (claims === null) throw authRequired();
    if (claims.scope === "platform") {
      return {
        access: "embed",
        scope: "platform",
        accountId: claims.accountId,
        role: "superAdmin",
        contribution: claims.contribution,
        exp: claims.exp,
      };
    }
    const config = await this.config(claims.orgId, route.plugin);
    return {
      access: "embed",
      scope: "org",
      orgId: claims.orgId,
      accountId: claims.accountId,
      role: claims.role,
      contribution: claims.contribution,
      ...(claims.conversationId !== undefined && { conversationId: claims.conversationId }),
      exp: claims.exp,
      config,
    };
  }

  private async member(
    route: Route,
    req: FastifyRequest,
    params: Record<string, string>,
  ): Promise<RouteCaller> {
    const account = await authenticatePersonalToken(req, {
      accounts: this.accounts,
      tokens: this.tokens,
    });
    const orgId = params.orgId ?? "";
    const role =
      orgId === "" ? undefined : await orgRouteMember(this.kdb.db, route.plugin, orgId, account.id);
    if (role === undefined) throw new ApiError("org.not_found", "Organization not found");
    const min = route.access === "admin" ? "admin" : "member";
    if (!roleAtLeast(role, min)) {
      throw new ApiError("forbidden", "Insufficient organization role");
    }
    const config = await this.config(orgId, route.plugin);
    return {
      access: route.access === "admin" ? "admin" : "member",
      orgId,
      accountId: account.id,
      role,
      config,
    };
  }

  /** The extension's effective config for the org, or 409 `extension.needs_config`. */
  private async config(orgId: string, plugin: string): Promise<unknown> {
    const effective = await this.effective.get(orgId, plugin);
    if (!effective.ok) {
      throw new ApiError("extension.needs_config", `Extension ${plugin} ${NEEDS_CONFIG_REASON}`);
    }
    return effective.config;
  }
}

/** The embed token of a request: `Authorization: Bearer` unless it is a kernel token, else `?token=`. */
function embedToken(req: FastifyRequest): string | undefined {
  const bearer = BEARER_RE.exec(req.headers.authorization ?? "")?.[1];
  if (bearer !== undefined && !bearer.startsWith("cap_")) return bearer;
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof q === "string" && q !== "" ? q : undefined;
}

/** The one {@link PluginRouteAccess}: the HTTP side resolves it lazily for the plugin dispatch. */
@Module({
  imports: [IdentityModule, ExtensionStateModule],
  providers: [PluginRouteAccess],
  exports: [PluginRouteAccess],
})
export class PluginRouteAccessModule {}
