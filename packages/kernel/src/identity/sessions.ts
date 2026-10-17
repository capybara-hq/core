import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import {
  compactVerify,
  type JWSHeaderParameters,
  errors as joseErrors,
  jwtVerify,
  SignJWT,
} from "jose";
import { sql } from "kysely";
import type { DerivedKeys, Keyring } from "../ctx/secrets.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";

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
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newRefreshToken = () => REFRESH_PREFIX + randomBytes(32).toString("base64url");

/** 按 JWS 头里的 kid 选派生密钥；找不到时抛出，由调用方映射为 `auth.required`。 */
class UnknownKidError extends Error {}

/**
 * Web 会话服务：短期 access token（HS256 JWT，密钥由主密钥环派生）+ PG 中可吊销、一次一换的 refresh token。
 * 吊销会在 Redis 写 `capk:revoked-sid:<sid>`（TTL 覆盖 access token 剩余寿命），使所有副本立即拒绝该会话的 access token。
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
        refresh_hash: sha256(refreshToken),
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
    const oldHash = sha256(refreshToken);
    const next = newRefreshToken();
    // 原子轮换：并发的两次刷新只有一个能匹配 refresh_hash = old
    const row = await this.db
      .updateTable("sessions")
      .set((eb) => ({
        prev_refresh_hash: eb.ref("refresh_hash"),
        refresh_hash: sha256(next),
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

  async verifyAccess(accessToken: string): Promise<{ accountId: string; sessionId: string }> {
    let sub: unknown;
    let sid: unknown;
    try {
      const { payload } = await jwtVerify(accessToken, this.keyFor, { algorithms: ["HS256"] });
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
    return { accountId: sub, sessionId: sid };
  }

  /** 只验签不看过期，供登出使用；签名无效返回 undefined。 */
  async sessionIdFromAccess(accessToken: string): Promise<string | undefined> {
    try {
      const { payload } = await compactVerify(accessToken, this.keyFor, { algorithms: ["HS256"] });
      const sid: unknown = JSON.parse(new TextDecoder().decode(payload)).sid;
      return typeof sid === "string" ? sid : undefined;
    } catch {
      return undefined;
    }
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db
      .updateTable("sessions")
      .set({ revoked_at: sql<Date>`now()` })
      .where("id", "=", sessionId)
      .where("revoked_at", "is", null)
      .execute();
    await this.redis.set(revokedKey(sessionId), "1", "EX", this.revokedMarkerTtl());
  }

  async revokeAllForAccount(accountId: string, exceptSessionId?: string): Promise<number> {
    let q = this.db
      .updateTable("sessions")
      .set({ revoked_at: sql<Date>`now()` })
      .where("account_id", "=", accountId)
      .where("revoked_at", "is", null);
    if (exceptSessionId !== undefined) q = q.where("id", "!=", exceptSessionId);
    const rows = await q.returning("id").execute();
    if (rows.length > 0) {
      const pipe = this.redis.pipeline();
      for (const r of rows) pipe.set(revokedKey(r.id), "1", "EX", this.revokedMarkerTtl());
      const results = (await pipe.exec()) ?? [];
      const failed = results.find(([err]) => err);
      if (failed) throw failed[0];
    }
    return rows.length;
  }

  async setCurrentOrg(sessionId: string, orgId: string | null): Promise<void> {
    await this.db
      .updateTable("sessions")
      .set({ current_org_id: orgId })
      .where("id", "=", sessionId)
      .execute();
  }

  /** 未吊销的会话；已吊销或不存在返回 undefined。 */
  async get(
    sessionId: string,
  ): Promise<{ id: string; accountId: string; currentOrgId: string | null } | undefined> {
    const row = await this.db
      .selectFrom("sessions")
      .select(["id", "account_id", "current_org_id"])
      .where("id", "=", sessionId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return row && { id: row.id, accountId: row.account_id, currentOrgId: row.current_org_id };
  }

  private readonly keyFor = (header: JWSHeaderParameters): Uint8Array => {
    const key = header.kid === undefined ? undefined : this.keys.byId(header.kid);
    if (!key) throw new UnknownKidError("unknown kid");
    return key;
  };

  private revokedMarkerTtl(): number {
    return this.opts.accessTtlSeconds + 60;
  }

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
