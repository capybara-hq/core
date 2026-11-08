import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeOAuthServer, startFakeOAuthServer } from "../src/fake-oauth-server.js";

const REDIRECT = "https://cb.example.com/cb";
const CLIENT = { clientId: "c1", clientSecret: "s1" };
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function start(dialect?: "oauth" | "slack"): Promise<FakeOAuthServer> {
  const as = await startFakeOAuthServer({ clients: [CLIENT], ...(dialect && { dialect }) });
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

async function codeFlow(as: FakeOAuthServer) {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${as.issuer}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
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
