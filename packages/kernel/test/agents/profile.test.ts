import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PRESET_IDS } from "../../src/agents/profile.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let accounts: AccountsService;
let owner: Account;

const PW = "correct horse battery";

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
}, 120_000);
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await redis.flushdb();
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
});

type Req = ReturnType<typeof asUser>;
const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

async function session(login: string): Promise<Req> {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

const definition = {
  name: "Helper",
  instructions: "Be helpful.",
  model: { provider: "model-fake", model: "fake-1" },
};

interface Profile {
  avatar: { kind: string; id?: string; url?: string } | null;
  description: string;
  quickActions: { title: string; body: string }[];
  updatedAt: string;
}
type AgentJson = { id: string; currentVersion: number; profile: Profile };

async function setup(body: Record<string, unknown> = {}) {
  const req = await session("owner");
  const org = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  const orgId = (org.json() as { org: { id: string } }).org.id;
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: { definition, visibility: "org", ...body },
  });
  expect(res.statusCode).toBe(201);
  const agent = (res.json() as { agent: AgentJson }).agent;
  const url = `/api/v1/orgs/${orgId}/agents/${agent.id}`;
  return { req, orgId, agent, url };
}

describe("agent profile", () => {
  it("create without a profile gets a random preset avatar", async () => {
    const { agent } = await setup();
    expect(agent.profile.avatar?.kind).toBe("preset");
    expect(PRESET_IDS).toContain(agent.profile.avatar?.id);
    expect(agent.profile.description).toBe("");
    expect(agent.profile.quickActions).toEqual([]);
  });

  it("create keeps a given profile", async () => {
    const { agent } = await setup({
      profile: {
        avatar: { kind: "preset", id: "owl" },
        description: "hi",
        quickActions: [{ title: "t", body: "b" }],
      },
    });
    expect(agent.profile).toMatchObject({
      avatar: { kind: "preset", id: "owl" },
      description: "hi",
      quickActions: [{ title: "t", body: "b" }],
    });
  });

  it("profile changes create no agent version", async () => {
    const { req, url, agent } = await setup();
    const res = await req({
      method: "PATCH",
      url: `${url}/profile`,
      payload: {
        avatar: { kind: "preset", id: "fox" },
        description: "A fox",
        quickActions: [{ title: "Go", body: "Do it" }],
        expectedUpdatedAt: agent.profile.updatedAt,
      },
    });
    expect(res.statusCode).toBe(200);
    const { profile } = res.json() as { profile: Profile };
    expect(profile).toMatchObject({ avatar: { kind: "preset", id: "fox" }, description: "A fox" });
    expect(profile.updatedAt).not.toBe(agent.profile.updatedAt);
    const after = (await req({ method: "GET", url })).json() as { agent: AgentJson };
    expect(after.agent.currentVersion).toBe(agent.currentVersion);
    expect(after.agent.profile).toEqual(profile);
  });

  it("profile limits", async () => {
    const { req, url, agent } = await setup();
    const bad: Record<string, unknown>[] = [
      { description: "x".repeat(501) },
      { quickActions: Array.from({ length: 10 }, () => ({ title: "t", body: "b" })) },
      { quickActions: [{ title: "x".repeat(41), body: "b" }] },
      { quickActions: [{ title: "t", body: "x".repeat(20_001) }] },
      { avatar: { kind: "preset", id: "dragon" } },
      { avatar: { kind: "external", url: "https://example.com/a.png" } },
    ];
    for (const patch of bad) {
      const res = await req({
        method: "PATCH",
        url: `${url}/profile`,
        payload: { ...patch, expectedUpdatedAt: agent.profile.updatedAt },
      });
      expect(res.statusCode, JSON.stringify(patch).slice(0, 60)).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
    const ok = await req({
      method: "PATCH",
      url: `${url}/profile`,
      payload: {
        description: "x".repeat(500),
        quickActions: Array.from({ length: 9 }, () => ({
          title: "x".repeat(40),
          body: "y".repeat(20_000),
        })),
        expectedUpdatedAt: agent.profile.updatedAt,
      },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("a stale expectedUpdatedAt is 409 agent.profile_conflict", async () => {
    const { req, url, agent } = await setup();
    const first = await req({
      method: "PATCH",
      url: `${url}/profile`,
      payload: { description: "one", expectedUpdatedAt: agent.profile.updatedAt },
    });
    expect(first.statusCode).toBe(200);
    const second = await req({
      method: "PATCH",
      url: `${url}/profile`,
      payload: { description: "two", expectedUpdatedAt: agent.profile.updatedAt },
    });
    expect(second.statusCode).toBe(409);
    expect(errCode(second)).toBe("agent.profile_conflict");
    const now = (await req({ method: "GET", url })).json() as { agent: AgentJson };
    expect(now.agent.profile.description).toBe("one");
  });

  it("a profile change writes agent.profile_updated with the fields", async () => {
    const { req, url, agent, orgId } = await setup();
    await req({
      method: "PATCH",
      url: `${url}/profile`,
      payload: {
        description: "d",
        quickActions: [],
        expectedUpdatedAt: agent.profile.updatedAt,
      },
    });
    const rows = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "org_id", "target", "detail"])
      .where("action", "=", "agent.profile_updated")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_account_id: owner.id,
      org_id: orgId,
      target: agent.id,
      detail: { fields: ["description", "quickActions"], channel: "web" },
    });
  });

  it("an existing definition.avatarUrl migrates once to an external avatar", async () => {
    const { req, url, agent } = await setup();
    const avatarUrl = "https://example.com/old.png";
    await sql`update capybara.agent_versions
      set definition = definition || ${JSON.stringify({ avatarUrl })}::jsonb
      where agent_id = ${agent.id}`.execute(raw);
    await sql`update capybara.agents set profile_avatar = null where id = ${agent.id}`.execute(raw);
    const content = readFileSync(join(KERNEL_MIGRATIONS_DIR, "0066_agent_profiles.sql"), "utf8");
    await raw.transaction().execute(async (t) => {
      await sql`set local search_path to capybara, public`.execute(t);
      await sql.raw(content).execute(t);
    });
    const got = (await req({ method: "GET", url })).json() as { agent: AgentJson };
    expect(got.agent.profile.avatar).toEqual({ kind: "external", url: avatarUrl });
  });

  it("old agents read profile.avatar null, description '' and quickActions []", async () => {
    const { req, url, agent } = await setup();
    await sql`update capybara.agents
      set profile_avatar = null, profile_description = '', profile_quick_actions = '[]'
      where id = ${agent.id}`.execute(raw);
    const got = (await req({ method: "GET", url })).json() as { agent: AgentJson };
    expect(got.agent.profile).toMatchObject({ avatar: null, description: "", quickActions: [] });
  });

  it("an empty or non-string avatarUrl leaves profile_avatar NULL", async () => {
    const { agent } = await setup();
    const content = readFileSync(join(KERNEL_MIGRATIONS_DIR, "0066_agent_profiles.sql"), "utf8");
    for (const v of ["", 5, null]) {
      await sql`update capybara.agent_versions
        set definition = definition || ${JSON.stringify({ avatarUrl: v })}::jsonb
        where agent_id = ${agent.id}`.execute(raw);
      await sql`update capybara.agents set profile_avatar = null where id = ${agent.id}`.execute(
        raw,
      );
      await raw.transaction().execute(async (t) => {
        await sql`set local search_path to capybara, public`.execute(t);
        await sql.raw(content).execute(t);
      });
      const row = await db
        .selectFrom("agents")
        .select(sql<boolean>`profile_avatar is null`.as("isNull"))
        .where("id", "=", agent.id)
        .executeTakeFirstOrThrow();
      expect(row.isNull, JSON.stringify(v)).toBe(true);
    }
  });

  it("avatar: null stores SQL NULL", async () => {
    const { req, url, agent } = await setup();
    const res = await req({
      method: "PATCH",
      url: `${url}/profile`,
      payload: { avatar: null, expectedUpdatedAt: agent.profile.updatedAt },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { profile: Profile }).profile.avatar).toBeNull();
    const row = await db
      .selectFrom("agents")
      .select(sql<boolean>`profile_avatar is null`.as("isNull"))
      .where("id", "=", agent.id)
      .executeTakeFirstOrThrow();
    expect(row.isNull).toBe(true);
  });

  it("a PATCH with no field writes nothing but still checks expectedUpdatedAt", async () => {
    const { req, url, agent } = await setup();
    const res = await req({
      method: "PATCH",
      url: `${url}/profile`,
      payload: { expectedUpdatedAt: agent.profile.updatedAt },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { profile: Profile }).profile).toEqual(agent.profile);
    const n = await db
      .selectFrom("audit_events")
      .select("id")
      .where("action", "=", "agent.profile_updated")
      .execute();
    expect(n).toHaveLength(0);
    const stale = await req({
      method: "PATCH",
      url: `${url}/profile`,
      payload: { expectedUpdatedAt: "2000-01-01T00:00:00.000Z" },
    });
    expect(stale.statusCode).toBe(409);
  });
});
