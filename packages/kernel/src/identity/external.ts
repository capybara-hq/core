import { randomUUID } from "node:crypto";
import type { ExternalIdentity } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { LinkedVia } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { audit } from "./audit.js";
import { ExternalIdentityLock } from "./external-identity-lock.js";
import { LoginSourcesService } from "./login-sources.js";
import { decideSsoCallback, type SsoDecision, type SsoIntent } from "./sso-decisions.js";

/** `<插件名>:<租户 id>`；插件名同清单规则，租户 id 为非空、不含空白的串。 */
const SOURCE_RE = /^([a-z0-9][a-z0-9._-]{0,213}):(\S{1,256})$/;
const MAX_EXTERNAL_ID = 256;
const MAX_DISPLAY_NAME = 200;
const MAX_EMAIL = 320;

export type { LinkedVia };

/** The options of {@link ExternalIdentities.resolve}. */
export interface ResolveOptions {
  /**
   * How a new identity row is made: `sso` (a sign-in's self sign-up), `directory` (directory
   * sync). An existing row keeps its kind.
   */
  linkedVia: "sso" | "directory";
}

/** How a verified link was made (`identity.linked` audit `via`). */
export type VerifiedLinkVia = "oauth" | "link_page" | "verified_email";

/** A sign-in decision once applied: a creation is reported as the sign-in of the new account. */
export type SignInDecision = Exclude<SsoDecision, { kind: "create" }>;

/** The sign-in callback's context for {@link ExternalIdentities.decideSignIn}. */
export interface SignInContext {
  intent: SsoIntent;
  /** Link intent only: the account of the web session the start and the callback both carried. */
  sessionAccountId?: string;
  /** The login source's setting for an unlinked external account. */
  signUp: "link" | "create";
}

/** 账号已绑定的一个外部身份（不含本地登录名）。 */
export interface LinkedIdentity {
  source: string;
  externalId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  /**
   * 身份行是怎么建立的（Ruling A18）：`bind` 只能在 IM 里代表本人，要用于第三方登录须本人登录后完成一次该身份的
   * 第三方登录（网页据此显示「验证」）；null 为 0019 之前的旧行（按 sso 处理）。
   */
  linkedVia: "bind" | "sso" | "directory" | "local" | null;
  createdAt: Date;
}

/** 身份源键里的插件名（`source` 中 `:` 之前的部分）。 */
export function identityPlugin(source: string): string {
  const i = source.indexOf(":");
  return i < 0 ? source : source.slice(0, i);
}

const invalid = (message: string) =>
  new ApiError("validation_failed", "Invalid external identity", [{ path: "identity", message }]);

/** 校验插件交来的外部身份（键的格式、长度），返回规范化后的副本。 */
function normalize(identity: ExternalIdentity): ExternalIdentity {
  const m = SOURCE_RE.exec(identity.source);
  if (!m || m[1] === "local") {
    throw invalid('source must be "<plugin>:<tenant>"');
  }
  // 身份源键的租户必须就是身份的租户（Ruling A19）：信任按租户判断，不能让键与租户各说各的
  if (identity.tenantId !== m[2]) {
    throw invalid("source tenant must equal tenantId");
  }
  if (
    typeof identity.externalId !== "string" ||
    identity.externalId.length === 0 ||
    identity.externalId.length > MAX_EXTERNAL_ID
  ) {
    throw invalid(`externalId must be 1-${MAX_EXTERNAL_ID} characters`);
  }
  const email =
    typeof identity.email === "string" && identity.email.length > 0
      ? identity.email.trim().slice(0, MAX_EMAIL)
      : undefined;
  const displayName =
    (typeof identity.displayName === "string" ? identity.displayName.trim() : "").slice(
      0,
      MAX_DISPLAY_NAME,
    ) || identity.externalId.slice(0, MAX_DISPLAY_NAME);
  return {
    source: identity.source,
    externalId: identity.externalId,
    tenantId: identity.tenantId,
    ...(email !== undefined && { email }),
    emailVerified: email !== undefined && identity.emailVerified === true,
    displayName,
    ...(typeof identity.avatarUrl === "string" && { avatarUrl: identity.avatarUrl.slice(0, 2000) }),
  };
}

const profileOf = (i: ExternalIdentity) =>
  JSON.stringify({
    tenantId: i.tenantId,
    displayName: i.displayName,
    ...(i.avatarUrl !== undefined && { avatarUrl: i.avatarUrl }),
  });

/**
 * External identities: `(source, externalId)` maps to an account (sign-in, channel inbound and the
 * directory share the key). A sign-in of an identity nobody has linked ({@link decideSignIn})
 * merges into an existing account when its tenant is trusted and both emails are verified;
 * otherwise it goes to the link page by default, and creates a new org-less account only when the
 * login source's `signUp` is `create`. Directory sync creates the account for its identity
 * ({@link resolve}). Concurrent first resolves of one identity are serialized by
 * {@link ExternalIdentityLock}, so only one account is created.
 */
