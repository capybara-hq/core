import { createHash, randomBytes } from "node:crypto";
import type { ExternalIdentity } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import type { KernelConfig } from "../config/schema.js";
import { ApiError } from "../errors.js";
import type { ExternalIdentities } from "./external.js";

/** 绑定令牌的有效期（秒）。 */
export const BIND_TOKEN_TTL_SECONDS = 900;
/** 绑定确认页（网页）路径前缀：`<http.publicUrl>/bind/<token>`。 */
export const BIND_PAGE_PATH = "/bind/";
/** 令牌前缀：日志里的路径段按 `cap_` 前缀自动打码。 */
const TOKEN_PREFIX = "cap_bind_";
const TOKEN_RE = /^cap_bind_[A-Za-z0-9_-]{43}$/;

/** Redis 里只存令牌的哈希，拿到 Redis 内容也换不出可用的绑定链接。 */
const tokenKey = (token: string) =>
  `capk:bind:${createHash("sha256").update(token).digest("base64url")}`;

interface BindRecord {
  connectionId: string;
  identity: ExternalIdentity;
}

/** 绑定确认页展示的待绑定身份。 */
export interface PendingBinding {
  connectionId: string;
  source: string;
  externalId: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
}

const invalid = () => new ApiError("bind.invalid", "Binding link is invalid or has expired");

const view = (r: BindRecord): PendingBinding => ({
  connectionId: r.connectionId,
  source: r.identity.source,
  externalId: r.identity.externalId,
  displayName: r.identity.displayName,
  ...(r.identity.email !== undefined && { email: r.identity.email }),
  ...(r.identity.avatarUrl !== undefined && { avatarUrl: r.identity.avatarUrl }),
});

/**
 * IM 里识别不出的人：内核发一个一次性绑定链接，本人登录网页后确认，把该 IM 身份绑到当前账号。
 * 令牌 `cap_bind_<32 字节>`，Redis `capk:bind:<sha256>` 15 分钟、单次有效（确认时 GETDEL）。框架无关。
 */
export class IdentityBinding {
  constructor(
    private readonly deps: {
      redis: Redis;
      config: () => KernelConfig;
      external: ExternalIdentities;
    },
  ) {}

  /** 生成绑定链接（渠道运行时在回绑定卡片时调用）；需要 `http.publicUrl`。 */
  async createBindToken(args: {
    connectionId: string;
    identity: ExternalIdentity;
  }): Promise<string> {
    const publicUrl = this.deps.config().http.publicUrl;
    if (!publicUrl) throw new Error("binding links require http.publicUrl to be configured");
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const rec: BindRecord = { connectionId: args.connectionId, identity: args.identity };
    await this.deps.redis.set(tokenKey(token), JSON.stringify(rec), "EX", BIND_TOKEN_TTL_SECONDS);
    return `${publicUrl.replace(/\/+$/, "")}${BIND_PAGE_PATH}${token}`;
  }

  /** 查看待绑定的身份（不消耗令牌）；无效 / 过期 / 已用 → `bind.invalid`。 */
  async peek(token: string): Promise<PendingBinding> {
    if (!TOKEN_RE.test(token)) throw invalid();
    const raw = await this.deps.redis.get(tokenKey(token));
    if (raw === null) throw invalid();
    return view(JSON.parse(raw) as BindRecord);
  }

  /**
   * 把令牌里的身份绑到 `accountId`：先 GETDEL 消耗令牌（并发确认只有一个拿到），再绑定；
   * 已绑定他人 → `identity.taken`（令牌同样作废，需在 IM 里重新获取）。
   */
  async bind(token: string, accountId: string): Promise<PendingBinding> {
    if (!TOKEN_RE.test(token)) throw invalid();
    const raw = await this.deps.redis.getdel(tokenKey(token));
    if (raw === null) throw invalid();
    const rec = JSON.parse(raw) as BindRecord;
    await this.deps.external.link(accountId, rec.identity);
    return view(rec);
  }
}
