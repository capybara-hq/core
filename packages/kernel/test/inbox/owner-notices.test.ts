import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { orgsUsing } from "../../src/catalog/ownership.js";
import { notifySharedUpdate } from "../../src/inbox/org-notices.js";
import { addPlatformNotice } from "../../src/inbox/platform-notices.js";
import {
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  setScope,
  startOrgEnv,
} from "../catalog/org-env.js";
import { createOrg, waitFor } from "../helpers/runs.js";

/**
 * Plugin scope phase 3, Task 3 (spec §14, P3-18, P3-22): org notices (`item_shared`,
 * `shared_item_updated`) and the platform notice `ownership_transferred`.
 */

let env: OrgEnv;
/** The owner org ("A"); `env.orgId` is org B; org C is another one. */
let orgA: string;
let orgC: string;

beforeAll(async () => {
  env = await startOrgEnv();
  orgA = await createOrg(env.root, "A");
  orgC = await createOrg(env.root, "C");
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("org_notices").execute();
  await env.db.deleteFrom("platform_notices").execute();
});

const items = "/api/v1/admin/catalog/items";

async function ownedPlugin(shareable: boolean, scope: "named" | "optional" = "named") {
  const itemId = await seedPlugin(env, {
    name: "owned-crm",
    skills: ["owned-skill"],
    templates: false,
  });
  await setScope(env, itemId, scope, scope === "named" ? [orgA] : []);
  await env.db
    .updateTable("catalog_items")
    .set({ owner_org_id: orgA, shareable, shown_to_others: true })
    .where("id", "=", itemId)
    .execute();
  await env.db
    .updateTable("platform_skills")
    .set({ owner_org_id: orgA, origin_org_id: orgA, shareable })
    .where("catalog_item_id", "=", itemId)
    .execute();
  return itemId;
}

async function putScope(itemId: string, body: Record<string, unknown>) {
  const p = await env.root({
    method: "POST",
    url: `${items}/${itemId}/scope/preview`,
    payload: body,
  });
  expect(p.statusCode, p.body).toBe(200);
  const r = await env.root({
    method: "PUT",
    url: `${items}/${itemId}/scope`,
    payload: { ...body, scopeHash: p.json().scopeHash },
  });
  expect(r.statusCode, r.body).toBe(200);
}

interface InboxItem {
  type: string;
  id: string;
  notice: { kind: string; detail: Record<string, unknown> };
}