@Injectable()
export class ExternalIdentities {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ExternalIdentityLock) private readonly identityLock: ExternalIdentityLock,
    @Inject(LoginSourcesService)
    private readonly loginSources: Pick<LoginSourcesService, "isTrusted">,
  ) {}

  /** The account the external identity is linked to (in the context's transaction when there is one); undefined when unlinked. */
  async findAccount(source: string, externalId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom("identities")
      .select("account_id")
      .where("source", "=", source)
      .where("external_id", "=", externalId)
      .executeTakeFirst();
    return row?.account_id;
  }

  /**
   * Resolves an external identity to an account: linked → that account (the row's email and
   * profile are refreshed); unlinked → a new org-less account with this identity, the row
   * recording `linked_via = opts.linkedVia`. It never merges by email and never checks a row for
   * sign-in: the sign-in callback goes through {@link decideSignIn} (which calls this only for a
   * self sign-up); directory sync calls it directly. A created account's `email_verified` is true
   * only when the source is trusted and the identity's email is verified: an untrusted source can
   * claim any email "verified", and its accounts must not become merge targets of a later trusted
   * sign-in. A creation audits `account.created`. The account's status is not checked.
   * Joins the caller's transaction when there is one; takes the same lock as `link`, and falls back
   * to `ON CONFLICT DO NOTHING` plus a re-read, so it never throws a unique violation or aborts the
   * caller's transaction.
   */
  @Transactional()
  async resolve(
    identity: ExternalIdentity,
    opts: ResolveOptions,
  ): Promise<{ accountId: string; created: boolean }> {
    const id = normalize(identity);
    await this.lockIdentity(id);
    const existing = await this.findRow(id);
    if (existing !== undefined) {
      await this.refreshIdentity(id);
      return { accountId: existing.accountId, created: false };
    }
    const accountId = randomUUID();
    await this.db
      .insertInto("accounts")
      .values({
        id: accountId,
        display_name: id.displayName,
        email: id.email ?? null,
        email_verified: id.emailVerified && (await this.trusted(id.source)),
      })
      .execute();
    if (!(await this.insertIdentity(accountId, id, opts.linkedVia))) {
      // a writer that skipped the lock inserted the same identity first: undo the account, re-read
      await this.db.deleteFrom("accounts").where("id", "=", accountId).execute();
      return { accountId: await this.mustFind(id), created: false };
    }
    await audit(this.db.db, {
      actorAccountId: accountId,
      action: "account.created",
      target: accountId,
      detail: { source: id.source, externalId: id.externalId },
    });
    return { accountId, created: true };
  }

  /**
   * The sign-in callback's decision on a verified external identity (spec §4,
   * {@link decideSsoCallback}), taken and applied in one transaction under the identity lock: the
   * row and the merge target are read under the lock, then `signin` / `refresh` refresh the row,
   * `upgrade` and `linked` go through {@link linkVerified}, `create` creates the account
   * ({@link resolve}, no merge: the decision ruled it out). `link_page` and `error` write nothing.
   * A link intent never creates an account. Returns the decision, whether an account was created
   * and the normalized identity (what a link page stores). Throws `identity.taken` when a concurrent writer linked the
   * identity to another account between the read and the write (cannot happen under the lock
   * except for a writer that skips it).
   */
  @Transactional()
  async decideSignIn(
    identity: ExternalIdentity,
    ctx: SignInContext,
  ): Promise<{ decision: SignInDecision; identity: ExternalIdentity; created: boolean }> {
    const id = normalize(identity);
    await this.lockIdentity(id);
    const row = await this.findRow(id);
    // the merge target matters only to a sign-in of an unlinked identity (a link intent links to
    // the session's account whatever the email says)
    const mergeTarget =
      row === undefined && ctx.intent === "signin" ? await this.mergeTarget(id) : undefined;
    const decision = decideSsoCallback({
      intent: ctx.intent,
      ...(ctx.sessionAccountId !== undefined && { sessionAccountId: ctx.sessionAccountId }),
      ...(row !== undefined && { row }),
      ...(mergeTarget !== undefined && { mergeTarget }),
      signUp: ctx.signUp,
    });
    switch (decision.kind) {
      case "create": {
        const r = await this.resolve(id, { linkedVia: "sso" });
        return {
          decision: { kind: "signin", accountId: r.accountId },
          identity: id,
          created: r.created,
        };
      }
      case "signin":
      case "refresh":
        await this.refreshIdentity(id);
        break;
      case "upgrade":
        await this.linkVerified(decision.accountId, id, "oauth");
        break;
      case "linked":
        // a disabled merge target gets no row: reported as its sign-in, which the caller refuses
        // (auth.account_disabled) as it refuses any disabled account
        if (decision.via === "verified_email" && !(await this.isActive(decision.accountId))) {
          return {
            decision: { kind: "signin", accountId: decision.accountId },
            identity: id,
            created: false,
          };
        }
        await this.linkVerified(decision.accountId, id, decision.via);
        break;
      case "link_page":
      case "error":
        break;
    }
    return { decision, identity: id, created: false };
  }

  private async isActive(accountId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("accounts")
      .select("status")
      .where("id", "=", accountId)
      .executeTakeFirst();
    return row?.status === "active";
  }

  /**
   * Links an external identity whose control the person proved (a third-party sign-in, or the
   * link page's password plus the sign-in) to `accountId` as `sso`: no row → a new `sso` row
   * (audit `identity.linked` with `via`); a `bind` row of the same account → upgraded to `sso`
   * (audit `identity.verified`); an `sso` / `directory` / legacy row of the same account → its
   * profile refreshed; a row of another account → `409 identity.taken`. Under the identity lock,
   * in the caller's transaction when there is one.
   */
  @Transactional()
  async linkVerified(
    accountId: string,
    identity: ExternalIdentity,
    via: VerifiedLinkVia,
  ): Promise<void> {
    const id = normalize(identity);
    await this.lockIdentity(id);
    const row = await this.findRow(id);
    if (row !== undefined && row.accountId !== accountId) throw taken();
    if (row !== undefined) {
      await this.refreshIdentity(id);
      if (row.linkedVia !== "bind") return;
      await this.db
        .updateTable("identities")
        .set({ linked_via: "sso" })
        .where("source", "=", id.source)
        .where("external_id", "=", id.externalId)
        .execute();
      await audit(this.db.db, {
        actorAccountId: accountId,
        action: "identity.verified",
        target: accountId,
        detail: { source: id.source, externalId: id.externalId, from: "bind", via },
      });
      return;
    }
    if (!(await this.insertIdentity(accountId, id, "sso"))) {
      if ((await this.mustFind(id)) !== accountId) throw taken();
      return;
    }
    await audit(this.db.db, {
      actorAccountId: accountId,
      action: "identity.linked",
      target: accountId,
      detail: { source: id.source, externalId: id.externalId, via },
    });
  }

  /**
   * The account an identity row links to and how it was made, without a lock (the link page's
   * read-only view; any write re-reads under the lock).
   */
  async peekRow(
    identity: Pick<ExternalIdentity, "source" | "externalId">,
  ): Promise<{ accountId: string; linkedVia: LinkedVia | null } | undefined> {
    return this.findRow(identity);
  }

  /** Serializes resolve / link of one identity ({@link ExternalIdentityLock}). */
  private async lockIdentity(id: ExternalIdentity): Promise<void> {
    await this.identityLock.lock(id);
  }

  /**
   * Whether the source key (`<plugin>:<tenant>`) is trusted: its tenant is among the login
   * source's trusted tenants, full key match, trust is per tenant (Ruling A19).
   */
  private trusted(source: string): Promise<boolean> {
    return this.loginSources.isTrusted(source);
  }

  private async findRow(
    id: Pick<ExternalIdentity, "source" | "externalId">,
  ): Promise<{ accountId: string; linkedVia: LinkedVia | null } | undefined> {
    const row = await this.db
      .selectFrom("identities")
      .select(["account_id", "linked_via"])
      .where("source", "=", id.source)
      .where("external_id", "=", id.externalId)
      .executeTakeFirst();
    return row && { accountId: row.account_id, linkedVia: row.linked_via };
  }

  private async mustFind(id: ExternalIdentity): Promise<string> {
    const owner = await this.findAccount(id.source, id.externalId);
    if (owner === undefined) throw new Error("identity vanished after a conflicting insert");
    return owner;
  }

  private async refreshIdentity(id: ExternalIdentity): Promise<void> {
    await this.db
      .updateTable("identities")
      .set({
        email: id.email ?? null,
        email_verified: id.emailVerified,
        profile: profileOf(id),
        updated_at: sql`now()`,
      })
      .where("source", "=", id.source)
      .where("external_id", "=", id.externalId)
      .execute();
  }

  /**
   * The existing account to merge into: the source key is trusted (a trusted tenant of its login
   * source), the identity's email is verified, and exactly one account has the same verified email
   * (case-insensitive); else undefined (with several candidates it never guesses).
   */
  private async mergeTarget(id: ExternalIdentity): Promise<string | undefined> {
    if (!id.emailVerified || id.email === undefined || !(await this.trusted(id.source))) {
      return undefined;
    }
    const rows = await this.db
      .selectFrom("accounts")
      .select("id")
      .where("email_verified", "=", true)
      .where(sql<string>`lower(email)`, "=", id.email.toLowerCase())
      .limit(2)
      .execute();
    return rows.length === 1 ? rows[0]?.id : undefined;
  }

  /** 插入身份行；已存在（主键冲突）时什么都不做并返回 false。 */
  private async insertIdentity(
    accountId: string,
    id: ExternalIdentity,
    linkedVia: LinkedVia,
  ): Promise<boolean> {
    const row = await this.db
      .insertInto("identities")
      .values({
        source: id.source,
        external_id: id.externalId,
        account_id: accountId,
        email: id.email ?? null,
        email_verified: id.emailVerified,
        profile: profileOf(id),
        linked_via: linkedVia,
        updated_at: sql`now()`,
      })
      .onConflict((oc) => oc.columns(["source", "external_id"]).doNothing())
      .returning("account_id")
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * 把外部身份绑定到账号（IM 里点绑定链接等）：已绑定本人 → 刷新资料，幂等（不改 `linked_via`）；
   * 已绑定他人 → `409 identity.taken`。新行记 `linked_via = bind`：这样绑定的身份只能在 IM 里代表此人，
   * 不能直接用于第三方登录（Ruling A18）。与 `resolve` 取同一把咨询锁。新绑定写审计 `identity.linked`。
   */
  @Transactional()
  async link(accountId: string, identity: ExternalIdentity): Promise<void> {
    const id = normalize(identity);
    await this.lockIdentity(id);
    const owner = await this.findAccount(id.source, id.externalId);
    if (owner !== undefined && owner !== accountId) throw taken();
    if (owner === accountId) {
      await this.refreshIdentity(id);
      return;
    }
    if (!(await this.insertIdentity(accountId, id, "bind"))) {
      if ((await this.mustFind(id)) !== accountId) throw taken();
      return;
    }
    await audit(this.db.db, {
      actorAccountId: accountId,
      action: "identity.linked",
      target: accountId,
      detail: { source: id.source, externalId: id.externalId, via: "bind" },
    });
  }

  /**
   * 解除本人的一个外部身份（本地登录名不可解除）；不存在或不属于本人 → `identity.not_found`；
   * 账号没有本地密码且这是最后一个外部身份 → `409 identity.last_login_method`。审计 `identity.unlinked`。
   */
  async unlink(accountId: string, source: string, externalId: string): Promise<void> {
    if (source === "local") throw notFound();
    await this.unlinkIn(accountId, source, externalId);
  }

  @Transactional()
  private async unlinkIn(accountId: string, source: string, externalId: string): Promise<void> {
    const r = await this.db
      .deleteFrom("identities")
      .where("source", "=", source)
      .where("external_id", "=", externalId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    if (r.numDeletedRows === 0n) throw notFound();
    // 没有本地密码时至少还要剩一个外部身份，否则此人再也登录不了（锁账号行，串行化并发解除）
    await this.db
      .selectFrom("accounts")
      .select("id")
      .where("id", "=", accountId)
      .forUpdate()
      .execute();
    const password = await this.db
      .selectFrom("local_passwords")
      .select("account_id")
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    const others = await this.db
      .selectFrom("identities")
      .select("source")
      .where("account_id", "=", accountId)
      .where("source", "!=", "local")
      .limit(1)
      .execute();
    if (!password && others.length === 0) {
      throw new ApiError(
        "identity.last_login_method",
        "Cannot unlink the last sign-in method of an account without a password",
      );
    }
    await audit(this.db.db, {
      actorAccountId: accountId,
      action: "identity.unlinked",
      target: accountId,
      detail: { source, externalId },
    });
  }

  /** 账号绑定的外部身份（不含本地登录名），按绑定时间升序。 */
  async listForAccount(accountId: string): Promise<LinkedIdentity[]> {
    const rows = await this.db
      .selectFrom("identities")
      .select([
        "source",
        "external_id",
        "email",
        "email_verified",
        "profile",
        "linked_via",
        "created_at",
      ])
      .where("account_id", "=", accountId)
      .where("source", "!=", "local")
      .orderBy("created_at")
      .orderBy("source")
      .orderBy("external_id")
      .execute();
    return rows.map((r) => {
      const p = (r.profile ?? {}) as { displayName?: unknown; avatarUrl?: unknown };
      return {
        source: r.source,
        externalId: r.external_id,
        email: r.email,
        emailVerified: r.email_verified,
        displayName: typeof p.displayName === "string" ? p.displayName : null,
        avatarUrl: typeof p.avatarUrl === "string" ? p.avatarUrl : null,
        linkedVia: r.linked_via,
        createdAt: r.created_at,
      };
    });
  }
}

const taken = () =>
  new ApiError("identity.taken", "This external identity is already linked to another account");
const notFound = () => new ApiError("identity.not_found", "External identity not found");
