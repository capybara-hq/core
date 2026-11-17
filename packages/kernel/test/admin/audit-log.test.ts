import { fileURLToPath } from "node:url";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditLogService } from "../../src/admin/audit-log.service.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { audit } from "../../src/identity/audit.js";
import { truncateTables } from "../helpers/db.js";
import { handlesFor } from "../helpers/identity.js";

/**
 * The audit log reader (admin overview spec §4.4, §5.2, §9): the platform scope reads `org_id IS
 * NULL` rows only, an org scope that org's only; newest id first, keyset paging, an action prefix,
 * never `detail` (only `detail.via === "agent"` as `viaAgent`).
 */

let pgc: TestContainer;
let raw: ReturnType<typeof createDb>;
let service: AuditLogService;

beforeAll(async () => {
  pgc = await startTestPostgres();
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 3);
  service = new AuditLogService(handlesFor(raw).db);
});

afterAll(async () => {
  await raw?.destroy();
  await pgc?.stop();
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.audit_events");
});

const db = () => kernelDb(raw);

async function seed(): Promise<void> {
  await db()
    .insertInto("accounts")
    .values({ id: "acc-root", display_name: "Root", email: "root@example.com" })
    .execute();
  // 1: a platform row by the root account through a personal token
  await audit(db(), {
    actorAccountId: "acc-root",
    actorTokenId: "tok-1",
    action: "deployment.settings.updated",
    target: "settings",
    detail: { fields: ["priceCurrency"] },
  });
  // 2: an org row (never listed)
  await audit(db(), {
    actorAccountId: "acc-root",
    orgId: "org-1",
    action: "org.member.added",
    target: "acc-x",
  });
  // 3: a platform row whose actor account no longer exists
  await audit(db(), { actorAccountId: "acc-gone", action: "marketplace.added", target: "m-1" });
  // 4: a platform row written through the Platform tool (detail.via === "agent")
  await audit(db(), {
    actorAccountId: "acc-root",
    action: "account.created",
    target: "acc-new",
    detail: { via: "agent", operation: "accounts.create", agentId: "a-1" },
  });
  // 5: a connector action by the kernel itself
  await audit(db(), { action: "connector.created", target: "conn-1" });
}

/** Org rows: org-1 has four (one whose name a LIKE wildcard would match), org-2 one. */
async function seedOrgs(): Promise<void> {
  await db()
    .insertInto("accounts")
    .values({ id: "acc-admin", display_name: "Ada", email: "ada@example.com" })
    .execute();
  await audit(db(), {
    actorAccountId: "acc-admin",
    orgId: "org-1",
    action: "org.member.added",
    target: "acc-x",
    detail: { role: "member", secretish: "s3cr3t" },
  });
  await audit(db(), { orgId: "org-2", action: "org.member.added", target: "acc-y" });
  await audit(db(), { actorAccountId: "acc-admin", orgId: "org-1", action: "connector.updated" });
  await audit(db(), {
    actorAccountId: "acc-admin",
    orgId: "org-1",
    action: "org.settings_updated",
    target: "org-1",
  });
  await audit(db(), { actorAccountId: "acc-admin", orgId: "org-1", action: "orgxsettings" });
  // a platform row (never in an org's log)
  await audit(db(), { actorAccountId: "acc-admin", action: "account.created", target: "acc-new" });
}

const PLATFORM = { platform: true } as const;

