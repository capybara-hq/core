import { randomBytes, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { type JWSHeaderParameters, errors as joseErrors, jwtVerify, SignJWT } from "jose";
import { sql } from "kysely";
import { ACCESS_TOKEN_TTL_MAX_SECONDS } from "../config/schema.js";
import type { DerivedKeys, Keyring } from "../ctx/secrets.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ACCOUNT_COLUMNS, type Account, toAccount } from "./accounts.js";
import { sha256Hex } from "./hash.js";

export interface IssuedSession {
  sessionId: string;
  accountId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

/** 旧 refresh token 在被轮换后多久内重放视为并发刷新（不吊销会话）。 */
export const REFRESH_RACE_GRACE_MS = 30_000;

const REFRESH_PREFIX = "cap_rt_";
const ACCESS_KEY_INFO = "access-token/v1";
const revokedKey = (sid: string) => `capk:revoked-sid:${sid}`;
/**
 * 吊销标记的 TTL：按 schema 允许的 access token 最长寿命 + 60s 计算，而不是本实例配置的寿命——
 * 滚动修改 `auth.accessTokenTtlSeconds` 时，按旧（更长）寿命签发的 token 不会在标记过期后复活。
 */
const REVOKED_MARKER_TTL_SECONDS = ACCESS_TOKEN_TTL_MAX_SECONDS + 60;
const VERIFY_OPTS = { algorithms: ["HS256"], requiredClaims: ["exp", "sub"] };
const newRefreshToken = () => REFRESH_PREFIX + randomBytes(32).toString("base64url");

/** 按 JWS 头里的 kid 选派生密钥；找不到时抛出，由调用方映射为 `auth.required`。 */
class UnknownKidError extends Error {}

/**
 * Web 会话服务：短期 access token（HS256 JWT，密钥由主密钥环派生）+ PG 中可吊销、一次一换的 refresh token。
 * 吊销会在 Redis 写 `capk:revoked-sid:<sid>`（TTL 覆盖任何配置下 access token 的最长剩余寿命），使所有副本立即拒绝该会话的 access token；
 * 验证 access token 时还会读 PG 的 `sessions.revoked_at`，Redis 丢数据也不会让已吊销的会话复活。
 * 框架无关，由调用方注入依赖。
 */
export class SessionService {
  private readonly keys: DerivedKeys;

  constructor(
    private readonly db: KernelDb,
    private readonly redis: Redis,
    keyring: Keyring,
    private readonly opts: { accessTtlSeconds: number; refreshTtlDays: number },
  ) {
    this.keys = keyring.deriveKey(ACCESS_KEY_INFO);
  }

  async create(
    accountId: string,
    meta: { userAgent?: string; ip?: string },
  ): Promise<IssuedSession> {
    const id = randomUUID();
    const refreshToken = newRefreshToken();
    const row = await this.db
      .insertInto("sessions")
      .values({
        id,
        account_id: accountId,
        refresh_hash: sha256Hex(refreshToken),
        user_agent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        expires_at: sql<Date>`now() + make_interval(days => ${this.opts.refreshTtlDays})`,
      })
      .returning(["expires_at"])
      .executeTakeFirstOrThrow();
    return this.issue(id, accountId, refreshToken, row.expires_at);
  }

  async refresh(
    refreshToken: string,
    meta: { userAgent?: string; ip?: string },
  ): Promise<IssuedSession> {
    const oldHash = sha256Hex(refreshToken);
    const next = newRefreshToken();
    // 原子轮换：并发的两次刷新只有一个能匹配 refresh_hash = old
    const row = await this.db
      .updateTable("sessions")
      .set((eb) => ({
        prev_refresh_hash: eb.ref("refresh_hash"),
        refresh_hash: sha256Hex(next),
        rotated_at: sql<Date>`now()`,
        last_used_at: sql<Date>`now()`,
        ...(meta.userAgent !== undefined && { user_agent: meta.userAgent }),
        ...(meta.ip !== undefined && { ip: meta.ip }),
      }))
      .where("refresh_hash", "=", oldHash)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .returning(["id", "account_id", "expires_at"])
      .executeTakeFirst();
    if (!row) return this.rejectRefresh(oldHash);
    const account = await this.db
      .selectFrom("accounts")
      .select("status")
      .where("id", "=", row.account_id)
      .executeTakeFirst();
    if (account?.status !== "active") {
      await this.revoke(row.id);
      throw new ApiError("auth.account_disabled", "Account is disabled");
    }
    return this.issue(row.id, row.account_id, next, row.expires_at);
  }

  /** 旧 refresh token 未能轮换：区分并发刷新（宽限期内）与重放（吊销会话）。 */
  private async rejectRefresh(oldHash: string): Promise<never> {
    const prev = await this.db
      .selectFrom("sessions")
      .select((eb) => [
        "id",
        eb
          .and([
            eb("revoked_at", "is", null),
            eb("expires_at", ">", sql<Date>`now()`),
            eb(
              "rotated_at",
              ">",
              sql<Date>`now() - make_interval(secs => ${REFRESH_RACE_GRACE_MS / 1000})`,
            ),
          ])
          .as("in_grace"),
      ])
      .where("prev_refresh_hash", "=", oldHash)
      .executeTakeFirst();
    if (prev?.in_grace) {
      throw new ApiError("auth.refresh_race", "Refresh token was just rotated by another request");
    }
    if (prev) await this.revoke(prev.id);
    throw new ApiError("auth.refresh_invalid", "Refresh token is invalid");
  }

  /**
   * 验证 access token 并读出会话所属账号（不判断账号状态，由调用方决定）。
   * Redis 吊销标记是快速路径；PG 的 `sessions.revoked_at` 才是事实来源——Redis 被清空 / 故障切换丢数据时，
   * 已登出或因改密码被吊销的会话不能复活（spec 8.1）。吊销检查与账号读取合并为一条按主键的 JOIN 查询。
   */
  async verifyAccess(
    accessToken: string,
  ): Promise<{ accountId: string; sessionId: string; account: Account }> {
    let sub: unknown;
    let sid: unknown;
    try {
      const { payload } = await jwtVerify(accessToken, this.keyFor, VERIFY_OPTS);
      sub = payload.sub;
      sid = payload.sid;
    } catch (e) {
      if (e instanceof joseErrors.JWTExpired) {
        throw new ApiError("auth.token_expired", "Access token has expired");
      }
      throw new ApiError("auth.required", "Authentication required");
    }
    if (typeof sub !== "string" || typeof sid !== "string") {
      throw new ApiError("auth.required", "Authentication required");
    }
    if (await this.redis.exists(revokedKey(sid))) {
      throw new ApiError("auth.session_revoked", "Session has been revoked");
    }
    const row = await this.db
      .selectFrom("sessions")
      .innerJoin("accounts", "accounts.id", "sessions.account_id")
      .select(["sessions.revoked_at", ...ACCOUNT_COLUMNS])
      .where("sessions.id", "=", sid)
      .executeTakeFirst();
    if (!row || row.revoked_at !== null) {
      throw new ApiError("auth.session_revoked", "Session has been revoked");
    }
    if (row.id !== sub) throw new ApiError("auth.required", "Authentication required");
    return { accountId: sub, sessionId: sid, account: toAccount(row) };
  }

  /**
   * 只验签不看过期，供登出使用：过期的 token 也接受（取 `JWTExpired` 里已验签的 payload）；
   * 签名无效或缺 sid 返回 undefined。
   */
  async sessionIdFromAccess(accessToken: string): Promise<string | undefined> {
    let sid: unknown;
    try {
      sid = (await jwtVerify(accessToken, this.keyFor, VERIFY_OPTS)).payload.sid;
    } catch (e) {
      // JWTExpired 只会在签名校验通过之后抛出，其 payload 可信
      if (!(e instanceof joseErrors.JWTExpired)) return undefined;
      sid = e.payload.sid;
    }
    return typeof sid === "string" ? sid : undefined;
  }

  /** 按 refresh token 吊销其当前会话（供登出使用）；无匹配则什么都不做。 */
  async revokeByRefresh(refreshToken: string): Promise<void> {
    const row = await this.db
      .selectFrom("sessions")
      .select("id")
      .where("refresh_hash", "=", sha256Hex(refreshToken))
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (row) await this.revoke(row.id);
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db
      .updateTable("sessions")
      .set({ revoked_at: sql<Date>`now()` })
      .where("id", "=", sessionId)
      .where("revoked_at", "is", null)
      .execute();
    await this.redis.set(revokedKey(sessionId), "1", "EX", REVOKED_MARKER_TTL_SECONDS);
  }

  async revokeAllForAccount(accountId: string, exceptSessionId?: string): Promise<number> {
    let q = this.db
      .updateTable("sessions")
      .set({ revoked_at: sql<Date>`now()` })
      .where("account_id", "=", accountId)
      .where("revoked_at", "is", null);
    if (exceptSessionId !== undefined) q = q.where("id", "!=", exceptSessionId);
    const rows = await q.returning("id").execute();
    await this.markRevoked(rows.map((r) => r.id));
    return rows.length;
  }

  /**
   * 给已在 PG 中吊销的会话写 Redis 吊销标记（快速路径）；任一写入失败即抛出。
   * 鉴权以 PG `revoked_at` 为准，调用方可以把这一步当作尽力而为。
   */
  async markRevoked(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const pipe = this.redis.pipeline();
    for (const id of sessionIds) pipe.set(revokedKey(id), "1", "EX", REVOKED_MARKER_TTL_SECONDS);
    const results = (await pipe.exec()) ?? [];
    const failed = results.find(([err]) => err);
    if (failed) throw failed[0];
  }

  /** 设当前组织；会话已吊销、已过期或不存在 → `auth.session_revoked`。 */
  async setCurrentOrg(sessionId: string, orgId: string | null): Promise<void> {
    const r = await this.db
      .updateTable("sessions")
      .set({ current_org_id: orgId })
      .where("id", "=", sessionId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    if (r.numUpdatedRows === 0n) {
      throw new ApiError("auth.session_revoked", "Session has been revoked");
    }
  }

  /** 有效（未吊销且未过期）的会话；否则返回 undefined。 */
  async get(
    sessionId: string,
  ): Promise<{ id: string; accountId: string; currentOrgId: string | null } | undefined> {
    const row = await this.db
      .selectFrom("sessions")
      .select(["id", "account_id", "current_org_id"])
      .where("id", "=", sessionId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    return row && { id: row.id, accountId: row.account_id, currentOrgId: row.current_org_id };
  }

  private readonly keyFor = (header: JWSHeaderParameters): Uint8Array => {
    const key = header.kid === undefined ? undefined : this.keys.byId(header.kid);
    if (!key) throw new UnknownKidError("unknown kid");
    return key;
  };

  private async issue(
    sessionId: string,
    accountId: string,
    refreshToken: string,
    refreshExpiresAt: Date,
  ): Promise<IssuedSession> {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + this.opts.accessTtlSeconds;
    const accessToken = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: "HS256", kid: this.keys.currentId })
      .setSubject(accountId)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.keys.current);
    return {
      sessionId,
      accountId,
      accessToken,
      refreshToken,
      accessExpiresAt: new Date(exp * 1000),
      refreshExpiresAt,
    };
  }
}
