import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmbedClaims } from "@capybara-hq/plugin-sdk";
import type { Keyring } from "../ctx/secrets.js";

/** 嵌入令牌的有效期（秒）。网页在过期前 60 秒续期。 */
export const EMBED_TOKEN_TTL_SECONDS = 300;
/** 校验 `exp` 时容许的副本间时钟偏差（秒）。 */
export const EMBED_TOKEN_SKEW_SECONDS = 30;
/** HKDF 用途（keyring 派生时 info 为 `capybara:capybara-embed/1`），也是签名输入的域前缀。 */
export const EMBED_KEY_INFO = "capybara-embed/1";

/** 令牌总长上限：声明有界（id ≤ 100 字符），远小于此。 */
const TOKEN_MAX = 2048;
const MAC_LEN = 32;
const B64URL = /^[A-Za-z0-9_-]+$/;
const PLUGIN_RE = /^[a-z][a-z0-9-]{1,40}$/;
const CLAIM_KEYS = new Set([
  "plugin",
  "orgId",
  "accountId",
  "conversationId",
  "contribution",
  "exp",
]);

const isId = (v: unknown): v is string => typeof v === "string" && v !== "" && v.length <= 100;

/**
 * 严格解码 base64url：只允许字母表内字符、不带填充，且必须是规范编码（解码后再编码与原文相同），
 * 同一份字节只有一种写法。
 */
function decodeStrict(s: string): Buffer | null {
  if (!B64URL.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  return buf.toString("base64url") === s ? buf : null;
}

/** 逐字段核对声明：只认已知字段、类型正确，返回只含已知字段的新对象。 */
function parseClaims(v: unknown): EmbedClaims | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  if (Object.keys(c).some((k) => !CLAIM_KEYS.has(k))) return null;
  if (typeof c.plugin !== "string" || !PLUGIN_RE.test(c.plugin)) return null;
  if (!isId(c.orgId) || !isId(c.accountId) || !isId(c.contribution)) return null;
  if (c.conversationId !== undefined && !isId(c.conversationId)) return null;
  if (typeof c.exp !== "number" || !Number.isSafeInteger(c.exp)) return null;
  return {
    plugin: c.plugin,
    orgId: c.orgId,
    accountId: c.accountId,
    ...(c.conversationId !== undefined && { conversationId: c.conversationId }),
    contribution: c.contribution,
    exp: c.exp,
  };
}

/**
 * 嵌入令牌：`base64url(JSON 声明).base64url(HMAC-SHA256(key, "capybara-embed/1." + 第一段))`。
 * - 格式固定、没有头（没有 alg 可混淆）；密钥由主密钥环经 HKDF 派生，轮换后上一把主密钥签的令牌仍可校验到过期；
 * - 校验：严格 base64url、常量时间比较签名、逐字段核对声明、`exp` 容许 {@link EMBED_TOKEN_SKEW_SECONDS} 秒偏差、
 *   `exp` 不得超过「现在 + 有效期 + 偏差」、`plugin` 必须是调用方插件；任何一项不过都返回 null（不说明原因）。
 * 无状态（不落库、不进 Redis）：各副本用同一主密钥即可校验，不需要共享状态。
 */
export class EmbedTokens {
  private readonly current: Buffer;
  private readonly keys: Buffer[];
  private readonly now: () => number;

  constructor(keyring: Keyring, opts: { now?: () => number } = {}) {
    const derived = keyring.deriveKey(EMBED_KEY_INFO);
    const ids = [derived.currentId, ...keyring.toJSON().previousIds];
    this.current = derived.current;
    this.keys = ids.map((id) => derived.byId(id)).filter((k): k is Buffer => k !== undefined);
    this.now = opts.now ?? Date.now;
  }

  /** 签发：`exp` = 现在 + {@link EMBED_TOKEN_TTL_SECONDS}。 */
  issue(c: Omit<EmbedClaims, "exp">): { token: string; claims: EmbedClaims; expiresAt: Date } {
    const exp = Math.floor(this.now() / 1000) + EMBED_TOKEN_TTL_SECONDS;
    const claims = parseClaims({ ...c, exp });
    if (claims === null) throw new Error("embed token claims are invalid");
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const token = `${payload}.${mac(this.current, payload).toString("base64url")}`;
    return { token, claims, expiresAt: new Date(exp * 1000) };
  }

  /** 校验令牌并要求它签给 `plugin`；不通过返回 null。 */
  verify(token: unknown, plugin: string): EmbedClaims | null {
    if (typeof token !== "string" || token.length > TOKEN_MAX) return null;
    const dot = token.indexOf(".");
    if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
    const payload = token.slice(0, dot);
    const sig = decodeStrict(token.slice(dot + 1));
    const body = decodeStrict(payload);
    if (sig === null || body === null || sig.length !== MAC_LEN) return null;
    // 每把候选密钥都算一遍、常量时间比较（不因第一把匹配就提前返回）
    let ok = false;
    for (const key of this.keys) ok = timingSafeEqual(mac(key, payload), sig) || ok;
    if (!ok) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return null;
    }
    const claims = parseClaims(parsed);
    if (claims === null || claims.plugin !== plugin) return null;
    const nowSec = this.now() / 1000;
    if (claims.exp + EMBED_TOKEN_SKEW_SECONDS <= nowSec) return null;
    if (claims.exp > nowSec + EMBED_TOKEN_TTL_SECONDS + EMBED_TOKEN_SKEW_SECONDS) return null;
    return claims;
  }
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key).update(`${EMBED_KEY_INFO}.${payload}`).digest();
}