describe("AuditLogService.list (platform scope)", () => {
  it("lists only platform rows, newest first, with keyset paging", async () => {
    await seed();
    const first = await service.list(PLATFORM, { limit: 3 });
    expect(first.events.map((e) => e.action)).toEqual([
      "connector.created",
      "account.created",
      "marketplace.added",
    ]);
    expect(first.next).toBe(first.events[2]?.id);
    const second = await service.list(PLATFORM, {
      limit: 3,
      ...(first.next && { after: first.next }),
    });
    expect(second.events.map((e) => e.action)).toEqual(["deployment.settings.updated"]);
    expect(second.next).toBeNull();
    // ids are strings, decreasing
    const ids = [...first.events, ...second.events].map((e) => BigInt(e.id));
    expect([...ids].sort((a, b) => (a > b ? -1 : 1))).toEqual(ids);
  });

  it("carries the actor, the token and agent flags, and never the detail", async () => {
    await seed();
    const { events } = await service.list(PLATFORM, { limit: 20 });
    const by = (action: string) => events.find((e) => e.action === action);
    expect(by("deployment.settings.updated")).toEqual({
      id: expect.any(String),
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      actor: { id: "acc-root", name: "Root", email: "root@example.com" },
      viaToken: true,
      viaAgent: false,
      action: "deployment.settings.updated",
      target: "settings",
    });
    expect(by("marketplace.added")?.actor).toEqual({ id: "acc-gone", name: null, email: null });
    expect(by("account.created")).toMatchObject({ viaAgent: true, viaToken: false });
    expect(by("connector.created")).toMatchObject({ actor: null, target: "conn-1" });
    for (const e of events) expect(Object.keys(e)).not.toContain("detail");
    expect(JSON.stringify(events)).not.toMatch(/priceCurrency|accounts\.create|"a-1"/);
  });

  it("an empty log is an empty page", async () => {
    expect(await service.list(PLATFORM, { limit: 20 })).toEqual({ events: [], next: null });
  });

  it("reads through the partial index audit_events_platform_idx", async () => {
    await seed();
    // the planner prefers a sequential scan on a tiny table: turned off for this one plan
    const plan = await raw.transaction().execute(async (trx) => {
      await sql`SET LOCAL enable_seqscan = off`.execute(trx);
      const r = await sql<{ "QUERY PLAN": string }>`EXPLAIN
        SELECT id FROM capybara.audit_events
        WHERE org_id IS NULL AND id < ${"100"} ORDER BY id DESC LIMIT 21`.execute(trx);
      return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("audit_events_platform_idx");
  });
});

describe("AuditLogService.list (org scope)", () => {
  it("lists only the org's rows, newest first, with keyset paging", async () => {
    await seedOrgs();
    const org = { orgId: "org-1" };
    const first = await service.list(org, { limit: 2 });
    expect(first.events.map((e) => e.action)).toEqual(["orgxsettings", "org.settings_updated"]);
    const second = await service.list(org, { limit: 2, ...(first.next && { after: first.next }) });
    expect(second.events.map((e) => e.action)).toEqual(["connector.updated", "org.member.added"]);
    expect(second.next).toBeNull();
    expect((await service.list({ orgId: "org-2" }, { limit: 20 })).events).toEqual([
      expect.objectContaining({ action: "org.member.added", target: "acc-y", actor: null }),
    ]);
    expect(await service.list({ orgId: "org-none" }, { limit: 20 })).toEqual({
      events: [],
      next: null,
    });
    // the platform log has none of them
    expect((await service.list(PLATFORM, { limit: 20 })).events.map((e) => e.action)).toEqual([
      "account.created",
    ]);
  });

  it("carries the actor and never the detail", async () => {
    await seedOrgs();
    const { events } = await service.list({ orgId: "org-1" }, { limit: 20 });
    expect(events.find((e) => e.action === "org.member.added")).toEqual({
      id: expect.any(String),
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      actor: { id: "acc-admin", name: "Ada", email: "ada@example.com" },
      viaToken: false,
      viaAgent: false,
      action: "org.member.added",
      target: "acc-x",
    });
    expect(JSON.stringify(events)).not.toMatch(/s3cr3t|secretish|"role"/);
  });

  it("filters by an action prefix of literal characters", async () => {
    await seedOrgs();
    const actions = async (action: string) =>
      (await service.list({ orgId: "org-1" }, { limit: 20, action })).events.map((e) => e.action);
    expect(await actions("org.")).toEqual(["org.settings_updated", "org.member.added"]);
    expect(await actions("org.settings_")).toEqual(["org.settings_updated"]);
    // "_" is no wildcard: it matches neither org.… nor orgxsettings
    expect(await actions("org_")).toEqual([]);
    expect(await actions("connector.")).toEqual(["connector.updated"]);
    expect(await actions("org.member.added")).toEqual(["org.member.added"]);
  });

  it("reads through the partial index audit_events_org_id_idx", async () => {
    await seedOrgs();
    const plan = await raw.transaction().execute(async (trx) => {
      await sql`SET LOCAL enable_seqscan = off`.execute(trx);
      const r = await sql<{ "QUERY PLAN": string }>`EXPLAIN
        SELECT id FROM capybara.audit_events
        WHERE org_id = ${"org-1"} AND id < ${"100"} ORDER BY id DESC LIMIT 21`.execute(trx);
      return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("audit_events_org_id_idx");
  });
});