async function ownerInbox(orgId: string, type: string): Promise<InboxItem[]> {
  const r = await env.root({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json().items as InboxItem[]).filter((i) => i.type === type);
}

const sharedOrgs = async () =>
  (await ownerInbox(orgA, "item_shared")).map((i) => i.notice.detail.org);

describe("owner notices", { timeout: 90_000 }, () => {
  it("association notifies the owner", async () => {
    const itemId = await ownedPlugin(true);
    await putScope(itemId, { scope: "named", orgs: [orgA, env.orgId] });
    expect(await sharedOrgs()).toEqual([{ id: env.orgId, name: expect.any(String) }]);
    // approving orgC's access request
    const r = await env.root({
      method: "POST",
      url: `/api/v1/orgs/${orgC}/catalog/${itemId}/requests`,
      payload: { kind: "access" },
    });
    expect(r.statusCode, r.body).toBe(201);
    const ok = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/requests/${r.json().request.id}/decide`,
      payload: { approve: true },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const orgs = (await sharedOrgs()) as { id: string; name: string }[];
    expect(orgs.map((o) => o.id).sort()).toEqual([env.orgId, orgC].sort());
    expect(orgs.find((o) => o.id === orgC)?.name).toBe("C");
    // widening to optional
    await putScope(itemId, { scope: "optional" });
    const all = await ownerInbox(orgA, "item_shared");
    expect(all).toHaveLength(3);
    expect(all.filter((i) => i.notice.detail.org === "all_orgs")).toHaveLength(1);
    expect(all[0]?.notice.detail).toMatchObject({
      ref: { kind: "plugin", id: itemId },
      name: "owned-crm",
    });
  });

  it("a platform item writes none", async () => {
    const itemId = await seedPlugin(env, {
      name: "plain",
      skills: ["plain-skill"],
      templates: false,
    });
    await setScope(env, itemId, "named", []);
    await putScope(itemId, { scope: "named", orgs: [env.orgId] });
    // the scope sync installs the item in org B and changes what the next preview covers
    await waitFor(
      async () =>
        (await env.db
          .selectFrom("plugin_installs")
          .select("id")
          .where("item_id", "=", itemId)
          .where("org_id", "=", env.orgId)
          .where("status", "=", "installed")
          .executeTakeFirst()) !== undefined,
      30_000,
      "the scope sync installs the item in org B",
    );
    await putScope(itemId, { scope: "optional" });
    const n = await env.db.selectFrom("org_notices").select("id").execute();
    expect(n).toEqual([]);
  });

  it("notifySharedUpdate reaches the orgs using it", async () => {
    const itemId = await ownedPlugin(true, "optional");
    await env.db
      .insertInto("catalog_item_org_switches")
      .values([
        { item_id: itemId, org_id: env.orgId, enabled: true },
        { item_id: itemId, org_id: orgC, enabled: false },
        { item_id: itemId, org_id: orgA, enabled: true },
      ])
      .execute();
    const ref = { kind: "plugin", id: itemId } as const;
    expect((await orgsUsing(env.db, ref, { except: orgA })).map((o) => o.id)).toEqual([env.orgId]);
    const n = await notifySharedUpdate(env.db, ref, {
      name: "owned-crm",
      from: "1.0.0",
      to: "1.1.0",
    });
    expect(n).toBe(1);
    const rows = await env.db
      .selectFrom("org_notices")
      .select(["org_id", "kind", "detail"])
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: env.orgId,
      kind: "shared_item_updated",
      detail: {
        ref,
        name: "owned-crm",
        from: "1.0.0",
        to: "1.1.0",
        owner: { kind: "org", orgId: orgA, name: "A" },
      },
    });
    // B's admin sees it
    expect(await ownerInbox(env.orgId, "shared_item_updated")).toHaveLength(1);
    // a platform-owned item tells nobody
    const plat = await seedPlugin(env, {
      name: "plain",
      skills: ["plain-skill"],
      templates: false,
    });
    expect(
      await notifySharedUpdate(
        env.db,
        { kind: "plugin", id: plat },
        { name: "plain", from: "1", to: "2" },
      ),
    ).toBe(0);
  });

  it("a component's own scope writes item_shared, and orgsUsing covers skills, deleted orgs and disabled items", async () => {
    const itemId = await ownedPlugin(true);
    const skill = await env.db
      .selectFrom("platform_skills")
      .select("id")
      .where("catalog_item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    const comps = `/api/v1/admin/components/skill/${skill.id}`;
    const put = async (body: Record<string, unknown>) => {
      const p = await env.root({ method: "POST", url: `${comps}/scope/preview`, payload: body });
      expect(p.statusCode, p.body).toBe(200);
      const r = await env.root({
        method: "PUT",
        url: `${comps}/scope`,
        payload: { ...body, scopeHash: p.json().scopeHash },
      });
      expect(r.statusCode, r.body).toBe(200);
    };
    await put({ scope: "named", orgs: [orgA, env.orgId] });
    const first = await ownerInbox(orgA, "item_shared");
    expect(first).toHaveLength(1);
    expect(first[0]?.notice.detail).toMatchObject({
      ref: { kind: "skill", id: skill.id },
      name: "owned-skill",
      org: { id: env.orgId },
    });
    // the skill branch of orgsUsing: B is listed, C is not
    const ref = { kind: "skill", id: skill.id } as const;
    expect((await orgsUsing(env.db, ref, { except: orgA })).map((o) => o.id)).toEqual([env.orgId]);
    // switched off in B: nobody
    await env.db
      .insertInto("component_org_switches")
      .values({ kind: "skill", component_id: skill.id, org_id: env.orgId, enabled: false })
      .execute();
    expect(await orgsUsing(env.db, ref, { except: orgA })).toEqual([]);
    await put({ scope: "optional" });
    expect(
      (await ownerInbox(orgA, "item_shared")).filter((i) => i.notice.detail.org === "all_orgs"),
    ).toHaveLength(1);
    // a deleted org is not "using": plugin scope all, org C soft-deleted
    const plugin = { kind: "plugin", id: itemId } as const;
    await env.db
      .updateTable("catalog_items")
      .set({ scope: "all" })
      .where("id", "=", itemId)
      .execute();
    const ids = async () => (await orgsUsing(env.db, plugin, { except: orgA })).map((o) => o.id);
    expect(await ids()).toContain(orgC);
    await env.db
      .updateTable("orgs")
      .set({ deleted_at: new Date() })
      .where("id", "=", orgC)
      .execute();
    try {
      expect(await ids()).not.toContain(orgC);
    } finally {
      await env.db.updateTable("orgs").set({ deleted_at: null }).where("id", "=", orgC).execute();
    }
    // a disabled item is on nowhere
    await env.db
      .updateTable("catalog_items")
      .set({ disabled: true })
      .where("id", "=", itemId)
      .execute();
    expect(await ids()).toEqual([]);
  });

  it("the platform inbox total counts every open notice, as the count route does", async () => {
    for (let i = 0; i < 103; i++) {
      await addPlatformNotice(env.db, "ownership_transferred", {
        ref: { kind: "skill", id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` },
        name: `s${i}`,
        fromOrg: { id: orgA, name: "A" },
        reason: "org_deleted",
        usedBy: 1,
      });
    }
    const list = (await env.root({ method: "GET", url: "/api/v1/admin/inbox" })).json();
    const count = (await env.root({ method: "GET", url: "/api/v1/admin/inbox/count" })).json();
    expect(list.items).toHaveLength(100);
    expect(list.truncated).toBe(true);
    expect(list.total).toBe(count.total);
    expect(list.total).toBeGreaterThanOrEqual(103);
  });

  it("platform notice", async () => {
    const count = async () =>
      (
        (await env.root({ method: "GET", url: "/api/v1/admin/inbox/count" })).json() as {
          total: number;
        }
      ).total;
    const before = await count();
    await addPlatformNotice(env.db, "ownership_transferred", {
      ref: { kind: "skill", id: "00000000-0000-4000-8000-000000000001" },
      name: "owned-skill",
      fromOrg: { id: orgA, name: "A" },
      reason: "owner_deleted",
      usedBy: 2,
    });
    expect(await count()).toBe(before + 1);
    const list = await env.root({ method: "GET", url: "/api/v1/admin/inbox" });
    const item = (
      list.json().items as { type: string; id: string; notice?: { detail: unknown } }[]
    ).find((i) => i.type === "ownership_transferred");
    expect(item?.notice?.detail).toMatchObject({
      name: "owned-skill",
      usedBy: 2,
      reason: "owner_deleted",
    });
    expect(
      (await env.boss({ method: "POST", url: `/api/v1/admin/inbox/notices/${item?.id}/dismiss` }))
        .statusCode,
    ).toBe(403);
    for (let i = 0; i < 2; i++) {
      const d = await env.root({
        method: "POST",
        url: `/api/v1/admin/inbox/notices/${item?.id}/dismiss`,
      });
      expect(d.statusCode, d.body).toBe(204);
    }
    expect(await count()).toBe(before);
    const after = await env.root({ method: "GET", url: "/api/v1/admin/inbox" });
    expect(
      (after.json().items as { type: string }[]).some((i) => i.type === "ownership_transferred"),
    ).toBe(false);
  });
});
