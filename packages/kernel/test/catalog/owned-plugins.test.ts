import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CatalogScopeService } from "../../src/catalog/catalog-scope.service.js";
import { OwnedPluginCleanup } from "../../src/catalog/owned-plugin-cleanup.js";
import { usableSkills } from "../../src/skills/usable.js";
import { lifePkg } from "../helpers/plugin-packages.js";
import { createOrg, type Req, waitFor } from "../helpers/runs.js";
import { type OrgEnv, resetOrgCatalog, setScope, startOrgEnv } from "./org-env.js";
import { skillPlugin } from "./packages.js";

/**
 * Plugin scope phase 3, Task 7 (spec §14, P3-17 to P3-21; pre-flight F9, F13 to F15): the owner
 * org's admin toggles 可共享 on its own plugin and deletes it after a preview. A plugin no other
 * org uses is removed (its extension uninstalled by the cleanup job); a plugin another org uses is
 * transferred to the platform with a platform notice.
 */

let env: OrgEnv;
/** Org A ("Acme"; boss is its admin, mem a member). */
let orgA: string;
/** Org B ("B"; root is its owner). */
let orgB: string;
/** Org C ("C"; root is its owner). */
let orgC: string;

beforeAll(async () => {
  env = await startOrgEnv();
  orgA = env.orgId;
  orgB = await createOrg(env.root, "B");
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

const errorOf = (r: { statusCode: number; body: string }) =>
  [r.statusCode, (JSON.parse(r.body) as { error?: { code: string } }).error?.code] as const;

const uploads = (orgId: string) => `/api/v1/orgs/${orgId}/catalog/uploads`;
const owned = (orgId: string, itemId: string) => `/api/v1/orgs/${orgId}/owned-plugins/${itemId}`;

/** Uploads and confirms a package in the org; returns the item id after asserting the outcome. */
async function uploaded(
  req: Req,
  orgId: string,
  bytes: Uint8Array,
  outcome: "pending" | "installed",
): Promise<string> {
  const p = await req({
    method: "POST",
    url: `${uploads(orgId)}/file`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
  expect(p.statusCode, p.body).toBe(200);
  const prepared = p.json() as { stagingId: string; review: { reviewHash: string } };
  const c = await req({
    method: "POST",
    url: `${uploads(orgId)}/${prepared.stagingId}/confirm`,
    payload: { reviewHash: prepared.review.reviewHash },
  });
  expect(c.statusCode, c.body).toBe(201);
  expect((c.json() as { outcome: string }).outcome).toBe(outcome);
  return (c.json() as { item: { id: string } }).item.id;
}

const usable = async (orgId: string) => (await usableSkills(env.db, orgId)).map((s) => s.name);

const installRow = (name: string) =>
  env.db
    .selectFrom("extension_installs")
    .select(["sha256", "desired_state"])
    .where("name", "=", name)
    .executeTakeFirst();

/** Org A uploads `name` 1.0.0 (extension + skill `<name>-notes`), the super admin confirms it. */
async function confirmedV1(name: string): Promise<string> {
  const itemId = await uploaded(
    env.boss,
    orgA,
    await lifePkg({ name, version: "1.0.0", skills: [`${name}-notes`] }),
    "pending",
  );
  const list = await env.root({ method: "GET", url: "/api/v1/admin/catalog/items?pending=true" });
  const digest = (list.json() as { items: { id: string; permissionsHash: string }[] }).items.find(
    (i) => i.id === itemId,
  )?.permissionsHash;
  expect(digest).toBeTruthy();
  const c = await env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/items/${itemId}/confirm`,
    payload: { permissionsHash: digest },
  });
  expect(c.statusCode, c.body).toBe(200);
  await waitFor(
    async () => (await usable(orgA)).includes(`${name}-notes`),
    30_000,
    `${name}-notes usable in A`,
  );
  return itemId;
}

/** Shares a confirmed item of org A with org B (the super admin's association), where it is on. */
async function sharedWithB(itemId: string, skill: string): Promise<void> {
  const s = await env.boss({
    method: "PUT",
    url: `${owned(orgA, itemId)}/shareable`,
    payload: { shareable: true },
  });
  expect(s.statusCode, s.body).toBe(204);
  await setScope(env, itemId, "named", [orgA, orgB]);
  await env.db
    .updateTable("catalog_items")
    .set({ scope_version: sql<number>`scope_version + 1` })
    .where("id", "=", itemId)
    .execute();
  await env.k.app.get(CatalogScopeService).enqueueSync(itemId);
  await waitFor(async () => (await usable(orgB)).includes(skill), 30_000, `${skill} usable in B`);
}

/** An agent of the org whose current definition selects the item's (platform) skill. */
async function agentUsingSkill(orgId: string, itemId: string, name: string): Promise<string> {
  const skill = await env.db
    .selectFrom("platform_skills")
    .select("id")
    .where("catalog_item_id", "=", itemId)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  const agentId = randomUUID();
  await env.db
    .insertInto("agents")
    .values({
      id: agentId,
      org_id: orgId,
      owner_account_id: env.rootId,
      visibility: "private",
      current_version: 1,
    })
    .execute();
  await env.db
    .insertInto("agent_versions")
    .values({
      agent_id: agentId,
      version: 1,
      definition: JSON.stringify({ name, skills: { orgSkills: [skill.id] } }),
      created_by: env.rootId,
    })
    .execute();
  return agentId;
}

interface DeletePreview {
  outcome: "removed" | "transferred";
  orgs: { id: string; name: string }[];
  agents: { id: string; name: string }[];
  previewHash: string;
}

async function preview(req: Req, orgId: string, itemId: string): Promise<DeletePreview> {
  const r = await req({ method: "POST", url: `${owned(orgId, itemId)}/delete/preview` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as DeletePreview;
}

const del = (req: Req, orgId: string, itemId: string, previewHash: string) =>
  req({ method: "POST", url: `${owned(orgId, itemId)}/delete`, payload: { previewHash } });

describe("org-owned plugins", { timeout: 180_000 }, () => {
  it("shareable toggles the plugin and its components", async () => {
    const itemId = await uploaded(env.boss, orgA, await skillPlugin("share-a"), "installed");
    const put = (req: Req, orgId: string, shareable: boolean) =>
      req({ method: "PUT", url: `${owned(orgId, itemId)}/shareable`, payload: { shareable } });
    const r = await put(env.boss, orgA, true);
    expect(r.statusCode, r.body).toBe(204);
    const item = await env.db
      .selectFrom("catalog_items")
      .select("shareable")
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(item.shareable).toBe(true);
    const skills = await env.db
      .selectFrom("platform_skills")
      .select("shareable")
      .where("catalog_item_id", "=", itemId)
      .execute();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((s) => s.shareable)).toBe(true);
    // a member may not; another org (root is B's owner) does not see A's item
    expect(errorOf(await put(env.mem, orgA, false))[0]).toBe(403);
    expect(errorOf(await put(env.root, orgB, false))).toEqual([404, "catalog.item_not_found"]);
    // off again
    expect((await put(env.boss, orgA, false)).statusCode).toBe(204);
    expect(
      (
        await env.db
          .selectFrom("platform_skills")
          .select("shareable")
          .where("catalog_item_id", "=", itemId)
          .execute()
      ).every((s) => !s.shareable),
    ).toBe(true);
  });

  it("delete an unshared plugin removes it", async () => {
    const itemId = await confirmedV1("own-rm");
    const agentId = await agentUsingSkill(orgA, itemId, "Helper");
    // another org or a member cannot preview it
    const other = await env.root({ method: "POST", url: `${owned(orgB, itemId)}/delete/preview` });
    expect(errorOf(other)).toEqual([404, "catalog.item_not_found"]);
    const p = await preview(env.boss, orgA, itemId);
    expect(p).toMatchObject({
      outcome: "removed",
      orgs: [],
      agents: [{ id: agentId, name: "Helper" }],
    });
    const d = await del(env.boss, orgA, itemId, p.previewHash);
    expect(d.statusCode, d.body).toBe(204);
    const row = await env.db
      .selectFrom("catalog_items")
      .select(["deleted_at", "owner_org_id"])
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
    expect(row.owner_org_id).toBe(orgA);
    expect(await usable(orgA)).not.toContain("own-rm-notes");
    // the cleanup job enqueued after the commit takes its extension out; running it again is a
    // no-op
    await waitFor(
      async () => (await installRow("own-rm")) === undefined,
      30_000,
      "own-rm uninstalled by the cleanup job",
    );
    await env.k.app.get(OwnedPluginCleanup).run(itemId);
    await env.k.app.get(OwnedPluginCleanup).run(itemId);
    expect(await installRow("own-rm")).toBeUndefined();
    expect(
      await env.db
        .selectFrom("extension_name_owners")
        .select("name")
        .where("name", "=", "own-rm")
        .executeTakeFirst(),
    ).toBeUndefined();
    // gone: a second delete is a 404
    expect(errorOf(await del(env.boss, orgA, itemId, p.previewHash))).toEqual([
      404,
      "catalog.item_not_found",
    ]);
  });

  it("delete a shared plugin transfers it", async () => {
    const itemId = await confirmedV1("own-tx");
    await sharedWithB(itemId, "own-tx-notes");
    const p = await preview(env.boss, orgA, itemId);
    expect(p).toMatchObject({ outcome: "transferred", orgs: [{ id: orgB, name: "B" }] });
    const d = await del(env.boss, orgA, itemId, p.previewHash);
    expect(d.statusCode, d.body).toBe(204);
    const row = await env.db
      .selectFrom("catalog_items")
      .select(["deleted_at", "owner_org_id", "pending_version"])
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ deleted_at: null, owner_org_id: null, pending_version: null });
    const comps = await env.db
      .selectFrom("platform_skills")
      .select("owner_org_id")
      .where("catalog_item_id", "=", itemId)
      .where("deleted_at", "is", null)
      .execute();
    expect(comps.map((c) => c.owner_org_id)).toEqual([null]);
    const listed = await env.db
      .selectFrom("catalog_item_scope_orgs")
      .select("org_id")
      .where("item_id", "=", itemId)
      .execute();
    expect(listed.map((l) => l.org_id)).toEqual([orgB]);
    await waitFor(
      async () => !(await usable(orgA)).includes("own-tx-notes"),
      30_000,
      "own-tx-notes gone from A",
    );
    expect(await usable(orgB)).toContain("own-tx-notes");
    const inbox = await env.root({ method: "GET", url: "/api/v1/admin/inbox" });
    const items = (
      inbox.json() as {
        items: { type: string; notice?: { detail: { reason: string; ref: unknown } } }[];
      }
    ).items.filter((i) => i.type === "ownership_transferred");
    expect(items).toHaveLength(1);
    expect(items[0]?.notice?.detail).toMatchObject({
      reason: "owner_deleted",
      ref: { kind: "plugin", id: itemId },
      fromOrg: { id: orgA, name: "Acme" },
      usedBy: 1,
    });
    // the extension stays installed for B, even after a cleanup run
    await env.k.app.get(OwnedPluginCleanup).run(itemId);
    expect((await installRow("own-tx"))?.desired_state).toBe("enabled");
    // the former owner can no longer act on it
    expect(
      errorOf(await env.boss({ method: "POST", url: `${owned(orgA, itemId)}/delete/preview` })),
    ).toEqual([404, "catalog.item_not_found"]);
  });

  it("stale preview", async () => {
    const itemId = await uploaded(env.boss, orgA, await skillPlugin("own-stale"), "installed");
    const s = await env.boss({
      method: "PUT",
      url: `${owned(orgA, itemId)}/shareable`,
      payload: { shareable: true },
    });
    expect(s.statusCode, s.body).toBe(204);
    await env.db
      .updateTable("catalog_items")
      .set({ scope: "optional", shown_to_others: true })
      .where("id", "=", itemId)
      .execute();
    const p = await preview(env.boss, orgA, itemId);
    expect(p).toMatchObject({ outcome: "removed", orgs: [] });
    // org C turns it on after the preview
    const on = await env.root({
      method: "PUT",
      url: `/api/v1/orgs/${orgC}/catalog/${itemId}/switch`,
      payload: { enabled: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(errorOf(await del(env.boss, orgA, itemId, p.previewHash))).toEqual([
      409,
      "catalog.preview_stale",
    ]);
    const now = await preview(env.boss, orgA, itemId);
    expect(now).toMatchObject({ outcome: "transferred", orgs: [{ id: orgC, name: "C" }] });
  });
});
