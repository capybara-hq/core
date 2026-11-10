import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminAgents } from "../../src/agents/admin-agents.js";
import { AgentsService } from "../../src/agents/agents.service.js";
import { type AgentDefinition, AgentDefinitionSchema } from "../../src/agents/definition.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import type { OrgsService } from "../../src/orgs/orgs.service.js";
import { anonymousGuestsFor } from "../helpers/channels.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, orgsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let accounts: AccountsService;
let members: MembersService;
let orgs: OrgsService;
let agents: AgentsService;
let admin: AdminAgents;

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
  members = testMembers(db);
  orgs = orgsFor(db);
  agents = k.app.get(AgentsService);
  admin = k.app.get(AdminAgents);
}, 120_000);
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
};

let n = 0;
const account = (): Promise<Account> => {
  n++;
  return accounts.createLocal({
    login: `adm${n}`,
    password: "correct horse battery",
    displayName: `U${n}`,
  });
};

const def = (over: Partial<AgentDefinition> = {}): AgentDefinition =>
  AgentDefinitionSchema.parse({
    name: "Helper",
    model: { provider: "model-fake", model: "fake-1" },
    ...over,
  });

interface Fixture {
  orgA: string;
  orgB: string;
  ownerA: Account;
  memberA: Account;
  ownerB: Account;
  memberB: Account;
  /** a private agent of a member of A, named "Support bot" */
  agentA: string;
  /** a private agent of a member of B */
  agentB: string;
  /** a soft-deleted agent of A */
  deleted: string;
  /** a live agent of a deleted org */
  inDeletedOrg: string;
}

let f: Fixture;

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await redis.flushdb();
  const ownerA = await account();
  const orgA = (await orgs.create({ name: "Org A", slug: `org-a-${n}` }, ownerA)).id;
  const memberA = await account();
  await members.add(orgA, memberA.id, "member", ownerA.id);
  const ownerB = await account();
  const orgB = (await orgs.create({ name: "Org B", slug: `org-b-${n}` }, ownerB)).id;
  const memberB = await account();
  await members.add(orgB, memberB.id, "member", ownerB.id);
  const ownerC = await account();
  const orgC = (await orgs.create({ name: "Org C", slug: `org-c-${n}` }, ownerC)).id;

  const agentA = (
    await agents.create(orgA, memberA.id, {
      definition: def({ name: "Support bot", instructions: "Answer support tickets politely." }),
      visibility: "private",
      profile: {
        description: "Helps customers",
        quickActions: [{ title: "Triage", body: "Triage the latest ticket in full detail" }],
      },
    })
  ).agent.id;
  const agentB = (
    await agents.create(orgB, memberB.id, {
      definition: def({ name: "Sales bot" }),
      visibility: "private",
    })
  ).agent.id;
  const deleted = (
    await agents.create(orgA, memberA.id, {
      definition: def({ name: "Support old" }),
      visibility: "private",
    })
  ).agent.id;
  await agents.softDelete(orgA, deleted, memberA.id);
  const inDeletedOrg = (
    await agents.create(orgC, ownerC.id, { definition: def({ name: "Ghost" }), visibility: "org" })
  ).agent.id;
  await db.updateTable("orgs").set({ deleted_at: sql`now()` }).where("id", "=", orgC).execute();
  f = { orgA, orgB, ownerA, memberA, ownerB, memberB, agentA, agentB, deleted, inDeletedOrg };
});

describe("AdminAgents", () => {
  it("lists live agents of every org, private ones included", async () => {
    const { agents: rows, next } = await admin.list({ limit: 50 });
    expect(rows.map((r) => r.id).sort()).toEqual([f.agentA, f.agentB].sort());
    expect(next).toBeNull();
    const a = rows.find((r) => r.id === f.agentA);
    expect(a).toMatchObject({
      orgId: f.orgA,
      orgName: "Org A",
      name: "Support bot",
      ownerAccountId: f.memberA.id,
      ownerName: f.memberA.displayName,
      needsReassignment: false,
      visibility: "private",
      createdFrom: null,
    });
    expect(a?.updatedAt).toBeInstanceOf(Date);
  });

  it("filters by org and searches the name case-insensitively", async () => {
    const { agents: rows } = await admin.list({ orgId: f.orgA, q: "SUPP", limit: 50 });
    expect(rows.map((r) => r.id)).toEqual([f.agentA]);
    expect((await admin.list({ orgId: f.orgB, q: "SUPP", limit: 50 })).agents).toEqual([]);
    // LIKE wildcards in the search are matched literally
    expect((await admin.list({ q: "%", limit: 50 })).agents).toEqual([]);
    expect((await admin.list({ q: "_", limit: 50 })).agents).toEqual([]);
  });

  it("pages by id with next", async () => {
    const first = await admin.list({ limit: 1 });
    expect(first.agents).toHaveLength(1);
    expect(first.next).toBe(first.agents[0]?.id);
    const second = await admin.list({ limit: 1, after: first.next ?? "" });
    expect(second.agents).toHaveLength(1);
    expect(second.next).toBeNull();
    expect([first.agents[0]?.id, second.agents[0]?.id].sort()).toEqual([f.agentA, f.agentB].sort());
  });

  it("detail has instructions and quick action labels only", async () => {
    const d = await admin.get(f.agentA);
    expect(d.definition.instructions).toBe("Answer support tickets politely.");
    expect(d.profile).toEqual({
      description: "Helps customers",
      quickActions: [{ label: "Triage" }],
    });
    expect(d).toMatchObject({
      id: f.agentA,
      orgId: f.orgA,
      orgName: "Org A",
      name: "Support bot",
      ownerName: f.memberA.displayName,
      memberIds: null,
      versions: 1,
    });
    expect(d.createdAt).toBeInstanceOf(Date);
    expect(JSON.stringify(d)).not.toContain("full detail");
  });

  it("get of a deleted agent is agent.not_found", async () => {
    expect(await codeOf(admin.get(f.deleted))).toBe("agent.not_found");
    expect(await codeOf(admin.get(f.inDeletedOrg))).toBe("agent.not_found");
    expect(await codeOf(admin.get("00000000-0000-0000-0000-000000000000"))).toBe("agent.not_found");
  });
});

