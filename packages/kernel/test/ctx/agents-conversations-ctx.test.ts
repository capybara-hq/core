import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CtxReadError,
  defineExtension,
  type ExtensionManifest,
  ExtensionPermissionError,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentLookup } from "../../src/agents/agent-lookup.js";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import { createExtensionContext, type KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { KernelDb } from "../../src/infra/database/kernel-db.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { PluginReadsService } from "../../src/plugin-reads/plugin-reads.service.js";
import { EmbedTokens } from "../../src/ui/embed-token.js";

/**
 * ctx.agents / ctx.conversations / ctx.people (collaboration spec; plugin full pages spec §8):
 * the real service on a real database, reached through the ctx like an extension does.
 */

const PLUGIN = "reads-test";
let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const quiet = { info() {}, warn() {}, error() {} };

const manifest = (over: Partial<ExtensionManifest> = {}) =>
  defineExtension({
    name: PLUGIN,
    version: "0.1.0",
    sdk: "^0.1.0-rc.0",
    provides: [],
    setup() {},
    permissions: {
      agents: { read: true },
      conversations: { subjects: true },
      people: { read: true },
    },
    ...over,
  });

let orgId: string;
let otherOrgId: string;
const ids = {} as Record<"alice" | "bob" | "carol" | "dave" | "eve", string>;
let orgAgent: string;
let alicePrivate: string;
let bobPrivate: string;

async function account(name: string, status: "active" | "disabled" = "active", email?: string) {
  const id = randomUUID();
  await db
    .insertInto("accounts")
    .values({ id, display_name: name, email: email ?? null, status })
    .execute();
  return id;
}

async function agent(owner: string, visibility: "private" | "org", name: string) {
  const id = randomUUID();
  await db
    .insertInto("agents")
    .values({
      id,
      org_id: orgId,
      owner_account_id: owner,
      visibility,
      current_version: 1,
    })
    .execute();
  await db
    .insertInto("agent_versions")
    .values({
      agent_id: id,
      version: 1,
      definition: JSON.stringify({ name, instructions: "x" }) as never,
      created_by: owner,
    })
    .execute();
  return id;
}

async function conversation(
  owner: string,
  agentId: string,
  subject: { source: string; kind: string; id: string; title: string } | null,
  deleted = false,
) {
  const id = randomUUID();
  await db
    .insertInto("conversations")
    .values({
      id,
      org_id: orgId,
      account_id: owner,
      agent_id: agentId,
      title: "secret title",
      source: "web",
      subject: subject === null ? null : (JSON.stringify(subject) as never),
      deleted_at: deleted ? new Date() : null,
    })
    .execute();
  return id;
}

async function run(
  conversationId: string,
  accountId: string,
  status: "queued" | "running" | "waiting" | "completed",
  waiting = false,
) {
  await db
    .insertInto("runs")
    .values({
      id: randomUUID(),
      conversation_id: conversationId,
      trigger_account_id: accountId,
      status,
      agent_version: 1,
      trigger_seq: 0,
      waiting_since: waiting ? new Date() : null,
    })
    .execute();
}

beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pg.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  // the service reads through `KernelDb`; a stub over the pool stands in for it here
  const kdb = new Proxy({} as KernelDb, {
    get: (_t, p) => {
      if (p === "db") return db;
      const v = (db as never)[p as never] as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(db) : v;
    },
  });
  const service = new PluginReadsService(kdb, new AgentLookup(kdb));
  deps = {
    db: raw,
    dbUrl: pg.url,
    redis,
    locks: new LockService(redis, createLogger("error")),
    busSubscriber: sub,
    redisUrl: rd.url,
    keyring: createKeyring(Buffer.alloc(32, 1), []),
    embedTokens: new EmbedTokens(createKeyring(Buffer.alloc(32, 1), [])),
    hooks: undefined,
    shares: undefined,
    runWorkers: false,
    log: quiet,
    pluginReads: () => service,
  };

  ids.alice = await account("Alice Lee", "active", "alice@example.com");
  ids.bob = await account("Bob Stone", "active", "bob@example.com");
  ids.carol = await account("carol 100%_x", "active", "carol@example.com");
  ids.dave = await account("Dave Disabled", "disabled", "dave@example.com");
  ids.eve = await account("Eve Outsider", "active", "eve@example.com");
  orgId = randomUUID();
  otherOrgId = randomUUID();
  for (const [id, owner] of [
    [orgId, ids.alice],
    [otherOrgId, ids.eve],
  ] as const) {
    await db.insertInto("orgs").values({ id, slug: id, name: id, created_by: owner }).execute();
  }
  for (const a of [ids.alice, ids.bob, ids.carol, ids.dave])
    await db
      .insertInto("memberships")
      .values({ org_id: orgId, account_id: a, role: "member" })
      .execute();
  await db
    .insertInto("memberships")
    .values({ org_id: otherOrgId, account_id: ids.eve, role: "owner" })
    .execute();
  await db
    .insertInto("extension_org_configs")
    .values({ plugin: PLUGIN, org_id: orgId, enabled: true })
    .execute();
  orgAgent = await agent(ids.alice, "org", "Shared helper");
  alicePrivate = await agent(ids.alice, "private", "Alice private");
  bobPrivate = await agent(ids.bob, "private", "Bob private");
});

afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pg?.stop(), rd?.stop()]);
});

const ctxFor = (m = manifest()) => createExtensionContext(deps, m, {});

describe("ctx.agents.usableBy", () => {
  it("lists the account's own and the org's agents, never another member's private one", async () => {
    const ctx = ctxFor();
    const aliceSees = await ctx.agents.usableBy({ orgId, accountId: ids.alice });
    expect(aliceSees.map((a) => a.id).sort()).toEqual([orgAgent, alicePrivate].sort());
    expect(aliceSees.find((a) => a.id === orgAgent)).toMatchObject({ name: "Shared helper" });
    const bobSees = await ctx.agents.usableBy({ orgId, accountId: ids.bob });
    expect(bobSees.map((a) => a.id).sort()).toEqual([orgAgent, bobPrivate].sort());
    expect(bobSees.map((a) => a.id)).not.toContain(alicePrivate);
    await ctx.close();
  });

  it("returns [] for an account that is not an active member", async () => {
    const ctx = ctxFor();
    expect(await ctx.agents.usableBy({ orgId, accountId: ids.eve })).toEqual([]);
    expect(await ctx.agents.usableBy({ orgId, accountId: ids.dave })).toEqual([]);
    await ctx.close();
  });
});

describe("ctx.conversations.bySubject", () => {
  const subject = (source = PLUGIN, id = "CAP-1") => ({
    source,
    kind: "item",
    id,
    title: "Secret subject title",
  });

  it("returns metadata of this plugin's subject conversations only, never content", async () => {
    const mine = await conversation(ids.alice, orgAgent, subject(PLUGIN, "CAP-1"));
    await run(mine, ids.alice, "completed");
    const other = await conversation(ids.alice, orgAgent, subject("other-plugin", "CAP-1"));
    const otherItem = await conversation(ids.alice, orgAgent, subject(PLUGIN, "CAP-2"));
    const gone = await conversation(ids.alice, orgAgent, subject(PLUGIN, "CAP-1"), true);
    const ctx = ctxFor();
    const rows = await ctx.conversations.bySubject({
      orgId,
      subject: { kind: "item", id: "CAP-1" },
    });
    expect(rows.map((r) => r.id)).toEqual([mine]);
    expect(rows.map((r) => r.id)).not.toContain(other);
    expect(rows.map((r) => r.id)).not.toContain(otherItem);
    expect(rows.map((r) => r.id)).not.toContain(gone);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "agentId",
      "id",
      "lastActivityAt",
      "ownerAccountId",
      "state",
    ]);
    expect(JSON.stringify(rows)).not.toContain("secret");
    expect(rows[0]).toMatchObject({ ownerAccountId: ids.alice, agentId: orgAgent, state: "idle" });
    await ctx.close();
  });

  it("derives the state from the latest run", async () => {
    const ctx = ctxFor();
    const states = async (id: string) =>
      (await ctx.conversations.bySubject({ orgId, subject: { kind: "item", id } })).map(
        (r) => r.state,
      );
    const running = await conversation(ids.bob, orgAgent, subject(PLUGIN, "S-RUN"));
    await run(running, ids.bob, "completed");
    await run(running, ids.bob, "running");
    expect(await states("S-RUN")).toEqual(["running"]);
    const queued = await conversation(ids.bob, orgAgent, subject(PLUGIN, "S-Q"));
    await run(queued, ids.bob, "queued");
    expect(await states("S-Q")).toEqual(["running"]);
    const waiting = await conversation(ids.bob, orgAgent, subject(PLUGIN, "S-W"));
    await run(waiting, ids.bob, "waiting", true);
    expect(await states("S-W")).toEqual(["waiting"]);
    const none = await conversation(ids.bob, orgAgent, subject(PLUGIN, "S-N"));
    expect(none).toBeTruthy();
    expect(await states("S-N")).toEqual(["idle"]);
    await ctx.close();
  });

  it("another org sees nothing", async () => {
    const ctx = ctxFor();
    await expect(
      ctx.conversations.bySubject({ orgId: otherOrgId, subject: { kind: "item", id: "CAP-1" } }),
    ).rejects.toMatchObject({ code: "org_disabled" });
    await ctx.close();
  });
});

