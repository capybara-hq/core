import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ToolError } from "@capybara-hq/plugin-sdk";
import {
  type FakeOAuthServer,
  startFakeOAuthServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../../src/config/schema.js";
import { createKeyring } from "../../../src/ctx/secrets.js";
import { kernelDb } from "../../../src/db/kernel-schema.js";
import { migrate } from "../../../src/db/migrator.js";
import { createDb } from "../../../src/db/pool.js";
import { createLogger } from "../../../src/log.js";
import {
  type ConnectorAuth,
  CredentialMissing,
  Credentials,
} from "../../../src/tools/credentials.js";

/**
 * Task 15 Review 重点：两个「副本」（各自的 PG 连接池、Redis 连接与 Credentials 实例，没有任何进程内共享）
 * 同时收到 401 → 只刷新一次（`capk:oauth-refresh:*` 分布式锁内进行，拿不到锁的等待后重读凭据）。
 * 授权服务器轮换 refresh token：并发刷新时第二次刷新会因旧 refresh token 作废而失败，从而被测试发现。
 */

let pgc: TestContainer;
let rdc: TestContainer;
// biome-ignore lint/suspicious/noExplicitAny: 测试库无表结构类型
const pools: Kysely<any>[] = [];
const redises: Redis[] = [];
const ring = createKeyring(randomBytes(32), []);
const lines: string[] = [];
const stops: (() => Promise<void>)[] = [];

const ORG = "org_oauth_lock";
const ACCOUNT = "acct_1";
const AUTH: ConnectorAuth = {
  type: "oauth_code",
  ownership: "personal",
  discovery: "manual",
  authorizationUrl: "unused",
  tokenUrl: "unused",
  client: "manual",
};

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../../src/migrations", import.meta.url)),
  });
}, 120_000);

afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

