import type { AuthInjection } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import type { KernelConfig } from "../config/schema.js";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelDatabase, KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { KernelLogger } from "../log.js";
import { oauthHttpOptions } from "./oauth/discovery.js";
import {
  type OAuthClientRecord,
  OAuthReconnectRequired,
  type OAuthStore,
  type OAuthTokenRecord,
  OAuthTokens,
} from "./oauth/tokens.js";
import { injectionSecrets } from "./redact.js";

export type Ownership = "org" | "personal";

/** 静态认证方式（连接器安装时选定）；`headers` 的值本身就是凭据。 */
export type StaticAuth =
  | { type: "none" }
  | { type: "bearer"; ownership: Ownership }
  | { type: "api_key"; ownership: Ownership; in: "header" | "query"; name: string }
  | { type: "basic"; ownership: Ownership }
  | { type: "headers"; ownership: Ownership; names: string[] };

/**
 * OAuth 认证方式。授权码流为个人凭据（每个成员自己连接），`discovery: "mcp"` 时端点经 MCP OAuth 发现得到，
 * `client: "dcr"` 时安装时动态注册客户端（只能配合 MCP 发现）；客户端凭据流为组织凭据。
 */
export type OAuthAuth =
  | {
      type: "oauth_code";
      ownership: "personal";
      discovery: "mcp" | "manual";
      authorizationUrl?: string | undefined;
      tokenUrl?: string | undefined;
      scopes?: string[] | undefined;
      client: "dcr" | "manual";
      /** 令牌端点的客户端认证方式（有密钥时），默认 client_secret_basic。 */
      tokenAuthMethod?: "client_secret_basic" | "client_secret_post" | undefined;
    }
  | {
      type: "oauth_client";
      ownership: "org";
      tokenUrl: string;
      scopes?: string[] | undefined;
      tokenAuthMethod?: "client_secret_basic" | "client_secret_post" | undefined;
    };

export type ConnectorAuth = StaticAuth | OAuthAuth;

export const isOAuth = (auth: ConnectorAuth): auth is OAuthAuth =>
  auth.type === "oauth_code" || auth.type === "oauth_client";

/** 静态凭据的存储形态（JSON 序列化后信封加密）。 */
export type StaticSecret =
  | { token: string }
  | { username: string; password: string }
  | { headers: Record<string, string> };

export type CredentialOwner = { kind: "org" } | { kind: "user"; accountId: string };

/** 缺凭据：只带连接器 id 与归属，绝不带值。 */
export class CredentialMissing extends ApiError {
  constructor(
    readonly connectorId: string,
    readonly ownership: Ownership,
  ) {
    super(
      "credential.missing",
      `No credential configured for connector ${connectorId} (${ownership})`,
    );
    this.name = "CredentialMissing";
  }
}

/**
 * 内核自己的 secrets 命名空间：plugin-sdk 把 `kernel` 列为保留插件名，而 `credentials` 是合法插件名，
 * 会与某个同名插件的 ctx.secrets 相撞，所以凭据用 `kernel` 命名空间加 `credentials:` 键前缀。
 */
const NAMESPACE = "kernel";

/* secrets 键沿用改名前的 `credentials:app:<connectorId>:…`（D17 / C27：已存数据不迁移）。 */

const NO_COLON = (label: string, v: string) => {
  if (v.length === 0 || v.includes(":")) throw new Error(`credentials: invalid ${label}`);
};
const orgKey = (connectorId: string) => {
  NO_COLON("connectorId", connectorId);
  return `credentials:app:${connectorId}:org`;
};
const userKey = (connectorId: string, accountId: string) => {
  NO_COLON("connectorId", connectorId);
  NO_COLON("accountId", accountId);
  return `credentials:app:${connectorId}:user:${accountId}`;
};
const keyOf = (connectorId: string, owner: CredentialOwner) =>
  owner.kind === "org" ? orgKey(connectorId) : userKey(connectorId, owner.accountId);
/** OAuth 客户端（组织级，按连接器一条）。 */
const clientKey = (connectorId: string) => {
  NO_COLON("connectorId", connectorId);
  return `credentials:app:${connectorId}:client`;
};
const ownerOf = (auth: ConnectorAuth, accountId: string): CredentialOwner =>
  auth.type !== "none" && auth.ownership === "personal"
    ? { kind: "user", accountId }
    : { kind: "org" };

const nonEmpty = z.string().min(1);
const secretSchemas = {
  token: z.strictObject({ token: nonEmpty }),
  basic: z.strictObject({ username: nonEmpty, password: nonEmpty }),
};

/**
 * 删除某账号在该组织所有连接器上的个人凭据（`credentials:app:<connectorId>:user:<accountId>`，含已删除连接器残留的），
 * 成员离职时在其事务内调用（不解密，不需要密钥环）。返回删除条数。
 */
