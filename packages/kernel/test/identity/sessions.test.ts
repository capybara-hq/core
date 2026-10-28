import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { SignJWT } from "jose";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createKeyring, type Keyring } from "../../src/ctx/secrets.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { REFRESH_RACE_GRACE_MS, SessionService } from "../../src/identity/sessions.js";
import { truncateTables } from "../helpers/db.js";

let pgBox: Awaited<ReturnType<typeof startTestPostgres>>;
let pgUrl: string;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let raw: ReturnType<typeof createDb>;
let raw2: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let db2: KernelSchemaDb;
let redis: Redis;
let redis2: Redis;
const k1 = randomBytes(32);
const k2 = randomBytes(32);
const ring = createKeyring(k1, []);
const OPTS = { accessTtlSeconds: 900, refreshTtlDays: 30 };

/** 模拟一个副本：独立的 Kysely 与 Redis 连接。 */
const replica = (keyring: Keyring = ring, opts = OPTS, which: 1 | 2 = 1) =>
  which === 1
    ? new SessionService(db, redis, keyring, opts)
    : new SessionService(db2, redis2, keyring, opts);

beforeAll(async () => {
  [pgBox, rd] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  pgUrl = pgBox.url;
  await migrate(pgUrl, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgUrl, 5);
  raw2 = createDb(pgUrl, 5);
  db = kernelDb(raw);
  db2 = kernelDb(raw2);
  redis = new Redis(rd.url);
  redis2 = new Redis(rd.url);
}, 120_000);
afterAll(async () => {
  redis.disconnect();
  redis2.disconnect();
  await raw.destroy();
  await raw2.destroy();
  await Promise.all([pgBox.stop(), rd.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts");
});

async function account(): Promise<string> {
  const id = randomUUID();
  await db.insertInto("accounts").values({ id, display_name: "A", email: null }).execute();
  return id;
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as ApiError).code ?? String(e);
  }
  return undefined;
};

describe("SessionService access token", () => {
  it("create → verifyAccess 返回同一 accountId / sessionId", async () => {
    const acc = await account();
    const s = await replica().create(acc, { userAgent: "ua", ip: "127.0.0.1" });
    expect(s.refreshToken).toMatch(/^cap_rt_[A-Za-z0-9_-]{43}$/);
    expect(s.accountId).toBe(acc);
    expect(await replica(ring, OPTS, 2).verifyAccess(s.accessToken)).toEqual({
      accountId: acc,
      sessionId: s.sessionId,
      account: expect.objectContaining({ id: acc, displayName: "A", status: "active" }),
    });
    const row = await db
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", s.sessionId)
      .executeTakeFirstOrThrow();
    expect(row.refresh_hash).not.toContain(s.refreshToken);
    expect(row.user_agent).toBe("ua");
    expect(Math.abs(row.expires_at.getTime() - s.refreshExpiresAt.getTime())).toBeLessThan(1000);
    expect(await replica().get(s.sessionId)).toEqual({
      id: s.sessionId,
      accountId: acc,
      currentOrgId: null,
    });
  });

  it("过期 → auth.token_expired", async () => {
    const acc = await account();
    const svc = replica(ring, { accessTtlSeconds: 1, refreshTtlDays: 30 });
    const s = await svc.create(acc, {});
    await new Promise((r) => setTimeout(r, 2100));
    expect(await codeOf(svc.verifyAccess(s.accessToken))).toBe("auth.token_expired");
    // 只验签不看过期：登出仍能拿到 sid
    expect(await svc.sessionIdFromAccess(s.accessToken)).toBe(s.sessionId);
  });

  it("别的主密钥签的 → auth.required；轮换后旧 token 仍有效；乱串 → auth.required", async () => {
    const acc = await account();
    const s = await replica().create(acc, {});
    expect(await codeOf(replica(createKeyring(k2, [])).verifyAccess(s.accessToken))).toBe(
      "auth.required",
    );
    expect(await replica(createKeyring(k2, [])).sessionIdFromAccess(s.accessToken)).toBeUndefined();
    expect((await replica(createKeyring(k2, [k1])).verifyAccess(s.accessToken)).sessionId).toBe(
      s.sessionId,
    );
    expect(await codeOf(replica().verifyAccess("not-a-jwt"))).toBe("auth.required");
    expect(await replica().sessionIdFromAccess("not-a-jwt")).toBeUndefined();
    const [h, p] = s.accessToken.split(".");
    expect(await codeOf(replica().verifyAccess(`${h}.${p}.AAAA`))).toBe("auth.required");
  });

  it("缺 exp 或 sub 的 token（即使签名正确）→ auth.required", async () => {
    const acc = await account();
    const s = await replica().create(acc, {});
    const keys = ring.deriveKey("access-token/v1");
    const sign = (jwt: SignJWT) =>
      jwt.setProtectedHeader({ alg: "HS256", kid: keys.currentId }).sign(keys.current);
    const noExp = await sign(new SignJWT({ sid: s.sessionId }).setSubject(acc).setIssuedAt());
    const noSub = await sign(
      new SignJWT({ sid: s.sessionId }).setIssuedAt().setExpirationTime("10m"),
    );
    expect(await codeOf(replica().verifyAccess(noExp))).toBe("auth.required");
    expect(await codeOf(replica().verifyAccess(noSub))).toBe("auth.required");
  });

  it("配置较短 TTL 的副本吊销后，标记仍覆盖 schema 上限（3600 + 60）", async () => {
    const acc = await account();
    const s = await replica().create(acc, {});
    await replica(ring, { accessTtlSeconds: 60, refreshTtlDays: 30 }).revoke(s.sessionId);
    expect(await redis.ttl(`capk:revoked-sid:${s.sessionId}`)).toBeGreaterThan(3600);
  });

  it("revoke 后另一副本 verifyAccess → auth.session_revoked；吊销标记 TTL 合理", async () => {
    const acc = await account();
    const s = await replica().create(acc, {});
    await replica().revoke(s.sessionId);
    expect(await codeOf(replica(ring, OPTS, 2).verifyAccess(s.accessToken))).toBe(
      "auth.session_revoked",
    );
    const ttl = await redis2.ttl(`capk:revoked-sid:${s.sessionId}`);
    // 标记 TTL 固定为 schema 上限 3600 + 60，与本实例配置的 accessTtlSeconds 无关（滚动改配置时不会复活已吊销的 token）
    expect(ttl).toBeGreaterThan(3600);
    expect(ttl).toBeLessThanOrEqual(3600 + 60);
    expect(await codeOf(replica().refresh(s.refreshToken, {}))).toBe("auth.refresh_invalid");
  });
});

