import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKeyring } from "../../src/ctx/secrets.js";
import {
  HTML_KEY_INFO,
  HTML_TOKEN_SKEW_SECONDS,
  HTML_TOKEN_TTL_SECONDS,
  HtmlTokens,
} from "../../src/html/html-token.js";
import { EmbedTokens } from "../../src/ui/embed-token.js";

/**
 * The HTML document token (file sharing spec §4): `base64url(JSON claims).base64url(HMAC-SHA256)`
 * with a key derived by HKDF (`capybara-html/1`); anything not issued as it is returns null.
 */

const K1 = Buffer.alloc(32, 1);
const K2 = Buffer.alloc(32, 2);
const T0 = 1_800_000_000_000;

const FILE = {
  kind: "file" as const,
  orgId: "11111111-1111-4111-8111-111111111111",
  conversationId: "33333333-3333-4333-8333-333333333333",
  fileId: "44444444-4444-4444-8444-444444444444",
  accountId: "22222222-2222-4222-8222-222222222222",
};
const SHARE = {
  kind: "share" as const,
  shareId: "55555555-5555-4555-8555-555555555555",
  generation: 2,
};

const tokens = (now: number, ring = createKeyring(K1, [])) => new HtmlTokens(ring, () => now);
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** Signs arbitrary claims with the K1-derived HTML key (a token the kernel could not have issued). */
const signK1 = (claims: unknown): string => {
  const p = b64(JSON.stringify(claims));
  const key = createKeyring(K1, []).deriveKey(HTML_KEY_INFO).current;
  return `${p}.${b64(createHmac("sha256", key).update(`${HTML_KEY_INFO}.${p}`).digest())}`;
};

const exp0 = T0 / 1000 + 300;

describe("HtmlTokens", () => {
  it("constants: HKDF info capybara-html/1, TTL 300 s, skew 30 s", () => {
    expect(HTML_KEY_INFO).toBe("capybara-html/1");
    expect(HTML_TOKEN_TTL_SECONDS).toBe(300);
    expect(HTML_TOKEN_SKEW_SECONDS).toBe(30);
  });

  it("round-trips a file token", () => {
    const t = tokens(T0);
    const issued = t.issue(FILE);
    expect(issued.expiresAt.getTime()).toBe(T0 + 300_000);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(t.verify(issued.token)).toEqual({ ...FILE, exp: exp0 });
  });

  it("round-trips a share token", () => {
    const t = tokens(T0);
    expect(t.verify(t.issue(SHARE).token)).toEqual({ ...SHARE, exp: exp0 });
  });

  it("refuses to issue invalid claims", () => {
    const t = tokens(T0);
    expect(() => t.issue({ ...FILE, orgId: "" })).toThrow();
    expect(() => t.issue({ ...SHARE, generation: 0 })).toThrow();
  });

  it("a tampered signature or payload → null", () => {
    const t = tokens(T0);
    const { token } = t.issue(FILE);
    const [p, s] = token.split(".") as [string, string];
    const flipped = `${s.slice(0, -2)}${s.at(-2) === "A" ? "B" : "A"}${s.at(-1)}`;
    expect(t.verify(`${p}.${flipped}`)).toBeNull();
    const other = b64(JSON.stringify({ ...FILE, accountId: SHARE.shareId, exp: exp0 }));
    expect(t.verify(`${other}.${s}`)).toBeNull();
  });

  it("strict claims: an extra key, an unknown kind, a mixed shape → null", () => {
    const t = tokens(T0);
    expect(t.verify(signK1({ ...FILE, exp: exp0 }))).toEqual({ ...FILE, exp: exp0 });
    expect(t.verify(signK1({ ...FILE, exp: exp0, role: "owner" }))).toBeNull();
    expect(t.verify(signK1({ ...FILE, kind: "other", exp: exp0 }))).toBeNull();
    expect(t.verify(signK1({ ...SHARE, exp: exp0, orgId: FILE.orgId }))).toBeNull();
    expect(t.verify(signK1({ ...SHARE, generation: "2", exp: exp0 }))).toBeNull();
    expect(t.verify(signK1({ ...SHARE, generation: 1.5, exp: exp0 }))).toBeNull();
    expect(t.verify(signK1({ ...FILE, exp: exp0 + 0.5 }))).toBeNull();
    expect(t.verify(signK1([FILE]))).toBeNull();
  });

  it("expired beyond the skew → null; within the skew still valid", () => {
    const { token } = tokens(T0).issue(FILE);
    expect(tokens(T0 + 300_000 + 29_000).verify(token)).not.toBeNull();
    expect(tokens(T0 + 300_000 + 30_000).verify(token)).toBeNull();
  });

  it("exp too far ahead → null", () => {
    const t = tokens(T0);
    const far = T0 / 1000 + HTML_TOKEN_TTL_SECONDS + HTML_TOKEN_SKEW_SECONDS + 1;
    expect(t.verify(signK1({ ...FILE, exp: far }))).toBeNull();
  });

  it("a token signed with the previous master key still verifies after rotation", () => {
    const { token } = tokens(T0, createKeyring(K1, [])).issue(FILE);
    expect(tokens(T0, createKeyring(K2, [K1])).verify(token)).toEqual({ ...FILE, exp: exp0 });
    expect(tokens(T0, createKeyring(K2, [])).verify(token)).toBeNull();
  });

  it("an embed token never verifies as an HTML token (another HKDF info)", () => {
    const embed = new EmbedTokens(createKeyring(K1, []), () => T0).issue({
      plugin: "example-board",
      scope: "org",
      orgId: FILE.orgId,
      accountId: FILE.accountId,
      role: "member",
      conversationId: FILE.conversationId,
      fileId: FILE.fileId,
      contribution: "board",
    });
    expect(tokens(T0).verify(embed.token)).toBeNull();
  });

  it("non-canonical encodings and wrong shapes → null", () => {
    const t = tokens(T0);
    const { token } = t.issue(FILE);
    expect(t.verify(`${token}=`)).toBeNull();
    expect(t.verify(`${token}.x`)).toBeNull();
    expect(t.verify(`${token.split(".")[0]}.${"+".repeat(43)}`)).toBeNull();
    expect(t.verify(42)).toBeNull();
    expect(t.verify("")).toBeNull();
    expect(t.verify("a".repeat(5000))).toBeNull();
  });
});
