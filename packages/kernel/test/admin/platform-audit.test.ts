import { fileURLToPath } from "node:url";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PlatformAuditService } from "../../src/admin/platform-audit.service.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { audit } from "../../src/identity/audit.js";
import { truncateTables } from "../helpers/db.js";
import { handlesFor } from "../helpers/identity.js";

/**
 * The platform-level audit reader (admin overview spec §4.4, §5.2, §9): `org_id IS NULL` rows only,
 * newest id first, keyset paging, never `detail` (only `detail.via === "agent"` as `viaAgent`).
 */

let pgc: TestContainer;
let raw: ReturnType<typeof createDb>;
let service: PlatformAuditService;

beforeAll(async () => {
  pgc = await startTestPostgres();
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 3);
  service = new PlatformAuditService(handlesFor(raw).db);
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
  // 5: a legacy connector action by the kernel itself
  await audit(db(), { action: "app.created", target: "conn-1" });
}

describe("PlatformAuditService.list", () => {
  it("lists only platform rows, newest first, with keyset paging", async () => {
    await seed();
    const first = await service.list({ limit: 3 });
    expect(first.events.map((e) => e.action)).toEqual([
      "connector.created",
      "account.created",
      "marketplace.added",
    ]);
    expect(first.next).toBe(first.events[2]?.id);
    const second = await service.list({ limit: 3, ...(first.next && { after: first.next }) });
    expect(second.events.map((e) => e.action)).toEqual(["deployment.settings.updated"]);
    expect(second.next).toBeNull();
    // ids are strings, decreasing
    const ids = [...first.events, ...second.events].map((e) => BigInt(e.id));
    expect([...ids].sort((a, b) => (a > b ? -1 : 1))).toEqual(ids);
  });

  it("carries the actor, the token and agent flags, and never the detail", async () => {
    await seed();
    const { events } = await service.list({ limit: 20 });
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
    expect(await service.list({ limit: 20 })).toEqual({ events: [], next: null });
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
