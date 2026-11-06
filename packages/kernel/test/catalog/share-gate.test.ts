import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOrg, waitFor } from "../helpers/runs.js";
import { type OrgEnv, resetOrgCatalog, seedPlugin, setScope, startOrgEnv } from "./org-env.js";

/**
 * Plugin scope phase 3, Task 2 (spec §14, rulings P3-1, P3-16, P3-17): an org-owned item reaches
 * other orgs only through the share gate (`owner_org_id IS NULL OR shareable`). Not shareable: it
 * is never shown or requestable elsewhere, and the super admin cannot show it, widen its scope or
 * add an org to its list (409 `catalog.not_shareable`); narrowing and disabling stay allowed; the
 * owner org stays on its list (409 `catalog.owner_required`). Views carry the owner.
 */

let env: OrgEnv;
/** The owner org ("A"); `env.orgId` is org B (boss is its admin); org C is another org. */
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
});

const items = "/api/v1/admin/catalog/items";
const comps = "/api/v1/admin/components/skill";

/**
 * A skills-only plugin owned by org A (written directly in PG): scope `named: [orgA, ...extra]`,
 * its platform skill owned by A too (P3-2: the plugin's flag copied to its components).
 */
async function ownedPlugin(
  o: { shareable?: boolean; shown?: boolean; extra?: string[] } = {},
): Promise<{ itemId: string; skillId: string }> {
  const itemId = await seedPlugin(env, {
    name: "owned-crm",
    skills: ["owned-skill"],
    templates: false,
  });
  await setScope(env, itemId, "named", [orgA, ...(o.extra ?? [])]);
  await env.db
    .updateTable("catalog_items")
    .set({ owner_org_id: orgA, shareable: o.shareable ?? false, shown_to_others: o.shown ?? true })
    .where("id", "=", itemId)
    .execute();
  await setSkillOwner(itemId, o.shareable ?? false);
  const s = await env.db
    .selectFrom("platform_skills")
    .select("id")
    .where("catalog_item_id", "=", itemId)
    .executeTakeFirstOrThrow();
  return { itemId, skillId: s.id };
}

async function setSkillOwner(itemId: string, shareable: boolean): Promise<void> {
  await env.db
    .updateTable("platform_skills")
    .set({ owner_org_id: orgA, origin_org_id: orgA, shareable })
    .where("catalog_item_id", "=", itemId)
    .execute();
}

async function setShareable(itemId: string, shareable: boolean): Promise<void> {
  await env.db.updateTable("catalog_items").set({ shareable }).where("id", "=", itemId).execute();
  await setSkillOwner(itemId, shareable);
}

const errorOf = (r: { statusCode: number; body: string }) =>
  [r.statusCode, (JSON.parse(r.body) as { error?: { code: string } }).error?.code] as const;

async function orgCatalog(orgId: string, req = env.boss) {
  const r = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/catalog` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items as { id: string; state: string }[];
}

async function orgSkills(orgId: string, req = env.boss) {
  const r = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/components?kind=skill` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().components as { id: string; on: boolean }[];
}

const requestAccess = (orgId: string, itemId: string, req = env.boss) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/catalog/${itemId}/requests`,
    payload: { kind: "access" },
  });

/** Preview + PUT of a plugin scope change. */
async function putItemScope(itemId: string, body: Record<string, unknown>) {
  const p = await env.root({
    method: "POST",
    url: `${items}/${itemId}/scope/preview`,
    payload: body,
  });
  expect(p.statusCode, p.body).toBe(200);
  return env.root({
    method: "PUT",
    url: `${items}/${itemId}/scope`,
    payload: { ...body, scopeHash: p.json().scopeHash },
  });
}

/** Preview + PUT of a component scope change. */
async function putSkillScope(skillId: string, body: Record<string, unknown>) {
  const p = await env.root({
    method: "POST",
    url: `${comps}/${skillId}/scope/preview`,
    payload: body,
  });
  expect(p.statusCode, p.body).toBe(200);
  return env.root({
    method: "PUT",
    url: `${comps}/${skillId}/scope`,
    payload: { ...body, scopeHash: p.json().scopeHash },
  });
}

async function listed(itemId: string): Promise<string[]> {
  const rows = await env.db
    .selectFrom("catalog_item_scope_orgs")
    .select("org_id")
    .where("item_id", "=", itemId)
    .orderBy("org_id")
    .execute();
  return rows.map((r) => r.org_id);
}

/** org B asks for access, the super admin approves; the sync then installs it in org B. */
async function grantB(itemId: string): Promise<void> {
  const r = await requestAccess(env.orgId, itemId);
  expect(r.statusCode, r.body).toBe(201);
  const ok = await env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/requests/${r.json().request.id}/decide`,
    payload: { approve: true },
  });
  expect(ok.statusCode, ok.body).toBe(200);
}

