import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKeyring } from "../../src/ctx/secrets.js";
import {
  EMBED_TOKEN_SKEW_SECONDS,
  EMBED_TOKEN_TTL_SECONDS,
  EmbedTokens,
} from "../../src/ui/embed-token.js";

/**
 * 嵌入令牌（审查重点 3）：`base64url(JSON 声明).base64url(HMAC-SHA256)`，密钥由主密钥经 HKDF 派生。
 * 给别的插件用、过期、篡改、格式不严格（填充、标准 base64 字符、多一段、JWT 头）一律返回 null。
 */

const K1 = Buffer.alloc(32, 1);
const K2 = Buffer.alloc(32, 2);
const T0 = 1_800_000_000_000;

const CLAIMS = {
  plugin: "example-board",
  orgId: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  contribution: "board",
  role: "member" as const,
};

const tokens = (now: number, ring = createKeyring(K1, [])) =>
  new EmbedTokens(ring, { now: () => now });

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

describe("EmbedTokens", () => {
  it("签发：有效期 300 秒，校验返回声明（只含已知字段）", () => {
    const t = tokens(T0);
    const issued = t.issue(CLAIMS);
    expect(EMBED_TOKEN_TTL_SECONDS).toBe(300);
    expect(issued.expiresAt.getTime()).toBe(T0 + 300_000);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(t.verify(issued.token, "example-board")).toEqual({
      ...CLAIMS,
      exp: (T0 + 300_000) / 1000,
    });
  });

  it("带对话的令牌：声明里有 conversationId", () => {
    const t = tokens(T0);
    const conv = "33333333-3333-4333-8333-333333333333";
    const { token } = t.issue({ ...CLAIMS, contribution: "board-conv", conversationId: conv });
    expect(t.verify(token, "example-board")).toMatchObject({ conversationId: conv });
  });

  it("给别的插件用 → null", () => {
    const t = tokens(T0);
    const { token } = t.issue(CLAIMS);
    expect(t.verify(token, "other-plugin")).toBeNull();
    expect(t.verify(token, "")).toBeNull();
  });

  it("过期 → null（容许至多 30 秒时钟偏差）", () => {
    const { token } = tokens(T0).issue(CLAIMS);
    expect(EMBED_TOKEN_SKEW_SECONDS).toBeLessThanOrEqual(30);
    const exp = T0 + 300_000;
    expect(tokens(exp - 1).verify(token, "example-board")).not.toBeNull();
    expect(
      tokens(exp + EMBED_TOKEN_SKEW_SECONDS * 1000 - 1).verify(token, "example-board"),
    ).not.toBeNull();
    expect(tokens(exp + EMBED_TOKEN_SKEW_SECONDS * 1000).verify(token, "example-board")).toBeNull();
    expect(tokens(exp + 3_600_000).verify(token, "example-board")).toBeNull();
  });

  it("篡改声明或签名 → null", () => {
    const t = tokens(T0);
    const { token } = t.issue(CLAIMS);
    const [payload, mac] = token.split(".") as [string, string];
    // 改声明（换插件 / 组织 / 延长过期），签名照旧
    const forged = (over: Record<string, unknown>) =>
      `${b64(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), ...over }))}.${mac}`;
    expect(t.verify(forged({ orgId: "99999999-9999-4999-8999-999999999999" }), CLAIMS.plugin)).toBe(
      null,
    );
    expect(t.verify(forged({ exp: T0 / 1000 + 86_400 }), CLAIMS.plugin)).toBeNull();
    expect(t.verify(forged({ plugin: "todo" }), "todo")).toBeNull();
    // 改签名一位
    const flipped = Buffer.from(mac, "base64url");
    flipped[0] = (flipped[0] as number) ^ 1;
    expect(t.verify(`${payload}.${b64(flipped)}`, CLAIMS.plugin)).toBeNull();
    // 截短签名
    expect(t.verify(`${payload}.${mac.slice(0, 20)}`, CLAIMS.plugin)).toBeNull();
    expect(t.verify(`${payload}.`, CLAIMS.plugin)).toBeNull();
  });

  it("别的主密钥签的 → null；轮换后上一把主密钥签的仍可校验", () => {
    const old = tokens(T0, createKeyring(K2, [])).issue(CLAIMS).token;
    expect(tokens(T0, createKeyring(K1, [])).verify(old, CLAIMS.plugin)).toBeNull();
    expect(tokens(T0, createKeyring(K1, [K2])).verify(old, CLAIMS.plugin)).not.toBeNull();
  });

  it("格式严格：填充、标准 base64 字符、多段、JWT 头、非 JSON、缺字段、多字段、非字符串输入 → null", () => {
    const t = tokens(T0);
    const { token } = t.issue(CLAIMS);
    const [payload, mac] = token.split(".") as [string, string];
    for (const bad of [
      `${payload}=.${mac}`,
      `${payload}.${mac}=`,
      `${payload.replace(/-/g, "+").replace(/_/g, "/")}x.${mac}`,
      `${payload}.${mac}.x`,
      `x.${payload}.${mac}`,
      ` ${token}`,
      `${token}\n`,
      "",
      ".",
      "a.b",
      "x".repeat(10_000),
    ]) {
      expect(t.verify(bad, CLAIMS.plugin), bad.slice(0, 40)).toBeNull();
    }
    for (const bad of [null, undefined, 42, {}, ["a"]]) {
      expect(t.verify(bad as unknown as string, CLAIMS.plugin)).toBeNull();
    }
    // 用同一把派生密钥正确签名、但内容不合规的声明：仍然拒绝（声明逐字段核对）
    const signWithSameKey = (claims: unknown): string => {
      const p = b64(typeof claims === "string" ? claims : JSON.stringify(claims));
      // 与实现同一派生规则（HKDF info capybara:capybara-embed/1）
      const key = createKeyring(K1, []).deriveKey("capybara-embed/1").current;
      return `${p}.${b64(createHmac("sha256", key).update(`capybara-embed/1.${p}`).digest())}`;
    };
    const exp = T0 / 1000 + 60;
    expect(t.verify(signWithSameKey({ ...CLAIMS, exp }), CLAIMS.plugin)).not.toBeNull();
    expect(t.verify(signWithSameKey("not json"), CLAIMS.plugin)).toBeNull();
    expect(t.verify(signWithSameKey([CLAIMS]), CLAIMS.plugin)).toBeNull();
    expect(t.verify(signWithSameKey({ ...CLAIMS }), CLAIMS.plugin)).toBeNull();
    expect(t.verify(signWithSameKey({ ...CLAIMS, exp: String(exp) }), CLAIMS.plugin)).toBeNull();
    expect(t.verify(signWithSameKey({ ...CLAIMS, exp: exp + 0.5 }), CLAIMS.plugin)).toBeNull();
    expect(t.verify(signWithSameKey({ ...CLAIMS, exp, admin: true }), CLAIMS.plugin)).toBeNull();
    expect(t.verify(signWithSameKey({ ...CLAIMS, exp, orgId: 1 }), CLAIMS.plugin)).toBeNull();
    // 角色（A38）：必须是四种之一，缺了也拒绝
    const { role: _role, ...noRole } = CLAIMS;
    expect(t.verify(signWithSameKey({ ...noRole, exp }), CLAIMS.plugin)).toBeNull();
    expect(t.verify(signWithSameKey({ ...CLAIMS, exp, role: "root" }), CLAIMS.plugin)).toBeNull();
    for (const role of ["owner", "admin", "member", "guest"]) {
      expect(t.verify(signWithSameKey({ ...CLAIMS, exp, role }), CLAIMS.plugin)).toMatchObject({
        role,
      });
    }
    expect(
      t.verify(signWithSameKey({ ...CLAIMS, exp, conversationId: null }), CLAIMS.plugin),
    ).toBeNull();
    // 声明的过期时间远超签发有效期（不可能由内核签出）
    expect(t.verify(signWithSameKey({ ...CLAIMS, exp: exp + 86_400 }), CLAIMS.plugin)).toBeNull();
    // JWT 形状（alg 头）：三段，直接拒绝
    const jwtish = `${b64('{"alg":"none"}')}.${b64(JSON.stringify({ ...CLAIMS, exp }))}.`;
    expect(t.verify(jwtish, CLAIMS.plugin)).toBeNull();
  });
});
