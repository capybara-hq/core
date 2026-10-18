import type { AuthInjection } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { KernelLogger } from "../log.js";

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

  private secrets() {
    return createSecrets(this.db, this.keyring, NAMESPACE);
  }

  /** 按认证方式校验凭据形状；错误只含路径与英文说明，不回显值。 */
  private validate(auth: AppAuth, owner: CredentialOwner, value: unknown): void {
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
  ): Promise<void> {
    this.validate(auth, owner, value);
    await this.secrets().set(orgId, keyOf(appId, owner), JSON.stringify(value));
  }

  async clear(orgId: string, appId: string, owner: CredentialOwner): Promise<void> {
    await this.secrets().delete(orgId, keyOf(appId, owner));
  }

  /** 只看与 auth.ownership 对应的那一条凭据是否存在（不解密）；none 恒为 connected。 */
  async status(
    orgId: string,
    appId: string,
    auth: AppAuth,
    accountId: string,
  ): Promise<"connected" | "missing"> {
    if (auth.type === "none") return "connected";
    const key = auth.ownership === "personal" ? userKey(appId, accountId) : orgKey(appId);
    const row = await this.db
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
    let value: Partial<{
      token: string;
      username: string;
      password: string;
      headers: Record<string, string>;
    }>;
    try {
      value = JSON.parse(raw);
    } catch {
      // 密文解开后不是合法 JSON：按缺失处理，日志不带内容
      this.log.warn("credential payload is corrupted", { appId });
      throw missing();
    }

    switch (auth.type) {
      case "bearer": {
        if (!value.token) throw missing();
        this.log.addOrgSecrets([value.token]);
        return { headers: { Authorization: `Bearer ${value.token}` } };
      }
      case "api_key": {
        if (!value.token) throw missing();
        this.log.addOrgSecrets([value.token]);
        return auth.in === "header"
          ? { headers: { [auth.name]: value.token } }
          : { headers: {}, query: { [auth.name]: value.token } };
      }
      case "basic": {
        if (value.username === undefined || value.password === undefined) throw missing();
        const encoded = Buffer.from(`${value.username}:${value.password}`).toString("base64");
        // 密码、拼接串与 base64 都可能出现在日志里
        this.log.addOrgSecrets([value.password, `${value.username}:${value.password}`, encoded]);
        return { headers: { Authorization: `Basic ${encoded}` } };
      }
      case "headers": {
        const headers: Record<string, string> = {};
        for (const name of auth.names) {
          const v = value.headers?.[name];
          if (v === undefined) throw missing();
          headers[name] = v;
        }
        this.log.addOrgSecrets(Object.values(headers));
        return { headers };
      }
    }
  }
}
