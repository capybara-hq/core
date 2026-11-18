import { createHmac, timingSafeEqual } from "node:crypto";
import { Inject, Injectable, Module, Optional } from "@nestjs/common";
import type { Keyring } from "../ctx/secrets.js";
import { KEYRING } from "../infra/tokens.js";

/** HKDF purpose of the document key, also the domain prefix of the signed input. */
export const HTML_KEY_INFO = "capybara-html/1";
/** How long a document token loads its document (seconds). */
export const HTML_TOKEN_TTL_SECONDS = 300;
/** Clock skew between replicas tolerated when checking `exp` (seconds). */
export const HTML_TOKEN_SKEW_SECONDS = 30;

/**
 * What a document token names (file sharing spec §4): one version of a conversation file for its
 * owner (the right panel), or one generation of a share (the share page). Re-checked live on use.
 */
export type HtmlClaims =
  | {
      kind: "file";
      orgId: string;
      conversationId: string;
      fileId: string;
      accountId: string;
      exp: number;
    }
  | { kind: "share"; shareId: string; generation: number; exp: number };

/** Claims before issuing (the token's expiry is set by {@link HtmlTokens.issue}). */
export type HtmlClaimsInput =
  | Omit<Extract<HtmlClaims, { kind: "file" }>, "exp">
  | Omit<Extract<HtmlClaims, { kind: "share" }>, "exp">;

const TOKEN_MAX = 2048;
const MAC_LEN = 32;
const B64URL = /^[A-Za-z0-9_-]+$/;
const FILE_KEYS = ["kind", "orgId", "conversationId", "fileId", "accountId", "exp"];
const SHARE_KEYS = ["kind", "shareId", "generation", "exp"];

const isId = (v: unknown): v is string => typeof v === "string" && v !== "" && v.length <= 100;

/** Strict base64url: the alphabet only, no padding, the canonical encoding of its bytes. */
function decodeStrict(s: string): Buffer | null {
  if (!B64URL.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  return buf.toString("base64url") === s ? buf : null;
}

const sameKeys = (c: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(c);
  return own.length === keys.length && own.every((k) => keys.includes(k));
};

/** Exactly the keys of one kind, each of the right type; a new object with those keys only. */
function parseClaims(v: unknown): HtmlClaims | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  if (typeof c.exp !== "number" || !Number.isSafeInteger(c.exp)) return null;
  if (c.kind === "file") {
    if (!sameKeys(c, FILE_KEYS)) return null;
    if (!isId(c.orgId) || !isId(c.conversationId) || !isId(c.fileId) || !isId(c.accountId)) {
      return null;
    }
    return {
      kind: "file",
      orgId: c.orgId,
      conversationId: c.conversationId,
      fileId: c.fileId,
      accountId: c.accountId,
      exp: c.exp,
    };
  }
  if (c.kind === "share") {
    if (!sameKeys(c, SHARE_KEYS) || !isId(c.shareId)) return null;
    if (typeof c.generation !== "number" || !Number.isSafeInteger(c.generation)) return null;
    if (c.generation < 1) return null;
    return { kind: "share", shareId: c.shareId, generation: c.generation, exp: c.exp };
  }
  return null;
}

/** Optional provider: the clock {@link HtmlTokens} issues and checks with (default `Date.now`; tests). */
export const HTML_TOKEN_CLOCK = Symbol("HTML_TOKEN_CLOCK");

/**
 * HTML document tokens: `base64url(JSON claims).base64url(HMAC-SHA256(key, "capybara-html/1." +
 * first part))`, the format and checks of `EmbedTokens` with its own key (HKDF info
 * {@link HTML_KEY_INFO}: an embed token never verifies here, nor the reverse). No header (no alg to
 * confuse); keys from the master keyring, so a token signed before a rotation verifies until it
 * expires. Verifying: strict base64url, constant-time comparison over every candidate key, strict
 * claim keys, `exp` with {@link HTML_TOKEN_SKEW_SECONDS} of skew and never further ahead than the
 * TTL plus the skew; any failure is null, with no reason. Stateless: every replica verifies with
 * the same master key.
 */
@Injectable()
export class HtmlTokens {
  private readonly current: Buffer;
  private readonly keys: Buffer[];

  constructor(
    @Inject(KEYRING) keyring: Keyring,
    @Optional() @Inject(HTML_TOKEN_CLOCK) private readonly now: () => number = Date.now,
  ) {
    const derived = keyring.deriveKey(HTML_KEY_INFO);
    const ids = [derived.currentId, ...keyring.toJSON().previousIds];
    this.current = derived.current;
    this.keys = ids.map((id) => derived.byId(id)).filter((k): k is Buffer => k !== undefined);
  }

  /** Issues a token whose `exp` is now + {@link HTML_TOKEN_TTL_SECONDS}. */
  issue(c: HtmlClaimsInput): { token: string; expiresAt: Date } {
    const exp = Math.floor(this.now() / 1000) + HTML_TOKEN_TTL_SECONDS;
    const claims = parseClaims({ ...c, exp });
    if (claims === null) throw new Error("HTML token claims are invalid");
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const token = `${payload}.${mac(this.current, payload).toString("base64url")}`;
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /** The claims of a valid, unexpired token this kernel issued; null otherwise. */
  verify(token: unknown): HtmlClaims | null {
    if (typeof token !== "string" || token.length > TOKEN_MAX) return null;
    const dot = token.indexOf(".");
    if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
    const payload = token.slice(0, dot);
    const sig = decodeStrict(token.slice(dot + 1));
    const body = decodeStrict(payload);
    if (sig === null || body === null || sig.length !== MAC_LEN) return null;
    // every candidate key, compared in constant time (no early return on the first match)
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
    if (claims === null) return null;
    const nowSec = this.now() / 1000;
    if (claims.exp + HTML_TOKEN_SKEW_SECONDS <= nowSec) return null;
    if (claims.exp > nowSec + HTML_TOKEN_TTL_SECONDS + HTML_TOKEN_SKEW_SECONDS) return null;
    return claims;
  }
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key).update(`${HTML_KEY_INFO}.${payload}`).digest();
}

/** {@link HtmlTokens} on its own: the HTML document routes and the share routes import it. */
@Module({ providers: [HtmlTokens], exports: [HtmlTokens] })
export class HtmlTokensModule {}