describe("share gate", { timeout: 90_000 }, () => {
  it("not shareable: hidden from other orgs even when shown_to_others", async () => {
    const { itemId, skillId } = await ownedPlugin({ shown: true });
    expect((await orgCatalog(env.orgId)).map((i) => i.id)).not.toContain(itemId);
    expect((await orgSkills(env.orgId)).map((c) => c.id)).not.toContain(skillId);
    expect(errorOf(await requestAccess(env.orgId, itemId))).toEqual([
      404,
      "catalog.item_not_found",
    ]);
    const d = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}` });
    expect(d.statusCode).toBe(404);
    // the owner sees it on its list
    expect((await orgCatalog(orgA, env.root)).map((i) => i.id)).toContain(itemId);
  });

  it("not shareable: the super admin cannot show or associate", async () => {
    const { itemId, skillId } = await ownedPlugin({ shown: false, extra: [orgC] });
    const shown = await env.root({
      method: "PUT",
      url: `${items}/${itemId}/shown`,
      payload: { shownToOthers: true },
    });
    expect(errorOf(shown)).toEqual([409, "catalog.not_shareable"]);
    expect(
      errorOf(await putItemScope(itemId, { scope: "named", orgs: [orgA, orgC, env.orgId] })),
    ).toEqual([409, "catalog.not_shareable"]);
    expect(errorOf(await putItemScope(itemId, { scope: "optional" }))).toEqual([
      409,
      "catalog.not_shareable",
    ]);
    expect(errorOf(await putItemScope(itemId, { scope: "all" }))).toEqual([
      409,
      "catalog.not_shareable",
    ]);
    // the component equivalents
    const cShown = await env.root({
      method: "PUT",
      url: `${comps}/${skillId}/shown`,
      payload: { shownToOthers: true },
    });
    expect(errorOf(cShown)).toEqual([409, "catalog.not_shareable"]);
    expect(
      errorOf(await putSkillScope(skillId, { scope: "named", orgs: [orgA, env.orgId] })),
    ).toEqual([409, "catalog.not_shareable"]);
    expect(errorOf(await putSkillScope(skillId, { scope: "optional" }))).toEqual([
      409,
      "catalog.not_shareable",
    ]);
    // nothing written
    expect(await listed(itemId)).toEqual([orgA, orgC].sort());
    // narrowing (removing orgs) and disabling stay allowed
    const narrowed = await putItemScope(itemId, { scope: "named", orgs: [orgA] });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(await listed(itemId)).toEqual([orgA]);
    const own = await putSkillScope(skillId, { scope: "named", orgs: [orgA] });
    expect(own.statusCode, own.body).toBe(200);
    const narrowedSkill = await putSkillScope(skillId, { scope: "named", orgs: [] });
    expect(errorOf(narrowedSkill)).toEqual([409, "catalog.owner_required"]);
    const dp = await env.root({
      method: "POST",
      url: `${comps}/${skillId}/scope/preview`,
      payload: { disabled: true },
    });
    const cOff = await env.root({
      method: "PUT",
      url: `${comps}/${skillId}/disabled`,
      payload: { disabled: true, scopeHash: dp.json().scopeHash },
    });
    expect(cOff.statusCode, cOff.body).toBe(200);
    const ip = await env.root({
      method: "POST",
      url: `${items}/${itemId}/scope/preview`,
      payload: { disabled: true },
    });
    const off = await env.root({
      method: "PUT",
      url: `${items}/${itemId}/disabled`,
      payload: { disabled: true, scopeHash: ip.json().scopeHash },
    });
    expect(off.statusCode, off.body).toBe(200);
  });

  it("shareable: shown and associable", async () => {
    const { itemId, skillId } = await ownedPlugin({ shareable: true, shown: false });
    const shown = await env.root({
      method: "PUT",
      url: `${items}/${itemId}/shown`,
      payload: { shownToOthers: true },
    });
    expect(shown.statusCode, shown.body).toBe(200);
    // org B sees it as not offered (未开放，可申请)
    expect((await orgCatalog(env.orgId)).find((i) => i.id === itemId)?.state).toBe("not_offered");
    await grantB(itemId);
    expect(await listed(itemId)).toEqual([orgA, env.orgId].sort());
    // the component may be shown too
    const cShown = await env.root({
      method: "PUT",
      url: `${comps}/${skillId}/shown`,
      payload: { shownToOthers: true },
    });
    expect(cShown.statusCode, cShown.body).toBe(200);
  });

  it("shareable turned off keeps associations", async () => {
    const { itemId, skillId } = await ownedPlugin({ shareable: true, shown: true });
    await grantB(itemId);
    await waitFor(
      async () => (await orgCatalog(env.orgId)).find((i) => i.id === itemId)?.state === "on",
      30_000,
      "the scope sync installs the item in org B",
    );
    await setShareable(itemId, false);
    expect((await orgCatalog(env.orgId)).find((i) => i.id === itemId)?.state).toBe("on");
    expect((await orgSkills(env.orgId)).find((c) => c.id === skillId)?.on).toBe(true);
    // org C no longer sees it, and its request is refused as for an invisible item
    expect((await orgCatalog(orgC, env.root)).map((i) => i.id)).not.toContain(itemId);
    expect(errorOf(await requestAccess(orgC, itemId, env.root))).toEqual([
      404,
      "catalog.item_not_found",
    ]);
  });

  it("an access request approved after shareable was turned off is refused", async () => {
    const { itemId } = await ownedPlugin({ shareable: true, shown: true });
    const r = await requestAccess(env.orgId, itemId);
    expect(r.statusCode, r.body).toBe(201);
    await setShareable(itemId, false);
    const ok = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/requests/${r.json().request.id}/decide`,
      payload: { approve: true },
    });
    expect(errorOf(ok)).toEqual([409, "catalog.not_shareable"]);
    expect(await listed(itemId)).toEqual([orgA]);
  });

  it("owner stays listed", async () => {
    const { itemId } = await ownedPlugin({ shareable: true, extra: [env.orgId] });
    expect(errorOf(await putItemScope(itemId, { scope: "named", orgs: [env.orgId] }))).toEqual([
      409,
      "catalog.owner_required",
    ]);
    expect(await listed(itemId)).toEqual([orgA, env.orgId].sort());
  });

  it("views carry the owner", async () => {
    const { itemId, skillId } = await ownedPlugin();
    const platformId = await seedPlugin(env, {
      name: "plain",
      skills: ["plain-skill"],
      templates: false,
    });
    const r = await env.root({ method: "GET", url: items });
    expect(r.statusCode, r.body).toBe(200);
    const list = r.json().items as Record<string, unknown>[];
    expect(list.find((i) => i.id === itemId)).toMatchObject({
      owner: { kind: "org", orgId: orgA, name: "A" },
      shareable: false,
      awaitingConfirmation: false,
      pendingVersion: null,
    });
    expect(list.find((i) => i.id === platformId)).toMatchObject({
      owner: { kind: "platform" },
      shareable: false,
    });
    const one = await env.root({ method: "GET", url: `${items}/${itemId}` });
    expect(one.json().item.owner).toEqual({ kind: "org", orgId: orgA, name: "A" });
    const c = await env.root({ method: "GET", url: "/api/v1/admin/components?kind=skill" });
    const cs = c.json().components as Record<string, unknown>[];
    expect(cs.find((x) => x.id === skillId)).toMatchObject({
      owner: { kind: "org", orgId: orgA, name: "A" },
      shareable: false,
      promoted: false,
    });
    expect(cs.find((x) => x.name === "plain-skill")).toMatchObject({
      owner: { kind: "platform" },
      promoted: false,
    });
  });
});
