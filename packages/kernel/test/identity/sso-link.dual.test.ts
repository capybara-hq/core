import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type Harness,
  replicaOf,
  seedLoginSources,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { fakeIdpCode } from "../fixtures/plugins/fake-idp/index.js";
import { accountsFor } from "../helpers/identity.js";

// The link page across replicas (spec 2026-11-26-login-extensions, test plan): the sign-in starts
// on one replica, the callback, the link page's view and its POST run on the other. The state, the
// ticket and its attempts live only in Redis.

const FAKE_IDP = fileURLToPath(new URL("../fixtures/plugins/fake-idp/index.ts", import.meta.url));
const PUBLIC = "https://cap.example";
const PW = "correct horse battery";

type Jar = Map<string, string>;

/** Collects the response's Set-Cookie into the jar (an empty value or Max-Age=0 removes). */
function absorb(jar: Jar, res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0] ?? "";
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === "" || /max-age=0/i.test(c)) jar.delete(name);
    else jar.set(name, decodeURIComponent(value));
  }
}

let pgc: TestContainer;
let rdc: TestContainer;
let h: Harness;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  h = await createDualReplicaHarness({
    extensions: [FAKE_IDP],
    pgUrl: pgc.url,
    redisUrl: rdc.url,
    extensionConfig: { "fake-idp": { tenant: "t1", clientSecret: "s3cret" } },
    config: { auth: { cookieSecure: false }, http: { publicUrl: PUBLIC } },
  });
  raw = createDb(h.dbUrl, 3);
  db = kernelDb(raw);
});

afterAll(async () => {
  await raw?.destroy();
  await h?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

describe("link page (dual replica)", () => {
  it("start on one replica, callback and link POST on the other → signed in, one row", async () => {
    await seedLoginSources(db, [{ plugin: "fake-idp" }]);
    const alice = await accountsFor(db).createLocal({
      login: "alice",
      password: PW,
      displayName: "Alice",
    });

    const jar: Jar = new Map();
    const call = async (index: number, method: string, path: string, body?: unknown) => {
      const res = await h.requestTo(index, path, {
        method,
        redirect: "manual",
        headers: {
          "x-capybara-csrf": "1",
          ...(jar.size > 0 && {
            cookie: [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "),
          }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      expect(replicaOf(res)).toBe(index);
      absorb(jar, res);
      const text = await res.text();
      return {
        status: res.status,
        location: res.headers.get("location") ?? "",
        json: (text !== "" && res.headers.get("content-type")?.includes("json") === true
          ? JSON.parse(text)
          : {}) as Record<string, unknown>,
      };
    };

    const start = await call(0, "GET", "/api/v1/auth/sso/fake-idp/start?returnTo=%2Fchat");
    expect(start.status).toBe(302);
    const authorize = new URL(start.location);
    const code = fakeIdpCode({
      sub: "u-dual",
      nonce: authorize.searchParams.get("nonce") ?? "",
      challenge: authorize.searchParams.get("code_challenge") ?? "",
    });
    const state = authorize.searchParams.get("state") ?? "";
    const cb = await call(
      1,
      "GET",
      `/api/v1/auth/sso/fake-idp/callback?${new URLSearchParams({ state, code }).toString()}`,
    );
    expect(cb.status).toBe(302);
    const page = `${PUBLIC}/login/link?ticket=`;
    expect(cb.location.startsWith(page)).toBe(true);
    const ticket = decodeURIComponent(cb.location.slice(page.length));

    const view = await call(0, "GET", `/api/v1/auth/sso/link?ticket=${encodeURIComponent(ticket)}`);
    expect(view.status).toBe(200);
    expect(view.json).toEqual(expect.objectContaining({ plugin: "fake-idp", tenantId: "t1" }));
    // a wrong password on one replica, the right one on the other: the attempt is shared
    const wrong = await call(0, "POST", "/api/v1/auth/sso/link", {
      ticket,
      login: "alice",
      password: "wrong password!!",
    });
    expect(wrong.status).toBe(401);
    const ok = await call(1, "POST", "/api/v1/auth/sso/link", {
      ticket,
      login: "alice",
      password: PW,
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual(
      expect.objectContaining({
        account: expect.objectContaining({ id: alice.id }),
        returnTo: "/chat",
      }),
    );
    const me = await call(0, "GET", "/api/v1/me");
    expect(me.status).toBe(200);
    expect((me.json.account as { id: string }).id).toBe(alice.id);
    const rows = await db
      .selectFrom("identities")
      .select(["account_id", "linked_via"])
      .where("source", "=", "fake-idp:t1")
      .where("external_id", "=", "u-dual")
      .execute();
    expect(rows).toEqual([{ account_id: alice.id, linked_via: "sso" }]);
    // used: the other replica refuses it too
    const again = await call(0, "POST", "/api/v1/auth/sso/link", {
      ticket,
      login: "alice",
      password: PW,
    });
    expect(again.status).toBe(410);
  });
});
