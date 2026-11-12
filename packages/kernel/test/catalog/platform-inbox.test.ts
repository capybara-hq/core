import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CatalogItemView } from "../../src/catalog/catalog.service.js";
import { PluginScopeSync } from "../../src/catalog/scope-sync.js";
import { ExtensionAdminOps } from "../../src/extensions/admin-ops.js";
import {
  PLATFORM_INBOX_TYPES,
  PlatformInboxService,
} from "../../src/inbox/platform-inbox.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { SkillsService } from "../../src/skills/skills.service.js";
import { SKILL_MD } from "../skills/zip.js";
import {
  importDeployedPlugin,
  importSkill,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  setScope,
  startOrgEnv,
} from "./org-env.js";

/**
 * The super admin's inbox (`GET /api/v1/admin/inbox`, plugin scope phase 2 Task 11, spec §5.1 rule
 * 5 and §13.5): requests to the platform (`access` / `import`), plugins waiting for a permission
 * confirmation, failed scope syncs and platform notices. Read live; nothing is decided here (each item names what it is about, the web links to its page).
 */

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("platform_notices").execute();
});

const NO_ITEMS = {
  catalog_request: 0,
  permission_confirmation: 0,
  org_upload_pending: 0,
  scope_sync_failed: 0,
  ownership_transferred: 0,
};

interface Item {
  type: string;
  id: string;
  createdAt: string;
  [k: string]: unknown;
}

async function count(): Promise<number> {
  const r = await env.root({ method: "GET", url: "/api/v1/admin/inbox/count" });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { total: number }).total;
}

const failureRows = () =>
  env.db.selectFrom("plugin_scope_sync_failures").select(["item_id", "op"]).execute();

const liveIn = async (itemId: string): Promise<boolean> =>
  (await env.db
    .selectFrom("plugin_installs")
    .select("id")
    .where("org_id", "=", env.orgId)
    .where("item_id", "=", itemId)
    .where("status", "in", ["installing", "installed", "upgrading"])
    .executeTakeFirst()) !== undefined;

