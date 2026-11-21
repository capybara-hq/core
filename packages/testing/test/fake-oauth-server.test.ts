import {
  createHash,
  createPublicKey,
  type JsonWebKeyInput,
  randomBytes,
  verify,
} from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeOAuthServer,
  type FakeOAuthServerOptions,
  startFakeOAuthServer,
} from "../src/fake-oauth-server.js";

const REDIRECT = "https://cb.example.com/cb";
const CLIENT = { clientId: "c1", clientSecret: "s1" };
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function start(
  dialect?: "oauth" | "slack",
  extra: Partial<FakeOAuthServerOptions> = {},
): Promise<FakeOAuthServer> {
  const as = await startFakeOAuthServer({
    clients: [CLIENT],
    ...(dialect && { dialect }),
    ...extra,
  });
  stops.push(() => as.stop());
  return as;
}

const post = async (as: FakeOAuthServer, form: Record<string, string>) => {
  const res = await fetch(`${as.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...form,
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

async function codeFlow(as: FakeOAuthServer, extraAuthorize: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${as.issuer}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...extraAuthorize,
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  const code = new URL(res.headers.get("location") as string).searchParams.get("code") as string;
  return post(as, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
}

describe("startFakeOAuthServer dialect", () => {
  it("oauth (default): Bearer tokens, errors as 400 { error }", async () => {
    const as = await start();
    const ok = await codeFlow(as);
    expect(ok).toMatchObject({ status: 200, body: { token_type: "Bearer" } });
    expect(ok.body.ok).toBeUndefined();
    const bad = await post(as, { grant_type: "refresh_token", refresh_token: "nope" });
    expect(bad).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  });

  it("slack: ok:true + token_type user; errors as 200 ok:false with Slack's codes", async () => {
    const as = await start("slack");
    const ok = await codeFlow(as);
    expect(ok).toMatchObject({ status: 200, body: { ok: true, token_type: "user" } });
    const refreshed = await post(as, {
      grant_type: "refresh_token",
      refresh_token: ok.body.refresh_token as string,
    });
    expect(refreshed).toMatchObject({ status: 200, body: { ok: true, token_type: "user" } });
    as.revokeRefreshTokens();
    const dead = await post(as, {
      grant_type: "refresh_token",
      refresh_token: refreshed.body.refresh_token as string,
    });
    expect(dead).toEqual({ status: 200, body: { ok: false, error: "invalid_refresh_token" } });
    const badCode = await post(as, {
      grant_type: "authorization_code",
      code: "x",
      redirect_uri: REDIRECT,
    });
    expect(badCode.body).toEqual({ ok: false, error: "invalid_code" });
    expect(as.tokenRequests.map((r) => [r.status, r.error])).toEqual([
      [200, undefined],
      [200, undefined],
      [200, "invalid_refresh_token"],
      [200, "invalid_code"],
    ]);
  });
});

const decode = (jwt: string) => {
  const [h, p, sig] = jwt.split(".") as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>,
    input: `${h}.${p}`,
    sig: Buffer.from(sig, "base64url"),
  };
};

/** Verifies the token's signature against the key in the JWKS with the same `kid`. */
async function verifiesAgainstJwks(as: FakeOAuthServer, jwt: string): Promise<boolean> {
  const { header, input, sig } = decode(jwt);
  const jwks = (await (await fetch(as.jwksUrl)).json()) as {
    keys: (JsonWebKeyInput["key"] & { kid: string })[];
  };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return false;
  const key = createPublicKey({ key: jwk, format: "jwk" });
  return verify("RSA-SHA256", Buffer.from(input), key, sig);
}

describe("startFakeOAuthServer oidc", () => {
  it("issues an RS256 ID token with the authorize nonce and the queued claims", async () => {
    const as = await start("oauth", { oidc: {}, metadata: "openid" });
    as.queueLogin({ sub: "1001", hd: "example.com", email: "a@example.com", email_verified: true });
    const ok = await codeFlow(as, { nonce: "n-1" });
    const idToken = ok.body.id_token as string;
    expect(await verifiesAgainstJwks(as, idToken)).toBe(true);
    const { header, claims } = decode(idToken);
    expect(header).toMatchObject({ alg: "RS256", kid: "fake-oidc-key-1" });
    expect(claims).toMatchObject({
      iss: as.issuer,
      aud: CLIENT.clientId,
      azp: CLIENT.clientId,
      nonce: "n-1",
      sub: "1001",
      hd: "example.com",
      email: "a@example.com",
      email_verified: true,
    });
    expect(as.jwksUrl).toBe(`${as.issuer}/jwks`);
    const doc = (await (
      await fetch(`${as.issuer}/.well-known/openid-configuration`)
    ).json()) as Record<string, unknown>;
    expect(doc).toMatchObject({
      jwks_uri: as.jwksUrl,
      id_token_signing_alg_values_supported: ["RS256"],
    });
    expect(as.issuedSecrets()).toContain(idToken);
    // An empty queue logs in the default subject.
    const next = await codeFlow(as, { nonce: "n-2" });
    expect(decode(next.body.id_token as string).claims).toMatchObject({ sub: "fake-sub-1" });
  });

  it("issNext changes one token's iss", async () => {
    const as = await start("oauth", { oidc: {} });
    as.issNext("accounts.google.com");
    const first = await codeFlow(as, { nonce: "n" });
    const second = await codeFlow(as, { nonce: "n" });
    expect(decode(first.body.id_token as string).claims.iss).toBe("accounts.google.com");
    expect(decode(second.body.id_token as string).claims.iss).toBe(as.issuer);
  });

  it("tamperNextIdToken with foreignKey signs with a key not in the JWKS", async () => {
    const as = await start("oauth", { oidc: {} });
    as.tamperNextIdToken({ aud: "other" }, { foreignKey: true });
    const bad = await codeFlow(as, { nonce: "n" });
    expect(await verifiesAgainstJwks(as, bad.body.id_token as string)).toBe(false);
    expect(decode(bad.body.id_token as string).claims.aud).toBe("other");
    const good = await codeFlow(as, { nonce: "n" });
    expect(await verifiesAgainstJwks(as, good.body.id_token as string)).toBe(true);
  });

  it("tamperNextIdToken with an unknown kid fails JWKS verification once", async () => {
    const as = await start("oauth", { oidc: {} });
    as.tamperNextIdToken({}, { kid: "nope" });
    const bad = await codeFlow(as, { nonce: "n" });
    expect(await verifiesAgainstJwks(as, bad.body.id_token as string)).toBe(false);
    const good = await codeFlow(as, { nonce: "n" });
    expect(await verifiesAgainstJwks(as, good.body.id_token as string)).toBe(true);
  });

  it("refreshTokenOnlyWith issues a refresh token only with access_type=offline", async () => {
    const as = await start("oauth", { refreshTokenOnlyWith: { access_type: "offline" } });
    const without = await codeFlow(as);
    expect(without.body.refresh_token).toBeUndefined();
    const withParam = await codeFlow(as, { access_type: "offline" });
    expect(typeof withParam.body.refresh_token).toBe("string");
  });

  it("without oidc nothing changes", async () => {
    const as = await start("oauth", { metadata: "openid" });
    const doc = (await (
      await fetch(`${as.issuer}/.well-known/openid-configuration`)
    ).json()) as Record<string, unknown>;
    expect(doc.jwks_uri).toBeUndefined();
    const ok = await codeFlow(as, { nonce: "n" });
    expect(ok.body.id_token).toBeUndefined();
    expect(typeof ok.body.refresh_token).toBe("string");
    expect((await fetch(`${as.issuer}/jwks`)).status).toBe(404);
  });
});
