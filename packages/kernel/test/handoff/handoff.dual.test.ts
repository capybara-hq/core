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
import { accountsFor } from "../helpers/identity.js";

// A browser handoff across replicas (shell external authorization spec, test plan): the start
// runs on one replica, the redeem on the other. The ticket lives only in Redis and is taken with
// GETDEL, so a second redeem on either replica finds nothing.

const FAKE_IDP = fileURLToPath(new URL("../fixtures/plugins/fake-idp/index.ts", import.meta.url));
const PUBLIC = "https://cap.example";
const PW = "correct horse battery";
const HANDOFF_URL_RE = /^https:\/\/cap\.example\/handoff\/(cap_ho_[A-Za-z0-9_-]{43})$/;

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
    config: {
      auth: { cookieSecure: false, appRedirectUris: ["capybara://auth/callback"] },
      http: { publicUrl: PUBLIC },
    },
  });
  raw = createDb(h.dbUrl, 3);
  db = kernelDb(raw);
});

afterAll(async () => {
  await raw?.destroy();
  await h?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

describe("browser handoff (dual replica)", () => {
  it("start on one replica, redeem on the other; a second redeem is refused on both", async () => {
    await seedLoginSources(db, [{ plugin: "fake-idp" }]);
    await accountsFor(db).createLocal({ login: "alice", password: PW, displayName: "Alice" });

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
        headers: res.headers,
        json: (text !== "" && res.headers.get("content-type")?.includes("json") === true
          ? JSON.parse(text)
          : {}) as Record<string, unknown>,
      };
    };

    const login = await call(0, "POST", "/api/v1/auth/login", { login: "alice", password: PW });
    expect(login.status).toBe(200);
    const start = await call(0, "POST", "/api/v1/auth/sso/fake-idp/start", {
      intent: "link",
      returnTo: "/account/identities",
      handoff: { returnScheme: "capybara" },
    });
    expect(start.status).toBe(200);
    const m = HANDOFF_URL_RE.exec(String(start.json.handoffUrl));
    expect(m).not.toBeNull();
    const ticket = (m as RegExpExecArray)[1] as string;

    const redeemed = await call(1, "POST", "/api/v1/auth/handoffs/redeem", { ticket });
    expect(redeemed.status).toBe(200);
    expect(String(redeemed.json.location).startsWith("https://idp.example/authorize?")).toBe(true);
    expect(jar.has("cap_sso")).toBe(true);

    for (const index of [0, 1]) {
      const again = await call(index, "POST", "/api/v1/auth/handoffs/redeem", { ticket });
      expect(again.status).toBe(410);
      expect((again.json.error as { code: string }).code).toBe("handoff.invalid");
    }
  });
});
