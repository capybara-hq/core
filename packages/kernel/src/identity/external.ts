import { randomUUID } from "node:crypto";
import type { ExternalIdentity } from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "./audit.js";

type Trx = Transaction<KernelDatabase>;

/** `<插件名>:<租户 id>`；插件名同清单规则，租户 id 为非空、不含空白的串。 */
const SOURCE_RE = /^([a-z0-9][a-z0-9._-]{0,213}):(\S{1,256})$/;
const MAX_EXTERNAL_ID = 256;
const MAX_DISPLAY_NAME = 200;
const MAX_EMAIL = 320;

/** 账号已绑定的一个外部身份（不含本地登录名）。 */
export interface LinkedIdentity {
  source: string;
  externalId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
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

/** 仅当违反 identities 主键约束（身份已被占用）时为 true。 */
function isIdentityTaken(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string };
  return err.code === "23505" && err.constraint === "identities_pkey";
}

/**
 * 外部身份：按 `(source, externalId)` 映射到账号（登录、渠道入站、通讯录共用同一个键）。
 * 首次出现时按「受信任的身份源 + 两侧邮箱均已验证」合并到既有账号，否则新建账号（不建组织）。
 * 同一身份的并发首次解析用事务级咨询锁串行化，只建一个账号。框架无关，由调用方注入依赖。
 */
export class ExternalIdentities {
  constructor(
    private readonly db: KernelDb,
    private readonly config: () => {
      auth: Pick<KernelConfig["auth"], "trustedIdentitySources">;
    },
  ) {}

  /** 该外部身份绑定的账号 id；未绑定返回 undefined。 */
  async findAccount(source: string, externalId: string, trx?: Trx): Promise<string | undefined> {
    const row = await (trx ?? this.db)
      .selectFrom("identities")
      .select("account_id")
      .where("source", "=", source)
      .where("external_id", "=", externalId)
      .executeTakeFirst();
    return row?.account_id;
  }

  /**
   * 解析外部身份到账号。已绑定 → 该账号（顺带刷新身份行上的邮箱与资料）；未绑定 → 合并或新建（见类说明）。
   * 合并写审计 `identity.linked`，新建写 `account.created`。不判断账号状态，由调用方决定（如登录拒绝停用账号）。
   * 传 `trx` 时在调用方事务内执行。
   */
  async resolve(
    identity: ExternalIdentity,
    trx?: Trx,
  ): Promise<{ accountId: string; created: boolean }> {
    const id = normalize(identity);
    const run = async (t: Trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.identity:${id.source}:${id.externalId}`}))`.execute(
        t,
      );
      const existing = await this.findAccount(id.source, id.externalId, t);
      if (existing !== undefined) {
        await t
          .updateTable("identities")
          .set({
            email: id.email ?? null,
            email_verified: id.emailVerified,
            profile: profileOf(id),
          })
          .where("source", "=", id.source)
          .where("external_id", "=", id.externalId)
          .execute();
        return { accountId: existing, created: false };
      }
      const merged = await this.mergeTarget(t, id);
      if (merged !== undefined) {
        await this.insertIdentity(t, merged, id);
        await audit(t, {
          actorAccountId: merged,
          action: "identity.linked",
          target: merged,
          detail: { source: id.source, externalId: id.externalId, via: "verified_email" },
        });
        return { accountId: merged, created: false };
      }
      const accountId = randomUUID();
      await t
        .insertInto("accounts")
        .values({
          id: accountId,
          display_name: id.displayName,
          email: id.email ?? null,
          email_verified: id.emailVerified,
        })
        .execute();
      await this.insertIdentity(t, accountId, id);
      await audit(t, {
        actorAccountId: accountId,
        action: "account.created",
        target: accountId,
        detail: { source: id.source, externalId: id.externalId },
      });
      return { accountId, created: true };
    };
    return trx ? run(trx) : this.db.transaction().execute(run);
  }

  /**
   * 可合并的既有账号：身份源的插件名在 `auth.trustedIdentitySources` 中、身份邮箱已验证，
   * 且恰好有一个邮箱已验证、邮箱相同（不区分大小写）的账号；否则 undefined（多个候选时不猜，新建）。
   */
  private async mergeTarget(t: Trx, id: ExternalIdentity): Promise<string | undefined> {
    if (!id.emailVerified || id.email === undefined) return undefined;
    const trusted = this.config().auth.trustedIdentitySources;
    if (!trusted.includes(identityPlugin(id.source))) return undefined;
    const rows = await t
      .selectFrom("accounts")
      .select("id")
      .where("email_verified", "=", true)
      .where(sql<string>`lower(email)`, "=", id.email.toLowerCase())
      .limit(2)
      .execute();
    return rows.length === 1 ? rows[0]?.id : undefined;
  }

  private async insertIdentity(t: Trx, accountId: string, id: ExternalIdentity): Promise<void> {
    await t
      .insertInto("identities")
      .values({
        source: id.source,
        external_id: id.externalId,
        account_id: accountId,
        email: id.email ?? null,
        email_verified: id.emailVerified,
        profile: profileOf(id),
      })
      .execute();
  }

  /**
   * 把外部身份绑定到账号（IM 里点绑定链接等）：已绑定本人 → 刷新资料，幂等；已绑定他人 → `409 identity.taken`。
   * 新绑定写审计 `identity.linked`。
   */
  async link(accountId: string, identity: ExternalIdentity, trx?: Trx): Promise<void> {
    const id = normalize(identity);
    const run = async (t: Trx) => {
      const owner = await this.findAccount(id.source, id.externalId, t);
      if (owner !== undefined && owner !== accountId) throw taken();
      if (owner === accountId) {
        await t
          .updateTable("identities")
          .set({
            email: id.email ?? null,
            email_verified: id.emailVerified,
            profile: profileOf(id),
          })
          .where("source", "=", id.source)
          .where("external_id", "=", id.externalId)
          .execute();
        return;
      }
      try {
        await this.insertIdentity(t, accountId, id);
      } catch (e) {
        if (isIdentityTaken(e)) throw taken();
        throw e;
      }
      await audit(t, {
        actorAccountId: accountId,
        action: "identity.linked",
        target: accountId,
        detail: { source: id.source, externalId: id.externalId, via: "bind" },
      });
    };
    return trx ? run(trx) : this.db.transaction().execute(run);
  }

  /** 解除本人的一个外部身份（本地登录名不可解除）；不存在或不属于本人 → `identity.not_found`。审计 `identity.unlinked`。 */
  async unlink(accountId: string, source: string, externalId: string): Promise<void> {
    if (source === "local") throw notFound();
    await this.db.transaction().execute(async (t) => {
      const r = await t
        .deleteFrom("identities")
        .where("source", "=", source)
        .where("external_id", "=", externalId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();
      if (r.numDeletedRows === 0n) throw notFound();
      await audit(t, {
        actorAccountId: accountId,
        action: "identity.unlinked",
        target: accountId,
        detail: { source, externalId },
      });
    });
  }

  /** 账号绑定的外部身份（不含本地登录名），按绑定时间升序。 */
  async listForAccount(accountId: string): Promise<LinkedIdentity[]> {
    const rows = await this.db
      .selectFrom("identities")
      .select(["source", "external_id", "email", "email_verified", "profile", "created_at"])
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
        createdAt: r.created_at,
      };
    });
  }
}

const taken = () =>
  new ApiError("identity.taken", "This external identity is already linked to another account");
const notFound = () => new ApiError("identity.not_found", "External identity not found");
