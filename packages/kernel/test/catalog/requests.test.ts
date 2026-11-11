import { createHash } from "node:crypto";
import {
  type FakeMarketplace,
  type FakeNpmRegistry,
  startFakeMarketplace,
  startFakeNpmRegistry,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KERNEL_VERSION } from "../../src/version.js";
import { createOrg, waitFor } from "../helpers/runs.js";
import {
  auditActions,
  importSkill,
  install,
  type OrgEnv,
  resetOrgCatalog,
  setDeployment,
  setScope,
  startOrgEnv,
} from "./org-env.js";
import { skillPlugin } from "./packages.js";

// Requests under plugin scope (spec 2026-11-05-plugin-component-management-design.md §5.1):
// `enable` (member -> org admin, an optional item that is off), `access` (org admin -> super
// admin, a named item shown to other orgs) and `import` (org admin -> super admin, a
// marketplace entry not imported yet).

const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

let env: OrgEnv;
let reg: FakeNpmRegistry;
let market: FakeMarketplace;
let marketplaceId: string;
/** The marketplace's manifest as the tests start from it. */
let baseManifest: { plugins: Record<string, unknown>[] } & Record<string, unknown>;

beforeAll(async () => {
  const tgz = await skillPlugin("mkt-tools");
  const tgz2 = await skillPlugin("mkt-tools", { version: "2.0.0" });
  reg = await startFakeNpmRegistry({
    packages: [
      { name: "@acme/plugin-mkt-tools", version: "1.0.0", tgz },
      { name: "@acme/plugin-mkt-tools", version: "2.0.0", tgz: tgz2 },
    ],
  });
  baseManifest = {
    schemaVersion: 1,
    name: "Acme",
    plugins: [
      {
        name: "mkt-tools",
        summary: { en: "Marketplace tools" },
        minKernel: KERNEL_VERSION,
        source: {
          npm: { package: "@acme/plugin-mkt-tools", version: "1.0.0", integrity: sri(tgz) },
        },
      },
      {
        name: "mkt-tools",
        summary: { en: "Marketplace tools" },
        minKernel: KERNEL_VERSION,
        source: {
          npm: { package: "@acme/plugin-mkt-tools", version: "2.0.0", integrity: sri(tgz2) },
        },
      },
    ],
  };
  market = await startFakeMarketplace({ manifest: baseManifest });
  env = await startOrgEnv({
    packages: { npmRegistry: reg.url },
    marketplaces: { allowInsecureLoopback: true },
  });
  const add = await env.root({
    method: "POST",
    url: "/api/v1/admin/marketplaces",
    payload: { name: "Acme", url: market.url },
  });
  expect(add.statusCode, add.body).toBe(201);
  marketplaceId = add.json().id as string;
  const r = await env.root({
    method: "POST",
    url: `/api/v1/admin/marketplaces/${marketplaceId}/refresh`,
  });
  expect(r.statusCode, r.body).toBe(200);
}, 240_000);

afterAll(async () => {
  await env?.stop();
  await Promise.all([reg?.stop(), market?.stop()]);
});

beforeEach(async () => {
  await resetOrgCatalog(env);
});

type Req = OrgEnv["root"];
interface RequestView {
  id: string;
  kind: "access" | "import" | "enable";
  status: string;
  note: string;
  reason: string | null;
  item: { id: string } | null;
  entry: { marketplaceId: string; name: string; version: string | null } | null;
  stagingId: string | null;
}
type InboxItem = { type: string; id: string; request?: RequestView };

async function inbox(req: Req, type: string): Promise<InboxItem[]> {
  const r = await req({ method: "GET", url: `/api/v1/orgs/${env.orgId}/inbox` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { items: InboxItem[] }).items.filter((i) => i.type === type);
}

const request = (
  req: Req,
  itemId: string,
  kind: "access" | "enable",
  note?: string,
  orgId = env.orgId,
) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/catalog/${itemId}/requests`,
    payload: { kind, ...(note !== undefined && { note }) },
  });

const decideOrg = (req: Req, id: string, approve: boolean, reason?: string) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/catalog-requests/${id}/decide`,
    payload: { approve, ...(reason !== undefined && { reason }) },
  });

