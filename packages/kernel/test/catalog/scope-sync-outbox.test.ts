import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CatalogScopeService } from "../../src/catalog/catalog-scope.service.js";
import {
  PLUGIN_SCOPE_QUEUE,
  SCOPE_ITEM_JOB,
  SCOPE_ORG_JOB,
  scopeItemJobId,
  scopeOrgJobId,
} from "../../src/catalog/scope-sync.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import {
  OUTBOX_DISPATCH_FAILS,
  OutboxDispatcher,
} from "../../src/infra/outbox/outbox.dispatcher.js";
import { createOrg, type Req, waitFor } from "../helpers/runs.js";
import { type OrgEnv, resetOrgCatalog, seedPlugin, setScope, startOrgEnv } from "./org-env.js";
import { skillPlugin } from "./packages.js";

/**
 * Transactional outbox spec §8.1 (catalog rows): a scope change, a new org and an ownership
 * transfer owe the plugin scope sync in their own transaction. The fast path is disabled for the
 * scope queue (`OUTBOX_DISPATCH_FAILS`, while `failing` is set), so what converges the orgs got
 * there through an owed row an explicit relay pass delivered.
 */

let env: OrgEnv;
/** A second org (root owns it). */
let orgB: string;
/** While true, the outbox's adds to the plugin scope queue fail. */
let failing = false;

beforeAll(async () => {
  env = await startOrgEnv({
    kernelOverrides: [
      {
        provide: OUTBOX_DISPATCH_FAILS,
        useValue: (queue: string) => failing && queue === PLUGIN_SCOPE_QUEUE,
      },
    ],
  });
  orgB = await createOrg(env.root, "Owed B");
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  failing = false;
  // also drops the scope queue's owed rows a previous test left
  await resetOrgCatalog(env);
});

/** The scope queue's owed (not dead) outbox rows. */
const owed = () =>
  env.db
    .selectFrom("outbox")
    .select(["job_name", "job_id", "data", "org_id"])
    .where("queue", "=", PLUGIN_SCOPE_QUEUE)
    .where("dead_at", "is", null)
    .orderBy("id")
    .execute();

/** Lets the scope queue's adds succeed and runs one relay pass over the owed rows. */
async function relay(): Promise<void> {
  failing = false;
  await env.db
    .updateTable("outbox")
    .set({ next_attempt_at: sql<Date>`now()` as unknown as Date })
    .where("queue", "=", PLUGIN_SCOPE_QUEUE)
    .execute();
  await env.k.app.get(OutboxDispatcher).dispatchDue(500);
}

/** The live installs of an item, as the orgs they are in. */
async function liveOrgs(itemId: string): Promise<string[]> {
  const rows = await env.db
    .selectFrom("plugin_installs")
    .select("org_id")
    .where("item_id", "=", itemId)
    .where("status", "in", ["installing", "installed", "upgrading"])
    .execute();
  return rows.map((r) => r.org_id).sort();
}

async function liveOrgIds(): Promise<string[]> {
  const rows = await env.db
    .selectFrom("orgs")
    .select("id")
    .where("deleted_at", "is", null)
    .execute();
  return rows.map((r) => r.id).sort();
}

const scopeVersion = async (itemId: string) =>
  (
    await env.db
      .selectFrom("catalog_items")
      .select("scope_version")
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow()
  ).scope_version;