describe("SessionService refresh", () => {
  it("返回新 refresh；旧的立刻再刷 → auth.refresh_race，会话仍有效", async () => {
    const acc = await account();
    const svc = replica();
    const s = await svc.create(acc, {});
    const r1 = await svc.refresh(s.refreshToken, {});
    expect(r1.refreshToken).not.toBe(s.refreshToken);
    expect(r1.sessionId).toBe(s.sessionId);
    expect(r1.refreshExpiresAt.getTime()).toBe(s.refreshExpiresAt.getTime());
    expect((await svc.verifyAccess(r1.accessToken)).sessionId).toBe(s.sessionId);
    expect(await codeOf(svc.refresh(s.refreshToken, {}))).toBe("auth.refresh_race");
    const r2 = await svc.refresh(r1.refreshToken, {});
    expect((await svc.verifyAccess(r2.accessToken)).accountId).toBe(acc);
  });

  it("两个副本并发刷新同一 refresh → 恰好一个成功、一个 auth.refresh_race", async () => {
    const acc = await account();
    const s = await replica().create(acc, {});
    await sql`select 1`.execute(raw2);
    const rs = await Promise.allSettled([
      replica(ring, OPTS, 1).refresh(s.refreshToken, {}),
      replica(ring, OPTS, 2).refresh(s.refreshToken, {}),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rej = rs.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rej.reason as ApiError).code).toBe("auth.refresh_race");
  });

  it("宽限期外重放旧 refresh → auth.refresh_invalid 且整个会话被吊销", async () => {
    const acc = await account();
    const svc = replica();
    const s = await svc.create(acc, {});
    const r1 = await svc.refresh(s.refreshToken, {});
    await db
      .updateTable("sessions")
      .set({ rotated_at: new Date(Date.now() - REFRESH_RACE_GRACE_MS - 1000) })
      .where("id", "=", s.sessionId)
      .execute();
    expect(await codeOf(svc.refresh(s.refreshToken, {}))).toBe("auth.refresh_invalid");
    expect(await codeOf(svc.refresh(r1.refreshToken, {}))).toBe("auth.refresh_invalid");
    expect(await codeOf(replica(ring, OPTS, 2).verifyAccess(r1.accessToken))).toBe(
      "auth.session_revoked",
    );
  });

  it("重放两次轮换之前的 refresh → auth.refresh_invalid；只记上一枚哈希，认不出它属于哪个会话，所以不吊销（现行行为）", async () => {
    const acc = await account();
    const svc = replica();
    const s = await svc.create(acc, {});
    const r1 = await svc.refresh(s.refreshToken, {});
    const r2 = await svc.refresh(r1.refreshToken, {});
    expect(await codeOf(svc.refresh(s.refreshToken, {}))).toBe("auth.refresh_invalid");
    // 会话未被吊销：最新的 access / refresh 仍可用
    expect((await svc.verifyAccess(r2.accessToken)).sessionId).toBe(s.sessionId);
    const row = await db
      .selectFrom("sessions")
      .select("revoked_at")
      .where("id", "=", s.sessionId)
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).toBeNull();
    const r3 = await svc.refresh(r2.refreshToken, {});
    expect(r3.sessionId).toBe(s.sessionId);
  });

  it("会话已过期 → auth.refresh_invalid；未知 refresh → auth.refresh_invalid", async () => {
    const acc = await account();
    const svc = replica();
    const s = await svc.create(acc, {});
    await db
      .updateTable("sessions")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", s.sessionId)
      .execute();
    expect(await codeOf(svc.refresh(s.refreshToken, {}))).toBe("auth.refresh_invalid");
    expect(await codeOf(svc.refresh("cap_rt_nope", {}))).toBe("auth.refresh_invalid");
  });

  it("账号停用后 refresh → auth.account_disabled，会话被吊销", async () => {
    const acc = await account();
    const svc = replica();
    const s = await svc.create(acc, {});
    await db.updateTable("accounts").set({ status: "disabled" }).where("id", "=", acc).execute();
    expect(await codeOf(svc.refresh(s.refreshToken, {}))).toBe("auth.account_disabled");
    expect(await codeOf(svc.verifyAccess(s.accessToken))).toBe("auth.session_revoked");
    const row = await db
      .selectFrom("sessions")
      .select("revoked_at")
      .where("id", "=", s.sessionId)
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
  });
});

