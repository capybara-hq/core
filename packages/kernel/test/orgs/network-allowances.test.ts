import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import {
  allowanceEntryProblem,
  normalizeAllowanceEntry,
  OrgNetworkAllowances,
} from "../../src/orgs/network-allowances.service.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, handlesFor, orgsFor } from "../helpers/identity.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let allowances: OrgNetworkAllowances;
let actorId: string;
let orgId: string;
let otherOrgId: string;

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected an error");
};

const auditRows = () =>
  db
    .selectFrom("audit_events")
    .select(["action", "org_id", "actor_account_id", "detail"])
    .where("action", "like", "org.network_allowance_%")
    .orderBy("at")
    .execute();

beforeAll(async () => {
  pg = await startTestPostgres();
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pg.url, 5);
  db = kernelDb(raw);
  const h = handlesFor(db);
  allowances = new OrgNetworkAllowances(h.db, h.txHost);
});

afterAll(async () => {
  await raw.destroy();
  await pg.stop();
});

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.memberships, capybara.audit_events, capybara.org_network_allowances",
  );
  const root = await accountsFor(db).createLocal({
    login: "root",
    password: "correct horse battery",
    displayName: "Root",
  });
  actorId = root.id;
  orgId = (await orgsFor(db).create({ name: "Acme" }, root)).id;
  otherOrgId = (await orgsFor(db).create({ name: "Other" }, root)).id;
});

describe("allowanceEntryProblem", () => {
  it.each([
    "mcp.internal",
    "MCP.Internal.",
    "*.corp.example",
    "10.1.2.3",
    "10.0.0.0/8",
    "fd00::/16",
    "fd00::1",
    "[fd00::1]",
    "http://mcp.internal:8080",
    "https://mcp.internal:8443",
    "http://mcp.internal:8080/",
    "https://mcp.internal",
    "http://10.1.2.3:8080",
    "http://[fd00::1]:8080",
  ])("accepts %s", (entry) => {
    expect(allowanceEntryProblem(entry)).toBeNull();
  });

  it.each([
    ["", /empty/],
    ["http://mcp.internal:8080/x", /path/],
    ["http://mcp.internal:8080?a=1", /query/],
    ["http://mcp.internal:8080#f", /fragment/],
    ["http://user:pw@mcp.internal:8080", /credentials/],
    ["ftp://mcp.internal", /http or https/],
    ["http://*.corp.example:8080", /hostname/],
    ["http://169.254.169.254", /link-local/],
    ["169.254.169.254", /link-local/],
    ["169.254.0.0/16", /link-local/],
    ["169.0.0.0/8", /link-local/],
    ["fe80::1", /link-local/],
    ["10.0.0.0/4", /too broad/],
    ["*.10.0.0.1", /wildcard/],
    ["*", /wildcard/],
    ["mcp.internal/x", /hostname/],
    ["mcp.internal:8080", /origin/],
  ])("refuses %s", (entry, reason) => {
    expect(allowanceEntryProblem(entry)).toMatch(reason);
  });

  it("normalizes hosts, wildcards and origins", () => {
    expect(normalizeAllowanceEntry(" MCP.Internal. ")).toBe("mcp.internal");
    expect(normalizeAllowanceEntry("*.Corp.Example")).toBe("*.corp.example");
    expect(normalizeAllowanceEntry("[FD00::1]")).toBe("fd00::1");
    expect(normalizeAllowanceEntry("HTTP://MCP.internal:8080/")).toBe("http://mcp.internal:8080");
    expect(normalizeAllowanceEntry("https://mcp.internal:443")).toBe("https://mcp.internal");
  });
});