/** Uploads and confirms a skills-only package in the org (installed at once); returns its id. */
async function uploaded(req: Req, orgId: string, bytes: Uint8Array): Promise<string> {
  const base = `/api/v1/orgs/${orgId}/catalog/uploads`;
  const p = await req({
    method: "POST",
    url: `${base}/file`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
  expect(p.statusCode, p.body).toBe(200);
  const prepared = p.json() as { stagingId: string; review: { reviewHash: string } };
  const c = await req({
    method: "POST",
    url: `${base}/${prepared.stagingId}/confirm`,
    payload: { reviewHash: prepared.review.reviewHash },
  });
  expect(c.statusCode, c.body).toBe(201);
  expect((c.json() as { outcome: string }).outcome).toBe("installed");
  return (c.json() as { item: { id: string } }).item.id;
}

describe("plugin scope syncs are owed (transactional outbox §8.1)", { timeout: 90_000 }, () => {
  it("changing an item's scope converges every org with the fast path disabled", async () => {
    const itemId = await seedPlugin(env, {
      name: "owed-scope",
      skills: ["owed-scope-skill"],
      templates: false,
    });
    failing = true;
    const base = `/api/v1/admin/catalog/items/${itemId}/scope`;
    const p = await env.root({ method: "POST", url: `${base}/preview`, payload: { scope: "all" } });
    expect(p.statusCode, p.body).toBe(200);
    const r = await env.root({
      method: "PUT",
      url: base,
      payload: { scope: "all", scopeHash: (p.json() as { scopeHash: string }).scopeHash },
    });
    expect(r.statusCode, r.body).toBe(200);
    // committed with the scope: one owed item job for the new scope version, nothing installed
    expect(await owed()).toEqual([
      {
        job_name: SCOPE_ITEM_JOB,
        job_id: scopeItemJobId(itemId, await scopeVersion(itemId)),
        data: { kind: "item", itemId },
        org_id: null,
      },
    ]);
    expect(await liveOrgs(itemId)).toEqual([]);
    await relay();
    const all = await liveOrgIds();
    expect(all).toContain(orgB);
    await waitFor(
      async () => (await liveOrgs(itemId)).join() === all.join(),
      30_000,
      "installed in every org",
    );
    expect(await owed()).toEqual([]);
  });

  it("a new org gets the all-scope items with the fast path disabled", async () => {
    const itemId = await seedPlugin(env, {
      name: "owed-new-org",
      skills: ["owed-new-org-skill"],
      templates: false,
    });
    // written directly: no sync for the orgs that exist
    await setScope(env, itemId, "all");
    failing = true;
    const orgC = await createOrg(env.root, `Owed C ${Date.now()}`);
    expect(await owed()).toEqual([
      {
        job_name: SCOPE_ORG_JOB,
        job_id: scopeOrgJobId(orgC),
        data: { kind: "org", orgId: orgC },
        org_id: orgC,
      },
    ]);
    expect(await liveOrgs(itemId)).toEqual([]);
    await relay();
    await waitFor(
      async () => (await liveOrgs(itemId)).includes(orgC),
      30_000,
      "installed in the new org",
    );
    expect(await owed()).toEqual([]);
  });

  it("transferring an owned item with the fast path disabled cleans the old install up", async () => {
    const orgA = env.orgId;
    const itemId = await uploaded(env.boss, orgA, await skillPlugin("owed-tx"));
    await waitFor(
      async () => (await liveOrgs(itemId)).includes(orgA),
      30_000,
      "installed in the owner org",
    );
    // shared with B, where the scope sync installs it
    const s = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${orgA}/owned-plugins/${itemId}/shareable`,
      payload: { shareable: true },
    });
    expect(s.statusCode, s.body).toBe(204);
    await setScope(env, itemId, "named", [orgA, orgB]);
    await env.k.app
      .get(TransactionHost)
      .run(() => env.k.app.get(CatalogScopeService).enqueueSync(itemId));
    await waitFor(
      async () => (await liveOrgs(itemId)).join() === [orgA, orgB].sort().join(),
      30_000,
      "installed in B",
    );
    // the owner deletes it: B uses it, so it is transferred and A leaves its list
    failing = true;
    const owned = `/api/v1/orgs/${orgA}/owned-plugins/${itemId}/delete`;
    const p = await env.boss({ method: "POST", url: `${owned}/preview` });
    expect(p.statusCode, p.body).toBe(200);
    expect((p.json() as { outcome: string }).outcome).toBe("transferred");
    const d = await env.boss({
      method: "POST",
      url: owned,
      payload: { previewHash: (p.json() as { previewHash: string }).previewHash },
    });
    expect(d.statusCode, d.body).toBe(204);
    expect(await owed()).toEqual([
      {
        job_name: SCOPE_ITEM_JOB,
        job_id: scopeItemJobId(itemId, await scopeVersion(itemId)),
        data: { kind: "item", itemId },
        org_id: null,
      },
    ]);
    // the former owner's install is still there until the owed sync runs
    expect(await liveOrgs(itemId)).toContain(orgA);
    await relay();
    await waitFor(
      async () => (await liveOrgs(itemId)).join() === orgB,
      30_000,
      "the former owner's install removed",
    );
    expect(await owed()).toEqual([]);
  });
});
