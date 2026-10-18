import type { AuthInjection } from "@capybara-hq/plugin-sdk";
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

const orgKey = (appId: string) => `credentials:app:${appId}:org`;
const userKey = (appId: string, accountId: string) => `credentials:app:${appId}:user:${accountId}`;
const keyOf = (appId: string, owner: CredentialOwner) =>
  owner.kind === "org" ? orgKey(appId) : userKey(appId, owner.accountId);

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

  async setStatic(
    orgId: string,
    appId: string,
    owner: CredentialOwner,
    value: StaticSecret,
  ): Promise<void> {
    await this.secrets().set(orgId, keyOf(appId, owner), JSON.stringify(value));
  }

  async clear(orgId: string, appId: string, owner: CredentialOwner): Promise<void> {
    await this.secrets().delete(orgId, keyOf(appId, owner));
  }

  /** 该账号对此应用是否已有凭据（个人凭据或组织凭据任一存在即为 connected）。 */
  async status(orgId: string, appId: string, accountId: string): Promise<"connected" | "missing"> {
    const s = this.secrets();
    const hit =
      (await s.get(orgId, userKey(appId, accountId))) ?? (await s.get(orgId, orgKey(appId)));
    return hit === null ? "missing" : "connected";
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
    const value = JSON.parse(raw) as Partial<{
      token: string;
      username: string;
      password: string;
      headers: Record<string, string>;
    }>;

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