async function inbox(): Promise<{
  items: Item[];
  truncated: boolean;
  total: number;
  byType: Record<string, number>;
}> {
  const r = await env.root({ method: "GET", url: "/api/v1/admin/inbox" });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

const ofType = async (type: string) => (await inbox()).items.filter((i) => i.type === type);

describe("platform inbox", { timeout: 90_000 }, () => {
  it("is for super admins only, and empty when nothing waits", async () => {
    expect((await env.boss({ method: "GET", url: "/api/v1/admin/inbox" })).statusCode).toBe(403);
    expect((await env.mem({ method: "GET", url: "/api/v1/admin/inbox" })).statusCode).toBe(403);
    expect(await inbox()).toEqual({ items: [], truncated: false, total: 0, byType: NO_ITEMS });
    expect(await count()).toBe(0);
    expect((await env.boss({ method: "GET", url: "/api/v1/admin/inbox/count" })).statusCode).toBe(
      403,
    );
  });

  it("lists an org's access request until it is decided", async () => {
    const itemId = await importSkill(env);
    await setScope(env, itemId, "named", []);
    const r = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/requests`,
      payload: { kind: "access", note: "for sales" },
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().request.id as string;
    const items = await ofType("catalog_request");
    expect(items).toEqual([
      expect.objectContaining({
        id,
        request: expect.objectContaining({
          id,
          kind: "access",
          orgId: env.orgId,
          note: "for sales",
          item: expect.objectContaining({ id: itemId }),
        }),
      }),
    ]);
    const decided = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/requests/${id}/decide`,
      payload: { approve: false },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(await ofType("catalog_request")).toEqual([]);
  });

  it("lists a plugin whose extension permissions wait for a confirmation", async () => {
    // imported and deployed, then its extension uninstalled: the item waits for a confirmation
    const { itemId } = await importDeployedPlugin(env, "unconfirmed");
    expect(await ofType("permission_confirmation")).toEqual([]);
    await env.k.app.get(ExtensionAdminOps).disable("unconfirmed", null);
    await env.k.app.get(ExtensionAdminOps).uninstall("unconfirmed", null);
    expect(await ofType("permission_confirmation")).toEqual([
      expect.objectContaining({
        id: itemId,
        item: expect.objectContaining({ id: itemId, name: "unconfirmed", pending: true }),
      }),
    ]);
  });

  it("lists a failed scope sync until the pair syncs without failing", async () => {
    // the org's own skill of the same name makes the scope install fail (plugin.skill_conflict)
    const md = new TextEncoder().encode(SKILL_MD("clash-skill"));
    const own = await env.k.app.get(SkillsService).createVersionFromFiles(env.orgId, env.bossId, {
      name: "clash-skill",
      description: "Mine.",
      files: [{ path: "SKILL.md", size: md.byteLength, sha256: "x".repeat(64), data: md }],
    });
    const itemId = await seedPlugin(env, {
      name: "clash",
      skills: ["clash-skill"],
      templates: false,
    });
    await setScope(env, itemId, "named", [env.orgId]);
    expect(await env.k.app.get(PluginScopeSync).syncPair(itemId, env.orgId)).toBe("unchanged");
    const items = await ofType("scope_sync_failed");
    expect(items).toEqual([
      expect.objectContaining({
        id: `${itemId}/${env.orgId}`,
        failure: expect.objectContaining({
          item: expect.objectContaining({ id: itemId, name: "clash" }),
          org: expect.objectContaining({ id: env.orgId }),
          op: "install",
          code: "plugin.skill_conflict",
        }),
      }),
    ]);
    // the conflict goes away: the next sync of the pair installs it and the failure is gone
    await env.db
      .updateTable("skills")
      .set({ deleted_at: new Date() })
      .where("id", "=", own.skill.id)
      .execute();
    expect(await env.k.app.get(PluginScopeSync).syncPair(itemId, env.orgId)).toBe("installed");
    expect(await ofType("scope_sync_failed")).toEqual([]);
    expect(await env.db.selectFrom("plugin_scope_sync_failures").selectAll().execute()).toEqual([]);
  });

  it("a failure the org converged by other means is not listed", async () => {
    const itemId = await seedPlugin(env, {
      name: "gone-off",
      skills: ["off-skill"],
      templates: false,
    });
    // recorded: the uninstall failed, but nothing is installed in the org any more
    await env.db
      .insertInto("plugin_scope_sync_failures")
      .values({
        item_id: itemId,
        org_id: env.orgId,
        op: "uninstall",
        code: "internal",
        message: "boom",
      })
      .execute();
    expect(await ofType("scope_sync_failed")).toEqual([]);
  });

  it("a dependency a platform update added that fails to install is listed until it installs", async () => {
    const depId = await seedPlugin(env, { name: "depb", skills: ["depb-skill"], templates: false });
    const itemId = await seedPlugin(env, {
      name: "depa",
      skills: ["depa-skill"],
      templates: false,
    });
    await setScope(env, itemId, "named", [env.orgId]);
    const sync = env.k.app.get(PluginScopeSync);
    expect(await sync.syncPair(itemId, env.orgId)).toBe("installed");
    // a platform update adds a dependency no imported version satisfies yet
    const v = await env.db
      .selectFrom("catalog_item_versions")
      .select("manifest")
      .where("item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    await env.db
      .updateTable("catalog_item_versions")
      .set({
        manifest: JSON.stringify({
          ...(v.manifest as Record<string, unknown>),
          dependencies: [{ name: "depb", version: "^2.0.0" }],
        }),
      })
      .where("item_id", "=", itemId)
      .execute();
    expect(await sync.syncPair(itemId, env.orgId)).toBe("unchanged");
    expect(await liveIn(depId)).toBe(false);
    expect(await ofType("scope_sync_failed")).toEqual([
      expect.objectContaining({
        id: `${itemId}/${env.orgId}`,
        failure: expect.objectContaining({
          op: "dependencies",
          code: "catalog.dependency_unresolved",
        }),
      }),
    ]);
    expect(await count()).toBe(1);
    // the version is imported and the platform moved to it: the next sync installs the
    // dependency and clears the failure
    await seedPlugin(env, {
      name: "depb",
      skills: ["depb-skill"],
      templates: false,
      version: "2.0.0",
      addTo: depId,
    });
    await env.db
      .updateTable("catalog_items")
      .set({ platform_synced_version: "2.0.0" })
      .where("id", "=", depId)
      .execute();
    expect(await sync.syncPair(itemId, env.orgId)).toBe("unchanged");
    expect(await liveIn(depId)).toBe(true);
    expect(await ofType("scope_sync_failed")).toEqual([]);
    expect(await failureRows()).toEqual([]);
    // the dependency re-sync after an uninstall clears the dependency's own open failure too
    await env.db
      .insertInto("plugin_scope_sync_failures")
      .values({
        item_id: depId,
        org_id: env.orgId,
        op: "uninstall",
        code: "internal",
        message: "x",
      })
      .execute();
    expect(await ofType("scope_sync_failed")).toHaveLength(1);
    await setScope(env, itemId, "named", []);
    expect(await sync.syncPair(itemId, env.orgId)).toBe("removed");
    expect(await liveIn(depId)).toBe(false);
    expect(await failureRows()).toEqual([]);
  });

  it("truncates at 100 items, with the total and the count", async () => {
    const ids = Array.from({ length: 101 }, () => randomUUID());
    await env.db
      .insertInto("catalog_items")
      .values(
        ids.map((id, i) => ({
          id,
          name: `bulk-${i}`,
          package_name: `@acme/plugin-bulk-${i}`,
          publisher: "Acme",
          description: "bulk",
          latest_version: "1.0.0",
          policy: "allow" as const,
        })),
      )
      .execute();
    await env.db
      .insertInto("plugin_scope_sync_failures")
      .values(
        ids.map((id) => ({
          item_id: id,
          org_id: env.orgId,
          op: "install" as const,
          code: "internal",
          message: "boom",
        })),
      )
      .execute();
    const r = await inbox();
    expect(r.items).toHaveLength(100);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(101);
    // byType counts everything waiting, not the 100 listed
    expect(r.byType).toEqual({ ...NO_ITEMS, scope_sync_failed: 101 });
    expect(await count()).toBe(101);
  });

  it("byType counts every source, the pending list split by owner, and sums to total", async () => {
    const itemId = randomUUID();
    await env.db
      .insertInto("catalog_items")
      .values({
        id: itemId,
        name: "counted",
        package_name: "@acme/plugin-counted",
        publisher: "Acme",
        description: "counted",
        latest_version: "1.0.0",
        policy: "allow" as const,
      })
      .execute();
    await env.db
      .insertInto("plugin_scope_sync_failures")
      .values({ item_id: itemId, org_id: env.orgId, op: "install", code: "internal", message: "x" })
      .execute();
    await env.db
      .insertInto("platform_notices")
      .values({
        id: randomUUID(),
        kind: "ownership_transferred",
        detail: JSON.stringify({
          ref: { kind: "skill", id: randomUUID() },
          name: "weekly",
          fromOrg: { id: randomUUID(), name: "Gone" },
          reason: "org_deleted",
          usedBy: 0,
        }),
      })
      .execute();
    const pending = (kind: "platform" | "org") =>
      ({
        id: randomUUID(),
        updatedAt: new Date().toISOString(),
        owner: kind === "org" ? { kind, orgId: env.orgId, orgName: "Acme" } : { kind },
      }) as unknown as CatalogItemView;
    // the requests and the pending list from stubs (their own tests cover them), the rest from PG
    const service = new PlatformInboxService(
      { listDeployment: async () => [], countPendingDeployment: async () => 2 },
      { list: (async () => [pending("platform"), pending("org")]) as never },
      env.k.app.get(KernelDb),
    );
    const view = await service.list();
    expect(view.byType).toEqual({
      catalog_request: 2,
      permission_confirmation: 1,
      org_upload_pending: 1,
      scope_sync_failed: 1,
      ownership_transferred: 1,
    });
    expect(Object.keys(view.byType).sort()).toEqual([...PLATFORM_INBOX_TYPES].sort());
    expect(view.total).toBe(6);
    expect(await service.count()).toBe(6);
  });
});
