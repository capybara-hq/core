import { createHash, randomBytes } from "node:crypto";
import {
  type FakeOAuthServer,
  type FakeOAuthServerOptions,
  startFakeOAuthServer,
} from "@capybara-hq/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../../../src/log.js";
import {
  type OAuthClientRecord,
  OAuthGrantError,
  type OAuthOwner,
  OAuthReconnectRequired,
  type OAuthStore,
  type OAuthTokenRecord,
  OAuthTokens,
  OAuthUnavailable,
  tokenRequest,
} from "../../../src/tools/oauth/tokens.js";

/**
 * Token endpoints that do not answer like RFC 6749: Slack's `oauth.v2.user.access` returns
 * `token_type: "user"` (G1) and reports every error as HTTP 200 `{ ok: false, error }` (G2).
 */

const HTTP = { allowInsecureLoopback: true, timeoutMs: 5_000 };
const REDIRECT = "https://cb.example.com/cb";
const CLIENT = { clientId: "slack-client", clientSecret: "slack-secret" };
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function server(opts: FakeOAuthServerOptions = {}): Promise<FakeOAuthServer> {
  const as = await startFakeOAuthServer({ clients: [CLIENT], ...opts });
  stops.push(() => as.stop());
  return as;
}

const clientOf = (as: FakeOAuthServer): OAuthClientRecord => ({
  ...CLIENT,
  authMethod: "client_secret_post",
  authorizationEndpoint: `${as.issuer}/authorize`,
  tokenEndpoint: `${as.issuer}/token`,
});

/** Runs the authorize step (auto-approved) and returns the code with its PKCE verifier. */
async function authorize(as: FakeOAuthServer): Promise<{ code: string; verifier: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${as.issuer}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "s",
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  const code = new URL(res.headers.get("location") as string).searchParams.get("code") as string;
  return { code, verifier };
}

async function exchange(as: FakeOAuthServer, opts?: { tokenTypes?: string[] }) {
  const { code, verifier } = await authorize(as);
  return tokenRequest(
    clientOf(as),
    { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier },
    HTTP,
    opts,
  );
}

