import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { REDIS } from "../infra/tokens.js";
import { type Account, AccountsService } from "./accounts.js";
import type { AppAuthorizeBody, AppTokenBody } from "./app-auth.schemas.js";
import { audit } from "./audit.js";
import { sha256Hex } from "./hash.js";
import type { UserPrincipal } from "./principal.js";
import { type IssuedSession, SessionService } from "./sessions.js";

/** How long a sign-in code lives, seconds (one use within this window). */
export const APP_AUTH_CODE_TTL_SECONDS = 60;
const CODE_PREFIX = "cap_ac_";
const CODE_RE = /^cap_ac_[A-Za-z0-9_-]{43}$/;
/** A PKCE code verifier (RFC 7636 §4.1): 43 to 128 unreserved characters. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/** The stored grant of one code: `capk:app-auth-code:<sha256(code)>`. The code is never stored. */
export const appAuthCodeKey = (code: string): string => `capk:app-auth-code:${sha256Hex(code)}`;

/** What a code stands for, as JSON under its key. */
interface CodeGrant {
  accountId: string;
  /** The browser session that consented: the exchange fails once it signed out. */
  sessionId: string;
  client: "desktop";
  redirectUri: string;
  codeChallenge: string;
  name: string;
  appVersion: string;
}

/** BASE64URL(SHA-256(verifier)): the PKCE `S256` challenge (RFC 7636 §4.2). */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * `uri` with `params` appended to its query (values encoded; existing parameters kept). Allowed
 * redirect URIs carry no fragment (the config refuses one).
 */
export function buildRedirect(uri: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  if (!uri.includes("?")) return `${uri}?${query}`;
  return uri.endsWith("?") || uri.endsWith("&") ? `${uri}${query}` : `${uri}&${query}`;
}

/** Whether `uri` is one of `allowed`, compared as exact strings (no prefix, no case folding). */
export function isAllowedRedirect(uri: string, allowed: readonly string[]): boolean {
  return allowed.includes(uri);
}

/** The session user agent of an app session: `Capybara Desktop/<appVersion> (<name>)`. */
const appUserAgent = (g: Pick<CodeGrant, "appVersion" | "name">) =>
  `Capybara Desktop/${g.appVersion} (${g.name})`;

const codeInvalid = () =>
  new ApiError(
    "app_auth.code_invalid",
    "The sign-in code is invalid, already used or expired; start the sign-in from the app again",
  );

/**
 * Native-app sign-in (desktop client spec §6.5): the authorization code flow with PKCE for native
 * apps (RFC 8252, RFC 7636). The signed-in person consents on the web (`authorize`), which issues
 * a one-time code bound to the PKCE challenge, the redirect URI and the browser session; the app
 * exchanges it (`token`) for an ordinary web session of its own. State lives only in Redis, under
 * the code's hash with a 60 s TTL, so any replica can exchange it.
 */
