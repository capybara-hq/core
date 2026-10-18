import type { AuthInjection } from "@capybara-hq/plugin-sdk";
import type { Transaction } from "kysely";
import { z } from "zod";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { KernelLogger } from "../log.js";
import { injectionSecrets } from "./redact.js";

export type Ownership = "org" | "personal";

/** 静态认证方式（应用安装时选定）；`headers` 的值本身就是凭据。 */
export type StaticAuth =
  | { type: "none" }
  | { type: "bearer"; ownership: Ownership }
  | { type: "api_key"; ownership: Ownership; in: "header" | "query"; name: string }
  | { type: "basic"; ownership: Ownership }
  | { type: "headers"; ownership: Ownership; names: string[] };

/** 本任务只有静态认证；OAuth 在 Task 15 并入。 */
export type AppAuth = StaticAuth;

/** 静态凭据的存储形态（JSON 序列化后信封加密）。 */
export type StaticSecret =
  | { token: string }
  | { username: string; password: string }
  | { headers: Record<string, string> };

export type CredentialOwner = { kind: "org" } | { kind: "user"; accountId: string };

/** 缺凭据：只带应用 id 与归属，绝不带值。 */
export class CredentialMissing extends ApiError {
  constructor(
    readonly appId: string,
    readonly ownership: Ownership,
  ) {
    super("credential.missing", `No credential configured for app ${appId} (${ownership})`);
    this.name = "CredentialMissing";
  }
}

/**
 * 内核自己的 secrets 命名空间：plugin-sdk 把 `kernel` 列为保留插件名，而 `credentials` 是合法插件名，
 * 会与某个同名插件的 ctx.secrets 相撞，所以凭据用 `kernel` 命名空间加 `credentials:` 键前缀。
 */
const NAMESPACE = "kernel";

const NO_COLON = (label: string, v: string) => {
  if (v.length === 0 || v.includes(":")) throw new Error(`credentials: invalid ${label}`);
};
const orgKey = (appId: string) => {
  NO_COLON("appId", appId);
  return `credentials:app:${appId}:org`;
};
const userKey = (appId: string, accountId: string) => {
  NO_COLON("appId", appId);
  NO_COLON("accountId", accountId);
  return `credentials:app:${appId}:user:${accountId}`;
};
const keyOf = (appId: string, owner: CredentialOwner) =>
  owner.kind === "org" ? orgKey(appId) : userKey(appId, owner.accountId);

const nonEmpty = z.string().min(1);
const secretSchemas = {
  token: z.strictObject({ token: nonEmpty }),
  basic: z.strictObject({ username: nonEmpty, password: nonEmpty }),
};

/** 应用凭据：信封加密存入 capybara.secrets，解密后只在构造注入头时出现。 */
export class Credentials {
  constructor(
    private readonly db: KernelDb,
    private readonly keyring: Keyring,
    private readonly log: KernelLogger,
  ) {}

  private secrets(db: KernelDb | Transaction<KernelDatabase> = this.db) {
    return createSecrets(db, this.keyring, NAMESPACE);
  }

  /**
   * 按认证方式校验凭据形状与归属；错误（`validation_failed`）只含路径与英文说明，不回显值。
   * 应用创建时先用它校验、再拿内存中的值连接，连上之后才落库。
   */
  validate(auth: AppAuth, owner: CredentialOwner, value: unknown): asserts value is StaticSecret {
    const fail = (issues: { path: string; message: string }[]) =>
      new ApiError("validation_failed", "Invalid credential", issues);
    if (auth.type === "none")
      throw fail([{ path: "", message: "Auth type none takes no credential" }]);
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
    appId: string,
    auth: AppAuth,
    owner: CredentialOwner,
    value: StaticSecret,
    /** 传入时在调用方事务内写入（与应用行 / 审计同生共死）。 */
    trx?: Transaction<KernelDatabase>,
  ): Promise<void> {
    this.validate(auth, owner, value);
    await this.secrets(trx).set(orgId, keyOf(appId, owner), JSON.stringify(value));
  }

  async clear(
    orgId: string,
    appId: string,
    owner: CredentialOwner,
    trx?: Transaction<KernelDatabase>,
  ): Promise<void> {
    await this.secrets(trx).delete(orgId, keyOf(appId, owner));
  }

  /** 删除某应用的全部凭据（组织凭据与所有成员的个人凭据），应用删除时调用。 */
  async clearApp(orgId: string, appId: string, trx?: Transaction<KernelDatabase>): Promise<void> {
    const prefix = orgKey(appId).slice(0, -"org".length);
    await (trx ?? this.db)
      .deleteFrom("secrets")
      .where("namespace", "=", NAMESPACE)
      .where("org_id", "=", orgId)
      .where("key", "like", `${prefix}%`)
      .execute();
  }

  /** 只看与 auth.ownership 对应的那一条凭据是否存在（不解密）；none 恒为 connected。 */
  async status(
    orgId: string,
    appId: string,
    auth: AppAuth,
    accountId: string,
    trx?: Transaction<KernelDatabase>,
  ): Promise<"connected" | "missing"> {
    if (auth.type === "none") return "connected";
    const key = auth.ownership === "personal" ? userKey(appId, accountId) : orgKey(appId);
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
    appId: string,
    auth: AppAuth,
    accountId: string,
  ): Promise<AuthInjection> {
    if (auth.type === "none") return { headers: {} };
    const owner: CredentialOwner =
      auth.ownership === "personal" ? { kind: "user", accountId } : { kind: "org" };
    const missing = () => new CredentialMissing(appId, auth.ownership);
    const raw = await this.secrets().get(orgId, keyOf(appId, owner));
    if (raw === null) throw missing();
    let value: StaticSecret;
    try {
      value = JSON.parse(raw);
    } catch {
      // 密文解开后不是合法 JSON：按缺失处理，日志不带内容
      this.log.warn("credential payload is corrupted", { appId });
      throw missing();
    }
    return this.injectionFor(appId, auth, value);
  }

  /**
   * 由凭据值构造注入（不读库）；值登记日志打码。应用创建时用请求里带的、尚未落库的凭据连接。
   * 值缺字段 → CredentialMissing。
   */
  injectionFor(appId: string, auth: AppAuth, secret: StaticSecret): AuthInjection {
    const inj = this.build(appId, auth, secret);
    // 与工具结果打码同一套展开（含 scheme 后的 token、Basic 解码串、百分号编码形式）；logger 只收 ≥ 12 的值
    this.log.addOrgSecrets(injectionSecrets(inj));
    return inj;
  }

  private build(appId: string, auth: AppAuth, secret: StaticSecret): AuthInjection {
    if (auth.type === "none") return { headers: {} };
    const missing = () => new CredentialMissing(appId, auth.ownership);
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