const decideAdmin = (req: Req, id: string, approve: boolean, reason?: string) =>
  req({
    method: "POST",
    url: `/api/v1/admin/catalog/requests/${id}/decide`,
    payload: { approve, ...(reason !== undefined && { reason }) },
  });

const marketplaceRequest = (req: Req, note?: string, version = "1.0.0") =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/marketplace-requests`,
    payload: { marketplaceId, name: "mkt-tools", version, ...(note && { note }) },
  });

/** The super admin imports mkt-tools@version from the marketplace; returns the item id. */
async function adminImport(version: string): Promise<string> {
  const p = await env.root({
    method: "POST",
    url: `/api/v1/admin/marketplaces/${marketplaceId}/entries/mkt-tools/import`,
    payload: { version },
  });
  expect(p.statusCode, p.body).toBe(200);
  const c = await env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/imports/${p.json().stagingId}/confirm`,
    payload: { reviewHash: p.json().review.reviewHash },
  });
  expect(c.statusCode, c.body).toBe(201);
  return c.json().item.id as string;
}

type EntryView = {
  name: string;
  adopted: { itemId: string } | null;
  newerAvailable: boolean;
  contentChanged: boolean;
};
async function orgEntries(): Promise<EntryView[]> {
  const r = await env.boss({
    method: "GET",
    url: `/api/v1/orgs/${env.orgId}/marketplaces/entries`,
  });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { items: EntryView[] }).items;
}

const scopeOrgsOf = async (itemId: string) =>
  (
    await env.db
      .selectFrom("catalog_item_scope_orgs")
      .select("org_id")
      .where("item_id", "=", itemId)
      .execute()
  ).map((r) => r.org_id);