@Injectable()
export class AppAuthService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(SessionService) private readonly sessions: Pick<SessionService, "create">,
    @Inject(AccountsService) private readonly accounts: Pick<AccountsService, "get">,
  ) {}

  /**
   * The person's consent from the browser session `principal`: the redirect to hand to the app,
   * with `code`, `state` and `iss`, or with `error=access_denied` (no code) when `deny`. An
   * unlisted redirect URI is refused before anything is stored.
   */
  async authorize(principal: UserPrincipal, body: AppAuthorizeBody): Promise<{ redirect: string }> {
    if (principal.via !== "session") {
      throw new ApiError("auth.session_required", "This endpoint requires a web session");
    }
    if (!isAllowedRedirect(body.redirectUri, this.config.get().auth.appRedirectUris)) {
      throw new ApiError(
        "app_auth.redirect_uri_invalid",
        "The redirect URI is not one this platform allows for apps (auth.appRedirectUris)",
      );
    }
    const iss = this.issuer();
    if (body.deny === true) {
      return {
        redirect: buildRedirect(body.redirectUri, {
          error: "access_denied",
          state: body.state,
          iss,
        }),
      };
    }
    const code = CODE_PREFIX + randomBytes(32).toString("base64url");
    const grant: CodeGrant = {
      accountId: principal.account.id,
      sessionId: principal.sessionId,
      client: body.client,
      redirectUri: body.redirectUri,
      codeChallenge: body.codeChallenge,
      name: body.name,
      appVersion: body.appVersion,
    };
    // a plain SET: 32 random bytes do not collide (and `kc-lock` keeps SET NX to LockService)
    await this.redis.set(
      appAuthCodeKey(code),
      JSON.stringify(grant),
      "EX",
      APP_AUTH_CODE_TTL_SECONDS,
    );
    await this.recordAuthorized(principal.account.id, grant);
    return { redirect: buildRedirect(body.redirectUri, { code, state: body.state, iss }) };
  }

  /**
   * The app's exchange: the code is taken from Redis with GETDEL before anything else (one use:
   * a wrong verifier or redirect URI burns it too), then checked against `redirectUri` and
   * `S256(codeVerifier)`; the session is created in {@link signIn}. Every failure is
   * `app_auth.code_invalid`.
   */
  async token(
    body: AppTokenBody,
    meta: { ip: string },
  ): Promise<{ account: Account; session: IssuedSession }> {
    if (!CODE_RE.test(body.code)) throw codeInvalid();
    const stored = await this.redis.getdel(appAuthCodeKey(body.code));
    if (stored === null) throw codeInvalid();
    const grant = JSON.parse(stored) as CodeGrant;
    if (body.redirectUri !== grant.redirectUri) throw codeInvalid();
    if (!VERIFIER_RE.test(body.codeVerifier)) throw codeInvalid();
    const got = Buffer.from(s256(body.codeVerifier), "ascii");
    const want = Buffer.from(grant.codeChallenge, "ascii");
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw codeInvalid();
    return this.signIn(grant, meta.ip);
  }

  /**
   * Creates the app's session for a verified grant: the account must be active (its row is held
   * `FOR SHARE`, so a concurrent disable waits for this commit and then revokes the new session
   * too) and the consenting browser session still live. Audits `auth.app_signed_in`.
   */
  @Transactional()
  private async signIn(
    grant: CodeGrant,
    ip: string,
  ): Promise<{ account: Account; session: IssuedSession }> {
    const row = await this.db
      .selectFrom("accounts")
      .select("status")
      .where("id", "=", grant.accountId)
      .forShare()
      .executeTakeFirst();
    if (row?.status !== "active") throw codeInvalid();
    const consenting = await this.db
      .selectFrom("sessions")
      .select("id")
      .where("id", "=", grant.sessionId)
      .where("account_id", "=", grant.accountId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    if (!consenting) throw codeInvalid();
    const account = await this.accounts.get(grant.accountId);
    if (!account) throw codeInvalid();
    const session = await this.sessions.create(grant.accountId, {
      userAgent: appUserAgent(grant),
      ip,
    });
    await audit(this.db.db, {
      actorAccountId: grant.accountId,
      action: "auth.app_signed_in",
      detail: { client: grant.client, name: grant.name, sessionId: session.sessionId },
    });
    return { account, session };
  }

  @Transactional()
  private async recordAuthorized(accountId: string, grant: CodeGrant): Promise<void> {
    await audit(this.db.db, {
      actorAccountId: accountId,
      action: "auth.app_authorized",
      detail: { client: grant.client, name: grant.name },
    });
  }

  /** `iss`: `http.publicUrl` without a trailing slash, the origin the app checks (RFC 9207). */
  private issuer(): string {
    const url = this.config.get().http.publicUrl;
    if (!url) {
      throw new ApiError(
        "app_auth.unavailable",
        "Signing apps in needs http.publicUrl to be configured; ask the super admin",
      );
    }
    return url.replace(/\/+$/, "");
  }
}
