import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CatalogScopeService } from "../../src/catalog/catalog-scope.service.js";
import {
  PLUGIN_SCOPE_QUEUE,
  PluginScopeSync,
  SCOPE_BACKSTOP_JOB,
  SCOPE_ITEM_JOB,
  SCOPE_ORG_JOB,
  scopeBackstopJobId,
  scopeItemJobId,
  scopeOrgJobId,
} from "../../src/catalog/scope-sync.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import {
  OUTBOX_DISPATCH_FAILS,
  OutboxDispatcher,
} from "../../src/infra/outbox/outbox.dispatcher.js";
import { outboxJobOptions } from "../../src/infra/outbox/registry.js";
import { createOrg, type Req, waitFor } from "../helpers/runs.js";
import {
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  setScope,
  startOrgEnv,
  TEST_SCOPE_BACKSTOP_DELAY_MS,
} from "./org-env.js";
import { skillPlugin } from "./packages.js";

/**
 * Transactional outbox spec §8.1 (catalog rows): a scope change, a new org and an ownership
 * transfer owe the plugin scope sync in their own transaction; a confirmation's commit owes a
 * delayed backstop (ruling R24). The fast path is disabled for the
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

/**
 * Waits until the scope queue's rows matching `which` are gone. A pass (a fast path, the worker's
 * relay tick) deletes the rows it delivered only when its claim transaction commits, after
 * `addBulk`: the job may run (and the test see its effect) while its row is still there, and a
 * pass of ours skips the rows such a pass holds (`SKIP LOCKED`).
 */
async function delivered(which: "all" | "item-jobs"): Promise<void> {
  await waitFor(
    async () => {
      let q = env.db
        .selectFrom("outbox")
        .select("id")
        .where("queue", "=", PLUGIN_SCOPE_QUEUE)
        .where("dead_at", "is", null);
      if (which === "item-jobs") q = q.where("job_name", "=", SCOPE_ITEM_JOB);
      return (await q.execute()).length === 0;
    },
    30_000,
    `the scope queue's ${which === "all" ? "" : "item "}rows delivered`,
  );
}

/**
 * Lets the scope queue's adds succeed, runs one relay pass over the owed rows, each due now (a
 * backstop's `runAt` brought forward), and waits until every row is delivered (a concurrent pass
 * may hold some: {@link delivered}).
 */
async function relay(): Promise<void> {
  failing = false;
  await env.db
    .updateTable("outbox")
    .set({ next_attempt_at: sql<Date>`now()` as unknown as Date, run_at: null })
    .where("queue", "=", PLUGIN_SCOPE_QUEUE)
    .execute();
  await env.k.app.get(OutboxDispatcher).dispatchDue(500);
  await delivered("all");
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
    // the syncs owed so far are delivered (their passes committed) before adds start failing
    await delivered("item-jobs");
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
    // (the upload's backstop may still be owed too: only the transfer's job is checked)
    expect((await owed()).filter((r) => r.job_name === SCOPE_ITEM_JOB)).toEqual([
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

  it("a crash between an import's commit and its post-deploy add: the backstop converges the orgs", async () => {
    // the confirm's process dies after the deploy, before it owes the immediate sync
    const svc = env.k.app.get(CatalogScopeService) as unknown as {
      oweSync: (itemId: string) => Promise<void>;
    };
    const oweSync = svc.oweSync;
    svc.oweSync = async () => {};
    failing = true;
    let itemId: string;
    try {
      const p = await env.root({
        method: "POST",
        url: "/api/v1/admin/catalog/import/file",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from(await skillPlugin("owed-backstop")),
      });
      expect(p.statusCode, p.body).toBe(200);
      const c = await env.root({
        method: "POST",
        url: `/api/v1/admin/catalog/imports/${p.json().stagingId}/confirm`,
        payload: { reviewHash: p.json().review.reviewHash, scope: "all" },
      });
      expect(c.statusCode, c.body).toBe(201);
      itemId = (c.json() as { item: { id: string } }).item.id;
    } finally {
      svc.oweSync = oweSync;
    }
    // only the backstop the commit owed, due five minutes on; nothing installed
    expect(await owed()).toEqual([
      {
        job_name: SCOPE_BACKSTOP_JOB,
        job_id: scopeBackstopJobId(itemId, await scopeVersion(itemId)),
        data: { kind: "item", itemId, backstop: true },
        org_id: null,
      },
    ]);
    const row = await env.db
      .selectFrom("outbox")
      .select(["run_at", "created_at"])
      .where("queue", "=", PLUGIN_SCOPE_QUEUE)
      .executeTakeFirstOrThrow();
    expect(
      new Date(row.run_at as Date).getTime() - new Date(row.created_at).getTime(),
    ).toBeGreaterThan(TEST_SCOPE_BACKSTOP_DELAY_MS - 60_000);
    expect(await liveOrgs(itemId)).toEqual([]);
    // its time comes: the orgs converge
    await relay();
    const all = await liveOrgIds();
    await waitFor(
      async () => (await liveOrgs(itemId)).join() === all.join(),
      30_000,
      "installed in every org by the backstop",
    );
    expect(await owed()).toEqual([]);
  });

  it("a backstop whose extension is not deployed throws for a BullMQ retry and records no failure", async () => {
    // retried with backoff, bounded by its attempts
    expect(outboxJobOptions(SCOPE_BACKSTOP_JOB)).toMatchObject({ attempts: 5 });
    const itemId = await seedPlugin(env, {
      name: "owed-ghost",
      extension: true,
      skills: [],
      templates: false,
    });
    await setScope(env, itemId, "all");
    const sync = env.k.app.get(PluginScopeSync);
    await expect(sync.process({ kind: "item", itemId, backstop: true })).rejects.toThrow(
      /not enabled on the deployment yet/,
    );
    expect(await liveOrgs(itemId)).toEqual([]);
    expect(
      await env.db
        .selectFrom("plugin_scope_sync_failures")
        .select("code")
        .where("item_id", "=", itemId)
        .execute(),
    ).toEqual([]);
    // an extension loaded here (config-declared: no install record) passes the check
    const loaded = await seedPlugin(env, {
      name: "fake-tools-ui",
      extension: true,
      skills: [],
      templates: false,
    });
    await expect(
      sync.process({ kind: "item", itemId: loaded, backstop: true }),
    ).resolves.toBeUndefined();
  });
});