describe("ctx.people", () => {
  it("get drops accounts outside the org and returns no email", async () => {
    const ctx = ctxFor();
    const rows = await ctx.people.get({
      orgId,
      accountIds: [ids.alice, ids.dave, ids.eve, randomUUID()],
    });
    expect(rows.map((r) => r.id).sort()).toEqual([ids.alice, ids.dave].sort());
    expect(rows.find((r) => r.id === ids.dave)).toMatchObject({
      name: "Dave Disabled",
      active: false,
    });
    expect(rows.find((r) => r.id === ids.alice)).toMatchObject({ name: "Alice Lee", active: true });
    expect(JSON.stringify(rows)).not.toContain("example.com");
    expect(JSON.stringify(rows)).not.toContain("email");
    await ctx.close();
  });

  it("get takes at most 200 ids", async () => {
    const ctx = ctxFor();
    await expect(
      ctx.people.get({ orgId, accountIds: Array.from({ length: 201 }, () => randomUUID()) }),
    ).rejects.toBeInstanceOf(CtxReadError);
    expect(
      await ctx.people.get({ orgId, accountIds: Array.from({ length: 200 }, () => randomUUID()) }),
    ).toEqual([]);
    await ctx.close();
  });

  it("search matches display names case-insensitively among active members", async () => {
    const ctx = ctxFor();
    expect((await ctx.people.search({ orgId, query: "aLiCe" })).map((r) => r.id)).toEqual([
      ids.alice,
    ]);
    expect(await ctx.people.search({ orgId, query: "dave" })).toEqual([]);
    expect(await ctx.people.search({ orgId, query: "eve" })).toEqual([]);
    // wildcards match literally
    expect((await ctx.people.search({ orgId, query: "100%_" })).map((r) => r.id)).toEqual([
      ids.carol,
    ]);
    expect(await ctx.people.search({ orgId, query: "%" })).toHaveLength(1);
    await ctx.close();
  });

  it("search caps the limit at 50", async () => {
    const many = await Promise.all(Array.from({ length: 60 }, (_, i) => account(`Zed ${i}`)));
    for (const id of many)
      await db
        .insertInto("memberships")
        .values({ org_id: orgId, account_id: id, role: "member" })
        .execute();
    const ctx = ctxFor();
    expect(await ctx.people.search({ orgId, query: "Zed", limit: 500 })).toHaveLength(50);
    expect(await ctx.people.search({ orgId, query: "Zed", limit: 3 })).toHaveLength(3);
    expect(await ctx.people.search({ orgId, query: "Zed" })).toHaveLength(20);
    await ctx.close();
  });
});

describe("gating", () => {
  it("a plugin not enabled in the org is refused", async () => {
    const ctx = ctxFor(manifest({ name: "not-enabled" }));
    await expect(ctx.agents.usableBy({ orgId, accountId: ids.alice })).rejects.toMatchObject({
      code: "org_disabled",
    });
    await expect(ctx.people.get({ orgId, accountIds: [ids.alice] })).rejects.toMatchObject({
      code: "org_disabled",
    });
    await ctx.close();
  });

  it("without the permission the member throws ExtensionPermissionError", async () => {
    const ctx = ctxFor(manifest({ permissions: {} }));
    expect(() => ctx.agents).toThrow(ExtensionPermissionError);
    expect(() => ctx.conversations).toThrow(ExtensionPermissionError);
    expect(() => ctx.people).toThrow(ExtensionPermissionError);
    await ctx.close();
  });

  it("each permission enables only its member", async () => {
    const ctx = ctxFor(manifest({ permissions: { people: { read: true } } }));
    expect(() => ctx.agents).toThrow(ExtensionPermissionError);
    expect(ctx.people).toBeDefined();
    await ctx.close();
  });

  it("without a backend the calls reject", async () => {
    const ctx = createExtensionContext({ ...deps, pluginReads: () => undefined }, manifest(), {});
    await expect(ctx.people.get({ orgId, accountIds: [] })).rejects.toThrow("not available");
    await ctx.close();
  });

  it("a call without an org is refused", async () => {
    const ctx = ctxFor();
    await expect(ctx.people.get({ orgId: "", accountIds: [] })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await ctx.close();
  });
});
