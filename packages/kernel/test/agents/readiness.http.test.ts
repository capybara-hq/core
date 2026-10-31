import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { AccountsService } from "../../src/identity/accounts.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

// `GET /api/v1/orgs/:orgId/readiness` (acceptance round 2, finding 2): whether the org can run,
// from extension state only (never a vendor call), and the agents visible to the caller.

const NEEDS_CONFIG = fileURLToPath(
  new URL("../fixtures/plugins/model-needs-config/index.ts", import.meta.url),
);
const PW = "correct horse battery";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let accounts: AccountsService;
let members: MembersService;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
  members = testMembers(db);
}, 120_000);
afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function boot(extensions: string[], extensionConfig: Record<string, unknown> = {}) {
  await redis.flushdb();
  const k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      extensions,
      extensionPermissions: { autoApprove: true },
      extensionConfig,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  return k;
}

type Req = ReturnType<typeof asUser>;

async function session(k: TestKernel, login: string): Promise<Req> {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

async function ownerOrg(k: TestKernel) {
  const owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  const req = await session(k, "owner");
  const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  expect(res.statusCode).toBe(201);
  return { owner, req, orgId: (res.json() as { org: { id: string } }).org.id };
}

const readiness = async (req: Req, orgId: string) => {
  const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/readiness` });
  expect(res.statusCode).toBe(200);
  return res.json() as { modelProvider: string; agents: number };
};

describe("org readiness", () => {
  it("no provider, or one pending configuration: modelProvider none; unauthenticated is 401", async () => {
    const k = await boot([NEEDS_CONFIG]);
    try {
      const { req, orgId } = await ownerOrg(k);
      expect(await readiness(req, orgId)).toEqual({ modelProvider: "none", agents: 0 });
      const anon = await k.http.inject({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/readiness`,
        headers: { "x-capybara-csrf": "1" },
      });
      expect(anon.statusCode).toBe(401);
    } finally {
      await k.close();
    }
  }, 120_000);

  it("a loaded provider is ready without calling the vendor; agents count what each role sees", async () => {
    // model-needs-config is configured here, so it loads; its listModels throws (vendor down)
    const k = await boot([MODEL_FAKE, NEEDS_CONFIG], {
      "model-fake": { models: [{ id: "fake-1" }] },
      "model-needs-config": { apiKey: "k" },
    });
    try {
      const { owner, req, orgId } = await ownerOrg(k);
      const definition = {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
      };
      for (const visibility of ["org", "private"]) {
        const res = await req({
          method: "POST",
          url: `/api/v1/orgs/${orgId}/agents`,
          payload: { definition, visibility },
        });
        expect(res.statusCode).toBe(201);
      }
      expect(await readiness(req, orgId)).toEqual({ modelProvider: "ready", agents: 2 });
      for (const [login, role] of [
        ["mia", "member"],
        ["gus", "guest"],
      ] as const) {
        const a = await accounts.createLocal({ login, password: PW, displayName: login });
        await members.add(orgId, a.id, role, owner.id);
        const r = await session(k, login);
        const list = await r({ method: "GET", url: `/api/v1/orgs/${orgId}/agents` });
        const visible = (list.json() as { agents: unknown[] }).agents.length;
        expect(await readiness(r, orgId)).toEqual({ modelProvider: "ready", agents: visible });
        expect(visible).toBe(1);
      }
    } finally {
      await k.close();
    }
  }, 120_000);
});