describe("AgentsService platform paths", () => {
  it("reassignOwnerAsPlatform works for an account outside the org", async () => {
    const superAdmin = await account();
    await db
      .updateTable("agents")
      .set({ needs_reassignment: true })
      .where("id", "=", f.agentA)
      .execute();
    const view = await agents.reassignOwnerAsPlatform(f.agentA, f.ownerA.id, {
      accountId: superAdmin.id,
    });
    expect(view.ownerAccountId).toBe(f.ownerA.id);
    const row = await db
      .selectFrom("agents")
      .select(["owner_account_id", "needs_reassignment"])
      .where("id", "=", f.agentA)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ owner_account_id: f.ownerA.id, needs_reassignment: false });
    const ev = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "org_id", "detail"])
      .where("action", "=", "agent.owner_changed")
      .where("target", "=", f.agentA)
      .executeTakeFirstOrThrow();
    expect(ev.actor_account_id).toBe(superAdmin.id);
    expect(ev.org_id).toBe(f.orgA);
    expect(ev.detail).toMatchObject({
      from: f.memberA.id,
      to: f.ownerA.id,
      neededReassignment: true,
      via: "platform",
    });
  });

  it("reassignOwnerAsPlatform rejects a member of another org and an anonymous guest", async () => {
    const superAdmin = await account();
    expect(
      await codeOf(
        agents.reassignOwnerAsPlatform(f.agentA, f.memberB.id, { accountId: superAdmin.id }),
      ),
    ).toBe("member.not_found");
    const guest = await anonymousGuestsFor(raw).ensure(f.orgA);
    expect(
      await codeOf(agents.reassignOwnerAsPlatform(f.agentA, guest, { accountId: superAdmin.id })),
    ).toBe("member.anonymous_guest");
    const row = await db
      .selectFrom("agents")
      .select("owner_account_id")
      .where("id", "=", f.agentA)
      .executeTakeFirstOrThrow();
    expect(row.owner_account_id).toBe(f.memberA.id);
    expect(
      await codeOf(
        agents.reassignOwnerAsPlatform(f.deleted, f.ownerA.id, { accountId: superAdmin.id }),
      ),
    ).toBe("agent.not_found");
    expect(
      await codeOf(
        agents.reassignOwnerAsPlatform(f.inDeletedOrg, f.ownerA.id, { accountId: superAdmin.id }),
      ),
    ).toBe("agent.not_found");
  });

  it("softDeleteAsPlatform deletes and audits via platform", async () => {
    const superAdmin = await account();
    await agents.softDeleteAsPlatform(f.agentB, { accountId: superAdmin.id });
    const row = await db
      .selectFrom("agents")
      .select("deleted_at")
      .where("id", "=", f.agentB)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeInstanceOf(Date);
    const ev = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "org_id", "detail"])
      .where("action", "=", "agent.deleted")
      .where("target", "=", f.agentB)
      .executeTakeFirstOrThrow();
    expect(ev.actor_account_id).toBe(superAdmin.id);
    expect(ev.org_id).toBe(f.orgB);
    expect((ev.detail as { via?: string }).via).toBe("platform");
    expect(await codeOf(agents.softDeleteAsPlatform(f.agentB, { accountId: superAdmin.id }))).toBe(
      "agent.not_found",
    );
    expect(
      await codeOf(agents.softDeleteAsPlatform(f.inDeletedOrg, { accountId: superAdmin.id })),
    ).toBe("agent.not_found");
  });
});