afterAll(async () => {
  for (const r of redises) r.disconnect();
  for (const p of pools) await p.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

const config = KernelConfigSchema.parse({
  db: { url: "postgres://unused" },
  redis: { url: "redis://unused" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
  tools: { timeoutMs: 5_000, oauthAllowInsecureLoopback: true },
});

/** 一个「副本」：独立连接池、Redis 连接、logger 与 Credentials。 */
function replica(log = createLogger("info", { write: (l) => lines.push(l) })): Credentials {
  const pool = createDb(pgc.url, 5);
  pools.push(pool);
  const redis = new Redis(rdc.url);
  redises.push(redis);
  return new Credentials(kernelDb(pool), ring, log, { redis, config: () => config });
}

const pub = { clientId: "pub-client" };

/** 走一遍授权码 + PKCE 拿到一组真实 token。 */
async function issueTokens(as: FakeOAuthServer) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${as.issuer}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: pub.clientId,
    redirect_uri: "https://cb.example.com/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  const code = new URL(res.headers.get("location") as string).searchParams.get("code") as string;
  const tok = await fetch(`${as.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: pub.clientId,
      redirect_uri: "https://cb.example.com/cb",
    }),
  });
  return (await tok.json()) as { access_token: string; refresh_token: string; expires_in: number };
}

async function seed(creds: Credentials, as: FakeOAuthServer, connectorId: string) {
  const t = await issueTokens(as);
  await creds.setOAuthClient(ORG, connectorId, {
    clientId: pub.clientId,
    authMethod: "none",
    authorizationEndpoint: `${as.issuer}/authorize`,
    tokenEndpoint: `${as.issuer}/token`,
  });
  await creds.setOAuthTokens(
    ORG,
    connectorId,
    { kind: "user", accountId: ACCOUNT },
    {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: Date.now() + t.expires_in * 1000,
      token_type: "Bearer",
    },
  );
  return t;
}

const refreshes = (as: FakeOAuthServer) =>
  as.tokenRequests.filter((r) => r.grantType === "refresh_token");

describe("OAuth 刷新加锁（双副本）", () => {
  it("两个副本同时收到 401（各 5 个并发请求）→ 只刷新一次，全部拿到同一个新 token", async () => {
    const as = await startFakeOAuthServer({ clients: [pub], tokenDelayMs: 300 });
    stops.push(() => as.stop());
    const [a, b] = [replica(), replica()];
    const t = await seed(a, as, "app_lock_1");
    as.revokeAccessTokens();
    const stale = { headers: { Authorization: `Bearer ${t.access_token}` } };

    const all = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const c = i % 2 === 0 ? a : b;
        await c.onUnauthorized(ORG, "app_lock_1", AUTH, ACCOUNT, stale);
        return c.injection(ORG, "app_lock_1", AUTH, ACCOUNT);
      }),
    );
    expect(refreshes(as)).toHaveLength(1);
    expect(refreshes(as)[0]?.status).toBe(200);
    const tokens = new Set(all.map((inj) => inj.headers.Authorization));
    expect(tokens.size).toBe(1);
    const fresh = [...tokens][0] as string;
    expect(fresh).not.toBe(stale.headers.Authorization);
    expect(as.verify(fresh.slice("Bearer ".length))).toBe(true);
    // 锁已释放
    expect(await redises[0]?.keys("capk:oauth-refresh:*")).toEqual([]);

    // 已经过期的旧 token 再报 401（另一个请求迟到）：重读到的已是新 token，不再刷新
    await b.onUnauthorized(ORG, "app_lock_1", AUTH, ACCOUNT, stale);
    expect(refreshes(as)).toHaveLength(1);
  }, 30_000);

  it("refresh 被拒（invalid_grant）→ 凭据删除，抛 CredentialMissing（personal）", async () => {
    const as = await startFakeOAuthServer({ clients: [pub] });
    stops.push(() => as.stop());
    const a = replica();
    const t = await seed(a, as, "app_lock_2");
    as.revokeRefreshTokens();
    const stale = { headers: { Authorization: `Bearer ${t.access_token}` } };
    const err = await a.onUnauthorized(ORG, "app_lock_2", AUTH, ACCOUNT, stale).catch((e) => e);
    expect(err).toBeInstanceOf(CredentialMissing);
    expect((err as CredentialMissing).ownership).toBe("personal");
    expect(await a.status(ORG, "app_lock_2", AUTH, ACCOUNT)).toBe("missing");
  });

  it("429 / 408 / WAF 403 / 没有错误码的 400 / invalid_scope → 暂时不可用，凭据保留", async () => {
    const as = await startFakeOAuthServer({ clients: [pub] });
    stops.push(() => as.stop());
    const a = replica();
    const t = await seed(a, as, "app_lock_5");
    const stale = { headers: { Authorization: `Bearer ${t.access_token}` } };
    const cases: [number, unknown][] = [
      [429, { error: "slow_down" }],
      [408, {}],
      [403, { error: "invalid_grant" }],
      [400, "<html>bad gateway</html>"],
      [401, { error: "Not An OAuth Code!" }],
      [400, { error: "invalid_scope" }],
    ];
    for (const [status, body] of cases) {
      as.failTokenRequests(1, status, body);
      const err = await a.onUnauthorized(ORG, "app_lock_5", AUTH, ACCOUNT, stale).catch((e) => e);
      expect(err, `${status} ${JSON.stringify(body)}`).toBeInstanceOf(ToolError);
      expect((err as ToolError).kind).toBe("unavailable");
      expect(await a.status(ORG, "app_lock_5", AUTH, ACCOUNT)).toBe("connected");
    }
    // 之后授权服务器恢复：照常刷新成功
    await a.onUnauthorized(ORG, "app_lock_5", AUTH, ACCOUNT, stale);
    expect(refreshes(as).at(-1)?.status).toBe(200);
  });

  it("围栏：refresh 被拒期间另一个刷新者已写入新 token → 不删，直接用新的", async () => {
    const as = await startFakeOAuthServer({ clients: [pub], tokenDelayMs: 400 });
    stops.push(() => as.stop());
    const a = replica();
    const t = await seed(a, as, "app_lock_6");
    as.revokeRefreshTokens();
    const stale = { headers: { Authorization: `Bearer ${t.access_token}` } };
    const fresh = await issueTokens(as);
    const pending = a.onUnauthorized(ORG, "app_lock_6", AUTH, ACCOUNT, stale);
    // 模拟锁过期后另一个副本刷新成功并写入（在这次 refresh 请求返回 invalid_grant 之前）
    await new Promise((r) => setTimeout(r, 150));
    await a.setOAuthTokens(
      ORG,
      "app_lock_6",
      { kind: "user", accountId: ACCOUNT },
      {
        access_token: fresh.access_token,
        refresh_token: fresh.refresh_token,
        expires_at: Date.now() + 3_600_000,
        token_type: "Bearer",
      },
    );
    await pending;
    expect(refreshes(as).map((r) => r.status)).toEqual([400]);
    const inj = await a.injection(ORG, "app_lock_6", AUTH, ACCOUNT);
    expect(inj.headers.Authorization).toBe(`Bearer ${fresh.access_token}`);
  });

  it("授权服务器不可达 → 不可用错误（ToolError unavailable），凭据保留", async () => {
    const as = await startFakeOAuthServer({ clients: [pub] });
    const a = replica();
    const t = await seed(a, as, "app_lock_3");
    await as.stop();
    const stale = { headers: { Authorization: `Bearer ${t.access_token}` } };
    const err = await a.onUnauthorized(ORG, "app_lock_3", AUTH, ACCOUNT, stale).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe("unavailable");
    expect(await a.status(ORG, "app_lock_3", AUTH, ACCOUNT)).toBe("connected");
  });

  it("调用前 60 秒内过期 → 先刷新；refresh token、新旧 access token 都登记日志打码", async () => {
    const as = await startFakeOAuthServer({ clients: [pub], accessTokenTtl: 30 });
    stops.push(() => as.stop());
    const own: string[] = [];
    const log = createLogger("info", { write: (l) => own.push(l) });
    const a = replica(log);
    const t = await seed(a, as, "app_lock_4");
    const inj = await a.injection(ORG, "app_lock_4", AUTH, ACCOUNT);
    expect(refreshes(as)).toHaveLength(1);
    expect(inj.headers.Authorization).not.toBe(`Bearer ${t.access_token}`);
    log.warn("probe", { values: as.issuedSecrets() });
    const text = own.join("\n");
    for (const s of as.issuedSecrets()) expect(text.includes(s), s).toBe(false);
  });
});