describe("OrgNetworkAllowances", () => {
  it("adds, lists and removes entries, auditing each change", async () => {
    const added = await allowances.add(orgId, "MCP.internal", actorId);
    expect(added).toMatchObject({ entry: "mcp.internal", createdBy: actorId });
    expect(added.createdAt).toBeInstanceOf(Date);
    await allowances.add(orgId, "http://mcp.internal:8080", actorId);

    const listed = await allowances.list(orgId);
    expect(listed.map((r) => r.entry)).toEqual(["mcp.internal", "http://mcp.internal:8080"]);
    expect(await allowances.list(otherOrgId)).toEqual([]);

    expect(await allowances.remove(orgId, added.id, actorId)).toBe(true);
    expect((await allowances.list(orgId)).map((r) => r.entry)).toEqual([
      "http://mcp.internal:8080",
    ]);

    expect(await auditRows()).toEqual([
      {
        action: "org.network_allowance_added",
        org_id: orgId,
        actor_account_id: actorId,
        detail: { entry: "mcp.internal" },
      },
      {
        action: "org.network_allowance_added",
        org_id: orgId,
        actor_account_id: actorId,
        detail: { entry: "http://mcp.internal:8080" },
      },
      {
        action: "org.network_allowance_removed",
        org_id: orgId,
        actor_account_id: actorId,
        detail: { entry: "mcp.internal" },
      },
    ]);
  });

  it("is idempotent on a duplicate entry (no second row, no second audit)", async () => {
    const first = await allowances.add(orgId, "mcp.internal", actorId);
    const again = await allowances.add(orgId, "MCP.INTERNAL", actorId);
    expect(again).toEqual(first);
    expect(await allowances.list(orgId)).toHaveLength(1);
    expect(await auditRows()).toHaveLength(1);
  });

  it("refuses an invalid entry with the reason, writing nothing", async () => {
    const err = await errorOf(allowances.add(orgId, "169.254.169.254", actorId));
    expect(err.code).toBe("org.network_allowance_invalid");
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/link-local/);
    expect(await allowances.list(orgId)).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("refuses an unknown or deleted org", async () => {
    expect((await errorOf(allowances.add("nope", "mcp.internal", actorId))).code).toBe(
      "org.not_found",
    );
    await db.updateTable("orgs").set({ deleted_at: new Date() }).where("id", "=", orgId).execute();
    expect((await errorOf(allowances.add(orgId, "mcp.internal", actorId))).code).toBe(
      "org.not_found",
    );
  });

  it("removes only the org's own entry; an unknown id is a no-op", async () => {
    const other = await allowances.add(otherOrgId, "mcp.internal", actorId);
    expect(await allowances.remove(orgId, other.id, actorId)).toBe(false);
    expect(await allowances.remove(orgId, "not-a-uuid", actorId)).toBe(false);
    expect(await allowances.list(otherOrgId)).toHaveLength(1);
    expect((await auditRows()).map((r) => r.action)).toEqual(["org.network_allowance_added"]);
  });

  it("splits entries into private hosts and trusted origins, per org", async () => {
    for (const entry of [
      "mcp.internal",
      "*.corp.example",
      "10.1.0.0/16",
      "fd00::1",
      "http://mcp.internal:8080",
    ]) {
      await allowances.add(orgId, entry, actorId);
    }
    await allowances.add(otherOrgId, "other.internal", actorId);
    const policy = await allowances.policyFor(orgId);
    expect(policy.allowPrivateHosts.sort()).toEqual(
      ["*.corp.example", "10.1.0.0/16", "fd00::1", "mcp.internal"].sort(),
    );
    expect(policy.trustedOrigins).toEqual(["http://mcp.internal:8080"]);
    expect(await allowances.policyFor(otherOrgId)).toEqual({
      allowPrivateHosts: ["other.internal"],
      trustedOrigins: [],
    });
  });

  it("a deleted org's list allows nothing", async () => {
    await allowances.add(orgId, "mcp.internal", actorId);
    await db.updateTable("orgs").set({ deleted_at: new Date() }).where("id", "=", orgId).execute();
    expect(await allowances.policyFor(orgId)).toEqual({
      allowPrivateHosts: [],
      trustedOrigins: [],
    });
  });

  it("drops the org's entries when the org row goes", async () => {
    await allowances.add(orgId, "mcp.internal", actorId);
    await allowances.add(otherOrgId, "mcp.internal", actorId);
    await sql`delete from capybara.orgs where id = ${orgId}`.execute(raw);
    const rows = await db.selectFrom("org_network_allowances").select("org_id").execute();
    expect(rows).toEqual([{ org_id: otherOrgId }]);
  });
});