async function orgItem(req: Req, itemId: string) {
  const r = await req({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog` });
  expect(r.statusCode, r.body).toBe(200);
  return (
    r.json() as { items: { id: string; state: string; request: { id: string } | null }[] }
  ).items.find((i) => i.id === itemId);
}

/** Pending catalog requests as the admin overview counts them (the platform inbox by type). */
async function overviewPending(): Promise<number> {
  const r = await env.root({ method: "GET", url: "/api/v1/admin/inbox" });
  return (r.json() as { byType: { catalog_request: number } }).byType.catalog_request;
}

const setShown = (itemId: string, shown: boolean) =>
  env.db
    .updateTable("catalog_items")
    .set({ shown_to_others: shown })
    .where("id", "=", itemId)
    .execute();

describe("enable: member -> org admin", { timeout: 60_000 }, () => {
  it("an optional item that is off: the org admin approves and it is on in the org", async () => {
    const itemId = await importSkill(env);
    expect((await orgItem(env.mem, itemId))?.state).toBe("off");
    const r = await request(env.mem, itemId, "enable", "need PDFs");
    expect(r.statusCode, r.body).toBe(201);
    const req = r.json().request as RequestView;
    expect(req).toMatchObject({ kind: "enable", status: "pending", note: "need PDFs" });
    expect((await orgItem(env.mem, itemId))?.request?.id).toBe(req.id);
    expect((await inbox(env.boss, "catalog_request")).map((i) => i.id)).toEqual([req.id]);
    expect(await inbox(env.mem, "catalog_request")).toEqual([]);
    expect(await auditActions(env)).toContain("catalog.requested");
    // a member cannot decide; super admin routes do not take enable requests
    expect((await decideOrg(env.mem, req.id, true)).statusCode).toBe(403);
    expect((await decideAdmin(env.root, req.id, true)).statusCode).toBe(404);
    const ok = await decideOrg(env.boss, req.id, true);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().request).toMatchObject({ status: "approved" });
    expect((await orgItem(env.mem, itemId))?.state).toBe("on");
    expect(await inbox(env.boss, "catalog_request")).toEqual([]);
    // the requester gets the decision in the inbox, and can dismiss it
    const notices = await inbox(env.mem, "catalog_request_decided");
    expect(notices.map((i) => [i.id, i.request?.status])).toEqual([[req.id, "approved"]]);
    const dismiss = await env.mem({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/catalog-requests/${req.id}/dismiss`,
    });
    expect(dismiss.statusCode, dismiss.body).toBe(204);
    expect(await inbox(env.mem, "catalog_request_decided")).toEqual([]);
    expect(await auditActions(env)).toContain("catalog.request_decided");
  });

  it("a second pending request of the same kind is 409; an item that is on is 409", async () => {
    const itemId = await importSkill(env);
    expect((await request(env.mem, itemId, "enable")).statusCode).toBe(201);
    const dup = await request(env.boss, itemId, "enable");
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json().error.code).toBe("catalog.request_pending");
    // a member may not ask for access (org admins only)
    expect((await request(env.mem, itemId, "access")).statusCode).toBe(403);
    const on = await importSkill(env, { name: "on-tools", skillName: "on-skill" });
    expect((await install(env.boss, env, on)).statusCode).toBe(201);
    const bad = await request(env.mem, on, "enable");
    expect(bad.statusCode, bad.body).toBe(409);
    expect(bad.json().error.code).toBe("catalog.request_invalid");
  });

  it("rejection carries a reason the requester sees", async () => {
    const itemId = await importSkill(env);
    const id = (await request(env.mem, itemId, "enable")).json().request.id as string;
    const no = await decideOrg(env.boss, id, false, "use the shared one");
    expect(no.statusCode, no.body).toBe(200);
    expect(no.json().request).toMatchObject({ status: "rejected", reason: "use the shared one" });
    const notices = await inbox(env.mem, "catalog_request_decided");
    expect(notices.map((i) => i.request?.reason)).toEqual(["use the shared one"]);
    expect((await orgItem(env.mem, itemId))?.state).toBe("off");
    // decided once: 409
    expect((await decideOrg(env.boss, id, true)).json().error.code).toBe("catalog.request_decided");
  });

  it("switching the item on resolves the pending enable request", async () => {
    const itemId = await importSkill(env);
    const id = (await request(env.mem, itemId, "enable")).json().request.id as string;
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    const row = await env.db
      .selectFrom("catalog_requests")
      .select(["status", "decided_by"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "approved", decided_by: env.bossId });
    expect(await inbox(env.boss, "catalog_request")).toEqual([]);
  });

  it("a pending request on an item hidden from the org since is left out of the org admin's inbox", async () => {
    const itemId = await importSkill(env);
    const id = (await request(env.mem, itemId, "enable")).json().request.id as string;
    expect((await inbox(env.boss, "catalog_request")).map((i) => i.id)).toEqual([id]);
    // named for other orgs only, not shown to the rest: the org may not learn its name
    await setScope(env, itemId, "named", []);
    await setShown(itemId, false);
    expect(await inbox(env.boss, "catalog_request")).toEqual([]);
    // shown again (requestable): back in the inbox
    await setShown(itemId, true);
    expect((await inbox(env.boss, "catalog_request")).map((i) => i.id)).toEqual([id]);
  });
});