export async function clearAccountCredentials(
  db: KernelSchemaDb | Transaction<KernelDatabase>,
  orgId: string,
  accountId: string,
): Promise<number> {
  NO_COLON("accountId", accountId);
  const prefix = "credentials:app:";
  const suffix = `:user:${accountId}`;
  const r = await db
    .deleteFrom("secrets")
    .where("namespace", "=", NAMESPACE)
    .where("org_id", "=", orgId)
    .where(sql<string>`left(key, ${prefix.length})`, "=", prefix)
    .where(sql<string>`right(key, ${suffix.length})`, "=", suffix)
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}

/** OAuth 刷新所需的依赖（锁在 Redis，往返限时与本机 http 放行取自配置）。 */
export interface CredentialsOAuthDeps {
  redis: Redis;
  config: () => KernelConfig;
}

/**
 * 连接器凭据：信封加密存入 capybara.secrets，解密后只在构造注入头时出现。OAuth 连接器的 token 也存在这里
 * （个人 / 组织键，同静态凭据），OAuth 客户端存组织级的 `:client` 键；刷新见 oauth/tokens.ts。
 */
export class Credentials {
  private readonly tokens: OAuthTokens | undefined;

  constructor(
    private readonly db: KernelSchemaDb,
    private readonly keyring: Keyring,
    private readonly log: KernelLogger,
    oauth?: CredentialsOAuthDeps,
  ) {
    if (oauth) {
      const store: OAuthStore = {
        readClient: (orgId, connectorId) => this.oauthClient(orgId, connectorId),
        readTokens: (orgId, connectorId, owner) => this.oauthTokens(orgId, connectorId, owner),
        writeTokens: (orgId, connectorId, owner, rec) =>
          this.setOAuthTokens(orgId, connectorId, owner, rec),
        deleteTokens: (orgId, connectorId, owner) => this.clear(orgId, connectorId, owner),
      };
      this.tokens = new OAuthTokens(
        store,
        oauth.redis,
        () => oauthHttpOptions(oauth.config()),
        log,
      );
    }
  }

  private oauth(): OAuthTokens {
    if (!this.tokens) throw new Error("credentials: OAuth is not configured");
    return this.tokens;
  }

  /** 读一条 JSON 凭据；不存在 / 解不开 → null（日志不带内容）。 */
  private async readJson(orgId: string, key: string, connectorId: string): Promise<unknown> {
    const raw = await this.secrets().get(orgId, key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      this.log.warn("credential payload is corrupted", { connectorId });
      return null;
    }
  }

  /** OAuth 客户端与令牌里的密钥值登记日志打码（logger 只收 ≥ 12 的值）。 */
  private registerSecrets(values: (string | undefined)[]): void {
    this.log.addOrgSecrets(values.filter((v): v is string => typeof v === "string" && v !== ""));
  }

  async oauthClient(orgId: string, connectorId: string): Promise<OAuthClientRecord | null> {
    const v = (await this.readJson(
      orgId,
      clientKey(connectorId),
      connectorId,
    )) as OAuthClientRecord | null;
    if (v === null || typeof v !== "object" || typeof v.clientId !== "string") return null;
    this.registerSecrets([v.clientSecret, v.registration?.accessToken]);
    return v;
  }

  async setOAuthClient(
    orgId: string,
    connectorId: string,
    client: OAuthClientRecord,
    trx?: Transaction<KernelDatabase>,
  ): Promise<void> {
    this.registerSecrets([client.clientSecret, client.registration?.accessToken]);
    await this.secrets(trx).set(orgId, clientKey(connectorId), JSON.stringify(client));
  }

  async oauthTokens(
    orgId: string,
    connectorId: string,
    owner: CredentialOwner,
  ): Promise<OAuthTokenRecord | null> {
    const v = (await this.readJson(
      orgId,
      keyOf(connectorId, owner),
      connectorId,
    )) as OAuthTokenRecord | null;
    if (v === null || typeof v !== "object" || typeof v.access_token !== "string") return null;
    this.registerSecrets([v.access_token, v.refresh_token]);
    return v;
  }

  async setOAuthTokens(
    orgId: string,
    connectorId: string,
    owner: CredentialOwner,
    rec: OAuthTokenRecord,
    trx?: Transaction<KernelDatabase>,
  ): Promise<void> {
    this.registerSecrets([rec.access_token, rec.refresh_token]);
    await this.secrets(trx).set(orgId, keyOf(connectorId, owner), JSON.stringify(rec));
  }

  private secrets(db: KernelSchemaDb | Transaction<KernelDatabase> = this.db) {
    return createSecrets(db, this.keyring, NAMESPACE);
  }