const rejection = async (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("token_type (G1)", () => {
  it("Slack's `user` token type is accepted and stored as Bearer", async () => {
    const as = await server({ dialect: "slack" });
    const tokens = await exchange(as);
    expect(tokens.token_type).toBe("Bearer");
    expect(as.verify(tokens.access_token)).toBe(true);
    expect(tokens.refresh_token).toMatch(/^rt_/);
  });

  it("accepts `User` and `bearer` in any case", async () => {
    for (const tokenType of ["User", "bearer", "BEARER"]) {
      const as = await server({ tokenType });
      expect((await exchange(as)).token_type).toBe("Bearer");
    }
  });

  it("rejects other token types unless the auth settings allow them", async () => {
    for (const tokenType of ["DPoP", "mac", "N_A"]) {
      const as = await server({ tokenType });
      const e = await rejection(exchange(as));
      expect(e).toBeInstanceOf(OAuthGrantError);
      expect((e as OAuthGrantError).error).toBe("unsupported_token_type");
    }
    const as = await server({ tokenType: "Custom" });
    expect((await exchange(as, { tokenTypes: ["custom"] })).token_type).toBe("Bearer");
  });
});

describe("200 with ok:false (G2)", () => {
  it("an ok:false body is a grant error with Slack's code", async () => {
    const as = await server({ dialect: "slack" });
    const e = await rejection(
      tokenRequest(
        clientOf(as),
        { grant_type: "authorization_code", code: "bogus", redirect_uri: REDIRECT },
        HTTP,
      ),
    );
    expect(e).toBeInstanceOf(OAuthGrantError);
    expect((e as OAuthGrantError).error).toBe("invalid_code");
    expect(as.tokenRequests.at(-1)).toMatchObject({ status: 200, error: "invalid_code" });
  });

  it("a 200 with an RFC 6749 error and no token is a grant error too", async () => {
    const as = await server();
    as.failTokenRequests(1, 200, { error: "invalid_grant" });
    const e = await rejection(
      tokenRequest(clientOf(as), { grant_type: "refresh_token", refresh_token: "x" }, HTTP),
    );
    expect((e as OAuthGrantError).error).toBe("invalid_grant");
  });

  it("a transient or unparsable ok:false code is unavailable, not a refusal", async () => {
    const as = await server();
    for (const body of [
      { ok: false, error: "ratelimited" },
      { ok: false, error: "Something <odd>" },
      { ok: false },
    ]) {
      as.failTokenRequests(1, 200, body);
      const e = await rejection(
        tokenRequest(clientOf(as), { grant_type: "refresh_token", refresh_token: "x" }, HTTP),
      );
      expect(e, JSON.stringify(body)).toBeInstanceOf(OAuthUnavailable);
    }
  });
});

/** In-memory store and lock for one owner (the refresh path without Redis / PG). */
function memoryTokens(client: OAuthClientRecord, rec: OAuthTokenRecord) {
  let tokens: OAuthTokenRecord | null = rec;
  const store: OAuthStore = {
    readClient: async () => client,
    readTokens: async () => tokens,
    writeTokens: async (_o, _c, _w: OAuthOwner, r) => {
      tokens = r;
    },
    deleteTokens: async () => {
      tokens = null;
    },
  };
  const held = new Set<string>();
  const locks = {
    lease: async (key: string) => {
      if (held.has(key)) return false;
      held.add(key);
      return true;
    },
    releaseIf: async (key: string) => held.delete(key),
    renew: async (key: string) => held.has(key),
  };
  const oauth = new OAuthTokens(
    store,
    locks as never,
    { exists: async (key: string) => (held.has(key) ? 1 : 0) } as never,
    () => HTTP,
    createLogger("error", { write: () => {} }),
  );
  return { oauth, current: () => tokens };
}

describe("refresh against a Slack-like token endpoint (G2)", () => {
  const owner: OAuthOwner = { kind: "user", accountId: "acct_1" };
  const auth = { type: "oauth_code" as const };

  async function connected(as: FakeOAuthServer) {
    const tokens = await exchange(as);
    return memoryTokens(clientOf(as), { ...tokens, expires_at: Date.now() - 1 });
  }

  it("rotates the refresh token with token_type user", async () => {
    const as = await server({ dialect: "slack" });
    const { oauth, current } = await connected(as);
    const before = current()?.refresh_token;
    const token = await oauth.accessToken("org", "conn", auth, owner);
    expect(as.verify(token)).toBe(true);
    expect(current()?.refresh_token).not.toBe(before);
  });

  it("invalid_refresh_token on HTTP 200 deletes the credential and asks to reconnect", async () => {
    const as = await server({ dialect: "slack" });
    const { oauth, current } = await connected(as);
    as.revokeRefreshTokens();
    const e = await rejection(oauth.accessToken("org", "conn", auth, owner));
    expect(e).toBeInstanceOf(OAuthReconnectRequired);
    expect(current()).toBeNull();
    expect(as.tokenRequests.at(-1)).toMatchObject({
      status: 200,
      error: "invalid_refresh_token",
    });
  });

  it("token_revoked / token_expired also reconnect; another code keeps the credential", async () => {
    for (const error of ["token_revoked", "token_expired"]) {
      const as = await server({ dialect: "slack" });
      const { oauth, current } = await connected(as);
      as.failTokenRequests(1, 200, { ok: false, error });
      const e = await rejection(oauth.accessToken("org", "conn", auth, owner));
      expect(e, error).toBeInstanceOf(OAuthReconnectRequired);
      expect(current()).toBeNull();
    }
    const as = await server({ dialect: "slack" });
    const { oauth, current } = await connected(as);
    as.failTokenRequests(1, 200, { ok: false, error: "invalid_arguments" });
    const e = await rejection(oauth.accessToken("org", "conn", auth, owner));
    expect(e).toBeInstanceOf(OAuthUnavailable);
    expect((e as Error).message).toContain("invalid_arguments");
    expect(current()).not.toBeNull();
  });
});