describe("access: org admin -> super admin", { timeout: 60_000 }, () => {
  it("a named item shown to others: approved, the org is on its list and the sync installs it", async () => {
    const itemId = await importSkill(env);
    await setScope(env, itemId, "named", []);
    const before = await orgItem(env.boss, itemId);
    expect(before).toMatchObject({ state: "not_offered", request: null });
    // members see it but cannot ask for access; enable does not apply to it
    expect((await request(env.mem, itemId, "access")).statusCode).toBe(403);
    expect((await request(env.mem, itemId, "enable")).json().error.code).toBe(
      "catalog.request_invalid",
    );
    const r = await request(env.boss, itemId, "access", "for sales");
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().request.id as string;
    expect((await orgItem(env.boss, itemId))?.request?.id).toBe(id);
    expect(await overviewPending()).toBe(1);
    const list = await env.root({ method: "GET", url: "/api/v1/admin/catalog/requests" });
    expect(
      (list.json() as { requests: RequestView[] }).requests.map((x) => [x.id, x.kind]),
    ).toEqual([[id, "access"]]);
    // org admins cannot decide it
    expect((await decideOrg(env.boss, id, true)).statusCode).toBe(404);
    expect((await decideAdmin(env.boss, id, true)).statusCode).toBe(403);
    const version = (
      await env.db
        .selectFrom("catalog_items")
        .select("scope_version")
        .where("id", "=", itemId)
        .executeTakeFirstOrThrow()
    ).scope_version;
    const ok = await decideAdmin(env.root, id, true);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().request.status).toBe("approved");
    const scopeOrgs = await env.db
      .selectFrom("catalog_item_scope_orgs")
      .select("org_id")
      .where("item_id", "=", itemId)
      .execute();
    expect(scopeOrgs).toEqual([{ org_id: env.orgId }]);
    const after = await env.db
      .selectFrom("catalog_items")
      .select("scope_version")
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(after.scope_version).toBe(version + 1);
    expect(await auditActions(env)).toContain("catalog.scope_changed");
    await waitFor(
      async () =>
        (await env.db
          .selectFrom("plugin_installs")
          .select("id")
          .where("org_id", "=", env.orgId)
          .where("item_id", "=", itemId)
          .where("status", "=", "installed")
          .executeTakeFirst()) !== undefined,
      20_000,
      "the scope sync installs the item",
    );
    expect((await orgItem(env.boss, itemId))?.state).toBe("on");
    expect(await overviewPending()).toBe(0);
    expect((await inbox(env.boss, "catalog_request_decided")).map((i) => i.id)).toEqual([id]);
  });

  it("a hidden named item is absent and its requests are 404", async () => {
    const itemId = await importSkill(env);
    await setScope(env, itemId, "named", []);
    await setShown(itemId, false);
    expect(await orgItem(env.boss, itemId)).toBeUndefined();
    const r = await request(env.boss, itemId, "access");
    expect(r.statusCode, r.body).toBe(404);
    expect(r.json().error.code).toBe("catalog.item_not_found");
    const d = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}` });
    expect(d.statusCode).toBe(404);
  });

  it("deleting the item cancels its pending requests; deleting the org cancels the org's", async () => {
    const itemId = await importSkill(env);
    await setScope(env, itemId, "named", []);
    const id = (await request(env.boss, itemId, "access")).json().request.id as string;
    const other = await createOrg(env.root, "Doomed");
    const o = await request(env.root, itemId, "access", undefined, other);
    expect(o.statusCode, o.body).toBe(201);
    expect(await overviewPending()).toBe(2);
    const delOrg = await env.root({ method: "DELETE", url: `/api/v1/orgs/${other}` });
    expect(delOrg.statusCode, delOrg.body).toBe(204);
    expect(await overviewPending()).toBe(1);
    const del = await env.root({ method: "DELETE", url: `/api/v1/admin/catalog/items/${itemId}` });
    expect(del.statusCode, del.body).toBe(204);
    const row = await env.db
      .selectFrom("catalog_requests")
      .select(["status", "decided_by"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "cancelled", decided_by: env.rootId });
    expect(await auditActions(env)).toContain("catalog.request_cancelled");
    expect(await overviewPending()).toBe(0);
  });
});

describe("import: org admin -> super admin", { timeout: 90_000 }, () => {
  it("org admins browse entries; approval prepares the import and the confirm resolves it", async () => {
    const entries = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/marketplaces/entries`,
    });
    expect(entries.statusCode, entries.body).toBe(200);
    expect([
      ...new Set((entries.json() as { items: { name: string }[] }).items.map((e) => e.name)),
    ]).toEqual(["mkt-tools"]);
    expect(
      (await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/marketplaces/entries` }))
        .statusCode,
    ).toBe(403);
    expect((await marketplaceRequest(env.mem)).statusCode).toBe(403);
    const r = await marketplaceRequest(env.boss, "please");
    expect(r.statusCode, r.body).toBe(201);
    const req = r.json().request as RequestView;
    expect(req).toMatchObject({
      kind: "import",
      status: "pending",
      item: null,
      entry: { marketplaceId, name: "mkt-tools", version: "1.0.0" },
    });
    const dup = await marketplaceRequest(env.boss);
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json().error.code).toBe("catalog.request_pending");

    const ok = await decideAdmin(env.root, req.id, true);
    expect(ok.statusCode, ok.body).toBe(200);
    const stagingId = ok.json().import.stagingId as string;
    expect(ok.json().request).toMatchObject({ status: "pending", stagingId });
    const c = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/imports/${stagingId}/confirm`,
      payload: { reviewHash: ok.json().import.review.reviewHash },
    });
    expect(c.statusCode, c.body).toBe(201);
    const itemId = c.json().item.id as string;
    const item = await env.db
      .selectFrom("catalog_items")
      .select("scope")
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(item.scope).toBe("named");
    const scopeOrgs = await env.db
      .selectFrom("catalog_item_scope_orgs")
      .select("org_id")
      .where("item_id", "=", itemId)
      .execute();
    expect(scopeOrgs).toEqual([{ org_id: env.orgId }]);
    const row = await env.db
      .selectFrom("catalog_requests")
      .select(["status", "decided_by", "item_id"])
      .where("id", "=", req.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "approved", decided_by: env.rootId, item_id: itemId });
    expect((await inbox(env.boss, "catalog_request_decided")).map((i) => i.id)).toEqual([req.id]);
  });

  it("orgMarketplaceBrowse false: entries 404, marketplace requests 409", async () => {
    await setDeployment(env, { orgMarketplaceBrowse: false });
    const entries = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/marketplaces/entries`,
    });
    expect(entries.statusCode).toBe(404);
    const r = await marketplaceRequest(env.boss);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("catalog.marketplace_browse_disabled");
    const s = await env.root({ method: "GET", url: "/api/v1/admin/settings" });
    expect(s.json()).toMatchObject({ orgMarketplaceBrowse: false });
  });

  it("a request for a deprecated version is 409 marketplace.entry_deprecated", async () => {
    const manifest = baseManifest;
    const refreshMarket = async () => {
      const r = await env.root({
        method: "POST",
        url: `/api/v1/admin/marketplaces/${marketplaceId}/refresh`,
      });
      expect(r.statusCode, r.body).toBe(200);
    };
    market.setManifest({
      ...manifest,
      plugins: manifest.plugins.map((e, i) => (i === 1 ? { ...e, deprecated: true } : e)),
    });
    try {
      await refreshMarket();
      const r = await marketplaceRequest(env.boss, undefined, "2.0.0");
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error.code).toBe("marketplace.entry_deprecated");
      expect((await marketplaceRequest(env.boss)).statusCode).toBe(201);
    } finally {
      market.setManifest(manifest);
      await refreshMarket();
    }
  });

  it("rejection stores the reason", async () => {
    const id = (await marketplaceRequest(env.boss)).json().request.id as string;
    const no = await decideAdmin(env.root, id, false, "not vetted");
    expect(no.statusCode, no.body).toBe(200);
    expect(no.json().request).toMatchObject({ status: "rejected", reason: "not vetted" });
    const notices = await inbox(env.boss, "catalog_request_decided");
    expect(notices.map((i) => i.request?.reason)).toEqual(["not vetted"]);
  });
});

describe("hidden items stay unknown to unlisted orgs", { timeout: 120_000 }, () => {
  it("entries of a hidden item read as not imported; an import request for it is accepted and approval grants access", async () => {
    const itemId = await adminImport("1.0.0");
    await setScope(env, itemId, "named", []);
    // shown to others: the org sees the adoption and is told to ask for access
    expect((await orgEntries()).every((e) => e.adopted?.itemId === itemId)).toBe(true);
    const shown = await marketplaceRequest(env.boss);
    expect(shown.statusCode, shown.body).toBe(409);
    expect(shown.json().error.code).toBe("catalog.request_invalid");
    // hidden: nothing reveals it
    await setShown(itemId, false);
    for (const e of await orgEntries()) {
      expect(e).toMatchObject({ adopted: null, newerAvailable: false, contentChanged: false });
    }
    const r = await marketplaceRequest(env.boss);
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().request.id as string;
    // the entry's version is in the catalog already: the org joins the list, nothing imported
    const ok = await decideAdmin(env.root, id, true);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().import).toBeUndefined();
    expect(ok.json().request).toMatchObject({ status: "approved", item: { id: itemId } });
    expect(await scopeOrgsOf(itemId)).toEqual([env.orgId]);
    expect(await env.db.selectFrom("plugin_import_staging").select("id").execute()).toEqual([]);
  });

  it("a request for a version the hidden item lacks: the confirm adds the org to the existing item", async () => {
    const itemId = await adminImport("1.0.0");
    await setScope(env, itemId, "named", []);
    await setShown(itemId, false);
    const r = await marketplaceRequest(env.boss, undefined, "2.0.0");
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().request.id as string;
    const ok = await decideAdmin(env.root, id, true);
    expect(ok.statusCode, ok.body).toBe(200);
    const stagingId = ok.json().import.stagingId as string;
    const c = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/imports/${stagingId}/confirm`,
      payload: { reviewHash: ok.json().import.review.reviewHash },
    });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().item.id).toBe(itemId);
    const item = await env.db
      .selectFrom("catalog_items")
      .select(["scope", "latest_version"])
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(item).toEqual({ scope: "named", latest_version: "2.0.0" });
    expect(await scopeOrgsOf(itemId)).toEqual([env.orgId]);
    const row = await env.db
      .selectFrom("catalog_requests")
      .select(["status", "item_id"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "approved", item_id: itemId });
  });

  it("the super admin hides a not_offered item: absent, pending requests kept, new ones 404", async () => {
    const itemId = await importSkill(env);
    await setScope(env, itemId, "named", []);
    const id = (await request(env.boss, itemId, "access")).json().request.id as string;
    const put = await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${itemId}/shown`,
      payload: { shownToOthers: false },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ id: itemId, shownToOthers: false });
    expect(await auditActions(env)).toContain("catalog.shown_changed");
    expect(
      (
        await env.boss({
          method: "PUT",
          url: `/api/v1/admin/catalog/items/${itemId}/shown`,
          payload: { shownToOthers: true },
        })
      ).statusCode,
    ).toBe(403);
    expect(await orgItem(env.boss, itemId)).toBeUndefined();
    const row = await env.db
      .selectFrom("catalog_requests")
      .select("status")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("pending");
    // a fresh org-side request (the pending one is rejected first) is 404
    expect((await decideAdmin(env.root, id, false)).statusCode).toBe(200);
    const again = await request(env.boss, itemId, "access");
    expect(again.statusCode, again.body).toBe(404);
    const detail = await env.root({ method: "GET", url: `/api/v1/admin/catalog/items/${itemId}` });
    expect(detail.json().item.shownToOthers).toBe(false);
  });
});

describe("concurrency", { timeout: 60_000 }, () => {
  it("two requests at once: one pending, the other 409", async () => {
    const itemId = await importSkill(env);
    const [a, b] = await Promise.all([
      request(env.mem, itemId, "enable"),
      request(env.boss, itemId, "enable"),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const rows = await env.db.selectFrom("catalog_requests").select("id").execute();
    expect(rows).toHaveLength(1);
  });

  it("two approvals of one import request at once: one staging", async () => {
    const id = (await marketplaceRequest(env.boss)).json().request.id as string;
    const [a, b] = await Promise.all([
      decideAdmin(env.root, id, true),
      decideAdmin(env.root, id, true),
    ]);
    expect([a.statusCode, b.statusCode], `${a.body} ${b.body}`).toEqual([200, 200]);
    expect(a.json().import.stagingId).toBe(b.json().import.stagingId);
    expect(await env.db.selectFrom("plugin_import_staging").select("id").execute()).toHaveLength(1);
  });

  it("two decisions at once: one 200, the other 409", async () => {
    const itemId = await importSkill(env);
    await setScope(env, itemId, "named", []);
    const id = (await request(env.boss, itemId, "access")).json().request.id as string;
    const [p, q] = await Promise.all([
      decideAdmin(env.root, id, true),
      decideAdmin(env.root, id, true),
    ]);
    expect([p.statusCode, q.statusCode].sort()).toEqual([200, 409]);
    const decided = await env.db
      .selectFrom("audit_events")
      .select("action")
      .where("action", "=", "catalog.request_decided")
      .execute();
    expect(decided).toHaveLength(1);
  });
});