  /**
   * 按认证方式校验凭据形状与归属；错误（`validation_failed`）只含路径与英文说明，不回显值。
   * 连接器创建时先用它校验、再拿内存中的值连接，连上之后才落库。
   */
  validate(
    auth: ConnectorAuth,
    owner: CredentialOwner,
    value: unknown,
  ): asserts value is StaticSecret {
    const fail = (issues: { path: string; message: string }[]) =>
      new ApiError("validation_failed", "Invalid credential", issues);
    if (auth.type === "none")
      throw fail([{ path: "", message: "Auth type none takes no credential" }]);
    if (isOAuth(auth)) {
      throw fail([
        {
          path: "",
          message:
            "OAuth connectors get their tokens through the connect flow; credentials cannot be set directly",
        },
      ]);
    }
    const want = auth.ownership === "org" ? "org" : "user";
    if (owner.kind !== want) {
      throw fail([
        {
          path: "owner",
          message: `Credential owner must be ${want} for ${auth.ownership} ownership`,
        },
      ]);
    }
    let schema: z.ZodType;
    if (auth.type === "bearer" || auth.type === "api_key") schema = secretSchemas.token;
    else if (auth.type === "basic") schema = secretSchemas.basic;
    else {
      const names = auth.names;
      schema = z.strictObject({ headers: z.record(z.string(), nonEmpty) }).superRefine((v, ctx) => {
        for (const n of names) {
          if (!(n in v.headers))
            ctx.addIssue({
              code: "custom",
              path: ["headers", n],
              message: "Required header is missing",
            });
        }
        for (const n of Object.keys(v.headers)) {
          if (!names.includes(n))
            ctx.addIssue({ code: "custom", path: ["headers", n], message: "Unexpected header" });
        }
      });
    }
    const r = schema.safeParse(value);
    if (!r.success) {
      throw fail(r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
  }

  async setStatic(
    orgId: string,
    connectorId: string,
    auth: ConnectorAuth,
    owner: CredentialOwner,
    value: StaticSecret,
    /** 传入时在调用方事务内写入（与连接器行 / 审计同生共死）。 */
    trx?: Transaction<KernelDatabase>,
  ): Promise<void> {
    this.validate(auth, owner, value);
    await this.secrets(trx).set(orgId, keyOf(connectorId, owner), JSON.stringify(value));
  }

  async clear(
    orgId: string,
    connectorId: string,
    owner: CredentialOwner,
    trx?: Transaction<KernelDatabase>,
  ): Promise<void> {
    await this.secrets(trx).delete(orgId, keyOf(connectorId, owner));
  }

  /** 删除某连接器的全部凭据（组织凭据与所有成员的个人凭据），连接器删除时调用。 */
  async clearConnector(
    orgId: string,
    connectorId: string,
    trx?: Transaction<KernelDatabase>,
  ): Promise<void> {
    const prefix = orgKey(connectorId).slice(0, -"org".length);
    await (trx ?? this.db)
      .deleteFrom("secrets")
      .where("namespace", "=", NAMESPACE)
      .where("org_id", "=", orgId)
      .where("key", "like", `${prefix}%`)
      .execute();
  }

  /** 删除某账号在该组织所有连接器上的个人凭据，见 {@link clearAccountCredentials}。 */
  async clearAccount(
    orgId: string,
    accountId: string,
    trx?: Transaction<KernelDatabase>,
  ): Promise<number> {
    return clearAccountCredentials(trx ?? this.db, orgId, accountId);
  }

  /**
   * 持有该连接器个人凭据的**现任成员**（不解密），按凭据最近写入时间倒序（保存静态凭据、OAuth 连接与刷新 token
   * 都会更新写入时间），最多 `limit` 个。漂移检查用它挑个人凭据型连接器的凭据。
   */
  async personalHolders(orgId: string, connectorId: string, limit: number): Promise<string[]> {
    const prefix = userKey(connectorId, "x").slice(0, -1);
    const rows = await sql<{ account_id: string }>`
      SELECT m.account_id FROM capybara.secrets s
      JOIN capybara.memberships m
        ON m.org_id = s.org_id AND m.account_id = substr(s.key, ${prefix.length + 1})
      WHERE s.namespace = ${NAMESPACE} AND s.org_id = ${orgId}
        AND left(s.key, ${prefix.length}) = ${prefix}
      ORDER BY s.updated_at DESC, m.account_id
      LIMIT ${limit}`.execute(this.db);
    return rows.rows.map((r) => r.account_id);
  }

  /** 只看与 auth.ownership 对应的那一条凭据是否存在（不解密）；none 恒为 connected。 */
  async status(
    orgId: string,
    connectorId: string,
    auth: ConnectorAuth,
    accountId: string,
    trx?: Transaction<KernelDatabase>,
  ): Promise<"connected" | "missing"> {
    if (auth.type === "none") return "connected";
    // 客户端凭据流：有客户端即可按需取 token
    const key =
      auth.type === "oauth_client"
        ? clientKey(connectorId)
        : auth.ownership === "personal"
          ? userKey(connectorId, accountId)
          : orgKey(connectorId);
    const row = await (trx ?? this.db)
      .selectFrom("secrets")
      .select("key")
      .where("namespace", "=", NAMESPACE)
      .where("org_id", "=", orgId)
      .where("key", "=", key)
      .executeTakeFirst();
    return row ? "connected" : "missing";
  }

  /** 返回本次请求要注入的头 / 查询参数；缺凭据抛 CredentialMissing。 */
  async injection(
    orgId: string,
    connectorId: string,
    auth: ConnectorAuth,
    accountId: string,
  ): Promise<AuthInjection> {
    if (auth.type === "none") return { headers: {} };
    const owner = ownerOf(auth, accountId);
    if (isOAuth(auth)) {
      const token = await this.oauthCall(connectorId, auth, () =>
        this.oauth().accessToken(orgId, connectorId, auth, owner),
      );
      return this.injectionFor(connectorId, auth, { token });
    }
    const missing = () => new CredentialMissing(connectorId, auth.ownership);
    const raw = await this.secrets().get(orgId, keyOf(connectorId, owner));
    if (raw === null) throw missing();
    let value: StaticSecret;
    try {
      value = JSON.parse(raw);
    } catch {
      // 密文解开后不是合法 JSON：按缺失处理，日志不带内容
      this.log.warn("credential payload is corrupted", { connectorId });
      throw missing();
    }
    return this.injectionFor(connectorId, auth, value);
  }

  /**
   * 连接器收到 401 时调用（`stale` 为那次请求注入的鉴权）：OAuth 连接器在刷新锁内强制刷新，之后的 `injection()`
   * 返回新 token；refresh 被拒 → 凭据删除并抛 CredentialMissing。静态凭据无事可做。
   */
  async onUnauthorized(
    orgId: string,
    connectorId: string,
    auth: ConnectorAuth,
    accountId: string,
    stale?: AuthInjection,
  ): Promise<void> {
    if (!isOAuth(auth)) return;
    const header = stale?.headers.Authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    await this.oauthCall(connectorId, auth, () =>
      this.oauth().forceRefresh(orgId, connectorId, auth, ownerOf(auth, accountId), token),
    );
  }

  /** 「需要重新连接」→ CredentialMissing（个人凭据由管线转成 connection_required）。 */
  private async oauthCall<T>(
    connectorId: string,
    auth: OAuthAuth,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (e instanceof OAuthReconnectRequired) {
        throw new CredentialMissing(
          connectorId,
          e.owner.kind === "user" ? "personal" : auth.ownership,
        );
      }
      throw e;
    }
  }

  /**
   * 由凭据值构造注入（不读库）；值登记日志打码。连接器创建时用请求里带的、尚未落库的凭据连接。
   * 值缺字段 → CredentialMissing。
   */
  injectionFor(connectorId: string, auth: ConnectorAuth, secret: StaticSecret): AuthInjection {
    const inj = this.build(connectorId, auth, secret);
    // 与工具结果打码同一套展开（含 scheme 后的 token、Basic 解码串、百分号编码形式）；logger 只收 ≥ 12 的值
    this.log.addOrgSecrets(injectionSecrets(inj));
    return inj;
  }

  private build(connectorId: string, auth: ConnectorAuth, secret: StaticSecret): AuthInjection {
    if (auth.type === "none") return { headers: {} };
    if (isOAuth(auth)) {
      const token = (secret as { token?: unknown }).token;
      if (typeof token !== "string" || token === "")
        throw new CredentialMissing(connectorId, auth.ownership);
      return { headers: { Authorization: `Bearer ${token}` } };
    }
    const missing = () => new CredentialMissing(connectorId, auth.ownership);
    if (typeof secret !== "object" || secret === null) throw missing();
    const value = secret as Partial<{
      token: string;
      username: string;
      password: string;
      headers: Record<string, string>;
    }>;
    switch (auth.type) {
      case "bearer": {
        if (!value.token) throw missing();
        return { headers: { Authorization: `Bearer ${value.token}` } };
      }
      case "api_key": {
        if (!value.token) throw missing();
        return auth.in === "header"
          ? { headers: { [auth.name]: value.token } }
          : { headers: {}, query: { [auth.name]: value.token } };
      }
      case "basic": {
        if (value.username === undefined || value.password === undefined) throw missing();
        const encoded = Buffer.from(`${value.username}:${value.password}`).toString("base64");
        return { headers: { Authorization: `Basic ${encoded}` } };
      }
      case "headers": {
        const headers: Record<string, string> = {};
        for (const name of auth.names) {
          const v = value.headers?.[name];
          if (v === undefined) throw missing();
          headers[name] = v;
        }
        return { headers };
      }
    }
  }
}