describe("SessionService 其他", () => {
  it("revokeAllForAccount(acc, keep) 只保留 keep，返回吊销条数", async () => {
    const acc = await account();
    const other = await account();
    const svc = replica();
    const [a, b, c] = await Promise.all([
      svc.create(acc, {}),
      svc.create(acc, {}),
      svc.create(acc, {}),
    ]);
    const o = await svc.create(other, {});
    if (!a || !b || !c) throw new Error("unreachable");
    expect(await svc.revokeAllForAccount(acc, b.sessionId)).toBe(2);
    expect((await svc.verifyAccess(b.accessToken)).sessionId).toBe(b.sessionId);
    expect(await codeOf(svc.verifyAccess(a.accessToken))).toBe("auth.session_revoked");
    expect(await codeOf(svc.verifyAccess(c.accessToken))).toBe("auth.session_revoked");
    expect((await svc.verifyAccess(o.accessToken)).accountId).toBe(other);
    expect(await svc.revokeAllForAccount(acc)).toBe(1);
  });

  it("setCurrentOrg 写入并可清空", async () => {
    const acc = await account();
    const orgId = randomUUID();
    await db
      .insertInto("orgs")
      .values({ id: orgId, slug: "o1", name: "O", created_by: acc })
      .execute();
    const svc = replica();
    const s = await svc.create(acc, {});
    await svc.setCurrentOrg(s.sessionId, orgId);
    expect((await svc.get(s.sessionId))?.currentOrgId).toBe(orgId);
    await svc.setCurrentOrg(s.sessionId, null);
    expect((await svc.get(s.sessionId))?.currentOrgId).toBeNull();
    expect(await svc.get(randomUUID())).toBeUndefined();
  });

  it("get() 不返回已过期（未吊销）的会话", async () => {
    const acc = await account();
    const svc = replica();
    const s = await svc.create(acc, {});
    await db
      .updateTable("sessions")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", s.sessionId)
      .execute();
    expect(await svc.get(s.sessionId)).toBeUndefined();
  });

  it("setCurrentOrg 对已吊销 / 不存在的会话抛 auth.session_revoked", async () => {
    const acc = await account();
    const svc = replica();
    const s = await svc.create(acc, {});
    await svc.revoke(s.sessionId);
    expect(await codeOf(svc.setCurrentOrg(s.sessionId, null))).toBe("auth.session_revoked");
    expect(await codeOf(svc.setCurrentOrg(randomUUID(), null))).toBe("auth.session_revoked");
  });

  it("verifyAccess 每个请求只发一条 SQL（吊销检查与账号读取合并），并返回账号", async () => {
    const acc = await account();
    const s = await replica().create(acc, {});
    let queries = 0;
    const counted = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: pgUrl, max: 1 }) }),
      log: (e) => {
        if (e.level === "query") queries++;
      },
    });
    try {
      const svc = new SessionService(kernelDb(counted), redis, ring, OPTS);
      const r = await svc.verifyAccess(s.accessToken);
      expect(r.account.id).toBe(acc);
      expect(queries).toBe(1);
    } finally {
      await counted.destroy();
    }
  });
});
